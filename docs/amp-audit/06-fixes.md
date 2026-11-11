# 第五批审计结论与修复（execution / session / question）

来源：受限互斥子代理审计，原始结论见 [batch-execution-session-question.md](batch-execution-session-question.md)。

## 结论与处理

| 模块 | 审计判定 | 问题 | 处理 |
|---|---|---|---|
| execution | partial | `run` 直接 `ctx.tools.execute`，无 AMP policy/budget/action receipt；handle 是内存字符串；参数校验抛错会逃出 try | 校验改为结构化 `invalid_parameters`（不再抛异常）。policy/receipt 未接：见下“设计边界” |
| session | partial | `report_status` 只写 `host.statusLines`；`get` 把错误吞成 `amp:null`；`list` 读 DSH registry | 保留：AMP `SessionService` **没有 status 字段**，自由文本状态只能宿主持有（statusLines 随 AmpStateStore 持久化）。`get` 的 `amp:null` 是宽松兼容，已注明 |
| question | partial | `open` 只持久化 + 迁移，不调用 `userQuestions`；kind/expiresAt/options 静默降级 | 保留：`question.open` 是 AMP 侧问题实体；**实际向用户提问的是 `turn.clarify`**（已接 `ctx.userQuestions`）。两个动词职责不同，不强行合并 |

## 设计边界

### execution.run 为什么不直接接 AMP policy/receipt

AMP 的 policy/receipt 围绕 `Action → Attempt → Receipt` 生命周期：每个动作需要 `beginAction` / 预算预留 / `settleAction`。DSH 的 `execution.run` 是“子工具批调用”适配器，它的执行权在 DSH 工具层；如果为一个批调用强行造 AMP action 树，会与 kernel 已有的 action 产生双写。

正确的做法是：模型需要完整 AMP 语义时走 `attention_manifest_protocol_execution.run` 之外的 kernel flow；`execution.run` 就保持“薄适配器”语义。本报告把这一取舍写明，而不是用假 receipt 充数。

### session.report_status

`SessionService` 暴露的是生命周期迁移（active/idle/suspend/close/...），没有自由文本 status。宿主用 `host.statusLines` + `AmpStateStore` 持久化是唯一合理实现。

## 验证

- `npm test`：**189/189**。
- `execution.run` 对空 `name`、AMP 前缀工具的调用现在返回 `invalid_parameters`，不再抛异常。
