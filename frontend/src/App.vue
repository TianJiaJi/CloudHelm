<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import * as echarts from 'echarts'
import { Activity, AlertTriangle, Bot, CheckCircle2, ChevronRight, CloudCog, Gauge, LockKeyhole, RefreshCw, Rocket, Settings2, ShieldAlert, Terminal, Zap } from 'lucide-vue-next'
import { ElMessage, ElMessageBox } from 'element-plus'

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
// Escape first, then apply our own markup: AI/agent text is never trusted as HTML.
const renderMarkdown = (text) => escapeHtml(text)
  .replace(/^#{1,3}\s*(.+)$/gm, '<strong class="md-h">$1</strong>')
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/^-\s+(.+)$/gm, '<span class="md-li">• $1</span>')

const api = async (path, options = {}) => { const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options }); const data = await response.json(); if (!response.ok) throw new Error(data.detail || data.message || '请求失败'); if (data && data.mode) lastMode = data.mode; return data }
let lastMode = null
const metrics = ref({ qps: 0, latency_ms: 0, error_rate: 0, ready_pods: 0, total_pods: 0, traffic: [] })
const health = ref({ k8s_connected: false }); const pipeline = ref(null)
const deltas = ref({ qps: null, latency_ms: null, error_rate: null })
const pods = ref([]); const logs = ref([]); const messages = ref([]); const question = ref(''); const busy = ref(''); const demoFallback = ref(true); const chart = ref(null); let chartInstance; let refreshTimer; let logSocket; let reconnectTimer
const modeLabel = computed(() => {
  if (demoFallback.value) return '演示后备已开启'
  return health.value.k8s_connected ? '真实集群模式' : '后备已关闭 · 未连接集群'
})
const actionButtons = [{ key: 'deploy', label: '一键部署', icon: Rocket }, { key: 'scale', label: '弹性扩容', icon: Zap }, { key: 'load', label: '压测演练', icon: Gauge }, { key: 'chaos', label: '故障注入', icon: ShieldAlert, danger: true }, { key: 'rollback', label: '一键回滚', icon: RefreshCw }, { key: 'diagnostics', label: '故障排查', icon: Activity }, { key: 'circuit', label: '熔断降级', icon: ShieldAlert, danger: true }, { key: 'ai', label: '更新 AI 服务', icon: Bot }]
function computeDeltas(prev, next) {
  const out = {}
  for (const key of ['qps', 'latency_ms', 'error_rate']) {
    const a = prev?.[key], b = next?.[key]
    out[key] = typeof a === 'number' && typeof b === 'number' && a !== 0 ? ((b - a) / a) * 100 : null
  }
  return out
}
// Trend arrows are derived from the previous poll instead of being hard-coded,
// so they never state a change that did not happen.
const trends = computed(() => {
  const build = (key, upIsGood) => {
    const d = deltas.value[key]
    if (d === null || d === undefined) return { text: '—', cls: 'flat' }
    return { text: `${d >= 0 ? '↑' : '↓'} ${Math.abs(d).toFixed(2)}%`, cls: (upIsGood ? d >= 0 : d <= 0) ? 'good' : 'bad' }
  }
  return { qps: build('qps', true), latency: build('latency_ms', false), error: build('error_rate', false) }
})

async function clearLogs() {
  try {
    await api('/api/logs', { method: 'DELETE' })
    logs.value = []
    ElMessage.success('日志已清空')
  } catch (error) {
    ElMessage.error(error.message)
  }
}

