# AMP 0.14.0 接入最终报告

## 1. 升级

- `attention-manifest-protocol` 0.9.1 → **0.14.0**；破坏性变更为面变化（agent 17→18 模块、61→64 动词、总 29→30）。
- `bindingFor` 的 `policyVersion` 已从 `dsh-amp-0.9.1` 改为 `dsh-amp-0.14.0`。

## 2. 审计方式

五次互斥受限子代理批量审计（每次 3–4 个模块，≤12 次工具调用，禁止粘贴文件内容）：

| 批次 | 模块 | 文档 |
|---|---|---|
| 1 | turn / intent / mission | batch-turn-intent-mission.md |
| 2 | goal / plan / task / action | batch-goal-plan-task-action.md |
| 3 | attention / evidence / budget | batch-attention-evidence-budget.md |
| 4 | project / workspace / cooperation | batch-project-workspace-cooperation.md |
| 5 | execution / session / question | batch-execution-session-question.md |

## 3. agent 层：18/18 模块、64/64 动词

全部 64 个动词都有宿主 handler；逐模块语义审计后修复了发现的问题：

- `question`（0.14.0 新增）：get/list/open 加入，持久化到 AMP store。
- `turn.respond`：现在真的调 `TurnService.respond`（带 `expectedVersion`），失败开放。
- `intent.submit_clarification`：澄清文本写入 AMP 事件 reason，非法迁移返回 `invalid_state`。
- `goal.submit_evidence`：有 `receiptId` 时写 AMP evidence 台账，没有时明确 `recorded:false`。
- `task.report_progress`：可命名 state 触发 `TaskService` 迁移；未知 state 直接拒绝。
- `task.list_ready`：无 planId 时按 `ready` 过滤。
- `evidence.cite`：逐 id 对台账校验，不存在返 `missing`/`not_found`。
- `evidence.get`：`includeProvenance` 返回 `EvidenceLedger.auditEvents()` 尾部。
- `budget.remaining`：返回聚合值 + per-node `tree`。
- `workspace.write`：新建文件也走 AMP `mount/planWrite/write/flush`（内容不再直写）。
- `execution.run`：参数校验失败返回 `invalid_parameters`，不再抛异常。

## 4. hidden/host 层

| 模块 | 状态 |
|---|---|
| workflow / policy / profession / receipt / verification | 实际使用（kernel flow / 子代理权限） |
| behaviour | 已接入：`execution.run` 每次批调用记录一条 AMP 影子验证（`BehaviorGovernance`） |
| retrieval | 已接入：`execution.read_handle` 使用 AMP `RetrievalHandleStore`（scope 授权 + TTL） |
| capability | 已接入：每个 agent 模块一个协议能力，启动时 `define` + `activate`（`AmpSurface`） |
| manifest | 已接入：每个 agent 模块一个 manifest + tool 定义（sha256 digest） |
| provenance | 数据级已用（`EvidenceLedger.auditEvents`），模块本身是 receipt+verification+evidence 的重导出 |
| cooperation | 已接入：每个 session 一个 AMP cooperation + mailbox 任务，`send`/`inbox` 走 `CooperationCoordinator` |
| model | 已接入：`AmpModel` 持有 `ModelPort`，`propose` 委托 `proposeNextStep` |
| runtime | 已接入：`AmpRuntime` 配置 `ExecutionCoordinator`（receipt sink 默认 `MemoryReceiptSink`） |

## 5. 验证

- `npm test`：**194/194**。
- 回归测试：turn 迁移、intent 失败语义、goal 无 receipt、task 未知 state、evidence.cite 不存在 id、budget.tree——11 例在 `test/ampWiring.test.mjs`。

## 6. 已知边界

1. `execution.run` 不建 AMP action/receipt（DSH 拥有工具执行；强行造 action 树会双写）。
2. `session.report_status` 只能宿主持久化（AMP `SessionService` 无自由文本 status）。
3. `question.open` 不阻塞等待用户；实际提问走 `turn.clarify`。
4. `cooperation.send` 是 host mailbox 语义，不向 live 收件人推送。
5. `workspace.write` 创建时 `expectedBaseHash` 不生效（AMP mount 无 base）。
