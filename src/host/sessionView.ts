/** Read-only, human-facing projection. Never changes protocol state or invents work. */
import { asRecord } from './json.js'

export type ViewRow = Record<string, unknown>
export interface SessionViewContext {
  request?: string
  latestRequest?: string
  goal?: string
  calls: Map<string, { name: string; args: ViewRow }>
  todos: readonly ViewRow[]
  turnRequests: Map<number, string>
}

export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

const GENERATED = /^(?:DSH session .+ (?:tool|plan) work|task \d+ completes|dsh-session|dsh-goal(?::|$))/i
const INTERNAL = /^(?:time sampled while preparing turn|elapsed since|current runtime context|AMP binding:|items excluded by|\[model changed:|<system-reminder|<skill_content|<amp_attention|ProcessId\s*:|started background job)/i
export function meaningful(value: unknown): string | undefined {
  const result = text(value)
  if (!result || INTERNAL.test(result) || GENERATED.test(result) || /^(?:dsh:|turn:session-|session-[0-9a-f-]{30,}$)/i.test(result)) return undefined
  return result
}

export function humanMessage(value: unknown): string | undefined {
  const message = asRecord(value)
  const source = asRecord(message?.source)
  // Synthetic context can have the user role; only the declared human source qualifies.
  if (source?.kind !== undefined && source.kind !== 'user') return undefined
  const content = Array.isArray(message?.content) ? message.content : []
  const result = content.map(asRecord).filter((block) => block?.type === 'text')
    .map((block) => text(block?.text) ?? '').filter((part) => part && !INTERNAL.test(part)).join('\n').trim()
  return meaningful(result)
}

function argumentsOf(value: unknown): ViewRow {
  if (typeof value !== 'string') return asRecord(value) ?? {}
  try { return asRecord(JSON.parse(value)) ?? {} } catch { return {} }
}

export function sessionContext(messages: readonly unknown[], goal?: string): SessionViewContext {
  const context: SessionViewContext = { goal: meaningful(goal), calls: new Map(), todos: [], turnRequests: new Map() }
  for (const raw of messages) {
    const message = asRecord(raw)
    if (message?.role === 'user') {
      const request = humanMessage(message)
      if (request) { context.request ??= request; context.latestRequest = request }
    }
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const block of message.content.map(asRecord)) {
      if (block?.type !== 'tool-call' || !text(block.id) || !text(block.name)) continue
      const args = argumentsOf(block.arguments)
      context.calls.set(String(block.id), { name: String(block.name), args })
      if (block.name === 'todo_write' && Array.isArray(args.todos)) context.todos = args.todos.map(asRecord).filter((v): v is ViewRow => v !== undefined)
    }
  }
  return context
}

/** Maintain labels from events that have not reached a derived history snapshot yet. */
export function observeView(context: SessionViewContext, type: string, data: ViewRow): void {
  if (type === 'user/message') {
    const request = humanMessage(data)
    if (request) {
      context.request ??= request
      context.latestRequest = request
      if (typeof data.turn === 'number') context.turnRequests.set(data.turn, request)
    }
  }
  if (type === 'todo/write' && Array.isArray(data.todos)) context.todos = data.todos.map(asRecord).filter((v): v is ViewRow => v !== undefined)
  if (type === 'tool/call' && text(data.callId) && text(data.name)) context.calls.set(String(data.callId), { name: String(data.name), args: argumentsOf(data.arguments) })
}

