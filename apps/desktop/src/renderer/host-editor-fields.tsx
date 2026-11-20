import type { HostCredentialsPatch, HostDraft, HostView, SshConnectionSettings } from '@cloudhelm/contracts';
import { SSH_ALGORITHM_CHOICES } from '@cloudhelm/contracts';
import { NumberInput } from './number-input.js';
import { Button } from './ui/index.js';
import styles from './host-editor.module.css';

export interface HostEditorFields {
  draft: HostDraft; update(change: Partial<HostDraft>): void;
  credentials: HostCredentialsPatch; credential(key: keyof HostCredentialsPatch, value: string | null | undefined): void;
  editing?: HostView; hosts: HostView[]; selectingKey: boolean; selectKey(): void;
}
const connection = (props: HostEditorFields) => props.draft.connection ?? { version: 1 as const };
const change = (props: HostEditorFields, patch: Partial<SshConnectionSettings>) => props.update({ connection: { ...connection(props), ...patch } });

export function SecretField({ props, field, label, required = false }: {
  props: HostEditorFields; field: keyof HostCredentialsPatch; label: string; required?: boolean;
}): React.JSX.Element {
  const cleared = props.credentials[field] === null;
  return <div className={styles.secret}>
    <label>{label}<input type="password" autoComplete="new-password" data-sensitive-input="true" maxLength={field === 'x11Cookie' ? 32 : 4096}
      pattern={field === 'x11Cookie' ? '[a-fA-F0-9]{32}' : undefined} required={required && !cleared} disabled={cleared}
      value={props.credentials[field] ?? ''} onChange={(event) => props.credential(field, event.target.value || undefined)}
      placeholder={props.editing ? '留空仅保留接收方和用途未变的现有凭据' : '可不保存，连接时按实际认证请求输入'} /></label>
    {props.editing && <label className={styles.check}><input type="checkbox" checked={cleared}
      onChange={(event) => props.credential(field, event.target.checked ? null : undefined)} />清除已存{label}</label>}
  </div>;
}

export function GeneralFields(props: HostEditorFields): React.JSX.Element {
  const { draft, update } = props;
  return <>
    <h3>主机信息</h3><p>连接名称与分组只用于整理；不会改变 AI 的授权范围。</p>
    <div className={styles.grid}>
      <label>名称<input required autoFocus maxLength={80} value={draft.label} onChange={(event) => update({ label: event.target.value })} placeholder="例如：生产服务器" /></label>
      <label>分组<input maxLength={80} list="host-groups" value={draft.group ?? ''} onChange={(event) => update({ group: event.target.value || undefined })} placeholder="未分组" /></label>
      <datalist id="host-groups">{[...new Set(props.hosts.filter((host) => !host.archived).map((host) => host.group).filter(Boolean))].map((group) => <option key={group} value={group} />)}</datalist>
      <label className={styles.wide}>服务器地址<input required maxLength={255} pattern={'[^\\s]+'} value={draft.address} onChange={(event) => update({ address: event.target.value })} placeholder="192.0.2.10 或 example.com" /></label>
      <label>端口<NumberInput required min={1} max={65535} value={draft.port} onValueChange={(value) => update({ port: value })} /></label>
      <label>账户<input required maxLength={128} value={draft.username} onChange={(event) => update({ username: event.target.value })} placeholder="ubuntu" /></label>
    </div>
    <label>跳板机<select value={draft.jumpHostId ?? ''} onChange={(event) => update({ jumpHostId: event.target.value || undefined })}>
      <option value="">直连（不使用跳板机）</option>{props.hosts.filter((host) => !host.archived && !host.jumpHostId && host.id !== props.editing?.id && host.auth !== 'agent')
        .map((host) => <option key={host.id} value={host.id}>{host.label}</option>)}
    </select></label>
    <small>只支持单级跳板。启用代理时优先使用代理，不连接跳板机。</small>
    <label>备注<textarea rows={4} maxLength={4096} value={draft.notes ?? ''} onChange={(event) => update({ notes: event.target.value || undefined })} placeholder="用途、维护说明等；请勿填写凭据" /></label>
  </>;
}

