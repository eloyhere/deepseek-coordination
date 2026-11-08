# wire.md — AMP × DSH 上下文接线规范

> 状态：设计稿 v1 + P0–P4 已实现（2026-11-09）
> 适用：`deepseek-coordination` 0.24.0 · `attention-manifest-protocol` 0.7.9 · DeepSeek Harness 0.2.2-rc.1
> 读者：宿主插件维护者、AMP 适配器实现者、需要审计模型上下文的部署方
> 规范词：**必须**（MUST）、**应当**（SHOULD）、**可以**（MAY）、**不得**（MUST NOT）

## 0. 一句话

AMP 不为 DSH 再写一份上下文。它把 DSH 已经存在的事实登记成**可预算、可排除、可追溯的注意力指针**，只在 `<amp_attention>` 这个受预算约束的包里向模型呈现“索引”；原文仍由 DSH 的会话日志、附件存储、spill 文件和工具结果拥有。

## 1. 为什么要有 wire.md

宿主已经接好三件事：

- `src/host/prompt.ts` 把 AMP 契约注册为系统提示词段与运行时上下文；
- `src/host/context.ts` 每回合编译 AMP 注意力包；
- `src/host/sync.ts` 把 DSH 的会话、轮次、目标、todo 与工具调用投影进 AMP。

但还有四类上下文没有接线：

1. **用户带进来的**：`@file`、图片/文件附件、`@session`。
2. **运行中注入的**：`agent.steer()`、`agent.inject()`。
3. **为省 token 被处理的**：spill、retention、pruner、compact。
4. **从别处继承的**：session fork、subagent fork。

它们今天要么完全绕过 AMP，要么只在 DSH 侧生效。结果是 AMP 的注意力包看不到“这一步真正被接纳了什么”，也无法解释“哪些内容被刻意排除”。

还有一个具体的现存差距：`AmpContextOptimizer` 在系统提示词**组装时**读取 `user/message`，而 DSH 的当前用户消息是在 `agent/pre-step` 之后才提交的。于是同一轮里 AMP 的 `prompt` 项可能指向上一条 `user/message`（例如 time-context 快照），而不是用户刚发的那句话。wire.md 的一个核心目标，就是在 `agent/pre-step` 捕获“本步实际接纳的消息”，并在运行时上下文刷新时使用它。

### 1.1 目标

- 每个模型可见的 AMP 项都能追溯到 DSH 的某个事件、指针和版本。
- 每个被预算裁掉、过期、失效或转存的项都有排除记录，不伪装成“已读”。
- 同一份内容不在 DSH 消息和 AMP 包里重复出现；AMP 只给索引，不复制载荷。
- AMP 故障不阻塞 DSH 轮次；AMP 不伪造证据、收据或业务验收。
- fork、compaction、subagent 继承不复制注意力驻留，而是重新派生。

### 1.2 非目标

- 不把 AMP 变成第二份 transcript。
- 不替代 DSH 的 compaction、spill、retention 或 sandbox。
- 不让 `AttentionPointer` 变成读取授权或工具执行授权。
- 不改变 DSH 的会话日志格式，不向会话追加 AMP 自定义事件。
- 不为每条消息都生成 evidence；证据是“claim 需要 warrant”时才产生的，不是上下文的副产品。

## 2. 不变量

| ID | 不变量 | 检查点 |
|---|---|---|
| I1 | DSH 会话日志是唯一真相源；AMP 只是投影。 | 任何 AMP 状态必须能从 `session/event` 重建。 |
| I2 | 指针不是授权。 | `CompiledContext.authorization` 恒为 `not_granted`。 |
| I3 | 不重复载荷。 | `<amp_attention>` 中不得出现 base64、完整工具输出或完整会话 transcript。 |
| I4 | 版本先行。 | 每个 pointer 必须能被 `currentVersion` 解析；解析失败按 `version` 排除。 |
| I5 | 排除必须记账。 | 每个被丢弃的项必须产生 `ContextExclusion` 或宿主侧 exclusion ledger。 |
| I6 | 预算按序列化投影计。 | 使用 AMP 编译器的 `countTokens(serializedItem)`，不是摘要字符数。 |
| I7 | 失败开放。 | AMP 编译/写入失败不得让 DSH 的 step 失败；记录后继续。 |
| I8 | 不写 DSH 事件。 | AMP 只观察 `session/event`、`agent/*` 与工具事件，不得 append 会话事件。 |
| I9 | 派生不继承驻留。 | fork/compaction 不复制 attention residency；重新派生。 |
| I10 | 信任不升级。 | `derived`/`secondary` 内容不得变成 `trustedInstruction`。 |

## 3. 接线总图

```text
DSH 会话日志 / 工具 / 附件 / spill / compaction
        │
        ├─ session/event ───────────────► src/host/sync.ts ──► AMP workflow
        │                                                   (session/turn/goal/plan/action)
        │
        ├─ agent/pre-step ──────────────► wire.capture() ──► PendingInput
        │   (本步最终消息批次)                                │
        │                                                   ▼
        ├─ tool/result + spill/retention/prune ─────────► pointers + exclusions
        │                                                   │
        ├─ compaction/* ────────────────► compaction record ─┤
        │                                                   │
        └─ fork/subagent ───────────────► provenance ────────┤
                                                            ▼
ctx.systemPrompt.context ◄──── <amp_attention> ◄──── kernel.flow.compileTurnContext()
        │
        ▼
   DSH 模型请求（system prompt + 当前消息 + 工具 schema）
```

三条规则：

1. **DSH 拥有消息，AMP 拥有索引。** DSH 已经发出去的 user/assistant/tool 消息不由 AMP 重写。
2. **pre-step 是唯一能看到“本步最终批次”的位置。** 所有输入类通道都在这里捕获。
3. **runtime context 是唯一模型可见的 AMP 包。** 其他通道只影响它的选择、预算与排除。

## 4. Wire Envelope

### 4.1 类型

```ts
type WireChannel =
  | 'prompt' | 'goal' | 'plan' | 'tool' | 'workspace'
  | 'file' | 'attachment' | 'session-ref'
  | 'steer' | 'inject'
  | 'spill' | 'retention' | 'prune'
  | 'compaction' | 'fork' | 'subagent'

type WireTrust = 'host' | 'user' | 'workspace' | 'external' | 'derived'

interface WireItem {
  /** dsh:<channel>:<sessionId>:<turn>:<slot> */
  id: string
  channel: WireChannel
  scope: {
    tenantId: string
    principalId: string
    sessionId: string
    turnId: string
    workspaceId?: string
  }
  /** 指向领域事实，不是授权。 */
  pointer: {
    kind: string
    id: string
    version: string
    uri?: string
    digest?: string
  }
  /** 只放模型需要看的索引信息；不得复制原文。 */
  summary: string
  scores: {
    relevance: number
    urgency: number
    confidence: number
    importance: number
  }
  budget: { tokens: number; bytes?: number; calls?: number }
  expiresAt: string
  reason: string
  trust: WireTrust
}

interface WireExclusion {
  id: string
  version: number
  reason: 'scope' | 'expired' | 'stale' | 'unmounted' | 'version' | 'budget'
  pointer?: WireItem['pointer']
  note?: string
}
```

`WireItem` 到 `CreateAttentionInput` 的映射是直接的：`id`、`summary`、`pointer`、`scope`、`budget`、`expiresAt`、`reason` 原样传入，`scores` 作为 `scores`，`trust` 只进入宿主侧的信任判断，不写入 AMP 模型载荷。

### 4.2 ID 语法

```text
dsh:<channel>:<sessionId>:<turn>:<slot>
```

- `sessionId` 使用 DSH 的稳定 id；`turn` 使用十进制轮次号；`slot` 是通道内稳定槽位。
- `slot` 只允许 `[a-z0-9_-]`，不得包含用户文本、路径或空格。
- 超过 200 字符时，保留语义前缀，追加 `sha256` 前 12 位。
- 同一 `id` 在同一 turn 内不得指向两个不同版本；需要刷新时走 `attention.update()` 或换 step 限定 id。

建议的 slot：