async function refresh() { try { const [h, m, p, l, s, ci] = await Promise.all([api('/api/health'), api('/api/metrics'), api('/api/pods'), api('/api/logs'), api('/api/settings'), api('/api/pipeline')]); health.value = h; pipeline.value = ci; deltas.value = computeDeltas(metrics.value, m); metrics.value = m; pods.value = p.items; logs.value = l.items; demoFallback.value = s.demo_fallback; await nextTick(); renderChart(m.traffic) } catch (error) { ElMessage.error(error.message) } }
function renderChart(values) { if (!chart.value) return; chartInstance ||= echarts.init(chart.value); chartInstance.setOption({ animationDuration: 500, grid: { left: 8, right: 12, top: 18, bottom: 4, containLabel: true }, xAxis: { type: 'category', boundaryGap: false, data: values.map((_, i) => `${i * 2}s`), axisLine: { lineStyle: { color: '#334155' } }, axisLabel: { color: '#718096' } }, yAxis: { type: 'value', splitLine: { lineStyle: { color: '#1e293b' } }, axisLabel: { color: '#718096' } }, series: [{ data: values, type: 'line', smooth: true, symbol: 'none', lineStyle: { color: '#38bdf8', width: 3 }, areaStyle: { color: 'rgba(56,189,248,.12)' } }] }) }
async function run(key) { if (busy.value) return; busy.value = key; lastMode = null; try { if (key === 'scale') { const { value } = await ElMessageBox.prompt('输入目标副本数（1-20）', '弹性扩容', { inputValue: '3', inputPattern: /^([1-9]|1[0-9]|20)$/, inputErrorMessage: '请输入 1-20' }); const result = await api('/api/scale', { method: 'POST', body: JSON.stringify({ deployment: 'guide-service', replicas: Number(value) }) }); await approve(result.action_id) } else if (key === 'chaos') { const pod = pods.value.find(p => p.deployment === 'guide-service'); if (!pod) throw new Error('没有可注入的导览服务 Pod'); await ElMessageBox.confirm(`将删除 ${pod.name} 并触发自愈，是否继续？`, '高风险操作确认', { type: 'warning', confirmButtonText: '确认注入', cancelButtonText: '取消' }); const result = await api('/api/chaos/kill', { method: 'POST', body: JSON.stringify({ pod_name: pod.name }) }); await approve(result.action_id) } else if (key === 'load') await api('/api/load-test', { method: 'POST' }); else if (key === 'rollback') await api('/api/rollback', { method: 'POST' }); else if (key === 'diagnostics') await api('/api/diagnostics'); else if (key === 'circuit') { await api('/api/circuit-breaker', { method: 'POST' }); setTimeout(() => api('/api/circuit-breaker/recover', { method: 'POST' }), 3500) } else if (key === 'ai') { const result = await api('/api/ai/update', { method: 'POST', body: JSON.stringify({ deployment: 'ai-agent', image: 'cloudhelm/ai-agent:demo' }) }); await approve(result.action_id) } else await api('/api/deploy', { method: 'POST' }); ElMessage.success(lastMode === 'live' ? '真实执行完成' : '演示执行完成（未变更真实集群）'); await refresh() } catch (error) { if (error !== 'cancel' && error?.message !== 'cancel') ElMessage.error(error.message) } finally { busy.value = '' } }
async function approve(actionId) { const confirmed = await ElMessageBox.confirm('安全策略要求对该动作进行最终确认。', '审批高风险动作', { type: 'warning', confirmButtonText: '批准执行', cancelButtonText: '拒绝' }).then(() => true).catch(() => false); await api('/api/agent/approve', { method: 'POST', body: JSON.stringify({ action_id: actionId, approved: confirmed }) }); await refresh() }
async function ask(text = question.value) { if (!text.trim() || busy.value) return; busy.value = 'chat'; messages.value.push({ role: 'user', text }); question.value = ''; try { const result = await api('/api/ai/chat', { method: 'POST', body: JSON.stringify({ question: text }) }); messages.value.push({ role: 'ai', text: result.answer, severity: result.severity, action: result.suggested_action }) } catch (error) { ElMessage.error(error.message) } finally { busy.value = '' } }
async function toggleFallback() { const previous = demoFallback.value; demoFallback.value = !previous; try { await api('/api/settings', { method: 'PUT', body: JSON.stringify({ demo_fallback: demoFallback.value }) }); ElMessage.info(modeLabel.value) } catch (error) { demoFallback.value = previous; ElMessage.error(error.message) } }
function connectLogs() { if (logSocket) return; logSocket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/logs/ws`); logSocket.onmessage = event => { logs.value.unshift(JSON.parse(event.data)); logs.value = logs.value.slice(0, 80) }; logSocket.onclose = () => { logSocket = null; reconnectTimer = setTimeout(connectLogs, 3000) } }
onMounted(() => { refresh(); refreshTimer = setInterval(refresh, 2000); connectLogs(); window.addEventListener('resize', () => chartInstance?.resize()) })
onUnmounted(() => { clearInterval(refreshTimer); clearTimeout(reconnectTimer); logSocket?.close(); chartInstance?.dispose() })
</script>

<template>
  <main class="shell">
    <header class="topbar"><div class="brand"><div class="brand-mark"><CloudCog :size="22" /></div><div><strong>CloudHelm</strong><span>运维作战室 / 景区智慧导览</span></div></div><div class="top-actions"><span class="connection"><i></i> 控制面已连接</span><button class="mode-toggle" @click="toggleFallback"><Settings2 :size="15" /> {{ modeLabel }}</button></div></header>
    <section class="hero"><div><p class="eyebrow">OPERATIONS COMMAND CENTER</p><h1>让集群状态一眼可见</h1><p class="subhead">实时掌控服务健康、发布节奏和故障恢复。所有高风险动作都经过审批。</p></div><div class="hero-status"><span>集群状态</span><b><i></i> {{ health.k8s_connected ? 'LIVE' : 'DEMO' }}</b><small>{{ health.k8s_connected ? 'k3s 实时集群' : '未连接集群，演示后备' }} / {{ metrics.ready_pods }} 个就绪 Pod</small></div></section>
    <section v-if="pipeline" class="pipeline-strip"><div><span class="pipeline-dot"></span><strong>CI/CD · {{ pipeline.branch }}</strong><small>commit {{ pipeline.commit }}</small></div><div class="pipeline-tests"><CheckCircle2 :size="15" /> 测试 {{ pipeline.tests.passed }} 通过 / {{ pipeline.tests.failed }} 失败</div><span class="pipeline-state">{{ pipeline.status.toUpperCase() }} · {{ pipeline.mode.toUpperCase() }} 模拟</span></section>
    <section class="metrics-grid"><article class="metric-card"><div class="metric-label"><Activity :size="16" />实时 QPS</div><strong>{{ metrics.qps.toLocaleString() }}</strong><span class="trend" :class="trends.qps.cls">{{ trends.qps.text }}</span></article><article class="metric-card"><div class="metric-label"><RefreshCw :size="16" />平均响应</div><strong>{{ metrics.latency_ms }}<em>ms</em></strong><span class="trend" :class="trends.latency.cls">{{ trends.latency.text }}</span></article><article class="metric-card"><div class="metric-label"><ShieldAlert :size="16" />错误率</div><strong>{{ metrics.error_rate }}<em>%</em></strong><span class="trend" :class="trends.error.cls">{{ trends.error.text }}</span></article><article class="metric-card"><div class="metric-label"><Terminal :size="16" />就绪实例</div><strong>{{ metrics.ready_pods }}<em>/ {{ metrics.total_pods }}</em></strong><span class="trend good">运行正常</span></article></section>
    <section class="main-grid"><div class="panel chart-panel"><div class="panel-heading"><div><p class="eyebrow">TRAFFIC OVERVIEW</p><h2>流量趋势</h2></div><span class="live-pill"><i></i> 每 2 秒更新</span></div><div ref="chart" class="chart"></div></div><div class="panel pods-panel"><div class="panel-heading"><div><p class="eyebrow">SERVICE HEALTH</p><h2>服务状态</h2></div><span class="count">{{ pods.length }} services</span></div><div class="pod-list"><div v-for="pod in pods" :key="pod.name" class="pod-row" :class="{ down: !pod.ready }"><div class="pod-icon"><component :is="pod.ready ? CheckCircle2 : AlertTriangle" :size="17" /></div><div class="pod-info"><strong>{{ pod.deployment }}</strong><span>{{ pod.name }}</span></div><span class="pod-status">{{ pod.status }}</span></div></div></div></section>
    <section class="panel controls"><div class="panel-heading"><div><p class="eyebrow">COMMAND DECK</p><h2>运维控制台</h2></div><span class="security-note"><LockKeyhole :size="14" /> AI 操作受安全策略保护</span></div><div class="action-grid"><button v-for="item in actionButtons" :key="item.key" :class="['action-btn', { danger: item.danger }]" :disabled="!!busy" @click="run(item.key)"><component :is="item.icon" :size="19" /><span>{{ busy === item.key ? '执行中...' : item.label }}</span><ChevronRight :size="16" /></button></div></section>
    <section class="lower-grid"><div class="panel assistant"><div class="panel-heading"><div><p class="eyebrow">AI OPERATIONS AGENT</p><h2><Bot :size="20" /> 运维助手</h2></div><span class="agent-badge">安全模式</span></div><div class="quick-asks"><button @click="ask('请分析当前系统健康度')">健康度分析</button><button @click="ask('当前系统有什么瓶颈？')">瓶颈分析</button><button @click="ask('帮我排查故障')">故障排查</button><button @click="ask('生成一份运维报告')">生成报告</button></div><div class="messages"><div v-for="(message, index) in messages" :key="index" :class="['message', message.role]"><span class="message-avatar">{{ message.role === 'ai' ? 'AI' : '我' }}</span><div class="bubble" v-html="renderMarkdown(message.text)"></div><button v-if="message.action" class="suggestion" @click="approve(message.action.action_id)">{{ message.action.label }} · 需要确认</button></div><div v-if="!messages.length" class="empty-state">向助手询问系统健康度、瓶颈、故障排查或生成运维报告</div></div><form class="chat-form" @submit.prevent="ask()"><input v-model="question" placeholder="输入运维问题..." /><button aria-label="发送"><ChevronRight :size="18" /></button></form></div><div class="panel logs"><div class="panel-heading"><div><p class="eyebrow">EVENT STREAM</p><h2>实时操作日志</h2></div><div class="log-actions"><span class="live-pill"><i></i> LIVE</span><button class="clear-logs" @click="clearLogs">清空日志</button></div></div><div class="log-list"><div v-for="log in logs" :key="log.id" class="log-line"><time>{{ new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour12: false }) }}</time><b :class="log.level.toLowerCase()">{{ log.level }}</b><span>{{ log.message }}</span></div></div></div></section>
  </main>
</template>