export function AuthenticationFields(props: HostEditorFields): React.JSX.Element {
  const { draft, update } = props, c = connection(props);
  const order: NonNullable<SshConnectionSettings['authOrder']> = c.authOrder ?? (draft.auth === 'private-key' ? ['private-key', 'password', 'keyboard-interactive'] : ['password', 'keyboard-interactive']);
  const keyEnabled = draft.auth === 'private-key' || order.includes('private-key');
  const names = { 'private-key': '私钥', password: '密码', 'keyboard-interactive': '交互验证' };
  const reorder = (index: number, direction: number) => {
    const next = [...order]; [next[index], next[index + direction]] = [next[index + direction]!, next[index]!]; change(props, { authOrder: next });
  };
  return <>
    <h3>SSH 身份验证</h3><p>先协商服务器支持的方式，再使用相应用途的凭据。不会因选择了密码模式就提前索取密码。</p>
    {draft.auth === 'agent' && <p role="alert">旧 SSH Agent 配置已停用。请显式选择密码或私钥，旧凭据不会转换用途。</p>}
    <label>认证方式<select required value={draft.auth} onChange={(event) => {
      const auth = event.target.value as 'password' | 'private-key';
      update({ auth, privateKeyPath: undefined, connection: { ...c, authOrder: auth === 'private-key' ? ['private-key', 'password', 'keyboard-interactive'] : ['password', 'keyboard-interactive'] } });
      props.credential('password', undefined); props.credential('passphrase', undefined);
    }}>
      {draft.auth === 'agent' && <option value="agent" disabled>已停用，请重新选择</option>}
      <option value="password">密码</option><option value="private-key">私钥</option>
    </select></label>
    {draft.auth === 'password' && <label className={styles.check}><input type="checkbox" checked={keyEnabled} onChange={(event) => {
      update({ privateKeyPath: event.target.checked ? draft.privateKeyPath : undefined,
        connection: { ...c, authOrder: event.target.checked ? [...order, 'private-key'] : order.filter((method) => method !== 'private-key') } });
    }} />同时配置私钥候选</label>}
    {keyEnabled && <>
      <label htmlFor="private-key-path">私钥路径</label><div className={styles.file}>
        <input id="private-key-path" required value={draft.privateKeyPath ?? ''} onChange={(event) => update({ privateKeyPath: event.target.value })} placeholder="选择私钥文件，或输入完整路径" />
        <Button size="compact" disabled={props.selectingKey} onClick={props.selectKey}>{props.selectingKey ? '选择中…' : '选择文件'}</Button>
      </div><SecretField props={props} field="passphrase" label="私钥口令（如有）" />
    </>}
    <SecretField props={props} field="password" label={keyEnabled ? 'SSH 密码（后备认证）' : 'SSH 密码'} />
    <h4>认证顺序</h4><ol className={styles.order}>{order.map((method, index) => <li key={method}>
      <span>{index + 1}. {names[method]}</span><button type="button" aria-label={`上移${names[method]}`} disabled={index === 0} onClick={() => reorder(index, -1)}>↑</button>
      <button type="button" aria-label={`下移${names[method]}`} disabled={index === order.length - 1} onClick={() => reorder(index, 1)}>↓</button>
    </li>)}</ol><small>顺序是偏好，不是服务器能力声明。验证码只在绑定本次会话的私密弹窗中输入，不保存。</small>
  </>;
}

export function ConnectionFields(props: HostEditorFields): React.JSX.Element {
  const c = connection(props);
  return <><h3>连接与协议心跳</h3><p>协议心跳不执行远端 Shell 命令；自定义保活命令在「启动设置」中单独配置。</p>
    <label>SSH 握手与认证超时（秒）<NumberInput required min={1} max={300} value={(c.timeoutMs ?? 150000) / 1000} onValueChange={(value) => change(props, { timeoutMs: value * 1000 })} /></label>
    <label>SSH 心跳间隔（秒，0 表示关闭）<NumberInput required min={0} max={300} value={(c.keepaliveIntervalMs ?? 15000) / 1000} onValueChange={(value) => change(props, { keepaliveIntervalMs: value * 1000 })} /></label>
    <label>心跳最大未响应次数<NumberInput required min={1} max={20} value={c.keepaliveCountMax ?? 3} onValueChange={(value) => change(props, { keepaliveCountMax: value })} /></label>
    <small>交互输入另有最长两分钟的独立有效期；较短的连接超时也会终止正在等待的认证。</small>
  </>;
}