| channel | slot 示例 |
|---|---|
| `prompt` | `prompt` |
| `goal` | `goal` |
| `plan` | `plan` |
| `tool` | `tool-<callId>` |
| `workspace` | `workspace` |
| `file` | `file-<n>` |
| `attachment` | `attachment-<n>` |
| `session-ref` | `session-<n>` |
| `steer` | `steer-<messageId>` |
| `inject` | `inject-<messageId>` |
| `spill` | `spill-<callId>` |
| `retention` | `retention-<callId>` |
| `prune` | `prune-<callId>` |
| `compaction` | `compaction-<summarySeq>` |
| `fork` | `fork` |
| `subagent` | `subagent-<childId>` |

### 4.3 Pointer 版本来源

| kind | id | version | uri / digest |
|---|---|---|---|
| `prompt` | DSH message id | `seq:<n>` | — |
| `turn` | AMP turn id | turn entity version | — |
| `goal` | AMP goal id | goal revision | — |
| `plan` | AMP plan id | plan revision | — |
| `tool` | DSH `callId` | `seq:<resultSeq>` 或 `sha256:<digest>` | — |
| `file` | 工作区相对路径 | `stat:<mtimeMs>:<size>` 或 `sha256:<digest>` | `dsh-file:<path>` |
| `attachment` | attachment id | `sha256:<digest>` 或 `bytes:<n>` | `dsh-attachment:<id>` |
| `session` | 源 session id | `seq:<capturedThroughSeq>` | `dsh-session:<canonical-base64url>` |
| `message` | DSH message id | `seq:<n>` | — |
| `spill` | `SpillRef.locator` | `bytes:<n>` | locator + `sha256:<fullText>` |
| `compaction` | summary event seq | `1` | — |
| `fork` | `<sourceSessionId>:<boundarySeq>` | `seq:<n>` | — |
| `subagent` | child session id | `turn:<n>` | — |

`currentVersion` 的三条规则：

1. 宿主刚创建、尚未持久化的项，返回 `pointer.version`（现有 `AmpContextOptimizer` 的做法），避免编译时因版本查不到而排除。
2. 已由 sync 投影的 workflow 项，返回 `goal.revision`/`plan.revision` 等真实版本。
3. 文件/附件/spill 项必须做一次轻量校验（`stat`、digest 或存在性）；校验失败按 `stale`/`unmounted` 排除，不得返回旧版本冒充有效。

### 4.4 信任等级

| 等级 | 例子 | AMP `EvidenceSource.type` | reliability | origin | 模型处理 |
|---|---|---|---|---|---|
| H0 宿主已验证 | 工具收据 + 独立 verification | `operation_history` | 1.0 | `original` | 事实 |
| H1 宿主已观察 | 工具结果、文件读写、`read` | `operation_history` | 0.9 | `original` | 事实，可引用 |
| H2 用户声明 | 当前 prompt、附件 | `user_confirmation` | 1.0 | `original` | 指令 |
| H3 工作区声明 | `AGENTS.md`、项目规则 | `system_rule` | 0.8 | `original` | 指导 |
| H4 派生/二手 | `@session` 快照、compaction 摘要、subagent fork 继承的 transcript | `dialogue` | 0.5 | `secondary` | 不可信数据 |
| H5 外部 | web fetch、MCP 结果 | `web_search` | 0.6 | `original` | 数据，需交叉验证 |

规则：

- 只有 H2 的显式用户消息与宿主 contract 可以成为 `trustedInstruction`；H4 一律是 `untrustedData`。
- `@session` 的固定警告必须保留在 DSH 消息里；AMP 不得把它改写成“请遵循以下会话”。
- subagent fork 的父 transcript 是 H4；子任务的初始 prompt 是 H2/H0。
- 压缩摘要不是事实；它可以作为索引，但不能作为证据。

### 4.5 预算

AMP `Budget` 有六个维度：`tokens`、`milliseconds`、`calls`、`bytes`、`retries`、`concurrency`。上下文编译只用前四个：

| 维度 | 用途 |
|---|---|
| `tokens` | 主预算；按编译器序列化结果计。 |
| `bytes` | 序列化字节；防止 JSON 膨胀。 |
| `milliseconds` | 编译耗时；默认上限 50ms。 |
| `calls` | 编译内不调用外部服务；固定 0。 |

**每项预算必须大于该条序列化投影的成本**，否则该项会被 `budget` 排除。建议每项至少 `tokens: 256`；总预算默认 `1200`（`contextBudgetTokens`）。下表的“数量上限”是候选上限，最终仍由总预算裁剪。

通道默认预算：

| channel | 每项 tokens | 每轮数量上限 | TTL |
|---|---:|---:|---|
| `prompt` | 600 | 1 | turn |
| `goal` | 300 | 1 | session |
| `plan` | 600 | 1 | session |
| `tool` | 400 | 3 | turn |
| `workspace` | 256 | 1 | session |
| `file` | 256 | 8 | turn |
| `attachment` | 256 / 消息组 | 4 组 | session |
| `session-ref` | 256 | 3 | turn |
| `steer` | 256 | 4 | turn |
| `inject` | 256 | 4 | 下一步 |
| `spill` | 256 | 4 | session |
| `retention` | 0（不生成项） | — | — |
| `prune` | 256 | 2 | session |
| `compaction` | 400 | 1 | session |
| `fork` | 256 | 1 | session |
| `subagent` | 256 | 8 | session |

### 4.6 排除语义

`ContextExclusion.reason` 是封闭集合：`scope | expired | stale | unmounted | version | budget`。不要在这里使用 `superseded`/`over_budget`；那是 attention 生命周期 `ContextPruneReason` 的词汇。

| 情形 | reason | 记录 |
|---|---|---|
| 跨 tenant/session/turn | `scope` | 编译器自动产出 |
| 路径越出工作区 | `scope` | `hostExclusions`（对象未创建） |
| TTL 到期、turn 已结束 | `expired` | 编译器自动产出 |
| 文件 mtime/digest 变化 | `stale` | 编译器自动产出 |
| pruner/compaction 替换 | `version` 或 `stale` | tombstone 走编译器；无对象写 `hostExclusions` |
| 附件被 image-offload、spill 文件丢失 | `unmounted` | 对象存在走编译器；否则 `hostExclusions` |
| pointer 版本无法解析 | `version` | 编译器自动产出 |
| 预算不足 | `budget` | 编译器自动产出 |

**三本账**。`compileContext` 只会为它**收到的对象**产出 `ContextExclusion`；从未成为 attention 对象的东西（越界路径、stat 失败、self-inject）必须写入宿主侧 `hostExclusions`；retention 剪掉的项写入 `RetentionLedger`。`/amp/context` 分别返回三者，不要合并成一个数字。

**Tombstone**。要让一个已被移除/替换的项出现在编译器排除里，必须把它作为 `objects` 传给 `compileTurnContext`，而不是只从 `create` 里删掉：

| tombstone 状态 | 编译器 reason |
|---|---|
| `mounted: false` | `unmounted` |
| `stale: true` | `stale` |
| `expiresAt` 已过 | `expired` |
| `pointer.version` 与 `currentVersion` 不一致 | `version` |

pruner/compaction 用 `stale: true` 或版本不匹配的 pointer；不要用 `ContextExclusion` 里不存在的 `superseded`。

**保留策略的排除**（retention 剪掉的项）不经过 `compileContext`，因为那些项从未成为 attention 对象。它们写入宿主侧 `RetentionLedger`：

```ts
interface RetentionRecord {
  callId: string
  tool: string
  strategy: 'head' | 'tail' | 'headTail'
  limit: number
  kept: number
  omitted: { kind: 'exact'; count: number } | { kind: 'bytes'; bytes: number } | { kind: 'unknown' }
  at: string
}
```

`/deepseek-coordination/amp/context` 应当同时返回 `compilerExclusions`、`hostExclusions` 与 `retentionOmissions`，不要合并成一个数字。

## 5. 通道规范

每个通道按同一模板描述：**触发 → 采集 → Wire 映射 → AMP 动作 → 失败/边界**。

### 5.1 `@file`

**触发**：用户在 prompt 文本里输入 `@path` 或 `@"path with spaces"`。DSH 的 `dsh-file-reference` 只负责补全与文本插入，**不读取文件内容**。

**采集**：

