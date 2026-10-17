# DeepSeek Coordination 插件完整设计文档 v23

> 本文档是 DeepSeek Coordination 插件的唯一权威规格。任何 Agent、开发者、集成方在理解或实现本插件时，必须以本文档为准。如发现文档与实际行为不一致，以本文档为准，并修正实现。禁止基于文档之外的内容自行推断。

DeepSeek Harness (DSH) 的核心设计哲学是“一切皆插件”。DeepSeek Coordination 插件通过 Cordis 标准扩展点接入 DSH。

**本版核心变更：** 引入 **Agent 职能锁定（Profession Lock）**。Agent 可以在跨任务之间切换自己的职能，但在一次任务当中职能只能有一个，中途不能切换。唯一的例外是重建任务（rebuild）或丢弃任务（abandon）——此时职能可以重新选择。这条约束与“做工作的代理永远不能标记任务完成”同源：防止 agent 在任务中途“跳槽”到更轻松的职能，保证问责链清晰。

**v24 修订：** 情景（Scene）新增 `writing`（写作），位于“对话”与“办公”之间。写作场景强制要求大纲与修订轮次、必须有质量评分、不启用 bash、可选联网搜索。同时，验证档位 low/medium/high 三档都联网检索并做贝叶斯更新，差异仅在检索预算（1×3 / 2×5 / 4×8）与证据范围（当轮 / 当前会话 / 本地全部内容）；新增国际化（§22）。


## 第零章 · 命名规范（强制）

### 0.1 数据库 / 表 / 字段 / 函数 / 变量命名

| 规则 | 说明 |
|---|---|
| 完整英文单词 | 不能缩写 |
| 全小写 | 不能大写 |
| 单数形式 | 不能复数 |
| 无下划线 | 不能 `public_id` |
| 与关键字冲突 | 换近义词 |

**正例：** `identity`、`session`、`turn`、`prompt`、`command`、`goal`、`compact`、`profession`、`lock`、`locked`、`orchestration`、`subtask`、`recovery`、`verdict`、`acceptance`、`comprehension`、`organization`、`plan`、`predict`、`reality`、`action`、`answer`、`question`、`choice`、`error`、`pattern`、`calibration`、`lesson`、`rollback`、`score`、`resource`、`version`、`vision`、`grant`、`decision`、`handle`、`principal`、`fingerprint`、`emotion`、`companion`、`crisis`、`probe`、`cognition`、`evidence`、`constraint`、`gate`、`stopping`、`posterior`、`likelihood`、`fusion`、`refusal`、`directive`、`prior`、`boundary`、`prospect`、`provider`、`strategy`、`profile`、`cache`、`route`、`failure`、`validation`、`scene`、`history`、`rebuild`、`threshold`、`interaction`、`takeover`

**反例：** `sessions`、`req`、`public_id`、`created_at`、`ttl`

### 0.2 全局常量 / 类名命名

必须使用大写驼峰（PascalCase）。正例：`YearMonth`、`MaxThreads`、`DefaultTimeout`、`SessionManager`、`ResourceAdapter`、`PermissionClient`、`ErrorClassifier`、`CoordinationService`、`CacheOptimizer`、`BayesianEngine`、`ComprehensionEngine`、`OrganizationEngine`、`PlanScorer`、`TakeoverManager`、`ProfessionMatrix`、`ProfessionLock`、`GoalManager`、`CompactManager`、`ProviderView`、`OrchestrationEngine`、`AcceptanceGate`。反例：`MAX_THREADS`、`year_month`。

### 0.3 字段命名映射表

| 旧字段 | 新字段 | 理由 |
|---|---|---|
| `public_id` | `handle` | 无下划线 |
| `created_at` | `created` | 无下划线 |
| `updated_at` | `changed` | 无下划线 |
| `ended_at` | `ended` | 无下划线 |
| `started_at` | `started` | 无下划线 |
| `finished_at` | `finished` | 无下划线 |
| `expires_at` | `expired` | 无下划线 |
| `last_heartbeat` | `heartbeat` | 无下划线 |
| `worker_kind` | `engine` | 无下划线 |
| `worker_id` | `worker` | 无下划线 |
| `sandbox_root` | `sandbox` | 无下划线 |
| `session_identity` | `session` | 外键直接引用表名 |
| `ttl` | `lease` | 无缩写 |
| `mime_type` | `media` | 无下划线 |
| `created_by` | `author` | 无下划线 |
| `base_version` | `base` | 无下划线 |
| `current_version` | `current` | 无下划线 |
| `group_id` | `code` | 无下划线 |
| `file_views` | `vision` | 无下划线 |
| `reasoning_effort` | `effort` | 无下划线 |
| `workflow` | `scene` | 含义更广 |
| `quality` | `validation` | 语义更准 |
| `translation` | `comprehension` | 语义更准 |
| `interaction_form` | `interaction` | 语义更准 |
| `function_dimension` | `profession` | 语义更准 |

### 0.4 数据库命名

| 数据库 | 说明 |
|---|---|
| `coordination` | Coordination 插件专属 SQLite 数据库 |

### 0.5 应用层命名

接口 / 类 / 类型：大写驼峰。全局常量：大写驼峰。局部变量 / 函数 / 参数：小写驼峰，完整单词。禁止 `req`、`res`、`ctx`、`cfg`、`tmp`、`buf`、`str`、`num`、`obj`、`arr`、`fn`、`cb`。


## 第一章 · 插件定位

### 1.1 这是什么

DeepSeek Coordination 是 DeepSeek Harness (DSH) 的协调插件，作为 DSH 运行时中的 Cordis 插件树节点运行。本插件为 Agent 提供：多会话协调、输入命令、Goal 模块、Compact 模块、理解过程（Comprehension）、组织过程（Organization）、目标计划（Plan）及其评分与重建、**职能锁定（Profession Lock）**、统筹编排（Orchestration）、认知循环、响应管理、错误学习、通用评分、资源版本管理、权限服务、情感陪伴、启发引导、证据收束与贝叶斯推断、模型视图查询与缓存优化、窗体 UI 与接管。

### 1.2 这不是什么

不是 DSH 本身。不是 Agent 框架。不是工具。不是独立进程。不是品牌/模型的权威来源——品牌和模型的权威配置归 DSH 的 `ctx.llm` 与 `ctx.settings` 所有。本插件与 DSH 同进程运行，通过 Cordis 上下文通信。

### 1.3 关键边界

```text
Agent 可见：本插件通过 defineTool 注册的工具名、参数 schema、Result
Agent 不可见：coordination.db、identity、版本 DAG、锁表、权限表、审计、评分、先验、后验
DSH 可见：本插件注册的 Service、Tool、Event Listener、Settings Section、UI Slot、Takeover Slot
本插件不可见：DSH 内部实现、其他插件的内部状态
本插件只读：DSH ctx.llm（品牌/模型视图）
本插件不修改：DSH 的 provider 注册、模型 catalog、API key
```


## 第二章 · 插件架构

### 2.1 插件定义

```typescript
import type { Context } from '@deepseek-ai/cordis'

export const name = 'deepseek-coordination'
export const inject = ['tools', 'llm', 'agents', 'sessions']

export function apply(ctx: Context) {
  ctx.plugin(CoordinationService)
}
```

`inject` 声明插件需要哪些服务，Cordis 会让插件保持 PENDING 直到列出的每项服务都存在。`llm` 是核心依赖：没有 `ctx.llm`，Coordination 无法查询品牌/模型视图。

### 2.2 扩展点

| 扩展点 | 用途 | 机制 |
|---|---|---|
| Service | 向其他插件暴露协调能力 | 继承 `Service` 类，挂载到 `ctx.coordination` |
| Tool | 向 Agent 暴露协调工具 | `defineTool` + `ctx.tools.register()` |
| Event | 监听 DSH 生命周期事件 | `ctx.on()` / `ctx.waterfall()` |
| Effect | 管理需要清理的资源 | `ctx.effect()` |
| Config | 接受 `cordis.yml` 配置 | 导出 `Config` 类型 + Schemastery schema |
| Settings Section | 向 DSH 设置界面注入菜单页面 | `ctx.slots.inject('settings.section', ...)` |
| Input Toolbar | 向输入框工具栏注入控件 | `ctx.slots.inject('conversation.input.model', ...)` |
| Takeover Slot | 拦截 DSH 默认弹窗并渲染自有窗体 | `ctx.slots.inject('conversation.takeover', ...)` |

### 2.3 服务提供

```typescript
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    coordination: CoordinationService
  }
}

export default class CoordinationService extends Service {
  static inject = ['llm', 'tools', 'sessions']

  constructor(ctx: Context) {
    super(ctx, 'coordination')
  }

  // 职能锁定
  async selectProfession(turn: number, profession: Profession): Promise<Turn> { ... }
  async checkProfessionLock(turn: number): Promise<boolean> { ... }
  async rebuildTurn(turn: number, profession: Profession): Promise<Turn> { ... }
  async abandonTurn(turn: number): Promise<Turn> { ... }
  async rebuildSubTask(subtask: number, profession: Profession): Promise<SubTask> { ... }
  async abandonSubTask(subtask: number): Promise<SubTask> { ... }

  // 模型视图（只读，来自 DSH ctx.llm）
  async listProviderView(): Promise<ProviderView[]> { ... }
  async resolveProviderView(route: string): Promise<ProviderView> { ... }
  async listModelCapability(route: string): Promise<ModelCapability[]> { ... }

  // 统筹编排
  async orchestrate(turn: number): Promise<OrchestrationResult> { ... }
  async dispatch(subtask: SubTask): Promise<SubTask> { ... }
  async verify(subtask: number, verifier: string): Promise<SubTask> { ... }
  async recover(subtask: number, decision: RecoveryDecision): Promise<SubTask> { ... }

  // 理解与组织
  async comprehend(prompt: string): Promise<Comprehension> { ... }
  async organize(comprehension: number): Promise<Plan> { ... }
  async scorePlan(plan: number): Promise<Score[]> { ... }
  async rebuildPlan(plan: number): Promise<Plan> { ... }
}
```

### 2.4 工具注册

```typescript
ctx.tools.register(defineTool({
  name: 'coordination_comprehend',
  description: '理解用户提示词（四阶段过程）',
  parameters: {
    prompt: { type: 'string', required: true, description: '用户原始提示词' },
  },
  async execute(args, exec) {
    return this.comprehend(args.prompt)
  },
}))
```

### 2.5 事件监听

```typescript
ctx.on('agent/step', (step) => { /* ... */ })
ctx.waterfall('tools/pre-execute', async (call, next) => { return next() })

// 监听 DSH provider/模型变更，刷新本地视图缓存
ctx.on('llm/providers-changed', () => { /* invalidate provider view cache */ })
```

### 2.6 生命周期与自动清理

```typescript
export function apply(ctx: Context) {
  ctx.effect(() => {
    const timer = setInterval(() => {
      ctx.coordination.cleanupExpired()
    }, 60000)
    return () => clearInterval(timer)
  })
}
```

### 2.7 插件配置

```yaml
- id: coordination
  name: './src/coordination.ts'
  config:
    database: 'coordination'
    maxTurnPerSession: 1000
    defaultLease: 30000
    clarifyTimeout: 30000
    # 品牌/模型配置由 DSH Settings → Models 管理
```


