import { Type, type Static, type TSchema } from 'typebox';

// Keep literal tuples: TypeBox's static union inference cannot recover a tuple
// from Array.map(), even when the runtime schema produced by that map is valid.
const hostKey = Type.Union([Type.Literal('ssh-ed25519'), Type.Literal('ecdsa-sha2-nistp256'), Type.Literal('ecdsa-sha2-nistp384'),
  Type.Literal('ecdsa-sha2-nistp521'), Type.Literal('rsa-sha2-512'), Type.Literal('rsa-sha2-256'), Type.Literal('ssh-rsa')]);
const cipher = Type.Union([Type.Literal('aes128-gcm@openssh.com'), Type.Literal('aes256-gcm@openssh.com'), Type.Literal('chacha20-poly1305@openssh.com'),
  Type.Literal('aes128-ctr'), Type.Literal('aes192-ctr'), Type.Literal('aes256-ctr')]);
const kex = Type.Union([Type.Literal('curve25519-sha256'), Type.Literal('curve25519-sha256@libssh.org'), Type.Literal('ecdh-sha2-nistp256'),
  Type.Literal('ecdh-sha2-nistp384'), Type.Literal('ecdh-sha2-nistp521'), Type.Literal('diffie-hellman-group-exchange-sha256'),
  Type.Literal('diffie-hellman-group14-sha256'), Type.Literal('diffie-hellman-group16-sha512'), Type.Literal('diffie-hellman-group18-sha512')]);
export const SSH_ALGORITHM_CHOICES = { hostKey: hostKey.anyOf.map((item) => item.const), cipher: cipher.anyOf.map((item) => item.const), kex: kex.anyOf.map((item) => item.const) };
const algorithms = <T extends TSchema>(schema: T) => Type.Optional(Type.Array(schema, { minItems: 1, maxItems: 20, uniqueItems: true }));
const cleanString = (maxLength: number) => Type.String({ maxLength, pattern: '^[^\\u0000-\\u001f\\u007f]*$' });
export const SshConnectionSettingsSchema = Type.Object({
  version: Type.Literal(1),
  authOrder: Type.Optional(Type.Array(Type.Union([Type.Literal('private-key'), Type.Literal('password'), Type.Literal('keyboard-interactive')]), { minItems: 1, maxItems: 3, uniqueItems: true })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 300_000 })),
  keepaliveIntervalMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 300_000 })),
  keepaliveCountMax: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  proxy: Type.Optional(Type.Object({ enabled: Type.Boolean(), protocol: Type.Union([Type.Literal('http'), Type.Literal('https'), Type.Literal('socks5')]),
    address: Type.String({ minLength: 1, maxLength: 255, pattern: '^[a-zA-Z0-9._:\\[\\]-]+$' }), port: Type.Integer({ minimum: 1, maximum: 65535 }),
    username: Type.Optional(cleanString(128)) }, { additionalProperties: false })),
  algorithms: Type.Optional(Type.Object({ hostKey: algorithms(hostKey), cipher: algorithms(cipher), kex: algorithms(kex) }, { additionalProperties: false })),
  terminal: Type.Optional(Type.Object({
    encoding: Type.Optional(Type.Union([Type.Literal('utf8'), Type.Literal('gb18030'), Type.Literal('gbk'), Type.Literal('big5'), Type.Literal('shift_jis'), Type.Literal('windows-1252'), Type.Literal('latin1')])),
    term: Type.Optional(Type.String({ minLength: 1, maxLength: 80, pattern: '^[a-zA-Z0-9._+-]+$' }))
  }, { additionalProperties: false })),
  files: Type.Optional(Type.Object({ watch: Type.Optional(Type.Boolean()), followCwd: Type.Optional(Type.Boolean()) }, { additionalProperties: false })),
  x11: Type.Optional(Type.Object({ enabled: Type.Boolean(), display: Type.Integer({ minimum: 0, maximum: 59535 }), screen: Type.Integer({ minimum: 0, maximum: 255 }),
    cookie: Type.Union([Type.Literal('auto'), Type.Literal('manual'), Type.Literal('none')]) }, { additionalProperties: false })),
  session: Type.Optional(Type.Object({ directory: Type.Optional(cleanString(4096)),
    initialization: Type.Optional(Type.String({ maxLength: 8192, pattern: '^[^\\u0000]*$' })),
    keepaliveCommand: Type.Optional(Type.String({ maxLength: 2048, pattern: '^[^\\u0000]*$' })),
    keepaliveIntervalMs: Type.Optional(Type.Integer({ minimum: 10_000, maximum: 3_600_000 })),
    environment: Type.Optional(Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }),
      value: cleanString(4096) }, { additionalProperties: false }), { maxItems: 64 }))
  }, { additionalProperties: false }))
}, { additionalProperties: false });
export type SshConnectionSettings = Static<typeof SshConnectionSettingsSchema>;

/** undefined preserves a matching saved credential; null explicitly removes it. */
const secret = Type.Optional(Type.Union([Type.String({ maxLength: 4096 }), Type.Null()]));
export const HostCredentialsPatchSchema = Type.Object({ password: secret, passphrase: secret, proxyPassword: secret,
  x11Cookie: Type.Optional(Type.Union([Type.String({ pattern: '^[a-fA-F0-9]{32}$' }), Type.Null()])) }, { additionalProperties: false });
export type HostCredentialsPatch = Static<typeof HostCredentialsPatchSchema>;
export interface HostCredentials { password?: string; passphrase?: string; proxyPassword?: string; x11Cookie?: string }

/** Called at the trusted IPC boundary, in addition to structural validation. */
export function validateHostConnectionSettings(host: { auth: string; privateKeyPath?: string; connection?: SshConnectionSettings }): void {
  if (host.auth === 'agent') throw new Error('SSH Agent 已停用；请选择密码或私钥认证并重新保存主机');
  if (host.auth === 'private-key' && !host.privateKeyPath?.trim()) throw new Error('请选择 SSH 私钥文件');
  if (host.connection?.authOrder?.includes('private-key') && !host.privateKeyPath?.trim()) throw new Error('认证顺序包含私钥时必须选择私钥文件');
  const environment = host.connection?.session?.environment ?? [];
  if (new Set(environment.map(({ name }) => name)).size !== environment.length) throw new Error('环境变量名称不能重复');
  if (environment.some(({ name }) => name.startsWith('CLOUDHELM_'))) throw new Error('CLOUDHELM_ 前缀保留给终端集成，请使用其他环境变量名');
  if (environment.some(({ name }) => /password|passwd|passphrase|secret|token|cookie|credential|api_?key/iu.test(name))) throw new Error('秘密不能保存在普通环境变量中，请使用专用凭据输入');
  if (host.connection?.session?.keepaliveCommand?.trim() && !host.connection.session.keepaliveIntervalMs) throw new Error('请设置自定义保活命令的执行周期');
}
