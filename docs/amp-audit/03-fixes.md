# 第二批审计结论与修复（goal / plan / task / action）

来源：受限互斥子代理审计，原始结论见 [batch-goal-plan-task-action.md](batch-goal-plan-task-action.md)。

## 结论与处理

| 模块 | 审计判定 | 问题 | 处理 |
|---|---|---|---|
| goal | partial | `submit_evidence` 从不写 AMP：只有 host note + 可选 bridge feedback，返回 `verified:false` | 接受可选 `receiptId`；提供时调 `kernel.flow.recordEvidence` 真正写入 AMP evidence 台账并返回 `recorded:true/evidenceId`；未提供时返回 `recorded:false` 并说明“AMP 要求 receipt 绑定” |
| plan | wired | `propose_draft` 经 `flow.createPlan` 建计划，但绕过了 plan service / draft 审批；自动建 intent+mission+goal | 未改：`createPlan` 是 AMP 的计划创建入口，该 verb 的语义就是“提案建计划”；已记录为设计取舍 |
| task | partial | `report_progress` 只写 host note，不做任何 TaskService 迁移；`list_ready` 无 planId 时返回全部 task | 新增可选 `state`（active/paused/resumed/blocked/unblocked）→ 对应 `TaskService.start/pause/resume/block/unblock`，带 `expectedVersion`，非法边失败开放；无 planId 时按 `state === 'ready'` 过滤 |
| action | wired | `get` 把任何异常都报成 `not_found` | 未改（低优先级）：只影响错误分类，不影响数据链路 |

## 为什么 goal 的 evidence 不是无条件写入

`RecordEvidenceInput.receiptId` 是**必填**：AMP 的证据必须挂在一个 receipt（动作结果）上。自由文本证据没有 receipt，强行伪造 receiptId 会污染证据链。因此接入方式是有 receiptId 时真写、无 receiptId 时明确降级为 host note。

## 验证

- `tsc --noEmit`：无错误。
- `npm test`：**183/183**。