## 第三章 · Agent 职能锁定（Profession Lock）

### 3.1 设计原则

> **Agent 可以在跨任务之间切换自己的职能，但在一次任务当中职能只能有一个，中途不能切换。**

这是本插件的**核心安全约束**，与“做工作的代理永远不能标记任务完成”同源。它防止三种失效模式：

| 失效模式 | 后果 | 锁定的防御 |
|---|---|---|
| 中途跳槽 | Agent 遇到困难时切换到更轻松的职能，推卸责任 | 任务内职能不可变 |
| 兼职多职 | Agent 同时承担执行和验收，产生自我批准 | 一个任务只有一个职能 |
| 职责稀释 | “都管、都不管”，问责链断裂 | 每个任务职能清晰可追溯 |

**“一次任务”的粒度：**

| 模式 | 任务粒度 | 职能锁定对象 |
|---|---|---|
| 非统筹模式 | Turn | `Turn.profession` |
| 统筹模式（父代理） | Turn | `Turn.profession` |
| 统筹模式（子代理） | SubTask | `SubTask.profession` |

**父代理和子代理是独立的 agent 实例，各自在自己的任务内锁定职能。** 同一 Turn 内的不同 SubTask 可以绑定不同职能（因为它们由不同子代理执行），但每个子代理在其 SubTask 内职能不可变。

### 3.2 职能定义

```typescript
type Profession =
  | 'decision'      // 决策：批准或否决
  | 'outcome'       // 成果：对最终交付负责
  | 'resource'      // 资源：对要素供给负责
  | 'personnel'     // 人员：对分配合规负责
  | 'qualification' // 任职：对资格门槛负责
  | 'execution'     // 执行：对按既定条件完成作业负责
```

Agent 在任务开始时从六维职能中选择**一个**，这个选择锁定整个任务。

### 3.3 锁定机制

**锁定时机：**

| 事件 | 锁定动作 |
|---|---|
| Turn 创建 | `Turn.profession` 被设置，`Turn.locked` = true |
| SubTask 派发 | `SubTask.profession` 被设置，`SubTask.locked` = true |

**锁定后的约束：**

| 约束 | 实现 |
|---|---|
| `profession` 字段不可修改 | 服务层校验 + SQLite 触发器 |
| 不允许切换到其他职能 | `selectProfession` 在 locked 状态下抛错 |
| 不允许清空职能 | `profession` 为 NOT NULL |
| 不允许“临时兼任” | 每次调用只检查一个职能 |

**服务层校验：**

```typescript
async function selectProfession(turn: number, profession: Profession): Promise<Turn> {
  const current = await getTurn(turn)

  // 已锁定 → 拒绝修改
  if (current.locked) {
    throw new ProfessionLockedError({
      turn,
      current: current.profession,
      requested: profession,
      reason: 'profession is locked for the duration of the task',
      hint: 'use rebuildTurn or abandonTurn to change profession',
    })
  }

  // 未锁定 → 设置并锁定
  return await updateTurn(turn, {
    profession,
    locked: true,
    lockedAt: Date.now(),
  })
}
```

**SQLite 触发器（防御性约束）：**

```sql
CREATE TRIGGER trg_turn_profession_lock
BEFORE UPDATE OF profession ON turn
FOR EACH ROW
WHEN OLD.locked = 1 AND NEW.profession != OLD.profession
BEGIN
  SELECT RAISE(ABORT, 'profession is locked; use rebuild or abandon');
END;

CREATE TRIGGER trg_subtask_profession_lock
BEFORE UPDATE OF profession ON subtask
FOR EACH ROW
WHEN OLD.locked = 1 AND NEW.profession != OLD.profession
BEGIN
  SELECT RAISE(ABORT, 'profession is locked; use rebuild or abandon');
END;
```

触发器是防御性的——即使服务层被绕过，数据库也会拒绝修改。

### 3.4 例外场景：重建与丢弃

职能锁定的唯一例外是**重建任务**或**丢弃任务**。这两个操作不是“修改当前任务的职能”，而是“结束当前任务，创建新任务”。

**非统筹模式（Turn 级别）：**

| 操作 | 语义 | 职能处理 |
|---|---|---|
| `rebuildTurn` | 结束当前 Turn，创建新 Turn | 新 Turn 可以重新选择职能 |
| `abandonTurn` | 丢弃当前 Turn，不创建新 Turn | 当前 Turn 标记 abandoned，职能记录保留 |

**统筹模式（SubTask 级别）：**

| 操作 | 语义 | 职能处理 |
|---|---|---|
| `rebuildSubTask` | 结束当前 SubTask，创建新 SubTask（`supersedes` 指向旧任务） | 新 SubTask 可以重新选择职能 |
| `abandonSubTask` | 丢弃当前 SubTask | 当前 SubTask 标记 abandoned，职能记录保留 |

**关键区分：** 重建不是“修改职能”，而是“新任务新职能”。旧任务的职能记录保留在审计中，新任务的职能记录是独立的。

### 3.5 与六维职能矩阵的关系

v22 中每轮 Turn 生成六条 `ProfessionRecord`，记录六个职能的执行状态。v23 修正为：**每个任务（Turn 或 SubTask）生成一条 `ProfessionRecord`**，记录该任务锁定的职能。

```typescript
type ProfessionRecord = {
  identity: number
  handle: string
  turn: number
  subtask?: number            // 统筹模式下指向 SubTask
  actor: string               // 父代理 handle / 子代理 handle
  profession: Profession      // 任务锁定的职能
  locked: boolean             // 是否已锁定
  lockedAt?: number           // 锁定时间
  status: 'pending' | 'running' | 'done' | 'failed' | 'abandoned'
  input?: string
  output?: string
  reason?: string
  created: number
  finished?: number
}
```

**为什么从六条改为一条：**

- 六条记录隐含“一个 Turn 同时承担六个职能”，与“一个任务只有一个职能”冲突
- 一条记录明确“这个任务由这个 agent 以这个职能完成”
- 统筹模式下，父代理一条、每个子代理各一条，问责链清晰
- 审计时能直接回答“这个任务是谁、以什么职能、完成了什么”

**六维矩阵仍然存在**，但作为**职能池**——agent 从中选择一个，不是同时承担六个。

### 3.6 统筹模式下的职能分配

统筹模式下，父代理和子代理各自独立锁定职能：

| 角色 | 典型职能 | 不可承担的职能 |
|---|---|---|
| 父代理 | `decision` 或 `outcome` | `execution`（不直接执行子任务） |
| 子代理（执行） | `execution` | `outcome`（不自我验收） |
| 验收者 | `outcome` | `execution`（不执行任务） |

**执行者与验收者必须是不同的 agent 实例，承担不同的职能。** 这是“做工作的代理永远不能标记任务完成”在职能层面的体现。

**父代理的职能选择：**

- 如果父代理选择 `decision`，它负责批准/否决子任务的恢复决策，不负责最终交付的综合
- 如果父代理选择 `outcome`，它负责最终交付的综合和验收协调，不负责单点决策

大多数情况下，父代理选择 `outcome`——因为父代理对 Turn 的最终 Answer 负最终责任。

**子代理的职能选择：**

- 执行型子任务 → 子代理选择 `execution`
- 验收型子任务 → 子代理选择 `outcome`
- 研究型子任务（需要判断证据是否充分）→ 子代理选择 `outcome` 或 `decision`

### 3.7 跨任务切换职能

Agent 可以在**不同的任务**之间切换职能。这是合法的，也是设计意图：

```text
Turn 1: agent 选择 execution 职能 → 完成执行任务 → Turn 1 结束
Turn 2: agent 选择 outcome 职能 → 完成验收任务 → Turn 2 结束
Turn 3: agent 选择 decision 职能 → 完成决策任务 → Turn 3 结束
```

每次都是独立的任务，独立的职能锁定。**“切换”发生在任务边界，而不是任务内部。**

### 3.8 审计轨迹

每次职能锁定、重建、丢弃都写入 `OrchestrationTrace`：

```typescript
type OrchestrationTrace = {
  identity: number
  handle: string
  turn: number
  event: 'lock' | 'rebuild' | 'abandon' | 'dispatch' | 'submit' | 'verify' | 'recover' | 'synthesize'
  subtask?: number
  actor: string
  profession?: Profession     // 锁定/重建/丢弃时记录
  parentEvent?: number
  detail: string
  hash: string
  created: number
}
```

审计轨迹回答三个问题：

1. 这个任务的职能是什么？
2. 职能是什么时候锁定的？
3. 有没有发生过重建或丢弃？如果有，新旧任务的职能分别是什么？

### 3.9 错误处理

```typescript
class ProfessionLockedError extends Error {
  turn: number
  current: Profession
  requested: Profession
  reason: string
  hint: string
}

class ProfessionRequiredError extends Error {
  turn: number
  reason: string          // 'profession must be selected before task execution'
}
```

`ProfessionLockedError` 在尝试修改已锁定的职能时抛出。`ProfessionRequiredError` 在任务开始执行但没有选择职能时抛出。

**Fail-closed：** 如果职能未选择或锁定状态不明确，任务不允许执行。这比“默认某个职能”更安全。


## 第四章 · 模型视图（Provider View）

### 4.1 设计原则

品牌和模型的权威来源是 DSH 的 `ctx.llm`，不是 Coordination 插件。DSH 的模型层是运行时装配的：品牌和模型由 `ctx.llm` 服务在运行时注册和解析。Coordination 插件作为查询层，读取 DSH 的 live 视图，并在其上叠加缓存优化行为约束。

DSH 的 `ctx.llm` 提供以下关键接口：

| 接口 | 用途 |
|---|---|
| `ctx.llm.listProviders()` | 列出已注册（live）的 provider 路由 |
| `ctx.llm.listConfigurableProviders()` | 列出可配置（含 dormant）的 provider 目录 |
| `ctx.llm.listModels(route)` | 解析某个 provider 下的模型列表 |

`listProviders()` 和 `listConfigurableProviders()` 的关系是：配置界面将两者合并，为每个条目标注 live 或 dormant。Coordination 插件看到的品牌/模型视图，是 DSH 当前实际装配的视图，而不是一份猜测的清单。

DSH 中品牌和模型配置的分层：

| 层 | 位置 | 内容 |
|---|---|---|
| 基础层 | `cordis.yml` / `dsh-base` bundle | 默认 provider、默认 model、tools、persistence、policy |
| 插件层 | `llm-pi-ai`、`llm-deepseek` 等适配器插件 | provider 路由、endpoint、apiKeyEnv、模型 catalog |
| 用户层 | `settings.yaml` / Web UI Settings → Models | API key、modelOverrides、profile 覆盖 |
| 运行时 | `ctx.llm` | `listProviders()`、`listConfigurableProviders()`、`listModels()` |

Coordination 插件不持有这张表的任何一行。它只做两件事：读取和补充策略。

### 4.2 ProviderView 定义