const TOOL_LABELS: Record<string, string> = {
  read: '读取文件', read_image: '查看图片', write: '写入文件', edit: '修改文件', glob: '查找文件', grep: '搜索文件内容',
  pwsh: '运行命令', web_search: '搜索网页', web_fetch: '读取网页', todo_write: '更新待办计划',
  'workspace.read': '读取工作区文件', 'workspace.write': '修改工作区文件', 'workspace.list': '查看工作区文件',
  'workspace.outline': '查看文件大纲', 'workspace.diff': '比较文件差异', 'workspace.document_outline': '查看文档大纲',
  'session.get': '查看会话信息', 'session.list': '查看会话列表', 'session.report_status': '汇报会话进展',
  'turn.current': '查看本轮请求', 'turn.respond': '回复用户', 'turn.report': '汇报本轮进展', 'turn.clarify': '澄清本轮请求',
  'goal.get': '查看目标', 'goal.list': '查看目标列表', 'goal.submit_evidence': '提交验收证据', 'mission.get': '查看使命',
  'plan.get': '查看计划', 'plan.list': '查看计划列表', 'plan.ready_tasks': '查看可执行任务', 'plan.propose_draft': '提交计划草案',
  'task.get': '查看任务', 'task.list_ready': '查看就绪任务', 'task.report_progress': '汇报任务进展',
  'action.get': '查看执行动作', 'action.list': '查看动作列表', 'attention.context': '读取本轮上下文', 'attention.get': '查看注意力条目',
  'attention.request_focus': '请求关注事项', 'execution.run': '执行工具', 'execution.find_tools': '查找工具', 'execution.inspect_tool': '查看工具说明',
  'execution.read_handle': '读取执行结果', 'budget.remaining': '查看剩余预算', 'evidence.list': '查看证据列表', 'evidence.get': '查看证据', 'evidence.cite': '引用证据',
  'cooperation.inbox': '查看协作消息', 'cooperation.send': '发送协作消息', 'cooperation.report_result': '汇报协作结果',
  'project.metadata': '查看项目信息', 'project.rules': '读取项目规则', 'project.environment': '查看项目环境',
  attention_manifest_protocol_discover: '发现协议能力', coordination_notification: '发送界面通知',
}

export function describeCall(name: string, raw: ViewRow = {}): { title: string; detail?: string } {
  const short = name.replace(/^tool:/, '').replace(/^attention_manifest_protocol_/, '')
  const verb = text(raw.verb)
  const key = verb && !short.includes('.') ? `${short}.${verb}` : short
  const args = asRecord(raw.arguments) ?? raw
  const description = meaningful(args.description) ?? meaningful(args.summary)
  const target = text(args.file_path) ?? text(args.path) ?? text(args.query) ?? text(args.q)
  const title = description ?? TOOL_LABELS[key] ?? TOOL_LABELS[name] ?? '执行工具操作（未提供说明）'
  return { title, ...(target ? { detail: target } : {}) }
}

export interface SessionListItem {
  id: string
  kind: string
  title: string
  state?: string
  detail?: string
  at?: string
  diagnostic?: boolean
  raw: ViewRow
}

const LABELS: Record<string, string> = {
  session: '会话', turn: '轮次', intent: '意图', mission: '使命', goal: '目标', plan: '计划', task: '任务',
  action: '动作', action_attempt: '动作尝试', attention: '关注事项', evidence: '证据', profession: '职业配置',
}