export function ProxyFields(props: HostEditorFields): React.JSX.Element {
  const c = connection(props), proxy = c.proxy ?? { enabled: false, protocol: 'socks5' as const, address: '127.0.0.1', port: 1080 };
  const update = (patch: Partial<typeof proxy>) => change(props, { proxy: { ...proxy, ...patch } });
  return <><h3>网络代理</h3><p>代理启用时优先于跳板机。代理失败不会自动直连，目标 SSH 指纹仍必须通过验证。</p>
    <label className={styles.check}><input type="checkbox" checked={proxy.enabled} onChange={(event) => update({ enabled: event.target.checked })} />启用连接代理</label>
    <fieldset disabled={!proxy.enabled} className={styles.fields}>
      <label>代理协议<select value={proxy.protocol} onChange={(event) => update({ protocol: event.target.value as typeof proxy.protocol })}>
        <option value="socks5">SOCKS5</option><option value="http">HTTP CONNECT</option><option value="https">HTTPS CONNECT</option>
      </select></label>
      <div className={styles.grid}><label>代理地址<input required value={proxy.address} maxLength={255} onChange={(event) => update({ address: event.target.value })} placeholder="仅地址，不含协议或密码" /></label>
        <label>代理端口<NumberInput required min={1} max={65535} value={proxy.port} onValueChange={(value) => update({ port: value })} /></label></div>
      <label>代理用户名（可选）<input value={proxy.username ?? ''} maxLength={128} onChange={(event) => update({ username: event.target.value || undefined })} /></label>
      <SecretField props={props} field="proxyPassword" label="代理密码" />
    </fieldset><small>HTTP 和 SOCKS5 本身不加密代理认证；跨不可信网络请使用 HTTPS CONNECT 或可信隧道。HTTPS 会校验证书，不提供跳过验证开关。</small>
  </>;
}

export function TerminalFields(props: HostEditorFields): React.JSX.Element {
  const c = connection(props);
  return <><h3>终端与文件浏览</h3><p>编码只作用于人工终端的输入和输出；AI 使用独立、固定的控制协议。</p>
    <label>终端编码<select value={c.terminal?.encoding ?? 'utf8'} onChange={(event) => change(props, { terminal: { ...c.terminal, encoding: event.target.value as NonNullable<SshConnectionSettings['terminal']>['encoding'] } })}>
      {['utf8', 'gb18030', 'gbk', 'big5', 'shift_jis', 'windows-1252', 'latin1'].map((value) => <option key={value} value={value}>{value}</option>)}
    </select></label>
    <label>TERM<input required maxLength={80} pattern={'[a-zA-Z0-9._+\\-]+'} value={c.terminal?.term ?? 'xterm-256color'} onChange={(event) => change(props, { terminal: { ...c.terminal, term: event.target.value } })} /></label>
    <label className={styles.check}><input type="checkbox" checked={c.files?.watch === false} onChange={(event) => change(props, { files: { ...c.files, watch: !event.target.checked } })} />禁用文件列表自动监控</label>
    <small>开启监控时，只在文件页可见时每 5 秒读取目录；出错后停止，需手动刷新。</small>
    <label className={styles.check}><input type="checkbox" checked={c.files?.followCwd === false} onChange={(event) => change(props, { files: { ...c.files, followCwd: !event.target.checked } })} />禁用 pwd 目录跟随</label>
    <small>目录跟随使用人工 Bash/Zsh 终端报告的实际路径。关闭只影响文件面板，不关闭后端目录记录或改变批准绑定。</small>
  </>;
}

export function X11Fields(props: HostEditorFields): React.JSX.Element {
  const c = connection(props), x11 = c.x11 ?? { enabled: false, display: 0, screen: 0, cookie: 'auto' as const };
  const update = (patch: Partial<typeof x11>) => change(props, { x11: { ...x11, ...patch } });
  return <><h3>X11 转发</h3><p>仅供明确确认的人工终端使用，不为 AI 命令启用。本机需要先运行 X Server。</p>
    <label className={styles.check}><input type="checkbox" checked={x11.enabled} onChange={(event) => update({ enabled: event.target.checked })} />启用 X11 转发</label>
    <fieldset disabled={!x11.enabled} className={styles.fields}>
      <div className={styles.grid}><label>本机显示号<NumberInput required min={0} max={59535} value={x11.display} onValueChange={(value) => update({ display: value })} /></label>
        <label>屏幕号<NumberInput required min={0} max={255} value={x11.screen} onValueChange={(value) => update({ screen: value })} /></label></div>
      <label>Cookie 模式<select value={x11.cookie} onChange={(event) => update({ cookie: event.target.value as typeof x11.cookie })}>
        <option value="auto">读取本机 Xauthority</option><option value="manual">手动 Cookie（加密保存）</option><option value="none">本机 X Server 无认证（明确选择）</option>
      </select></label>
      {x11.cookie === 'manual' && <SecretField props={props} field="x11Cookie" label="X11 Cookie" required={!props.editing || props.editing.connection?.x11?.cookie !== 'manual'} />}
    </fieldset>
    <small>Windows 仅连接 127.0.0.1 的 6000＋显示号端口；其他平台使用本机 X11 Unix Socket。认证失败不会退回无认证模式。</small>
    <p className={styles.warning}>远端 X 客户端可能访问本机 X 桌面。仅对可信主机启用；本机 Cookie 不会发送给远端 SSH 服务器。</p>
  </>;
}