```typescript
type ProviderView = {
  route: string              // provider 路由 ID，如 'deepseek-official'、'anthropic'
  title: string              // displayName，来自 DSH provider 元数据
  live: boolean              // 来自 listProviders() 与 listConfigurableProviders() 的合并
  source: 'base' | 'plugin' | 'user'
  models: ModelCapability[]
  cacheStrategy?: CacheStrategy
  notes?: string
  observed: number
}

type ModelCapability = {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  input: string[]
  reasoningEfforts?: string[]
  compat?: Record<string, unknown>
}

type CacheStrategy = {
  effortCacheBreak: boolean
  reasoningPreserve: boolean
  configUpdateParam?: string
}
```

### 4.3 CacheStrategy 定义

CacheStrategy 只保留 DSH 不覆盖的行为约束。缓存命中指标从 DSH 的 `TokenUsage` 读取，不自行计算。

```typescript
type CacheStrategy = {
  effortCacheBreak: boolean   // effort 切换是否会破坏缓存
  reasoningPreserve: boolean  // 是否需要保留 reasoning_content
  configUpdateParam?: string  // 是否支持 configuration_update
}
```

### 4.4 Coordination 不做的三件事

| 不做 | 原因 | 应由谁做 |
|---|---|---|
| 不定义品牌清单 | 品牌由 DSH 适配器插件注册 | DSH 适配器 |
| 不定义模型 catalog | 模型由 DSH provider 配置或 catalog 提供 | DSH Settings → Models |
| 不翻译 `reasoningEffort` | effort → 原生参数的翻译是适配器职责 | DSH `LlmAdapter` |

### 4.5 设置中的模型适配（只读视图）

模型适配是只读视图 + 策略补充：

```
▸ 模型适配（来自 DSH，只读）
  当前 Provider   [ DeepSeek (live) ]  ← 只读
  模型 ID         [ deepseek-chat ]    ← 只读
  推理档位        [ high ]             ← 只读
  ──────────────────────────────────
  ▸ 缓存优化（Coordination 补充）
    启用缓存优化   开关 [ ● ]
    缓存命中率     [ 从 TokenUsage 计算 ]
    effort 缓存警告 开关 [ ● ]
  ──────────────────────────────────
  [ 打开 DSH 模型设置 ]  → 跳转 DSH Settings → Models
```

品牌和模型的增删改统一在 DSH 的 Settings → Models 中进行。


## 第五章 · 缓存优化（CacheOptimizer）

### 5.1 设计依据

DeepSeek 的缓存按 64 token 块工作，全有或全无。DeepSeek 的缓存键包含 `reasoning_effort` 和 `max_tokens`，切换这些参数会导致缓存完全失效。Anthropic 的 thinking 配置渲染进 prompt，切换配置会无效化缓存断点。Kimi 的前缀缓存要求字节级对齐，需完整保留 `reasoning_content`。GPT-6 支持通过 `configuration_update` 在不无效化缓存的情况下变更 effort。xAI 通过 `x-grok-conv-id` 维持缓存亲和性。这些是 provider 的行为差异，属于 Coordination 应该补充的行为约束。

### 5.2 CacheOptimizer 服务

```typescript
interface CacheOptimizer {
  reorderMessages(messages: Message[], strategy: CacheStrategy): Message[]
  stripDynamicContent(text: string): string
  fingerprint(messages: Message[]): string
  checkEffortCacheBreak(session: number, newEffort: UnifiedEffort): boolean
  getStats(session: number): CacheStats
}

type CacheStats = {
  totalRequests: number
  cacheHits: number       // 从 DSH TokenUsage.cacheReadTokens 汇总
  cacheMisses: number     // 从 DSH TokenUsage.inputTokens 汇总
  hitRate: number
  estimatedSavings: number
  effortBreaks: number
}
```

`cacheHits` 和 `cacheMisses` 从 DSH 返回的 `TokenUsage` 读取，不由 Coordination 自行估算。

### 5.3 缓存优化规则

**规则一：固定内容前置。** system prompt、工具定义、few-shot 示例放在消息列表最前面。

**规则二：effort 切换检测。** 对于 `effortCacheBreak = true` 的 provider，当 effort 变更时警告用户缓存将失效。

**规则三：Kimi 的 reasoning_content 保留。** 对于 `reasoningPreserve = true` 的 provider，跨轮次完整保留所有历史 `reasoning_content`。

**规则四：Anthropic 缓存断点稳定性。** 将 thinking 配置保持在 Turn 级别稳定。

**规则五：GPT-6 的 configuration_update。** 对于支持 `configUpdateParam` 的 provider，通过 `configuration_update` 发送 effort 变更。

### 5.4 buildModelRequest 的职责边界

`buildModelRequest` 的角色是缓存优化装饰器，不是参数适配器。DSH 的适配器负责将 `reasoningEffort` 翻译为各 provider 的原生参数。Coordination 只做缓存相关的消息重排和前缀稳定化：

```typescript
async function decorateRequest(
  options: GenerateOptions,
  strategy: CacheStrategy,
): Promise<GenerateOptions> {
  options.messages = reorderMessages(options.messages, strategy)
  options.messages = options.messages.map(m => ({
    ...m,
    content: stripDynamicContent(m.content),
  }))
  if (strategy.effortCacheBreak) {
    await warnIfEffortChanged(options)
  }
  return options
}
```

`reasoningEffort` 本身原样传递，不做二次映射。


## 第六章 · 交互维度与命令

### 6.1 交互（Interaction）

```typescript
type Interaction = 'emotion' | 'think' | 'heuristic' | 'converge' | 'orchestrate'
```

| 交互 | 驱动逻辑 | 用户角色 | 输出 |
|---|---|---|---|
| 感情 | 共情与倾听 | 倾诉者 | 情绪承接与陪伴 |
| 思维 | 显式推理链 | 观察者 | 深度分析与答案 |
| 启发 | 贝叶斯推断 + 成功案例检索 | 参与者 | 成功路线排序与最佳方向 |
| 收束 | 贝叶斯推断 + 失败案例检索 | 验证者/决策者 | 失败路线排序、边界与缘由 |
| **统筹** | **任务分解、派发、独立验收、综合** | **委托者** | **经独立验收的子任务产出集合** |

**感情模式**参考 UniESC 的人格敏感多智能体角色扮演框架，其核心是基于心智理论（Theory-of-Mind, ToM）的圆桌机制。EQ-Net+ 基于动态情绪智能网络（DEIN），考虑情绪转移、上下文依赖和长期记忆来生成共情回应。

**启发模式**参考 Nous 的信息论驱动框架。DiscoverLLM 发现用户往往并非“不愿表达”，而是“尚未形成意图”。STAP 将 LLM 角色从“oracle”转变为“Socratic tutor”。BioDiscoveryAgent 利用生物学知识设计基因扰动实验，在六个数据集上预测相关基因扰动平均提升 21%。HypoAgents 将贝叶斯推理与信息熵驱动的搜索机制整合，在 ICLR 2025 研究问题数据集上经过 12 轮迭代后平均 ELO 分数提升 116.3。

**收束模式**以贝叶斯推断和贝叶斯更新为理论基础，以客观证据为支撑。核心原则来自 Convergence Must Be Designed：迭代不等于进步，停止规则必须在收束循环开始前定义好。KL 散度用于检测信念是否稳定，但它无法区分收敛到正确答案还是错误答案。因此需要第二个判别性停止准则：过程奖励模型提供互补信号。

**统筹模式**以验证门控的多智能体编排为理论基础。核心原则来自 verify-gate-mcp：做工作的代理永远不能标记任务完成。任务在创建时就必须有验收标准，由一个代理带着证据声明完成，只能由另一个代理来验证。终态不可逆。模糊情况以 fail-closed 方式解决，保留分组的准入记录和事件轨迹以供审计。

### 6.2 情景（Scene）

> **v24 修订：** 情景新增 `writing`，位于 `dialogue` 与 `office` 之间。

```typescript
type Scene = 'dialogue' | 'writing' | 'office' | 'research' | 'engineering' | 'iterate'
```

| 情景 | 定位 | 典型场景 |
|---|---|---|
| 对话 | 快速自然交互 | 闲聊、简单问答 |
| **写作** | **内容创作与文本打磨** | **文章、文案、报告起草、邮件、创意写作、技术文档** |
| 办公 | 文件管理、任务自动化 | 整理文件、生成报告 |
| 研究 | 多步检索、证据综合 | 文献综述、市场调研 |
| 工程 | 代码生成、构建、调试 | 软件开发、重构 |
| 迭代 | generate → critique → revise | 代码优化、文档打磨 |

**写作与相邻情景的边界：**

| 对比 | 写作 | 对话 | 办公 |
|---|---|---|---|
| 产出 | 结构化长文本 | 即时回应 | 文件操作结果 |
| 交互节奏 | 多轮打磨 | 单轮快速 | 任务驱动 |
| 对 Plan 的要求 | 必须有结构（大纲 → 草稿 → 修订） | 可简化 | 必须有步骤 |
| 对评分的要求 | 必须有质量评分 | 可跳过 | 可简化 |
| 工具需求 | 无需 bash，可选联网搜索 | 无需 bash | 需文件工具，沙箱内 |
| 验证重点 | 风格、逻辑、受众匹配 | 准确性 | 文件正确性 |

**写作场景的核心约束：**

- 必须有 Plan，且 Plan 的 `step` 应体现“大纲 → 草稿 → 修订”的结构
- 必须有质量评分（`answer` 的 `clarity`、`coherence`、`audience` 维度）
- 收束阶段应明确“受众、语气、字数、格式”四个边界
- 不启用 bash，不需要沙箱文件操作
- 可选联网搜索（资料引用、事实核查）

### 6.3 验证（Validation）

```typescript
type Validation = 'low' | 'medium' | 'high'
```

| 档位 | 贝叶斯范围 | 检索预算 | 证据来源 |
|---|---|---|---|
| low | 对选定交互做轻量先验和后验 | 1 次查询 × 3 条结果 | 当轮对话 + 少量联网资料；不读取跨会话历史 |
| medium | 对选定交互做完整先验和后验 | 2 次查询 × 5 条结果 | 当前会话全部内容 + 联网资料；不读取跨会话历史 |
| high | 对所有交互做完整先验和后验 + 全局加权融合 | 4 次查询 × 8 条结果 | 当前会话 + 全部本地会话历史 + 工作区可读文件 + 联网资料 |

- **low**：执行选定交互，联网检索少量资料，只结合当轮对话做轻量贝叶斯更新，不读取跨会话历史
- **medium**：执行选定交互，联网检索资料，结合当前会话全部内容做完整贝叶斯更新，不读取跨会话历史
- **high**：对所有交互模式做完整贝叶斯更新，结合当前会话 + 联网检索 + 全部本地会话历史 + 工作区可读文件，执行全局加权融合

**三档都联网、都做贝叶斯。** 档位差异体现在检索预算（1×3 / 2×5 / 4×8）、证据范围（当轮 / 当前会话 / 本地全部内容）和融合范围，而不是“是否搜索、是否推断”。检索预算由 `comprehension` 配置段覆盖，默认值见上表。历史记录是如实记录，不区分 validation 档位。

### 6.4 命令（Command）与命令对接模块

```typescript
type CommandType = 'none' | 'goal' | 'plan' | 'feedback' | 'compact' | 'permission'
```

命令是输入框中的特殊前缀操作。命令直接作用于对应的模块，跳过常规流程。