export function projectSessionLists(groups: Record<string, readonly ViewRow[]>, context: SessionViewContext): Record<string, SessionListItem[]> {
  const result: Record<string, SessionListItem[]> = {}
  const byId = new Map<string, ViewRow>()
  for (const rows of Object.values(groups)) for (const row of rows) {
    const id = text(row.id) ?? text(row.attemptId)
    if (id) byId.set(id, row)
  }
  const linked = (id: unknown): ViewRow => byId.get(text(id) ?? '') ?? {}
  const objective = (row: ViewRow): string | undefined => meaningful(row.objective) ?? meaningful(row.title) ?? meaningful(row.summary)
    ?? (Array.isArray(row.acceptanceCriteria) ? row.acceptanceCriteria.map(meaningful).find(Boolean) : undefined)
  const missionText = (row: ViewRow): string | undefined => objective(row) ?? meaningful(linked(row.intentId).text)
  const goalText = (row: ViewRow): string | undefined => objective(row) ?? missionText(linked(row.missionId))
  for (const [kind, rows] of Object.entries(groups)) {
    const projected: SessionListItem[] = []
    for (const row of rows) {
      const id = text(row.id) ?? text(row.attemptId)
      if (!id) continue
      let title = `${LABELS[kind] ?? '记录'}：未记录具体说明`
      let detail: string | undefined
      let diagnostic = false
      const state = text(row.state) ?? text(row.status) ?? text(row.validity) ?? (kind === 'attention' ? row.stale === true ? 'stale' : row.mounted === true ? 'mounted' : 'unmounted' : undefined)
      const at = text(row.updatedAt) ?? text(row.settledAt) ?? text(row.createdAt) ?? text(row.startedAt)
      switch (kind) {
        case 'session':
          title = context.request ?? '本会话尚未记录用户请求'
          detail = '会话最初请求'
          break
        case 'intent':
          title = meaningful(row.text) ?? context.request ?? title
          if (!meaningful(row.text) && context.request) detail = '来自会话最初请求；原意图记录为自动占位内容'
          break
        case 'goal':
          title = goalText(row) ?? context.goal ?? context.request ?? title
          if (!goalText(row)) detail = context.goal ? '来自宿主目标' : context.request ? '来自会话请求；协议目标未记录详细说明' : undefined
          break
        case 'mission':
          title = missionText(row) ?? context.request ?? title
          if (!missionText(row) && context.request) detail = '来自会话请求；使命记录未附说明'
          break
        case 'plan': {
          const parent = goalText(linked(row.goalId)) ?? context.goal ?? context.request
          const tasks = (groups.task ?? []).filter((task) => task.planId === id)
          title = objective(row) ?? (parent ? `执行计划：${parent}` : '执行计划（未记录目标说明）')
          detail = `${tasks.length} 项任务；${tasks.filter((task) => task.state === 'completed').length} 项已验收完成`
          break
        }
        case 'task': {
          const todoMatch = id.match(/:todos:.*:(\d+)$/)
          const todo = todoMatch ? context.todos[Number(todoMatch[1])] : undefined
          const effects = Array.isArray(row.requiredEffects) ? row.requiredEffects.map(meaningful).filter(Boolean).join('；') : undefined
          title = meaningful(row.title) ?? meaningful(todo?.content) ?? meaningful(row.summary) ?? effects ?? title
          if (!meaningful(title) || title === '') title = `${LABELS[kind]}：未记录具体说明`
          if (id.startsWith('dsh:task:tools:')) {
            const parent = goalText(linked(linked(row.planId).goalId)) ?? context.request
            title = parent ? `执行会话请求：${parent}` : '执行工具任务（未记录任务说明）'
          }
          if (todo?.status === 'completed' && row.state !== 'completed') detail = '待办已标记完成；AMP 验收尚未完成'
          break
        }
        case 'action':
        case 'action_attempt': {
          const action = kind === 'action_attempt' ? linked(row.actionId) : row
          const callId = String(action.id ?? '').replace(/^dsh:action:/, '')
          const call = context.calls.get(callId)
          const described = describeCall(call?.name ?? String(action.effect ?? ''), call?.args)
          title = described.title
          detail = described.detail
          if (kind === 'action_attempt') detail = [detail, '执行尝试'].filter(Boolean).join(' · ')
          break
        }
        case 'turn': {
          const number = id.match(/:(\d+)$/)?.[1]
          const request = number ? context.turnRequests.get(Number(number)) : undefined
          title = number ? `第 ${number} 轮对话` : '会话轮次'
          if (request) detail = request
          break
        }
        case 'evidence':
          title = meaningful(row.claim) ?? title
          detail = row.polarity === 'supports' ? '支持结论的证据' : row.polarity === 'refutes' ? '反驳结论的证据' : undefined
          break
        case 'profession':
          title = meaningful(row.name) ?? title
          detail = meaningful(row.summary)
          break
        case 'attention': {
          const pointer = asRecord(row.pointer)
          const source = text(pointer?.kind) ?? ''
          const summary = text(row.summary) ?? ''
          diagnostic = ['tool', 'debug', 'trace'].includes(source) || INTERNAL.test(summary)
          if (source === 'workspace' || summary.startsWith('workspace:')) {
            title = '当前工作区'
            detail = summary.replace(/^workspace:\s*/i, '')
            diagnostic = false
          } else if (diagnostic) {
            title = source === 'tool' ? '工具执行回显（技术记录）' : '系统注入上下文（技术记录）'
            detail = '保留原始记录，默认收起'
          } else {
            title = meaningful(summary) ?? '关注事项：未记录可读摘要'
            detail = ({ prompt: '用户请求上下文', goal: '目标上下文', plan: '计划上下文' } as Record<string, string>)[source]
          }
          break
        }
      }
      projected.push({ id, kind, title, state, detail, at, diagnostic, raw: row })
    }
    result[kind] = projected.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
  }
  return result
}