- 在 `agent/pre-step` 的最终 `decision.messages` 中扫描 text block。
- 语法与 `dsh-file-reference` 保持一致：token 位于开头或空白之后；忽略 email 中间的 `@`；引号路径支持空格。
- 相对路径以 `agent.session.header.cwd` 为根解析；绝对路径必须仍位于工作区根内。
- 不做内容读取；最多做一次 `stat` 获取 `mtimeMs/size`。

**Wire 映射**：

```json
{
  "id": "dsh:file:session-a28d:7:file-1",
  "channel": "file",
  "pointer": {
    "kind": "file",
    "id": "src/host/context.ts",
    "version": "stat:1762540000000:8694",
    "uri": "dsh-file:src/host/context.ts"
  },
  "summary": "@src/host/context.ts — path reference only; not read (8,694 bytes)",
  "scores": { "relevance": 0.9, "urgency": 0.5, "confidence": 0.9, "importance": 0.7 },
  "budget": { "tokens": 256 },
  "expiresAt": "<turn end>",
  "reason": "the user referenced this path in the prompt",
  "trust": "user"
}
```

**AMP 动作**：创建 attention 对象；不创建 evidence。若模型随后用 `read` 读取该文件，工具结果产生 H1 evidence，并把 pointer.version 更新为内容 digest。

**失败/边界**：

- 路径越出工作区 → 不创建项，写 `hostExclusions`（reason `scope`）；不得读取。
- `stat` 失败 → 不创建项，写 `hostExclusions`（reason `stale`）；不得用 `unknown` 版本混过编译。
- 只解析 `@file`，不解析目录递归、不展开 glob、不读 outline。
- 同一路径重复 mention 只保留一项，`sources` 记录多个 message pointer。

### 5.2 附件（图片 / 通用文件）

**触发**：prompt 或命令携带图片/文件；DSH 在消息被接受前完成准入与持久化。

**采集**：

- `agent/pre-step` 的消息 content 中识别 `image` / `file` block。
- 读取 `ImageAttachmentRef`/`FileAttachmentRef` 的 `id`、`bytes`、`digest`、尺寸；**不得**读 base64。
- 通用文件只保留只读路径/句柄文本；图片只保留附件 id 与尺寸。

**Wire 映射**：

- 每个消息组一个 item（不按图片逐张建项，避免把昂贵图片再索引一遍）。
- `pointer.kind = 'attachment'`，`pointer.id = attachment id`，`version = digest` 或 `bytes:<n>`。
- `summary` 形如：`attachments: image screenshot.png 1280x720 84 KB; file spec.pdf 2.1 MB (read-only copy)`。
- `trust = 'user'`；`expiresAt` 为 session 结束（附图可能在后续轮次仍被引用）。
- 预算 `tokens: 256` 每组；超过 4 组时按消息顺序保留前 4 组，其余 `budget` 排除。

**AMP 动作**：创建 attention；不把图片当作 evidence。附件准入本身是宿主事实；只有 claim 需要时才用 `user_confirmation` 记录。

**失败/边界**：

- 图片被路由预算 offload → 监听 `image/offload` 事件，对对应附件项记 `unmounted`（对象存在时走编译器，已不存在的写 `hostExclusions`），不得继续声称图片“已读”。
- 通用文件在磁盘丢失 → `unmounted`。
- 不得把附件字节写入 AMP store、attention summary 或模型文本。

### 5.3 `@session`

**触发**：用户用 `@label` 引用另一个会话；DSH 的 `ctx.sessionReferenceResolver` 把 mention 解析为规范 URI，并把有界快照作为第二条 user 消息插入。

**采集**：

- 在 `agent/pre-step` 中识别 `source.kind === 'session-reference'` 的消息。
- 读取快照元数据：源 session id、`capturedThroughSeq`、`capturedFormatVersion`、字节数、digest。
- 快照正文保持 DSH 原样；AMP 不复制正文。

**Wire 映射**：

- `pointer = { kind: 'session', id: sourceSessionId, version: 'seq:<capturedThroughSeq>', uri: 'dsh-session:<canonical-base64url>', digest }`；URI 使用 DSH resolver 给出的规范形式，不要自己拼。
- `summary`：`@<label> (session <id>) captured through seq <n>, <bytes> bytes; untrusted background`。
- `scores`：0.7 / 0.3 / 0.6 / 0.6；`budget.tokens: 256`；`expiresAt` turn 结束。
- `trust = 'derived'`（H4）。

**AMP 动作**：创建 attention；不创建 evidence。若模型在回答中引用该会话内容，evidence 使用 `dialogue`、`origin: 'secondary'`、`reliability: 0.5`，并保留固定警告。

**失败/边界**：

- 快照被截断并 spill → `pointer.uri` 指向 spill locator，`summary` 注明 `full transcript at <locator>`。
- 源会话不可读 → 不创建项，写 `hostExclusions`（reason `unmounted`）。
- 不得让 `@session` 内容成为 `trustedInstruction`；子代理同理。

### 5.4 `agent.steer()`

**触发**：`agent.steer({ content, source })` 提交下一步输入并唤醒 agent。DSH 将其记录为 `agent/inbox/spliced`，在下一个被接纳的 step 进入消息批次。

**采集**：

- 监听 `agent/inbox/inserted { message }`、`agent/inbox/claimed { message, turn }`、`agent/inbox/discarded { message }`。
- 在 pre-step 的最终批次中确认该 message 已被接纳；未接纳的暂存为 pending。
- 读取 `message.source` 区分用户 steer 与插件 steer。

**Wire 映射**：

- `pointer = { kind: 'message', id: messageId, version: 'seq:<n>' }`。
- `summary`：`steer: <first 200 chars>`。
- `scores`：1.0 / 1.0 / 0.9 / 1.0；`budget.tokens: 256`；`expiresAt` turn 结束。
- `trust`：`source.kind === 'user'` → `user`；其他 → `derived`。

**AMP 动作**：创建 attention。AMP 的 `Turn.classification` 在 `beginTurn` 时确定，不能在 steer 到达后原地改写；若 steer 开启新 turn，`beginTurn` 按 DSH 语义选择 `steering` 或 `new_intent`。不创建 evidence。

**失败/边界**：

- turn 结束仍未接纳 → `expired` 排除；记录 message id。
- 被取消（`agent/inbox/discarded`）→ 不创建项；若已创建则 `unmounted`/`expired`。
- steer 不应被 AMP 重写成新消息；DSH 已经把它放进 inbox。

### 5.5 `agent.inject()`

**触发**：`agent.inject({ content, source })` 添加面向模型的上下文，但**不唤醒** agent；它落在下一个被接纳的 step。

**采集**：

- 同 5.4 的 inbox 事件与 pre-step 批次。
- `source.kind` 是插件命名空间；宿主维护一张 `trustedSources` 表（默认空）。

**Wire 映射**：

- `pointer = { kind: 'message', id: messageId, version: 'seq:<n>' }`。
- `summary`：`injected by <source.kind>: <first 160 chars>`。
- `scores`：0.7 / 0.2 / 0.6 / 0.8；`budget.tokens: 256`；`expiresAt` 下一步结束或 turn 结束。
- `trust`：默认 `derived`；只有 `trustedSources` 中的宿主插件可以是 `workspace`/`host`。

**AMP 动作**：创建 attention；默认 `untrustedData`。不创建 evidence。

**失败/边界**：

- 一直没有 step 消费它 → `expired` 排除；这正好符合“不唤醒”的语义。
- `source.kind` 以 `amp:` 开头（AMP 自己注入）→ 标记 `self`，**跳过索引**，防止反馈循环。
- 不得把注入正文再复制进 `<amp_attention>`；DSH 已经把它作为 user message 发出。

### 5.6 spill

**触发**：工具结果超过 `maxInlineTokens`，`dsh-spill-policy` 调用 `ctx.spillStore.saveText()`；工具结果变为“有界预览 + locator + retrievalHint”。

**采集**：

- 从 `tool/result` 事件读取 spill 引用：`locator`、`bytes`、`retrievalHint`。
- 若事件没有结构化 spill 字段，退化为扫描结果文本中的 locator；只做一次，不猜测。
- 校验 `locator` 指向的对象存在（本地文件 `stat`）；不存在则按 `unmounted` 处理。