| 命令 | 对接模块 | 语义 | 跳过的阶段 |
|---|---|---|---|
| 无 | 完整流程 | 走完整 Comprehension + Organization + Plan | 无 |
| 目标 | Goal 模块 | 设定或查看当前 Turn 的目标 | 跳过 Comprehension 和 Organization |
| 计划 | Plan 模块（命令模式） | 查看或修改当前 Turn 的计划 | 跳过 Comprehension 和 Organization |
| 反馈 | Directive 模块 | 对当前 Turn 或 Plan 给出反馈 | 跳过 Comprehension 和 Organization |
| 压缩 | Compact 模块 | 压缩当前会话上下文 | 跳过 Comprehension、Organization、Plan |
| 权限 | Permission 模块 | 查看或修改当前会话权限 | 跳过整个 Turn 流程 |

**统筹不是命令，而是交互选项。** 统筹模式下，Plan 的 `step` 被解析为 `SubTask[]`，走编排流程。

### 6.5 组合矩阵

| 情景 \ 交互 | 感情 | 思维 | 启发 | 收束 | 统筹 |
|---|---|---|---|---|---|
| 对话 | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| **写作** | **⚠️** | **✅** | **✅** | **✅** | **✅** |
| 办公 | ⚠️ | ✅ | ✅ | ✅ | ✅ |
| 研究 | ❌ | ✅ | ✅ | ✅ | ✅ |
| 工程 | ❌ | ✅ | ⚠️ | ✅ | ✅ |
| 迭代 | ❌ | ✅ | ✅ | ✅ | ✅ |

**写作场景下的交互推荐：**

| 交互 | 适用性 | 说明 |
|---|---|---|
| 感情 | ⚠️ 有限 | 仅在需要共情式写作（如慰问信、道歉信）时使用 |
| 思维 | ✅ 推荐 | 结构设计、逻辑梳理、论点组织 |
| 启发 | ✅ 推荐 | 创意角度、多方案比选、受众视角探索 |
| 收束 | ✅ 推荐 | 风格、字数、受众、格式的边界界定 |
| 统筹 | ✅ 推荐 | 长文档分段撰写、多章节并行、独立验收 |

统筹在办公、研究、工程、迭代中为推荐组合。对话中有限适用，因为简单对话通常不需要多智能体编排。


## 第七章 · 职能 Profession

### 7.1 设计原则

每一个职能在组织中的核心问责域是唯一且清晰的，避免“都管、都不管”的职责稀释。工程项目管理实践按“决策层—管理层—作业层”纵向分层，再在每一层内按职能切分。本插件借鉴这一框架，将六维职能映射到 Coordination 插件的模块，形成单一职责的职能矩阵。

“单一职责”不是指一个模块只做一件事，而是指每一个模块的“问责轴”只有一个方向。**v23 进一步强化：不仅是模块之间职责分离，agent 自身在任务期间也必须是单一职能。**

### 7.2 六维职能 Profession

```typescript
type Profession =
  | 'decision'      // 决策
  | 'outcome'       // 成果
  | 'resource'      // 资源
  | 'personnel'     // 人员
  | 'qualification' // 任职
  | 'execution'     // 执行
```

| 职能 | 单一职责定义 | Coordination 对应模块 | 关键边界 |
|---|---|---|---|
| **决策** | 对 Turn 是否执行、Plan 是否通过、重大变更拥有最终批准权或否决权 | Gate | 不陷入执行细节 |
| **成果** | 对 Turn 的最终 Answer 和 Plan 的 goal 达成负最终责任 | PlanScorer + AnswerScorer + 验收者 | 不替代技术专业判断，不管理资源 |
| **资源** | 对 Token、Provider、缓存、网络搜索的供给与成本负责 | CacheOptimizer + ProviderView + BayesianEngine 的搜索预算 | 不指挥执行 |
| **人员** | 对 Session、Thread、Agent 的分配与合规负责 | SessionManager + ThreadPool + OrchestrationEngine 的子代理分配 | 不决定用哪个 Provider，不批准 Plan |
| **任职** | 对 Provider/Model 的能力资格、不兼容回避进行独立把关 | ProviderView 的资格检查 | 不参与分配决策，不对执行能力做最终判断 |
| **执行** | 对在既定 Plan、预算、规范下把活干出来负责 | ExecutionEngine + Action + Request + 子代理执行 | 不反向决策范围和资源 |

### 7.3 任职必须与人员、决策分离

如果“人员分配”和“任职资格审核”由同一个模块完成，就会产生自我批准的风险。本插件的做法是：

- **人员**：SessionManager 分配 Session 和 Thread，OrchestrationEngine 分配子代理
- **任职**：ProviderView 检查 Provider/Model 是否满足 Plan 的要求
- **决策**：Gate 批准或否决 Plan

三者不能合并。例如：SessionManager 不能自己决定用哪个 Provider（那是任职），也不能自己批准 Plan（那是决策）。OrchestrationEngine 不能自己验收子任务（那是成果职能，且必须由独立验收者执行）。

### 7.4 职能在 Turn 中的执行顺序

```text
Turn 开始
   │
   ▼
① 职能选择：Agent 从六维中选择一个，锁定整个 Turn
   │
   ▼
② 人员：SessionManager 分配 Session，ThreadPool 准备 Thread
   │
   ▼
③ 任职：ProviderView 检查 Provider 能力是否满足
   │
   ▼
④ 决策：Gate 根据 Plan 评分和验证档位决定是否执行
   │
   ▼
⑤ 资源：CacheOptimizer 优化缓存，BayesianEngine 分配搜索预算
   │
   ▼
⑥ 执行：ExecutionEngine 执行 Action
   │        统筹模式下，OrchestrationEngine 派发子代理
   │
   ▼
⑦ 成果：PlanScorer 和 AnswerScorer 评分
            统筹模式下，独立验收者判定子任务完成
```

**v23 的关键变化：** 第 ① 步是新增的——Agent 在 Turn 开始时选择一个职能并锁定。这与 v22 的“每轮六个职能都执行”不同，v23 是“一个任务一个职能”。

### 7.5 职能与验证档位的关系

| 验证档位 | 职能选择 | 职能锁定 | 职能审计 |
|---|---|---|---|
| low | 必须选择 | 强制锁定 | 记录一条 |
| medium | 必须选择 | 强制锁定 | 记录一条 |
| high | 必须选择 | 强制锁定 | 记录一条 + 全局融合时引用 |

无论哪个档位，职能都必须选择、锁定、审计。


## 第八章 · 统筹编排（Orchestration）

### 8.1 设计原则

统筹是第五种交互选项，与感情、思维、启发、收束并列。它决定的是“Agent 如何组织多个子代理来完成任务”，而不是“Agent 如何直接回应用户”。统筹模式下，父代理不直接产出最终答案，而是产出经独立验收的子任务产出集合，再综合成 Answer。

统筹模式强制三条职责分离，这是从 verify-gate-mcp 和 Verify-Gated Completion 提炼出的硬约束：

| 角色 | 职责 | 不做什么 |
|---|---|---|
| **父代理（Manager）** | 拆解 Plan、定义验收标准、派发子任务、决策恢复、综合产出 | 不直接执行子任务，不自我验收 |
| **子代理（Worker）** | 在隔离上下文中执行子任务，提交产出和自检证据 | 不定义验收标准，不判定自己完成 |
| **验收者（Verifier）** | 对照验收标准独立判定 PASS/FAIL，产出 RecoveryPacket | 不执行任务，不改写产出，不决策重试 |

**关键约束：做工作的代理永远不能标记任务完成。** 一个被要求同时做任务和判断任务是否完成的代理，存在内建的利益冲突。验收门控必须存在于提示词之外——由服务端和 SQLite 约束强制执行，而不是依赖模型自觉。

**v23 强化：** 父代理、子代理、验收者**各自锁定自己的职能**，不共享职能。父代理通常是 `outcome` 或 `decision`，执行子代理是 `execution`，验收者是 `outcome`。同一 agent 实例不能在任务内切换职能。

### 8.2 子任务规格：四元组 + 验收标准 + 职能绑定

```typescript
type SubTask = {
  identity: number
  handle: string
  parent: number              // 父 Turn

  // 四元组
  model: string               // 子代理使用的模型
  effort: UnifiedEffort       // 严格继承父代理
  task: string                // 子任务描述
  tools: string[]             // 裁剪后的工具集
  context: string             // 隔离的上下文摘要

  // 验收（派发前定义，不可后补）
  acceptance: string          // 可检查的完成定义，非空
  groundTruth?: string        // 确定性检查方式（测试、退出码、schema）

  // 职能锁定
  profession: Profession      // 子代理的职能，锁定
  locked: boolean             // 派发时锁定
  lockedAt?: number

  // 依赖
  blockedBy: number[]

  // 状态机
  status: 'pending' | 'running' | 'submitted' | 'verified' | 'rejected' | 'partial'

  // 产出与证据
  result?: string
  evidence?: string

  // 验收结果
  verdict?: 'pass' | 'fail' | 'partial' | 'unverifiable'
  reason?: string

  // 恢复（验收 FAIL 时由验收者生成，父代理决策）
  recovery?: RecoveryPacket

  // 循环控制
  rejectCount: number
  supersedes?: number

  created: number
  finished?: number
}

type RecoveryPacket = {
  failedCriteria: string
  cause: string
  suggestion: 'retry' | 'revise_criteria' | 'accept_partial' | 'escalate'
  detail?: string
}
```

**验收标准必须前置。** 一个子任务不能没有验收标准就存在。验收标准在派发后不可被验收者或子代理修改，只有父代理在收到 RecoveryPacket 后可以通过 `revise_criteria` 路径显式修改。

### 8.3 统筹执行流程

```text
统筹触发（用户选择交互 = 统筹）
   │
   ▼
① 父代理选择职能并锁定（通常是 outcome 或 decision）
   │
   ▼
② 父代理拆解 Plan
   - 识别可并行/可委派的子任务
   - 为每个子任务定义四元组 + 验收标准 + 职能
   - 依赖解析：标记 blocked_by 关系
   │
   ▼
③ 派发子代理（并行执行，无 worker 间协调）
   - 每个子代理在隔离上下文中运行
   - 每个子代理选择职能并锁定（通常是 execution）
   - 严格继承父代理的 effort
   - 产出交付物 + 自检证据
   │
   ▼
④ 独立验收（验收者 ≠ 执行者）
   - 验收者选择职能并锁定（通常是 outcome）
   - 优先确定性检查（ground truth）
   - 确定性检查无法覆盖的部分才交给 judge 模型
   - 产出 PASS / FAIL / PARTIAL / UNVERIFIABLE
   │
   ├─ PASS → 子任务标记 verified，下游依赖解锁
   │
   └─ FAIL → 验收者生成 RecoveryPacket（只给原因和建议，不做决策）
              │
              ▼
          父代理决策恢复路径
              ├─ retry → 重新派发（rejectCount + 1）
              ├─ revise_criteria → 修改验收标准后重新派发
              ├─ accept_partial → 标记 partial，继续
              └─ escalate → 升级人类
   │
   ▼
⑤ 父代理综合
   - 检查子任务间依赖和冲突
   - 合成最终 Answer
   - 写入 OrchestrationTrace
```

**验收者的决策边界：** 验收者只判定 PASS/FAIL 并给出失败原因，不做恢复决策。恢复决策归父代理——这让问责链清晰：验收者问责“判定是否准确”，父代理问责“恢复是否恰当”。

