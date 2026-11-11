# 批量审计结论与修复（turn / intent / mission）

来源：受限互斥子代理审计，原始结论见 [batch-turn-intent-mission.md](batch-turn-intent-mission.md)。

## 结论

| 模块 | 审计判定 | 问题 | 修复 |
|---|---|---|---|
| turn | partial | `turn.respond` / `turn.report` 只写 `host.notes`，`TurnService` 的状态与 version 从不推进 | `turn.respond` 现在解析 `turnId` 并调用 `TurnService.respond({ expectedVersion, actor, reason })`；失败开放，返回 `advanced` 与 `transition` 诊断 |
| intent | partial | `intent.submit_clarification` 只把 `{actor, reason}` 传给 `IntentService.clarify`，澄清文本被丢弃；异常被吞成 `ok(intent:null)` | 先读 `version`，把澄清文本写入 `reason`（AMP `TransitionOptions` 无自由文本字段），非法迁移现返回 `invalid_state` 而不是假成功 |
| mission | wired | 无 | 未改 |

## 为什么 `turn.report` 仍只写 note

AMP 0.14.0 的 `TurnService` 没有 `report` 操作；`turn.report` 的语义是「turn 内的进度报告」，不是状态迁移。保留 note 并把 `turn.respond` 接上状态机，是语义上正确的最小接入。

## 验证

- `tsc --noEmit` 无错误。
- `npm test` **183/183**。
- 本次未新增测试文件；`turn.respond` 的迁移是失败开放（状态不允许时不报错），因此现有集成测试不会因状态差异而变更。