**Wire 映射**：

- `pointer = { kind: 'spill', id: locator, version: 'bytes:<n>', uri: locator, digest: 'sha256:<fullText>' }`。
- `summary`：`<tool> output spilled: <bytes> bytes; <retrievalHint>`。
- `scores`：0.8 / 0.5 / 0.6 / 1.0；`budget.tokens: 256`；`expiresAt` session 结束。
- **预算只计内联预览**：`tokens` 与 `bytes` 不得把完整 spill 文本计进去；完整字节数放在 pointer digest/宿主 ledger。

**AMP 动作**：创建 attention；不创建 evidence。模型 `read` spill 后产生新的 H1 evidence。

**失败/边界**：

- spill 保存失败 → 原始内联结果保留；不创建项；记录 warning。
- locator 过期/清理 → `unmounted` 排除。
- 不得把 spill 全文写成 attention summary。

### 5.7 retention

**触发**：`ItemRetainer` / `TextRetainer` 在工具结果提交前裁剪，返回 `{ truncated, omitted }`。

**采集**：

- 在工具结果组装处读取 `omitted`（exact count / bytes / unknown）与 `strategy`、`limit`、`kept`。
- 该项不创建 attention 对象；它记录“被裁掉了什么”。

**Wire 映射**：

```ts
interface RetentionRecord {
  callId: string
  tool: string
  strategy: 'head' | 'tail' | 'headTail'
  limit: number
  kept: number
  omitted: { kind: 'exact'; count: number } | { kind: 'bytes'; bytes: number } | { kind: 'unknown' }
  at: string
}
```

- 写入宿主侧 `RetentionLedger`（`host-state.json` 或独立 JSON），key 为 `callId`。
- `/amp/context` 返回 `retentionOmissions`，并与 `compilerExclusions`、`hostExclusions` 分列。
- 若工具结果同时 spill，则 attention 侧优先记录 spill；retention 的 omitted 仍写入 ledger，二者不互相覆盖。

**AMP 动作**：不创建 attention；不创建 evidence。retention 是预算事实，不是语义判断。

**失败/边界**：

- `omitted.kind === 'unknown'` 时不得编造计数；只记录 `unknown`。
- 不得用 retention 结果去标记工具失败；`truncated` 不是 `incomplete`。
- 原始结果仍在会话日志中；retention 只影响模型可见文本。

### 5.8 pruner

**触发**：`dsh-compaction-tool-result-pruner` 在压缩压力确认后，把超大工具结果替换为 head/tail + marker，并写 `compaction/prune`（含 shadow price）。

**采集**：

- 监听 `session/event` 的 `compaction/prune`：源事件 seq、替换后的 `tool/result` seq、shadow price、阈值。
- 读取原 attention 项（若有）与 pointer 版本。

**Wire 映射**：

- 原项：`attention.update(..., { stale: true }, { expectedVersion, reason })`；把它作为 tombstone 传给下一次编译，得到 `stale` exclusion。
- 新项：`id = dsh:prune:<sessionId>:<turn>:prune-<callId>`；`pointer = { kind:'tool', id:callId, version:'seq:<newSeq>' }`；`summary = "pruned to <threshold> chars (head/tail); original at seq <sourceSeq>"`。
- `scores`：0.6 / 0.4 / 0.6 / 1.0；`budget.tokens: 256`；`expiresAt` session 结束。
- `trust = 'host'`（H1）。

**AMP 动作**：更新/创建 attention；不创建 evidence。pruner 的 shadow price 只用于预算账本，不得当作业务验证。

**失败/边界**：

- 替换失败 → 不更新 attention；记录错误；原项保持有效。
- 原项已被 compaction 遮蔽 → 只更新仍 mounted 的对象。
- 不得把 pruner 的 `middle pruned` 文本当作完整工具结果引用。

### 5.9 compact

**触发**：

- 自动压缩：`dsh-compaction-basic` 在压力或溢出时；
- 手动：`/compact`；
- 编程：`ctx.compaction.compactNow()` / `compactRegion()`。

**采集**：

- 监听 `compaction/start`、`compaction/summary`、`compaction/end`、`compaction/prune`。
- 从压缩产生的替代 `user/message`（其 `surfaceOp` 为 `replace`）读取 `startSeq`、`endSeq`、摘要文本与 digest；`compaction/summary` 本身是仅日志事件，不直接进模型历史。
- 从 token meter 读取 before/after 估算（若可用）。

**Wire 映射**：

宿主侧记录：

```ts
interface CompactionRecord {
  id: string
  sessionId: string
  summarySeq: number
  startSeq: number
  endSeq: number
  shadowedSeqs: number[]
  summaryDigest: string
  tokensBefore?: number
  tokensAfter?: number
  trigger: 'pressure' | 'overflow' | 'manual' | 'region'
  at: string
}
```

AMP 侧：

- 一个 attention 项：`id = dsh:compaction:<sessionId>:<turn>:compaction-<summarySeq>`；`pointer = { kind:'compaction', id: summarySeq, version:'1' }`；`summary = "compacted <n> events into a summary (<tokens> tokens); detail at seq <summarySeq>"`；`scores` 0.8 / 0.5 / 0.9 / 0.9；`budget.tokens: 400`；`trust = 'host'`（“发生过压缩”是宿主观察）。
- 每个被遮蔽的 turn/step：优先用 tombstone（原 attention 项 `stale: true` 或版本不匹配）产生 `ContextExclusion`；没有对应 attention 对象的，写 `hostExclusions`（reason `version`）。不要为了凑 exclusion 而臆造对象。
- 可选：调用 AMP `turnService.compactHistory(sessionId, policy)` 记录 turn 层分档。`policy.keepRecent` 对应 DSH 保留的近期 turn 数，`summarizeWithin` 对应被摘要的 turn 数，`sessionSummary` 取摘要文本（有界）。
- `TurnCompactionRecord` 作为 turn 层记录保存（由 `compactHistory` 产生）；**不得**在没有真实 receipt/verification 时伪造 evidence。

**AMP 动作**：attention + exclusion + 可选 turn compaction record；不写 DSH 会话事件。

**失败/边界**：

- 摘要失败 → 无 record；`compaction/summary-error` 已记录；不得创建空摘要项。
- 压缩与 turn 边界不对齐 → 只记录事件范围，不调用 `compactHistory`。
- `compactRegion` 的显式范围 → 同上，按 seq 记录，不假设整轮。
- `/compact` 忙碌 → 不记录；只返回 DSH 的 busy 结果。

### 5.10 fork

**触发**：`ctx.sessions.fork(source, boundary?, childSessionId?)`；Web UI 的聊天 fork 选择已结束轮次。

**采集**：

- 读取源 session、边界 seq、子 session id、`inheritedEventCount`。
- 记录 `ForkRecord`：`{ sourceSessionId, boundarySeq, childSessionId, inheritedEventCount, at }`。

**Wire 映射**：

- 新建 AMP session：`id = dsh:session:<childId>`，`sessionType: 'user_interactive'`，participants 从源 session 复制。
- **不复制 attention 对象**。新 session 的 attention 在第一次 `pre-step` 时从子日志重新派生。
- 若需要审计血缘：`ProvenanceRecord = { sourceId: sourceSessionId, sourceType:'agent', chain:[sourceSessionId, childSessionId], taint:['fork'] }`，保存在宿主侧 `ForkRecord`，不进入模型文本。
- 若源 session 有 `session_receipt`，子 session 关闭时的 `session_receipt.parentId` 可以指向它；没有就不创建。
- 预算：新建 budget tree；不继承已结算 usage；不复制 `budgetBalance`（避免双计）。

**AMP 动作**：`startSession` + provenance；不复制 attention/evidence/receipt。

**失败/边界**：

- fork 失败 → 不创建 AMP session；不得半初始化。
- 子 session 恢复时，使用子日志的 seq 重新派生，不引用父 seq。
- 普通 fork 与 subagent fork 的 `parentSession` 语义不同：前者是历史来源，后者是委派血缘；分类用 `origin`，不要混用。

### 5.11 subagent fork