### 8.4 验收的分层策略

独立 ground truth 优先，另一 LLM 的意见不能替代确定性检查。

| 层 | 内容 | 优先级 |
|---|---|---|
| 确定性检查 | 文件存在、命令退出码、schema 校验、测试通过 | 最高 |
| Judge 模型评估 | 质量、完整性、一致性等无法确定性判定的维度 | 仅在确定性检查无法覆盖时使用 |
| 人工审查 | 严重模糊或高风险 | 升级路径 |

judge 模型的评分应采用最低维度决定总分的策略：如果 correctness、completeness、robustness 中任何一项低于阈值，整体判定 FAIL，而不是取平均。

### 8.5 Fail-closed 默认

验收者在超时或无法判定时，默认返回 FAIL 或 UNVERIFIABLE，而不是 PASS。子任务保持未验收状态，父代理必须显式处理。终止状态不可逆：一旦子任务被标记为 verified 或 rejected，不能直接改回；被拒绝的子任务通过创建新子任务（`supersedes` 指向旧子任务）来修复。

### 8.6 依赖解析与拒绝循环

任务声明 `blockedBy`，依赖完成时自动解锁，失败级联下游。拒绝循环允许验收者把工作退回给子代理并附带 RecoveryPacket，同时需要循环检测防止无限重试。每个子任务有 `rejectCount` 和 `maxReject`（默认 2）。达到上限后，父代理只能选择 `accept_partial` 或 `escalate`。

### 8.7 成本权衡

统筹模式天然比单代理昂贵。Anthropic 的生产变体在构建应用的任务上，比单代理慢约 20 倍、贵约 20 倍，但它能从一句话需求交付一个可玩的 app，而单代理做不到。

统筹不应默认对所有任务开启。建议的触发约束：

| 条件 | 行为 |
|---|---|
| 用户显式选择交互 = 统筹 | 启用统筹 |
| Plan 的 feasibility 或 coverage 低于阈值 | 提示用户可启用统筹 |
| 子任务数量 = 1 | 不启用统筹，直接单代理执行 |
| 任务可在几分钟内用确定性检查自验证 | 不启用统筹 |

**模型路由的成本优化：** 子代理的 `model` 可以不同于父代理。ROUTERHGC 的研究表明，通过动态路由 agent 组合和模型选择，可以在保持精度的同时降低 27.40% 的推理成本。子代理默认继承父代理的 `model`，但父代理可以在拆解时为特定子任务指定更轻量的模型，并在 OrchestrationTrace 中记录模型选择的原因。`effort` 则严格继承，不做降级。**`profession` 由父代理在拆解时指定，子代理不能自行更改。**

### 8.8 治理轨迹

当多个子代理、验收者和恢复决策交互时，仅靠局部日志无法回答“这个完成声明是如何被接受的”。治理轨迹需要是事件优先的、不可篡改的，串联派发、提交、验收、恢复和综合的完整因果链。

```typescript
type OrchestrationTrace = {
  identity: number
  handle: string
  turn: number
  event: 'lock' | 'rebuild' | 'abandon' | 'dispatch' | 'submit' | 'verify' | 'recover' | 'synthesize'
  subtask?: number
  actor: string               // 父代理 handle / 子代理 handle / 验收者 handle
  profession?: Profession     // 锁定/重建/丢弃时记录
  parentEvent?: number        // 父事件 identity，用于因果链
  detail: string              // 事件详情（JSON）
  hash: string                // 哈希链，前一条事件的 hash + 本条内容
  created: number
}
```

不可省略的字段：运行标识、子任务标识、事件类型、父事件标识（用于因果链）、负责人、职能、验收包标识、证据包标识、判定结果、恢复决策。哈希链使任何对历史记录的篡改可被检测。


## 第九章 · 理解过程与组织过程

### 9.1 核心原则

每一轮对话（命令 = none 时），都必须通过 Comprehension + Organization 建立目标 Plan。这是强约束。当命令为 goal / plan / feedback / compact / permission 时，跳过 Comprehension，直接对接对应模块。统筹模式下，Comprehension 和 Organization 仍然执行，但 Plan 的 `step` 被解析为 `SubTask[]`。

### 9.2 目标 Plan 的结构

```typescript
type Plan = {
  identity: number
  handle: string
  turn: number
  parent?: number

  goal: string
  approach: string
  step: string          // 统筹模式下解析为 SubTask[] 的 JSON
  constraint: string
  assumption: string

  status: 'draft' | 'scored' | 'active' | 'done' | 'failed' | 'abandoned' | 'rebuilt'
  rebuild: number
  mode: 'auto' | 'command'
  orchestration: boolean
  created: number
  finished?: number
}
```

### 9.3 Plan 评分

每一个 Plan 都必须评分。

| 维度 | 含义 | 阈值 | 方向 |
|---|---|---|---|
| `feasibility` | 可行性 | ≥ 0.5 | 越高越好 |
| `coverage` | 覆盖度 | ≥ 0.6 | 越高越好 |
| `clarity` | 清晰度 | ≥ 0.5 | 越高越好 |
| `specificity` | 具体性 | ≥ 0.5 | 越高越好 |
| `alignment` | 与 Comprehension 一致性 | ≥ 0.7 | 越高越好 |
| `risk` | 风险 | ≤ 0.7 | 越低越好 |
| `cost` | 成本 | ≤ 0.8 | 越低越好 |
| `efficiency` | 效率 | ≥ 0.5 | 越高越好 |

综合评分：

```text
planScore = weightedAverage(
  feasibility  × 0.15,
  coverage     × 0.15,
  clarity      × 0.10,
  specificity  × 0.10,
  alignment    × 0.20,
  (1 - risk)   × 0.10,
  (1 - cost)   × 0.10,
  efficiency   × 0.10
)
```

默认阈值：`planThreshold = 0.5`

### 9.4 评分低时重建 Plan

重建触发条件（任一满足即触发）：

```
① 任一维度低于阈值
② 综合评分 < planThreshold（默认 0.5）
③ alignment < 0.7（与理解不一致）
④ risk > 0.7（风险过高）
```

重建上限：默认 `maxRebuild = 3`。达到上限后，Plan 标记为 `failed`，Turn 升级到人类审查。

**重建与职能锁定的关系：** Plan 重建触发 Turn 重建（`rebuildTurn`），新 Turn 可以重新选择职能。当前 Turn 的职能记录保留在审计中。

### 9.5 理解过程（Comprehension）

四阶段顺序：情感 → 思维 → 启发 → 收束

| 验证等级 | 情感 | 思维 | 启发 | 收束 | 联网搜索 |
|---|---|---|---|---|---|
| low | 轻量 | 轻量 | 轻量（当轮证据） | 轻量（当轮证据） | 是（1×3，当轮对话） |
| medium | 完整 | 完整 | 完整（当前会话） | 完整（当前会话） | 是（2×5，当前会话） |
| high | 完整 | 完整 | 完整（当前会话 + 历史 + 工作区） | 完整（当前会话 + 历史 + 工作区） | 是（4×8，本地全部内容） |

**阶段一：情感** — 情绪识别 → 危机检测 → 共情校准 → 输出 emotion、empathy、crisis。

**阶段二：思维** — 显式推理链 → 意图推断 → 逻辑分析。

**阶段三：启发（贝叶斯强化）** — 定义先验 → 联网搜索成功案例 → 贝叶斯更新 → 成功路线排序 → 最佳方向选择。

**阶段四：收束（贝叶斯强化）** — 定义先验 → 联网搜索失败案例 → 构建因果贝叶斯网络 → 贝叶斯更新 → 失败路线排序 → 边界界定。

### 9.6 组织过程（Organization）

梳理 Comprehension 的结果，生成 Plan。统筹模式下，Plan 的步骤被进一步分解为 SubTask 集合，每个 SubTask 包含四元组、验收标准和职能绑定。

### 9.7 完整流程

```text
Prompt 提交
   │
   ▼
① 检查命令类型
   ├─ none     → 进入 ②
   ├─ goal     → Goal 模块 → 完成
   ├─ plan     → Plan 模块（命令模式）→ 完成
   ├─ feedback → Directive 模块 → 完成
   ├─ compact  → Compact 模块 → 完成
   └─ permission → Permission 模块 → 完成
   │
   ▼
② 选择职能并锁定（Turn.profession）
   │
   ▼
③ 创建 Comprehension 记录
   │
   ▼
④ 情感 → 思维 → 启发 → 收束
   │
   ▼
⑤ 完成 Comprehension
   │
   ▼
⑥ Organization 梳理
   │
   ▼
⑦ 生成 Plan（命令模式 = auto）
   │
   ▼
⑧ Plan 评分
   │
   ├─ 通过 → ⑩
   └─ 低 → ⑨
   │
   ▼
⑨ 重建 Plan（最多 3 次）
   - 重建触发 Turn 重建 → 新 Turn 可重新选择职能
   │
   ▼
⑩ 进入执行阶段
   ├─ 非统筹：Predict → Action → Reality → Answer
   └─ 统筹：拆解 SubTask（每个 SubTask 绑定职能）→ 派发 → 独立验收 → 恢复决策 → 综合 → Answer
```


## 第十章 · 认知编排

### 10.1 策略定义

```typescript
type CognitiveStage = 'comprehension' | 'organization' | 'plan' | 'planscore' | 'planrebuild' | 'constraint' | 'predict' | 'reality' | 'answer' | 'orchestrate'

type CognitiveStrategy = {
  stage: CognitiveStage
  think: boolean
  heuristic: boolean
  order: 'think-first' | 'heuristic-first' | 'parallel' | 'interleave'
  maxIteration: number
  convergence: 'entropy' | 'infoGain' | 'score' | 'evidence' | 'timeout'
  entropyThreshold?: number
}
```

### 10.2 各模式的认知编排

| 阶段 | 对话 | 思维 | 启发 | 收束 | 统筹 |
|---|---|---|---|---|---|
| profession lock | 必须 | 必须 | 必须 | 必须 | 必须（父代理） |
| comprehension | 四阶段 | 四阶段 | 四阶段 + 贝叶斯 | 四阶段 + 贝叶斯 | 四阶段 |
| organization | 标准 | 标准 | 标准 | 标准 | 标准 + SubTask 拆解 |
| plan | 必须 | 必须 | 必须 | 必须 | 必须 |
| planscore | 必须 | 必须 | 必须 | 必须 | 必须 |
| planrebuild | 按需 | 按需 | 按需 | 按需 | 按需 |
| orchestrate | — | — | — | — | 派发 → 验收 → 恢复 → 综合 |
| predict | — | — | — | — | — |
| reality | — | — | — | — | — |
| answer | — | think | heuristic | think + Bayesian | 综合子任务产出 |


## 第十一章 · 核心概念

### 11.1 Session

```typescript
type Session = {
  identity: number
  handle: string
  principal: string
  sandbox: string
  interaction: Interaction
  scene: Scene
  validation: Validation
  profile: string           // 引用 DSH provider route
  generation: number
  status: 'active' | 'ended'
  created: number
  ended?: number
}
```

### 11.2 Turn