export function AlgorithmFields(props: HostEditorFields): React.JSX.Element {
  const c = connection(props), names = { hostKey: '主机密钥算法', cipher: '加密算法 Cipher', kex: '密钥交换 KEX' };
  return <><h3>SSH 算法</h3><p>通常保留 SSH 库的安全默认值。自定义后只允许选中的算法，协商失败不会静默降级。</p>
    {(Object.keys(names) as Array<keyof typeof names>).map((key) => {
      const selected = c.algorithms?.[key];
      return <div className={styles.algorithm} key={key}><h4>{names[key]}</h4>
        <label className={styles.check}><input type="checkbox" checked={!selected} onChange={(event) => change(props, { algorithms: { ...c.algorithms,
          [key]: event.target.checked ? undefined : SSH_ALGORITHM_CHOICES[key].filter((value) => value !== 'ssh-rsa') } })} />使用默认{nameShort(key)}</label>
        <select multiple aria-label={names[key]} disabled={!selected} value={selected ?? []} onChange={(event) => {
          const values = Array.from(event.target.selectedOptions, (option) => option.value);
          const next = SSH_ALGORITHM_CHOICES[key].filter((value) => values.includes(value));
          change(props, { algorithms: { ...c.algorithms, [key]: next.length ? next : undefined } });
        }}>{SSH_ALGORITHM_CHOICES[key].map((value) => <option key={value} value={value}>{value}</option>)}</select>
      </div>;
    })}<small>可多选，按列表顺序协商；清空选择恢复默认。ssh-rsa 使用旧 SHA-1 签名，仅在确有兼容需求时显式选择。</small>
  </>;
}
const nameShort = (key: 'hostKey' | 'cipher' | 'kex') => ({ hostKey: '主机密钥算法', cipher: '加密算法', kex: '密钥交换算法' })[key];

export function SessionFields(props: HostEditorFields): React.JSX.Element {
  const c = connection(props), session = c.session ?? {}, environment = session.environment ?? [];
  const update = (patch: Partial<typeof session>) => change(props, { session: { ...session, ...patch } });
  return <><h3>人工会话启动设置</h3><p>命令和环境变量在打开人工终端时再次确认；AI 连接、连接测试和 AI 专用终端不会执行它们。</p>
    <label>默认目录<input maxLength={4096} value={session.directory ?? ''} onChange={(event) => update({ directory: event.target.value || undefined })} placeholder="登录目录；支持 /srv/app 或 ~/work" /></label>
    <label>初始化命令<textarea rows={4} maxLength={8192} value={session.initialization ?? ''} onChange={(event) => update({ initialization: event.target.value || undefined })} placeholder="仅在确认后，本次人工 Shell 启动时执行一次" /></label>
    <label>自定义保活命令<textarea rows={2} maxLength={2048} value={session.keepaliveCommand ?? ''} onChange={(event) => update({ keepaliveCommand: event.target.value || undefined, keepaliveIntervalMs: session.keepaliveIntervalMs ?? 30000 })} placeholder="留空不执行；通常无需设置，优先使用协议心跳" /></label>
    <label>自定义保活周期（秒）<NumberInput required min={10} max={3600} disabled={!session.keepaliveCommand?.trim()} value={(session.keepaliveIntervalMs ?? 30000) / 1000} onValueChange={(value) => update({ keepaliveIntervalMs: value * 1000 })} /></label>
    <small>保活使用独立非 PTY 通道与配置目录／变量，不向前台程序输入；AI 工作或未决操作期间暂停。失败、超时或结果未知后停止，不自动重试。</small>
    <h4>环境变量</h4><p>仅用于人工会话，不是密码、Token 或 Cookie 的存储入口。</p>
    {environment.map((item, index) => <div className={styles.environment} key={index}>
      <input aria-label={`环境变量名称 ${index + 1}`} required pattern="[A-Za-z_][A-Za-z0-9_]*" maxLength={128} value={item.name} placeholder="LANG"
        onChange={(event) => update({ environment: environment.map((value, i) => i === index ? { ...value, name: event.target.value } : value) })} />
      <input aria-label={`环境变量值 ${index + 1}`} maxLength={4096} value={item.value} placeholder="C.UTF-8"
        onChange={(event) => update({ environment: environment.map((value, i) => i === index ? { ...value, value: event.target.value } : value) })} />
      <button type="button" aria-label={`移除环境变量 ${index + 1}`} onClick={() => update({ environment: environment.filter((_value, i) => i !== index) })}>移除</button>
    </div>)}<button type="button" disabled={environment.length >= 64} onClick={() => update({ environment: [...environment, { name: '', value: '' }] })}>添加环境变量</button>
  </>;
}