**触发**：模型使用 `subagent_fork` 工具；子 agent 被 seeded 父会话的已完成轮次。对照 `subagent`（全新上下文，只带任务提示）。

**采集**：

- 父 session、子 session、初始任务、preset id、模型、reasoning effort、深度。
- 读取 DSH `maxDepth` 与 `maxActiveSubagents` 限制。

**Wire 映射**：

- 单次委派：`CooperationCoordinator.delegate({ taskId, parentTaskId?, cooperationId?, delegatorAgentId: parent, ownerAgentId: child, parentScope, requestedScope })`。省略 `cooperationId` 时 AMP 会惰性创建一个 implicit star cooperation，不需要宿主手工伪造多边结构。
- 多子代理/需要消息总线时才显式创建 `Cooperation`（star/hierarchical）。
- 起始收据：`ReceiptCore.kind = 'delegation_receipt'`，`parentId` 指向父收据（若有），`agentId` 子，`sessionId` 子，`executor` 记录 preset/model/skill 版本。
- 消息信任：父的初始任务 = `trustedInstruction`；**继承的父 transcript = `untrustedData`**。这是 subagent fork 最重要的信任边界。
- 结果：子 `submitResult({ outcome, value, provenance })`；父 `ResultAcceptance`；结果进入父的 evidence 时仍按 H4/H1 判断，不因“子代理说的”自动升级。
- attention：`id = dsh:subagent:<parent>:<turn>:subagent-<childId>`；`pointer = { kind:'subagent', id: childId, version:'turn:<n>' }`；`summary = "subagent fork <label> (<childId>) preset=<id> depth=<n>"`；`trust = 'host'`（委派关系是宿主事实）；`budget.tokens: 256`；`expiresAt` session 结束。

**AMP 动作**：delegation receipt + cooperation task + attention；子结果需要独立 verification 才能结算 goal/task。

**失败/边界**：

- `ACTIVATION_LIMIT_REACHED` / `maxDepth` 拒绝 → 不创建 task，不写 receipt；记录失败。
- 子会话冷恢复 → 不重新发 delegation receipt；沿用 descriptor 中的 preset/model 与已有 taskId。
- 子代理的输出不是父的事实；父必须自己 `read`/验证后才能升级为 H1。

### 5.12 `ctx.systemPrompt.section()`

**用途**：稳定的 AMP 契约文本。现有 `deepseek-coordination:amp-contract` 位于 `getSectionOrder('MCP_SERVERS') + 10`。

**规则**：

- 文本必须确定：不含时间戳、session id、当前 turn、随机值；否则每次请求都会改写前缀，破坏 KV cache。
- 一个 section 只表达一件事；长度建议 ≤ 1,500 字符。
- `name` 必须稳定；`order` 必须是有限数；优先使用 `getSectionOrder()` 的中心分配，避免和其他插件抢位。
- 需要保留字面 `{{...}}` 时设 `interpolate: false`；否则变量会被严格解析，未知引用会让组装失败。
- 不得把每轮动态内容塞进 section；动态内容走 `context()`。

**AMP 动作**：section 不是 attention 项，不参与预算/排除；它是固定指令。模块目录可以放在这里，但不要放 volatile 状态。

### 5.13 `ctx.systemPrompt.context()`

**用途**：每轮/每步动态运行时事实。现有五个：

| name | order | 内容 |
|---|---|---|
| `deepseek-coordination:bound` | `HARNESS_SOURCE + 10` | session/workspace 绑定 |
| `deepseek-coordination:takeover` | `HARNESS_SOURCE + 11` | 读接管提示（按需） |
| `deepseek-coordination:search-takeover` | `HARNESS_SOURCE + 12` | 搜索接管提示（按需） |
| `deepseek-coordination:file-write-takeover` | `HARNESS_SOURCE + 13` | 写接管提示（按需） |
| `deepseek-coordination:amp-attention` | `HARNESS_SOURCE + 30` | `<amp_attention>` 编译包 |

**规则**：

- `required: false`：用户/预设可以通过 `suppressRuntimeContext()` 关闭可选上下文。
- `interpolate: false`：编译包可能含 `{{`/`}}`，不得二次插值。
- 无内容时返回空字符串 `''`；**不得抛错**——context 求值失败会让整个提示词组装失败。
- 必须可在 `refreshContext` 时重新求值；不要在首次 assembly 时永久缓存。
- 同一个 name 的作用域内不得重复注册；scoped 注册会遮蔽 global。
- 内容长度：默认 `contextBudgetTokens`（1200 tokens）；不得把完整工具输出或会话 transcript 塞进来。

**`<amp_attention>` 格式**（保持现有）：

```text
<amp_attention budget="1200 tokens">
- [dsh:prompt:session-a28d:7:prompt] ...
- [dsh:file:session-a28d:7:file-1] @src/host/context.ts — path reference only; not read
</amp_attention>
Items excluded by the AMP attention budget remain in the AMP ledger as exclusions; do not assume they were read.
```

**关键修正**：`context` 回调必须读取 pre-step 捕获的 `PendingInput`，并在 pre-step 后使 `sessionId:turn` 缓存失效；否则当前实现会使用上一条 `user/message`。

### 5.14 `ctx.systemPrompt.variable()`

**用途**：给 section/context 模板提供小型标量；不适合放编译上下文。

建议变量：

| 变量 | 值 | 用途 |
|---|---|---|
| `amp_tenant` | `config.tenantId` | 契约文本 |
| `amp_contract` | `'AMP 0.7.9'` | 版本声明 |
| `amp_session` | `agent.id`（推荐 agent scope） | 绑定说明 |
| `amp_budget_tokens` | `config.contextBudgetTokens` | 预算说明 |
| `amp_module_count` | `host.agentModules.length` | 目录说明 |

规则：

- 变量名应当遵循 `[a-z][a-z0-9_]*` 的 DSH 提示词变量约定；重复注册会抛错。
- provider 返回 `string | undefined`；返回 `undefined` 时，引用它的 section 在渲染阶段会失败。只在不被引用的分支使用 `undefined`。
- global 与 scoped 的 provider 都接收组装上下文；`amp_session` 可以全局读取 `context.agent?.id`，但按 agent scope 注册更利于覆盖与释放。
- scoped 变量遮蔽 global；agent 释放时自动撤销。
- 不要把每轮变化的值放进变量再插值进 section；那等于每轮改写系统提示词前缀。

### 5.15 `agent/pre-step`

**角色**：捕获 + 审计，不是消息改写器。只有绑定/完整性问题可以拒绝 step；AMP 自身故障不得拒绝。

**必须做的事**：

1. `const decision = await next()`，拿到下游（含 DSH 自己的指令、time-context、session-reference）处理后的最终批次。
2. 只处理 `decision.kind === 'enter'`；`reject` 原样返回。
3. 扫描 `decision.messages`，按 5.1–5.5 提取 `@file`、附件、`@session`、steer、inject。
4. 写入 `PendingInput`，key 为 `sessionId:turn`；使 attention 缓存失效。
5. 记录捕获统计（items、bytes、elapsed），失败只记录不抛出。

**不得做的事**：

- 不得 `session.append()` 任何事件。
- 不得调用工具、发起网络请求或等待用户。
- 不得修改 `decision.messages`，除非有明确的脱敏策略并且保留了 `startsRequestSeries` 等字段。
- 不得因为 AMP 失败而拒绝 step。
- 不得在 pre-step 里做完整编译（编译应留给 `context()` 的求值/刷新）。

**代码骨架**：

```ts
ctx.on('agent/pre-step', async (context, next) => {
  const decision = await next()
  if (decision.kind !== 'enter') return decision
  // payload 形状以 DSH 实际类型为准：agent 与 turn 从 event data 读取。
  const agent = context.agent
  const turn = context.turn
  try {
    const captured = wire.capture(agent, decision.messages)
    pending.set(`${agent.id}:${turn}`, captured)
    optimizer.invalidate(agent.id, turn)
  } catch (error) {
    wire.recordFailure('pre-step', error)
  }
  return decision
})
```

**顺序**：应当注册为外层 wrapper（先于下游注册、调用 `next()`），这样能看到最终批次，而不是看到某个下游改写前的中间态。

**失败/边界**：