```typescript
type Turn = {
  identity: number
  handle: string
  session: number
  ordinal: number
  prompt: number
  command: CommandType
  comprehension?: number
  organization?: number
  plan?: number
  goal?: number
  compact?: number
  interaction: Interaction
  scene: Scene
  validation: Validation

  // 职能锁定
  profession: Profession      // 父代理/单代理的职能，NOT NULL
  locked: boolean             // 创建时锁定
  lockedAt?: number

  cognitive?: string
  effort: UnifiedEffort
  iteration: number
  rebuild: number
  status: TurnStatus
  created: number
  finished?: number
}

type TurnStatus =
  | 'pending' | 'commanding' | 'comprehending' | 'organizing'
  | 'planning' | 'scoring' | 'rebuilding' | 'orchestrating'
  | 'acting' | 'answering' | 'learning' | 'done' | 'failed'
  | 'cancelled' | 'abandoned'
```

### 11.3 Prompt

```typescript
type Prompt = {
  identity: number
  handle: string
  turn: number
  content: string
  media?: string
  created: number
}
```

### 11.4 Command

```typescript
type Command = {
  identity: number
  handle: string
  turn: number
  type: CommandType
  content: string
  result?: string
  created: number
  finished?: number
}

type CommandResult = {
  command: Command
  action: 'accepted' | 'rejected' | 'pending'
  message?: string
}
```

### 11.5 Goal

```typescript
type Goal = {
  identity: number
  handle: string
  turn: number
  session: number
  content: string
  status: 'set' | 'updated' | 'viewed' | 'cleared'
  reason?: string
  created: number
  changed?: number
}

type GoalResult = {
  goal: Goal
  plan?: Plan
  rescored: boolean
}
```

### 11.6 Compact

```typescript
type Compact = {
  identity: number
  handle: string
  turn: number
  session: number
  before: string
  after: string
  beforeSize: number
  afterSize: number
  ratio: number
  strategy: 'summary' | 'prune' | 'hybrid'
  reason?: string
  created: number
}

type CompactResult = {
  compact: Compact
  cacheBroken: boolean
}
```

### 11.7 SubTask（统筹子任务）

```typescript
type SubTask = {
  identity: number
  handle: string
  parent: number
  model: string
  effort: UnifiedEffort
  task: string
  tools: string[]
  context: string
  acceptance: string
  groundTruth?: string

  // 职能锁定
  profession: Profession      // 子代理的职能，NOT NULL
  locked: boolean             // 派发时锁定
  lockedAt?: number

  blockedBy: number[]
  status: 'pending' | 'running' | 'submitted' | 'verified' | 'rejected' | 'partial'
  result?: string
  evidence?: string
  verdict?: 'pass' | 'fail' | 'partial' | 'unverifiable'
  reason?: string
  recovery?: RecoveryPacket
  rejectCount: number
  supersedes?: number
  created: number
  finished?: number
}

type RecoveryPacket = {
  failedCriteria: string
  cause: string
  suggestion: 'retry' | 'revise_criteria' | 'accept_partial' | 'escalate'
  detail?: string
}
```

### 11.8 OrchestrationTrace（治理轨迹）

```typescript
type OrchestrationTrace = {
  identity: number
  handle: string
  turn: number
  event: 'lock' | 'rebuild' | 'abandon' | 'dispatch' | 'submit' | 'verify' | 'recover' | 'synthesize'
  subtask?: number
  actor: string
  profession?: Profession
  parentEvent?: number
  detail: string
  hash: string
  created: number
}
```

### 11.9 Comprehension

```typescript
type Comprehension = {
  identity: number
  handle: string
  turn: number
  prompt: number

  intent: string
  requirement: string
  constraint: string
  assumption: string
  ambiguity: string
  confidence: number
  entropy?: number

  emotion?: number
  empathy?: string
  think?: string
  probe?: number
  evidence?: string
  constraintIds?: string
  boundary?: string
  prospect?: string
  posterior?: string
  fusion?: string
  refusal?: number
  route?: string
  failure?: string

  stageCount: number
  thinkTrace?: string
  model?: string
  created: number
  finished?: number
}
```

### 11.10 ComprehensionStageRecord

```typescript
type ComprehensionStageRecord = {
  identity: number
  handle: string
  comprehension: number
  stage: 'emotion' | 'think' | 'heuristic' | 'converge'
  ordinal: number
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  input?: string
  output?: string
  confidence?: number
  entropyBefore?: number
  entropyAfter?: number
  created: number
  finished?: number
}
```

### 11.11 Organization

```typescript
type Organization = {
  identity: number
  handle: string
  turn: number
  comprehension: number
  plan: number

  goal: string
  approach: string
  step: string
  constraint: string
  assumption: string

  model?: string
  created: number
  finished?: number
}
```

### 11.12 Plan

```typescript
type Plan = {
  identity: number
  handle: string
  turn: number
  parent?: number

  goal: string
  approach: string
  step: string
  constraint: string
  assumption: string

  status: 'draft' | 'scored' | 'active' | 'done' | 'failed' | 'abandoned' | 'rebuilt'
  rebuild: number
  mode: 'auto' | 'command'
  orchestration: boolean
  created: number
  finished?: number
}
```

### 11.13 PlanRebuild

```typescript
type PlanRebuild = {
  identity: number
  handle: string
  plan: number
  attempt: number
  reason: string
  dimension: string
  beforeScore: string
  afterScore: string
  created: number
}
```

### 11.14 ProfessionRecord（v23 修正：每个任务一条）

```typescript
type ProfessionRecord = {
  identity: number
  handle: string
  turn: number
  subtask?: number            // 统筹模式下指向 SubTask
  actor: string               // 父代理 handle / 子代理 handle
  profession: Profession      // 任务锁定的职能
  locked: boolean
  lockedAt?: number
  status: 'pending' | 'running' | 'done' | 'failed' | 'abandoned'
  input?: string
  output?: string
  reason?: string
  created: number
  finished?: number
}

type Profession =
  | 'decision' | 'outcome' | 'resource'
  | 'personnel' | 'qualification' | 'execution'
```

**v22 的“每轮六条”修正为“每个任务一条”。** 六维矩阵仍然存在，但作为职能池——agent 从中选择一个，不是同时承担六个。

### 11.15 ProviderView

```typescript
type ProviderView = {
  route: string
  title: string
  live: boolean
  source: 'base' | 'plugin' | 'user'
  models: ModelCapability[]
  cacheStrategy?: CacheStrategy
  observed: number
}
```

### 11.16 Score

```typescript
type Score = {
  identity: number
  handle: string
  category: ScoreCategory
  target: number
  dimension: string
  value: number
  reason?: string
  model?: string
  created: number
}

type ScoreCategory =
  | 'prompt' | 'command' | 'goal' | 'compact'
  | 'comprehension' | 'organization' | 'turn'
  | 'plan' | 'predict' | 'reality' | 'action' | 'answer'
  | 'question' | 'choice' | 'error'
  | 'route' | 'failure'
  | 'subtask'
```

### 11.17 其余实体

以下实体定义与 v22 一致：

- `Predict`、`Reality`、`Action`、`Answer`、`Question`、`Choice`、`Error`、`Pattern`、`Calibration`、`Lesson`、`Rollback`
- `Emotion`、`Companion`、`Crisis`、`Probe`、`Cognition`、`Evidence`、`Constraint`、`Gate`、`Stopping`
- `Prior`、`Boundary`、`Prospect`、`Posterior`、`Likelihood`、`Fusion`、`Refusal`、`Directive`
- `Route`、`FailureRoute`、`ModeState`、`History`、`GlobalPosterior`
- `Takeover`、`Resource`、`Version`、`Vision`、`Lock`、`Request`、`Thread`、`Result`
- `ProviderProfile`（引用 DSH，不重复定义）


## 第十二章 · 贝叶斯推断引擎（BayesianEngine）

与 v22 一致。**v23 档位策略：** low / medium / high 三档都联网检索并做先验/后验更新；差异由 §6.3 的检索预算（1×3 / 2×5 / 4×8）与证据范围（当轮 / 当前会话 / 本地全部内容）控制。low 只对选定交互做轻量更新；medium 对选定交互做完整更新；high 对所有交互做完整更新并做全局加权融合。停止规则仍须在循环开始前定义（KL 散度 + 过程奖励模型）。


## 第十三章 · 目标计划的评分与重建

与 v22 一致。**新增关系：** Plan 重建触发 Turn 重建，新 Turn 可以重新选择职能。


## 第十四章 · 验证档位的执行差异

与 v22 一致。**v23 修正：** 三档都联网检索并做贝叶斯更新；档位差异只体现在检索预算、证据范围与融合范围（§6.3）。无论哪个档位，职能必须选择、锁定、审计。


## 第十五章 · UI 设计

### 15.1 消息输入框工具栏

四个下拉框：交互 / 情景 / 验证 / 命令。

**新增职能选择控件：** 在四个下拉框左侧新增一个“职能”下拉框，选项为六维职能。

```
┌─────────────────────────────────────────────────────────────┐
│  [ 职能 ▾ ] [ 交互 ▾ ] [ 情景 ▾ ] [ 验证 ▾ ] [ 命令 ▾ ]   │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  输入消息...                                           │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**职能 tooltip：**

| 选项 | tooltip |
|---|---|
| 决策 | 对是否执行、Plan 是否通过拥有最终批准权或否决权。任务内锁定，不可切换 |
| 成果 | 对最终交付物和 goal 达成负最终责任。任务内锁定，不可切换 |
| 资源 | 对 Token、Provider、缓存、搜索的供给与成本负责。任务内锁定，不可切换 |
| 人员 | 对 Session、Thread、Agent 的分配与合规负责。任务内锁定，不可切换 |
| 任职 | 对 Provider/Model 的能力资格进行独立把关。任务内锁定，不可切换 |
| 执行 | 对在既定条件下完成作业负责。任务内锁定，不可切换 |

**情景 tooltip（v24：新增“写作”，位于“对话”与“办公”之间）：**

| 选项 | tooltip |
|---|---|
| 对话 | 快速自然交互，适合闲聊和简单问答。缺点：不深入 |
| **写作** | **内容创作与文本打磨，适合文章、文案、报告、邮件、技术文档。优点：结构化产出、多轮打磨。缺点：需要多轮交互，不适合即时问答** |
| 办公 | 文件管理和任务自动化，适合整理、生成。缺点：限于沙箱内 |
| 研究 | 多步检索和证据综合，适合文献综述。优点：带引用。缺点：耗时 |
| 工程 | 代码生成和调试，适合软件开发。优点：支持 bash。缺点：需要沙箱 |
| 迭代 | generate → critique → revise 闭环，适合打磨。优点：质量高。缺点：多轮调用 |

**默认值：** 对话（保持不变）。

**行为规则：**

- 职能在 Turn 开始时选择，Turn 内锁定，不可切换
- 尝试在 Turn 内切换职能会触发 `ProfessionLockedError`
- 要切换职能，必须重建任务（`rebuildTurn`）或丢弃任务（`abandonTurn`）
- 下拉框在 Turn 锁定后变为只读

### 15.2 设置菜单页面

在 v22 基础上新增“职能锁定”分组：

```
▸ 职能 Profession
  职能锁定          开关 [ ● ]（强制）
  默认职能          [ 执行 ▾ ]
  重建时可重选      开关 [ ● ]（强制）
  丢弃时可重选      开关 [ ● ]（强制）
  ──────────────────────────────────
  职能审计          开关 [ ● ]
  锁定错误提示      开关 [ ● ]
```

**职能锁定**是强制开关，默认开启，不可关闭。这是本插件的核心安全约束。


## 第十六章 · 窗体 UI 与接管

与 v22 一致。**新增接管扩展：** `errorescalation` 窗体在职能锁定冲突时显示当前职能、请求职能、重建/丢弃选项。


## 第十七章 · SQLite 数据模型

### 17.1 coordination 数据库

**session 表** 与 v22 一致。

**turn 表（新增职能锁定字段）**

```sql
CREATE TABLE turn (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  session INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  prompt INTEGER,
  command TEXT NOT NULL DEFAULT 'none',
  comprehension INTEGER,
  organization INTEGER,
  plan INTEGER,
  goal INTEGER,
  compact INTEGER,
  interaction TEXT,
  scene TEXT,
  validation TEXT,
  profession TEXT NOT NULL,          -- v23 新增，NOT NULL
  locked INTEGER NOT NULL DEFAULT 0, -- v23 新增
  lockedAt INTEGER,                  -- v23 新增
  cognitive TEXT,
  effort TEXT,
  iteration INTEGER DEFAULT 1,
  rebuild INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created INTEGER NOT NULL,
  finished INTEGER,
  UNIQUE(session, ordinal),
  FOREIGN KEY (session) REFERENCES session(identity),
  FOREIGN KEY (plan) REFERENCES plan(identity),
  FOREIGN KEY (goal) REFERENCES goal(identity),
  FOREIGN KEY (compact) REFERENCES compact(identity)
);
CREATE INDEX idx_turn_session ON turn(session, ordinal);
CREATE INDEX idx_turn_status ON turn(status, created);
CREATE INDEX idx_turn_command ON turn(command);
CREATE INDEX idx_turn_profession ON turn(profession, locked);

CREATE TRIGGER trg_turn_profession_lock
BEFORE UPDATE OF profession ON turn
FOR EACH ROW
WHEN OLD.locked = 1 AND NEW.profession != OLD.profession
BEGIN
  SELECT RAISE(ABORT, 'profession is locked; use rebuild or abandon');
END;
```

**subtask 表（新增职能锁定字段）**

```sql
CREATE TABLE subtask (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  parent INTEGER NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  task TEXT NOT NULL,
  tools TEXT,
  context TEXT,
  acceptance TEXT NOT NULL,
  groundTruth TEXT,
  profession TEXT NOT NULL,          -- v23 新增，NOT NULL
  locked INTEGER NOT NULL DEFAULT 0, -- v23 新增
  lockedAt INTEGER,                  -- v23 新增
  blockedBy TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  evidence TEXT,
  verdict TEXT,
  reason TEXT,
  recovery TEXT,
  rejectCount INTEGER DEFAULT 0,
  supersedes INTEGER,
  created INTEGER NOT NULL,
  finished INTEGER,
  FOREIGN KEY (parent) REFERENCES turn(identity),
  FOREIGN KEY (supersedes) REFERENCES subtask(identity)
);
CREATE INDEX idx_subtask_parent ON subtask(parent, status);
CREATE INDEX idx_subtask_status ON subtask(status, created);
CREATE INDEX idx_subtask_profession ON subtask(profession, locked);

CREATE TRIGGER trg_subtask_profession_lock
BEFORE UPDATE OF profession ON subtask
FOR EACH ROW
WHEN OLD.locked = 1 AND NEW.profession != OLD.profession
BEGIN
  SELECT RAISE(ABORT, 'profession is locked; use rebuild or abandon');
END;
```

**profession_record 表（v23 修正：每个任务一条）**

```sql
CREATE TABLE profession_record (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  subtask INTEGER,
  actor TEXT NOT NULL,
  profession TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0,
  lockedAt INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  input TEXT,
  output TEXT,
  reason TEXT,
  created INTEGER NOT NULL,
  finished INTEGER,
  FOREIGN KEY (turn) REFERENCES turn(identity),
  FOREIGN KEY (subtask) REFERENCES subtask(identity)
);
CREATE INDEX idx_profession_record_turn ON profession_record(turn);
CREATE INDEX idx_profession_record_subtask ON profession_record(subtask);
CREATE INDEX idx_profession_record_actor ON profession_record(actor, profession);
```

**orchestration_trace 表（新增 lock/rebuild/abandon 事件）**

```sql
CREATE TABLE orchestration_trace (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  event TEXT NOT NULL,
  subtask INTEGER,
  actor TEXT NOT NULL,
  profession TEXT,
  parentEvent INTEGER,
  detail TEXT,
  hash TEXT NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (turn) REFERENCES turn(identity),
  FOREIGN KEY (subtask) REFERENCES subtask(identity),
  FOREIGN KEY (parentEvent) REFERENCES orchestration_trace(identity)
);
CREATE INDEX idx_trace_turn ON orchestration_trace(turn, created);
CREATE INDEX idx_trace_subtask ON orchestration_trace(subtask, created);
CREATE INDEX idx_trace_event ON orchestration_trace(event, created);
```

**其余表** 与 v22 一致。删除 `provider` 表和 `profile` 表——品牌和模型的权威数据由 DSH 的 `ctx.llm` 和 `ctx.settings` 管理。

### 17.2 与 DSH 主库的隔离

本插件使用独立的 `coordination` SQLite 数据库，与 DSH 的 `harness` 数据库物理隔离。品牌/模型数据不在 coordination 数据库中，而是通过 `ctx.llm` 实时查询。


## 第十八章 · 服务接口

### 18.1 CoordinationService

```typescript
interface CoordinationService {
  // 职能锁定
  selectProfession(turn: number, profession: Profession): Promise<Turn>
  checkProfessionLock(turn: number): Promise<boolean>
  rebuildTurn(turn: number, profession: Profession): Promise<Turn>
  abandonTurn(turn: number): Promise<Turn>
  rebuildSubTask(subtask: number, profession: Profession): Promise<SubTask>
  abandonSubTask(subtask: number): Promise<SubTask>
  getProfessionRecord(turn: number): Promise<ProfessionRecord>
  listProfessionRecord(session: number): Promise<ProfessionRecord[]>

  // 模型视图（只读，来自 DSH ctx.llm）
  listProviderView(): Promise<ProviderView[]>
  resolveProviderView(route: string): Promise<ProviderView>
  listModelCapability(route: string): Promise<ModelCapability[]>
  getCacheStrategy(route: string): Promise<CacheStrategy | undefined>

  // 统筹编排
  orchestrate(turn: number): Promise<OrchestrationResult>
  decompose(plan: number): Promise<SubTask[]>
  dispatch(subtask: number): Promise<SubTask>
  submit(subtask: number, result: string, evidence: string): Promise<SubTask>
  verify(subtask: number, verifier: string): Promise<SubTask>
  recover(subtask: number, decision: RecoveryDecision): Promise<SubTask>
  synthesize(turn: number): Promise<Answer>
  trace(turn: number): Promise<OrchestrationTrace[]>

  // 命令与模块
  executeCommand(command: Command): Promise<CommandResult>
  resolveCommand(turn: number): Promise<Command>
  executeGoal(goal: Goal): Promise<GoalResult>
  getGoal(turn: number): Promise<Goal>
  setGoal(turn: number, content: string): Promise<Goal>
  updateGoal(turn: number, content: string): Promise<Goal>
  clearGoal(turn: number): Promise<Goal>
  executePlan(plan: Plan, mode: 'command' | 'auto'): Promise<PlanResult>
  getPlan(turn: number): Promise<Plan>
  updatePlan(turn: number, patch: Partial<Plan>): Promise<Plan>
  rescorePlan(turn: number): Promise<Score[]>
  executeCompact(compact: Compact): Promise<CompactResult>
  compress(session: number, strategy: 'summary' | 'prune' | 'hybrid'): Promise<Compact>
  executeFeedback(turn: number, content: string): Promise<Directive>
  executePermission(turn: number, content: string): Promise<PermissionResult>

  // 理解过程（四阶段）
  comprehend(prompt: string, context?: Context): Promise<Comprehension>
  runComprehensionStage(comprehension: number, stage: ComprehensionStage): Promise<ComprehensionStageRecord>
  emotionStage(prompt: string): Promise<EmotionStageOutput>
  thinkStage(prompt: string, emotion: Emotion): Promise<ThinkStageOutput>
  heuristicStage(prompt: string, think: ThinkStageOutput): Promise<HeuristicStageOutput>
  convergeStage(prompt: string, heuristic: HeuristicStageOutput): Promise<ConvergeStageOutput>

  // 组织过程
  organize(comprehension: number): Promise<Plan>
  createPlan(turn: number, comprehension: number): Promise<Plan>
  scorePlan(plan: number): Promise<Score[]>
  computePlanScore(plan: number): Promise<number>
  shouldRebuild(plan: number): Promise<boolean>
  rebuildPlan(plan: number): Promise<Plan>
  recordRebuild(plan: number, attempt: number, reason: string, dimension: string, before: string, after: string): Promise<PlanRebuild>

  // 六维职能 Profession
  recordProfession(turn: number, profession: Profession, actor: string, status: string): Promise<ProfessionRecord>
  checkQualification(turn: number, route: string): Promise<boolean>
  checkDecision(turn: number): Promise<boolean>
  checkPersonnel(turn: number): Promise<boolean>

  // 验证档位
  executeLow(turn: number): Promise<LowOutput>
  executeMedium(turn: number): Promise<MediumOutput>
  executeHigh(turn: number): Promise<GlobalOutput>

  // 贝叶斯引擎
  definePrior(turn: number, hypothesis: string, source: string): Promise<Prior>
  computeLikelihood(evidence: number, hypothesis: string, weight: number): Promise<Likelihood>
  updatePosterior(turn: number, hypothesis: string, evidence: number): Promise<Posterior>
  computeEIG(turn: number, candidate: string): Promise<number>
  defineRoute(turn: number, name: string, description: string): Promise<Route>
  rankRoute(turn: number): Promise<Route[]>
  selectRoute(turn: number): Promise<Route>
  defineFailureRoute(turn: number, name: string, description: string): Promise<FailureRoute>
  rankFailureRoute(turn: number): Promise<FailureRoute[]>
  computeBoundary(turn: number, failureRoute: number): Promise<Boundary>
  shouldStop(turn: number): Promise<boolean>
  checkProgressInvariant(turn: number): Promise<ProgressInvariant>
  calibrate(model: string, dimension: string): Promise<Calibration>

  // 接管
  shouldTakeover(type: TakeoverType): Promise<boolean>
  requestTakeover(type: TakeoverType, payload: TakeoverPayload): Promise<TakeoverResult>
  resolveTakeover(handle: string, result: TakeoverResult): Promise<void>
  cancelTakeover(handle: string): Promise<void>
  getTakeover(handle: string): Promise<Takeover>
  listTakeover(session: number): Promise<Takeover[]>

  // 认知编排
  orchestrateStage(turn: number, stage: CognitiveStage): Promise<Cognition>
  probe(turn: number, entropy: number): Promise<Probe>