- 没有 `agent` 的 step（headless 某些路径）→ 跳过，不创建 pending。
- turn 结束 → 清理 pending；未消费的 steer/inject 按 `expired` 记录。
- AMP 禁用（`contextOptimization: false`）→ 仍然捕获（供审计），但不编译、不注入。

### 5.16 自定义 compaction 后端

**DSH 侧**：继承 `CompactionEngine`，实现 `compactIfNeeded`、`compactNow`、`compactRegion`。摘要通过 `ctx.llm.stream()` 产生，必须转发 `signal`。

**AMP 侧适配器**：

```ts
interface AmpCompactionSink {
  begin(agent: Agent, trigger: 'pressure' | 'overflow' | 'manual' | 'region'): Promise<string>
  record(record: CompactionRecord): Promise<void>
  fail(id: string, error: unknown): Promise<void>
}
```

`record()` 的职责：

1. 写入 `CompactionRecord`（宿主侧，idempotency key `dsh-compaction:<sessionId>:<summarySeq>`）。
2. `attention.update` 旧项 → `stale`；创建 compaction 索引项。
3. 为被遮蔽的 seq 生成 exclusion：有对应 attention 对象的用 tombstone；没有的写 `hostExclusions`。
4. 若 turn 对齐，调用 `turnService.compactHistory(sessionId, policy)`。
5. 把摘要请求的 `calls`/`tokens` 记入宿主预算账本；不写入 AMP 业务预算树（它不是 action）。

**不得做的事**：

- 不得 append `compaction/*` 事件；DSH 的 compaction seam 拥有这些事件。
- 不得用 `recordReceipt()` 伪造一次工具调用；compaction 不是 action。
- 不得对摘要调用 `verifyBusiness()` 并声称业务已验证；摘要只是模型文本。
- 不得在 `busy` 或取消时留下半条 record。

**失败映射**：

| DSH 失败 | AMP 行为 |
|---|---|
| `busy` | 不创建 record；返回 busy；不重试。 |
| `summary-error` | `fail(id)`；不创建 attention 项。 |
| 选区在压缩中变化 | 记录 attempt；不更新 attention；让 DSH 报告历史变化。 |
| `MODEL_SWITCH_COMPACTION_FAILED` | 保留旧 header；不写 record。 |
| 取消 | 清理临时 record；已提交的 exclusion 保留。 |

## 6. 一条 turn 的时序

```text
1. turn/start
   └─ sync: ensureSession/ensureTurn；创建 AMP turn（默认 interpreting）

2. assembly（首次）
   └─ systemPrompt.section/context/variable 求值
      └─ amp-attention 读取上一份 PendingInput（可能为空）

3. agent/pre-step（waterfall）
   ├─ DSH 自己的指令/时间/会话引用 listener 先运行
   ├─ wire.capture(decision.messages)
   │  ├─ @file → file items
   │  ├─ image/file blocks → attachment item
   │  ├─ session-reference → session item
   │  └─ steer/inject → message items
   ├─ PendingInput 写入；缓存失效
   └─ 返回原 decision

4. refreshContext（pre-step 之后、请求准入之前）
   └─ amp-attention 用 PendingInput + 会话状态重新 compileTurnContext
      └─ 结果作为本步运行时上下文快照

5. request
   └─ 模型看到 system prompt + 当前消息 + <amp_attention>

6. tool/call → tool/result
   ├─ spill/retention/pruner 先处理结果
   ├─ sync 写 action，必要时 recordReceipt/recordEvidence
   └─ attention 更新 tool 项

7. compaction（任意时刻）
   ├─ DSH 替换 surface 范围
   └─ AMP 记录 CompactionRecord + exclusions（不复制摘要全文）

8. turn/end
   └─ pending 清理；未消费的 steer/inject 记 expired；AMP turn 结算
```

如果 `refreshContext` 在该 DSH 版本/路由上不可用，则退化为“下一步生效”，并在 `/amp/context` 的 `lag` 字段中报告；不得假装当前步已包含。

## 7. 与 AMP 内核的映射

| Wire 需求 | AMP API | 注意 |
|---|---|---|
| 创建/挂载并编译 | `kernel.flow.compileTurnContext({ turnId, sessionId, budget, create, currentVersion, countTokens })` | `create` 中同 id 已存在时会**复用旧对象**，不会更新；刷新要走 `attention.update()` 或 step 限定 id。 |
| 更新摘要/分数 | `kernel.ports.attention.update(object, patch, { expectedVersion, now, reason })` | 乐观并发；版本冲突时重读再试。 |
| 挂载/卸载 | `kernel.ports.attention.mount/unmount` | `createAttention` 默认 `mounted:false`；`compileTurnContext` 会自动 mount 新建项。 |
| 排除记账 | `CompiledContext.exclusions` + 宿主 ledger | 编译器只排除它看到的对象；retention 的 omission 在宿主 ledger。 |
| 工具收据 | `kernel.flow.recordReceipt({ actionId, observation, kind, ... })` | 只在有真实 action/attempt 时使用。 |
| 证据 | `kernel.flow.recordEvidence({ receiptId, claim, source, level, ... })` | 需要真实 receipt/verification；不要为每条消息造证据。 |
| 业务验证 | `kernel.flow.verifyBusiness(...)` | 与证据独立；摘要不得调用。 |
| turn 历史压缩 | `turnService.compactHistory(sessionId, policy)` | 只在 DSH turn 与 AMP turn 对齐时调用。 |
| 委派 | `CooperationCoordinator.delegate/start/submitResult` | 单 subagent 可以只用 DelegatedTask；不要强行建多边 cooperation。 |
| 预算 | `kernel.flow.consumeBudget(...)` | 只对真实 action 计费；上下文编译的预算由 compiler 自己记。 |
| 检查点 | `ContextCheckpointRecord`（`context:<turnId>`） | 每次编译版本 +1；不要把不同 step 的编译写成同一个版本。 |

**`compileTurnContext` 的重要语义**：

- `create` 中已存在的 id 会直接复用，**不会**用新 `summary` 更新。
- `currentVersion` 会对 `pointer`、`sources`、`references` 全部调用；任一版本不匹配就排除。
- 排序是 `intensity + relevance + urgency + importance + confidence`；`intensity` 默认 0.5。
- 每项预算按序列化 JSON 计；预算不足时该项被排除，不会截断摘要。
- 没有 `tokens` 或 `bytes` 限制会抛 `invalid`；总预算至少给一个正数。
- 重复 id 会抛错；捕获阶段必须去重。

## 8. 失败与降级

| 情形 | DSH 行为 | AMP 行为 | 模型影响 |
|---|---|---|---|
| AMP 包未加载/内核不可用 | 正常继续 | 记录 `amp-unavailable`；跳过注入 | 无 `<amp_attention>` |
| `compileTurnContext` 抛错 | 正常继续 | 记录失败；返回 `''` | 本步无编译包 |
| 预算耗尽 | 正常继续 | 逐项 `budget` exclusion | 只看到高优先级项 |
| pointer 版本不匹配 | 正常继续 | `version` exclusion | 该项不出现 |
| 文件/附件/Spill 丢失 | 正常继续 | `unmounted`/`stale` exclusion | 索引提示不可用 |
| pre-step 捕获失败 | 正常继续 | 记录；pending 为空 | 本步退回会话事件派生的旧状态 |
| `attention.update` CAS 冲突 | 正常继续 | 重读一次；再失败则跳过本轮更新 | 摘要可能滞后一步 |
| compaction 摘要失败 | DSH 报错/重试 | 不写 record；不创建项 | 无压缩索引 |
| fork 失败 | DSH 报错 | 不创建 AMP session | 无 AMP 侧影响 |
| subagent 容量/深度拒绝 | DSH 报错 | 不创建 task/receipt | 无 AMP 侧影响 |
| AMP 写入磁盘失败 | 正常继续 | 记录 storage failure；保留内存状态 | 面板可能滞后 |

**总原则**：AMP 是旁路，不是关键路径。任何 AMP 失败都不得改变 DSH 的 step 结果。

## 9. 现状矩阵

| 通道 | 现状 | 代码/缺口 |
|---|---|---|
| `systemPrompt.section` | ✅ 已接线 | `src/host/prompt.ts` |
| `systemPrompt.context` | ✅ 已接线 | `src/host/prompt.ts`、`src/host/context.ts` |
| `systemPrompt.variable` | ✅ 已接线 | `src/host/prompt.ts`；注册 `amp_tenant`、`amp_contract`、`amp_budget_tokens`、`amp_module_count`、`amp_session` |
| AMP attention 编译 | ✅ 已接线 | `src/host/context.ts`；R1 后 pre-step 捕获/缓存失效，S1 增加 `contextDiagnostics`（真实 `lag`、`lastCompileAt`、`lastExclusions` 前 50 条、`compilerExclusions` 数字）；step 限定 id 避免同 id 复用 |
| 可观测性 | ✅ 已接线 | `/amp/context` 的 `recovery`、`lastCapture`、`capture`、`contextDiagnostics`、`compilerExclusionsDetailed`；三本账字段保持（`compilerExclusions`/`hostExclusions`/`retentionOmissions`） |
| DSH → AMP sync | 🟡 部分 | `src/host/sync.ts`；R3 增加 compaction/fork 的审计计数，不复制 AMP workflow 实体；session/turn/goal/todo/tool 仍为原投影 |
| AMP → DSH bridge | ✅ 已接线 | `src/host/bridge.ts` |
| `@file` | ✅ 已接线 | `src/host/channels/file.ts` + `src/host/prestep.ts` |
| 附件 | ✅ 已接线 | `src/host/channels/attachment.ts` + `src/host/prestep.ts` |
| `@session` | ✅ 已接线 | `src/host/channels/session.ts` + `src/host/prestep.ts` |
| `agent.steer()` | ✅ 已接线 | `src/host/channels/message.ts` + `src/host/prestep.ts` |
| `agent.inject()` | ✅ 已接线 | `src/host/channels/message.ts` + `src/host/prestep.ts` |
| spill | ✅ 已接线 | `src/host/spill.ts`；`src/host/sources.ts` 合并 |
| retention | ✅ 已接线 | `src/host/retention.ts`；排除写入宿主侧账本 |
| pruner | ✅ 已接线 | `src/host/prune.ts`；R2 tombstone 通过 `src/host/context.ts` 的 `previousItems` diff 进入 `compileTurnContext({objects})`，编译器 reason 为 `unmounted`；无对应对象的原文仍走宿主侧 `version` exclusion；S2 上限 `MAX_PREVIOUS_ITEMS=1000`/`MAX_TOMBSTONES=50`，超出按最新窗口截断并计数 |
| compact | ✅ 已接线（tracker） | `src/host/compaction.ts`；观察 `compaction/*` 并记录，无假 receipt |
| fork | ✅ 已接线 | `src/host/fork.ts`；普通 fork 的 source 仍依赖 `header.parentSession`，缺失时如实标注 `unrecorded source`；不复制 attention |
| subagent fork | ✅ 已接线 | `src/host/subagent.ts`；delegation task + `submitResult`，无假 receipt |
| cold recovery | 🟡 部分 | `src/host/recovery.ts`（R1）；从 `ctx.agents.list()`/`ctx.sessions.list()` 重放已有日志并 hydrate 开放 turn；若宿主只暴露 live sessions，真正的 cold 列表仍缺；S2 上限 `MAX_RECOVERY_SESSIONS=200`/`MAX_EVENTS_PER_SESSION=50000`，超出计数并降级 |
| `agent/pre-step` | ✅ 已接线 | `src/host/prestep.ts`；`src/index.ts` 注册 wrapper |
| 自定义 compaction 后端 | 🟡 部分 | 子路径 `deepseek-coordination/compaction-backend` 导出 `AmpCompactionBackend`/`createAmpCompactionBackend`；部署需显式替换基础 `ctx.compaction`，默认不注册（宿主入口不引入 `dsh-compaction`） |

图例：✅ 已实现；🟡 部分实现；⚪ 设计已定义、尚未实现。

P0–P4 与 R1–R4 已落地；S1/S2/S3 已落地。剩余仍为宿主级 cold session 列表、AMP task 跨重启持久化、默认 compaction 组合、真实 subagent receipt（不伪造）。R4 已将 `test/recovery.test.mjs`、`test/tombstones.test.mjs`、`test/syncCoverage.test.mjs` 纳入 `npm test`，并在 `/amp/context` 暴露 `recovery`、`lastCapture` 与 `capture`。S3 将 `test/diagnostics.test.mjs`、`test/faultInjection.test.mjs`、`test/release.test.mjs` 纳入 `npm test`；`test/release.test.mjs` 是静态发布契约，校验 manifest、构建/打包配置与本节文档，不替代真实打包。

### 9.1 与现有 `AmpContextOptimizer` 的差距

| 现状 | 目标 |
|---|---|
| `contextFor()` 以 `sessionId:turn` 缓存，同 turn 的后续 step 复用旧包。 | 缓存 key 加 step；pre-step 捕获后失效。 |
| `prompt` 来自 `onSessionEvent('user/message')`，当前消息尚未提交时滞后。 | 从 `decision.messages` 捕获当前批次。 |
| `compileTurnContext` 用 turn 限定的稳定 id；同 id 已存在时复用旧对象。 | 需要更新走 `attention.update()`，或对 step 级项使用 step 限定 id。 |
| 单项预算统一为 `max(256, total/2)`，没有通道上限。 | 按第 4.5 节通道预算 + 总预算裁剪。 |
| 只把编译器 `exclusions.length` 当作统计，没有 retention/host 账本。 | 三本账：compiler、host、retention。 |
| 只收集 prompt/goal/plan/tools/workspace。 | 增加 file/attachment/session-ref/steer/inject/spill/prune/compaction/subagent。 |

## 10. 实现落点

建议按 PR 拆分：

### P0 — 同轮正确性

1. `src/host/wire.ts`：新增 `WireItem`/`WireExclusion`/`WireTrust` 类型与 `toCreateAttention()`。
2. `src/host/prestep.ts`：新增 `agent/pre-step` wrapper、`PendingInput`、缓存失效。
3. `src/host/context.ts`：`contextFor()` 改为读 `PendingInput`；缓存 key 加 step；`compileTurnContext` 前对同 id 项走 update 或 step 限定 id。
4. `test/wire.test.mjs`：同轮 prompt/steer 捕获、缓存失效、重复 id 去重。

### P1 — 输入通道

5. `src/host/channels/file.ts`：`@file` 解析（与 `dsh-file-reference` 语法对齐）、stat、item。
6. `src/host/channels/attachment.ts`：image/file block 扫描、分组、item。
7. `src/host/channels/session.ts`：`session-reference` 识别、untrusted 标记、item。
8. `src/host/channels/message.ts`：steer/inject 的 inbox 事件与 item。
9. 测试：越界路径、图片 offload、@session 截断、self-inject 过滤。

### P2 — 输出与压缩

10. `src/host/spill.ts`：spill 引用解析、locator 校验、预算只计预览。
11. `src/host/retention.ts`：`RetentionLedger`；`/amp/context` 分列。
12. `src/host/prune.ts`：`compaction/prune` → attention update + exclusion。
13. `src/host/compaction.ts`：`CompactionRecord`、`compactHistory` 适配、idempotency。
14. 测试：预算不按全文计、pruner 原文保留、compaction 无假证据。

### P3 — 血缘与委派

15. `src/host/fork.ts`：`ForkRecord`、新 AMP session、provenance、不复制 attention。
16. `src/host/subagent.ts`：`CooperationCoordinator` 接入、delegation receipt、trusted/untrusted 分流。
17. 测试：fork 不复制驻留、subagent fork 的 inherited transcript 是 untrusted、深度/容量拒绝无 receipt。

### P4 — 变量与收尾

18. `src/host/prompt.ts`：`ctx.systemPrompt.variable()` 注册。
19. `/amp/context` 路由：返回 `compilerExclusions`、`hostExclusions`、`retentionOmissions`、`lag`、`lastCapture`。
20. README/CHANGELOG 更新。

## 11. 测试计划