  // 缓存优化
  decorateRequest(options: GenerateOptions, strategy: CacheStrategy): Promise<GenerateOptions>
  reorderMessages(messages: Message[], strategy: CacheStrategy): Message[]
  stripDynamicContent(text: string): string
  fingerprint(messages: Message[]): string
  checkEffortCacheBreak(session: number, newEffort: UnifiedEffort): boolean
  getCacheStats(session: number): CacheStats

  // 预测与执行
  predict(plan: number, step: string): Promise<Predict>
  compare(predict: number, reality: number): Promise<number>

  // 情感
  detectEmotion(turn: number): Promise<Emotion>
  calibrateEmpathy(emotion: Emotion): Promise<EmpathyProfile>
  detectCrisis(turn: number): Promise<Crisis | null>

  // 学习
  classify(error: number): Promise<Error>
  decideRemedy(error: number): Promise<ErrorRemedy>
  learn(error: number): Promise<void>

  // 评分
  score(category: ScoreCategory, target: number, dimension: string): Promise<Score>
  scoreAll(category: ScoreCategory, target: number): Promise<Score[]>

  // 资源
  resolve(handle: string): Promise<Resource>
  getVision(session: number, resource: number): Promise<ResourceVision>
  write(session: number, resource: number, content: Buffer): Promise<Version>
  merge(session: number, resource: number, strategy: MergeStrategy): Promise<MergeResult>

  // 权限
  check(subject: string, grant: string[]): Promise<CheckResult>
  request(subject: string, grant: string[], reason: string): Promise<RequestResult>
  revoke(subject: string, grant?: string[]): Promise<void>

  // 生命周期
  cleanupExpired(): Promise<void>
  metrics(): CoordinationMetrics
}
```

### 18.2 工具注册

新增工具：

| 工具名 | 描述 | 输出 |
|---|---|---|
| `coordination_profession` | 查询/设置职能（仅任务开始前可设置） | ProfessionRecord |
| `coordination_professionlock` | 查询职能锁定状态 | boolean |

其余工具与 v22 一致。

### 18.3 UI Slot 注册

与 v22 一致。


## 第十九章 · 配置

在 v22 基础上新增 `profession` 配置段：

```typescript
profession: Schema.object({
  enabled: Schema.boolean().default(true),
  lock: Schema.boolean().default(true),          // 强制锁定，不可关闭
  default: Schema.string().default('execution'),
  rebuildCanReselect: Schema.boolean().default(true),
  abandonCanReselect: Schema.boolean().default(true),
  audit: Schema.boolean().default(true),
  errorHint: Schema.boolean().default(true),
}),
```

其余配置与 v22 一致。

**v24 情景配置（`scenes`）：**

```typescript
scenes: Schema.object({
  dialogue: Schema.object({
    thinking: Schema.string().default('disabled'),
    requirePlan: Schema.boolean().default(false),
    requireScore: Schema.boolean().default(false),
    maxIteration: Schema.number().default(1),
  }),
  writing: Schema.object({
    thinking: Schema.string().default('enabled'),
    reasoningEffort: Schema.string().default('high'),
    requirePlan: Schema.boolean().default(true),
    requireScore: Schema.boolean().default(true),
    requireOutline: Schema.boolean().default(true),
    requireRevision: Schema.boolean().default(true),
    allowBash: Schema.boolean().default(false),
    allowWeb: Schema.boolean().default(true),
    sandboxOnly: Schema.boolean().default(false),
    maxIteration: Schema.number().default(3),
    scoreThreshold: Schema.number().default(0.6),
  }),
  office: Schema.object({
    thinking: Schema.string().default('disabled'),
    requirePlan: Schema.boolean().default(true),
    sandboxOnly: Schema.boolean().default(true),
  }),
  research: Schema.object({
    thinking: Schema.string().default('enabled'),
    reasoningEffort: Schema.string().default('high'),
    requirePlan: Schema.boolean().default(true),
    requirePredict: Schema.boolean().default(true),
    requireCitation: Schema.boolean().default(true),
    maxIteration: Schema.number().default(3),
  }),
  engineering: Schema.object({
    thinking: Schema.string().default('enabled'),
    reasoningEffort: Schema.string().default('high'),
    requirePlan: Schema.boolean().default(true),
    requirePredict: Schema.boolean().default(true),
    allowBash: Schema.boolean().default(true),
    maxIteration: Schema.number().default(3),
  }),
  iterate: Schema.object({
    thinking: Schema.string().default('enabled'),
    reasoningEffort: Schema.string().default('high'),
    requireScore: Schema.boolean().default(true),
    maxIteration: Schema.number().default(3),
    scoreThreshold: Schema.number().default(0.6),
  }),
}),
```

**写作场景的额外配置项：**

| 配置 | 默认 | 说明 |
|---|---|---|
| `requireOutline` | true | 必须先生成大纲，再写正文 |
| `requireRevision` | true | 必须有至少一轮修订 |
| `allowBash` | false | 写作不需要 bash |
| `allowWeb` | true | 可选联网搜索（资料引用、事实核查） |
| `sandboxOnly` | false | 写作不强制沙箱 |


## 第二十章 · 打包与安装

与 v22 一致。


## 第二十一章 · 一句话总结

```text
DeepSeek Coordination 是 DSH 的协调插件，通过 Cordis 标准扩展点接入；
Agent 可以在跨任务之间切换职能，但在一次任务当中职能只能有一个，中途不能切换；
唯一例外是重建任务（rebuild）或丢弃任务（abandon）——新任务可以重新选择职能；
职能锁定与“做工作的代理永远不能标记任务完成”同源，防止中途跳槽、兼职多职、职责稀释；
锁定粒度：非统筹模式锁定 Turn，统筹模式锁定 Turn（父代理）和 SubTask（子代理）；
锁定实现：服务层校验 + SQLite 触发器，双重防御，fail-closed；
ProfessionRecord 从 v22 的“每轮六条”修正为“每个任务一条”；
统筹模式下父代理、子代理、验收者各自锁定职能，通常为 outcome/decision、execution、outcome；
执行者与验收者必须是不同的 agent 实例，承担不同的职能；
六维职能 Profession：决策 / 成果 / 资源 / 人员 / 任职 / 执行；
任职必须与人员、决策分离，任职分离是强制开关；
统筹是第五种交互选项，决定 Agent 如何组织子代理，而非如何直接回应；
统筹职责三分：父代理拆解与决策、子代理隔离执行、验收者独立判定；
做工作的代理永远不能标记任务完成，验收门控由服务端和 SQLite 约束强制执行；
子任务 = 四元组（model, task, tools, context）+ 验收标准 + 依赖关系 + 职能绑定；
验收标准派发前定义、不可后撤，确定性 ground truth 优先，judge 模型仅在无法确定性判定时使用；
验收者只判定 PASS/FAIL 并生成 RecoveryPacket，恢复决策归父代理；
子代理严格继承父代理的 effort，model 可按任务复杂度覆盖并记录原因；
依赖解析 + 拒绝循环 + maxReject 上限 + fail-closed 默认 + 终态不可逆；
治理轨迹事件优先、哈希链不可篡改，新增 lock/rebuild/abandon 事件；
统筹不是默认开启，按用户显式选择或 Plan 复杂度阈值触发；
命令与模块一对一对接：goal → Goal 模块，plan → Plan 模块（命令模式），compact → Compact 模块，feedback → Directive 模块，permission → Permission 模块；
每一轮对话（命令 = none 时）都必须通过 Comprehension + Organization 建立目标 Plan；
理解过程（Comprehension）：固定四阶段，依次为情感 → 思维 → 启发 → 收束；
目标计划（Plan）：必须生成、必须评分、低分时必须重建（最多 3 次，超过则升级人类审查）；
四维会话配置：交互（感情 / 思维 / 启发 / 收束 / 统筹）+ 情景（对话 / 写作 / 办公 / 研究 / 工程 / 迭代）+ 验证（low / medium / high）；
情景写作：内容创作与文本打磨，强制大纲（requireOutline）与修订轮次（requireRevision），必须有质量评分，不启用 bash，可选联网搜索；
写作质量评分维度侧重 clarity / coherence / audience；收束阶段明确受众、语气、字数、格式四个边界；
验证三档都联网检索并做贝叶斯更新，差异在检索预算（1×3 / 2×5 / 4×8）与证据范围（当轮 / 当前会话 / 本地全部内容）；
品牌和模型的权威来源是 DSH ctx.llm，不是 Coordination；
Coordination 通过 listProviderView / resolveProviderView / listModelCapability 只读查询 DSH 视图；
Coordination 不定义品牌清单、不定义模型 catalog、不翻译 reasoningEffort；
Coordination 只补充缓存优化行为约束；
缓存命中指标从 DSH TokenUsage 读取，不自行计算；
buildModelRequest 降级为 decorateRequest，只做缓存装饰，不翻译 effort；
设置中的模型适配是只读视图 + 跳转 DSH Settings → Models；
窗体 UI 与接管：在设置中开启接管后，本插件可拦截 DSH 默认弹窗；
贝叶斯引擎：log-odds 更新 + KL 收敛 + 过程奖励模型 + 进展不变量；
UI 下拉框：新增职能下拉框，浅蓝灰背景 #E8EDF2，圆角 8px，无边框无 outline，悬浮变深 #D0D9E2，150ms transition；
接管窗体：浅蓝灰背景 #E8EDF2，圆角 12px，阴影 0 4px 24px rgba(0,0,0,0.16)，200ms transition；
所有注册通过 ctx.effect 自动清理，插件卸载无残留；
国际化：UI、工具提示、设置、错误提示与模型可见工具描述按宿主语言中/英切换，数据库只存英文规范值。
```


## 第二十二章 · 国际化（i18n）

- **语言权威：** DSH Client 的 `ctx.locale`（`getLocale()` / `subscribe()` / `setLocale()`）。本插件不自建语言选择器，只跟随宿主；语言变化通过 `locale/change` 或 LocaleFace 订阅同步。
- **语言集合：** `zh-CN`（默认与回退）与 `en-US`。未知 locale 归一到 `zh-CN`；`en-*` 归一到 `en-US`。
- **唯一文案源：** `src/shared/i18n.ts`。中文文案与 §6.1-6.3、§15.1、§15.2 一致，英文字典逐键对应。UI、宿主模块与工具描述不得再硬编码第二份用户可见文案；`src/shared/enum.ts` 的标签/提示常量是中文投影，仅用于兼容与审计。
- **用户可见面：** 五个下拉框、每个选项 tooltip、设置页、锁定/离线/拒绝提示、错误提示，全部通过字典取文案。
- **模型可见面：** `coordination_*` 工具的 `description` 与参数说明按宿主当前语言生成；语言切换时 dispose 旧注册并以新语言重新注册工具。工具 `name` 始终是英文规范名。
- **数据层：** 数据库只存英文规范值（profession / scene / interaction / validation / command）；展示层翻译。日志与审计保留规范值。
- **主机语言同步：** Client 通过 `POST /deepseek-coordination/locale` 上报当前 locale；Host 在内存中更新并重建工具描述，不落库，不修改 DSH 的语言设置。Host 尚未收到上报时使用 `ui.locale` 配置（默认 `auto` → `zh-CN`）。


本文档到此结束。任何与本文件冲突的实现，以本文件为准。