| 层级 | 用例 | 断言 |
|---|---|---|
| 单元 | `@file` 语法 | `@a b`、`@"a b"`、email 中的 `@`、越界路径 |
| 单元 | `WireItem` → `CreateAttentionInput` | 字段无损；id 去重；预算 ≥ 256 |
| 单元 | trust 映射 | `@session`/subagent transcript 恒为 untrusted |
| 集成 | 同轮 prompt | pre-step 捕获后，本步 `<amp_attention>` 的 prompt 是当前用户句，不是 time-context |
| 集成 | steer | steer 进入下一步；turn 结束未消费 → expired |
| 集成 | inject | 不唤醒；无 step → expired；`amp:` source 被跳过 |
| 集成 | 附件 | 图片不重复编码；offload 后 `unmounted` |
| 集成 | spill | 预算只计 preview；full bytes 在 pointer |
| 集成 | retention | omission 进入 ledger，不进入 compiler exclusions |
| 集成 | pruner | 原项由宿主 exclusion 记账；新项 pointer 指向新 seq；原文仍在日志 |
| 集成 | compact | record 幂等；shadowed seq 有 exclusion 或 host ledger；无假 evidence |
| 集成 | fork | 新 session 无 attention 复制；首次 pre-step 重新派生 |
| 集成 | subagent fork | delegation receipt 的 parent/child 正确；inherited transcript 是 untrusted |
| 回放 | 冷恢复 | 从日志重建 pending/exclusion/record，不读时钟 |
| 故障 | AMP 抛错 | DSH step 仍成功；`/amp/context` 记录 failure |
| 性能 | 50ms 预算 | pre-step 捕获不调用网络/工具；超时记录 |

## 12. 开放问题

1. **`session-reference` 快照与引用消息是否总在同一 `decision.messages` 批次？** `source.kind === 'session-reference'` 已确认；需要确认 pre-step 看到的批次是否包含紧随其后的快照消息。
2. **pre-step 的 `decision.messages` 是否包含图片 block 的完整 ref，还是只有 `ImageBlock` 的投影？** 若只有投影，需要从 `ctx.attachments` 反查。
3. **`agent.inbox/claimed` 与 pre-step 批次如何避免重复计数？** `agent.inject()` 在调用时写 `agent/inbox/spliced`，并在下一个被接纳的 step 进入批次；捕获应以 `decision.messages` 为准，inbox 事件只用于 pending/取消跟踪。
4. **`compileTurnContext` 的 `context:<turnId>` checkpoint 在同一 turn 多次编译时如何保留历史？** 当前是覆盖 + version+1；是否需要按 step 分 checkpoint，需与 AMP 维护者确认。
5. **fork 的 `sessionType`**：`user_interactive` 还是 `delegated`？普通 fork 建议 `user_interactive`；subagent fork 建议 `delegated`。
6. **fork 是否应复制 `Session.persist` 引用？** 本稿倾向“只复制稳定引用，不复制 attention residency”；需要验证 AMP `SessionService` 的 resume 语义。
7. **AMP `TurnCompactionRecord` 的 evidence 归属**：没有真实 receipt 时是否允许作为 `system_rule` 证据？本稿要求“不伪造”；若 AMP 允许 host-attested record，需要定义 attestation。
8. **`contextBudgetTokens` 与 DSH `compaction` 阈值的交互**：AMP 包太小会丢失有用索引，太大可能触发 DSH 压缩；需要实测一个默认比例（建议 AMP 包 ≤ 上下文窗口的 1%）。

## 附录 A：通道预算与优先级

| channel | relevance | urgency | importance | confidence | tokens | TTL |
|---|---:|---:|---:|---:|---:|---|
| `prompt` | 1.0 | 1.0 | 1.0 | 1.0 | 600 | turn |
| `goal` | 1.0 | 0.9 | 1.0 | 0.9 | 300 | session |
| `plan` | 0.9 | 0.8 | 0.8 | 0.9 | 600 | session |
| `tool` | 0.8 | 0.6 | 0.7 | 0.8 | 400 | turn |
| `workspace` | 0.6 | 0.4 | 0.5 | 1.0 | 256 | session |
| `file` | 0.9 | 0.5 | 0.7 | 0.9 | 256 | turn |
| `attachment` | 0.9 | 0.6 | 0.8 | 1.0 | 256 | session |
| `session-ref` | 0.7 | 0.3 | 0.6 | 0.6 | 256 | turn |
| `steer` | 1.0 | 1.0 | 0.9 | 1.0 | 256 | turn |
| `inject` | 0.7 | 0.2 | 0.6 | 0.8 | 256 | step |
| `spill` | 0.8 | 0.5 | 0.6 | 1.0 | 256 | session |
| `prune` | 0.6 | 0.4 | 0.6 | 1.0 | 256 | session |
| `compaction` | 0.8 | 0.5 | 0.9 | 0.9 | 400 | session |
| `fork` | 0.5 | 0.2 | 0.7 | 0.9 | 256 | session |
| `subagent` | 0.6 | 0.3 | 0.7 | 0.9 | 256 | session |

排序分数 = `0.5 + relevance + urgency + importance + confidence`（`intensity` 默认 0.5）。同分按 id 字典序。

## 附录 B：编译包示例

```text
<amp_attention budget="1200 tokens">
- [dsh:prompt:session-a28d:7:prompt] 在 dsh 当中，有哪些方法可以修改上下文
- [dsh:file:session-a28d:7:file-1] @src/host/context.ts — path reference only; not read (8,694 bytes)
- [dsh:attachment:session-a28d:7:attachment-1] attachments: image mock.png 800x600 42 KB
- [dsh:steer:session-a28d:7:steer-m3] steer: 先只看 host 侧，不要动 client
</amp_attention>
Items excluded by the AMP attention budget remain in the AMP ledger as exclusions; do not assume they were read.
```

## 附录 C：依据

DSH 侧：

- `@deepseek-ai/dsh-system-prompt` README：`section`/`context`/`variable`、`toolOrder`、运行时上下文抑制。
- `@deepseek-ai/dsh-agent` README：`agent.inject()`、`agent.steer()`、`agent/pre-step`、inbox 事件。
- `@deepseek-ai/dsh-session` README：`ctx.sessions.fork()`、`deriveMessages()`、surface 替换。
- `@deepseek-ai/dsh-file-reference` README：`@path` 语法、只插入路径不读内容。
- `@deepseek-ai/dsh-attachment` README：`ctx.attachments`、`ImageBlock`/`FileBlock`、文件只读路径。
- `@deepseek-ai/dsh-session-reference` README：`ctx.sessionReferenceResolver`、不受信任快照。
- `@deepseek-ai/dsh-spill` / `dsh-output-retention` / `dsh-compaction-*` README：locator、omitted、prune、`/compact`。
- `@deepseek-ai/dsh-subagent` README：spawn/fork、`startActivation`、preset、深度。
- 本仓库 `README.zh-CN.md`、`src/host/context.ts`、`src/host/prompt.ts`、`src/host/sync.ts`、`src/host/amp.ts`。

AMP 侧：

- `attention-manifest-protocol/lib/context/types.d.ts`：`CompiledContext`、`ContextExclusion`、六种 `reason`。
- `lib/context/compiler.js`：排序、预算、版本校验、排除逻辑。
- `lib/attention/types.d.ts`：`AttentionObject`、`AttentionPointer`、`createAttention` 默认值。
- `lib/kernel/types.d.ts`：`compileTurnContext`、`recordReceipt`、`recordEvidence`、`consumeBudget`。
- `lib/kernel/kernel.js`：`create` 同 id 复用、checkpoint 版本递增。
- `lib/cooperation/types.d.ts` 与 `coordinator.d.ts`：`DelegatedTask`、`delegation_receipt`、`ResultSubmission`。
- `lib/turn/service.d.ts` 与 `types.d.ts`：`compactHistory`、`TurnCompactionRecord`。
- `lib/evidence/types.d.ts` / `scoring.d.ts`：`EvidenceSource`、source tier、reliability。

---

**变更记录**：v1 初稿，定义 wire envelope 与 16 个 Wire 通道，外加 `systemPrompt` 三件套、`agent/pre-step` 与自定义 compaction 后端三组宿主机制；状态矩阵区分“已接线/部分/设计”。后续实现必须同步更新第 9 节与测试计划。
