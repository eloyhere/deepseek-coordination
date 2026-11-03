---
name: amp-duties
description: Define scoped duties, assignees and observable acceptance criteria.
---

Use `coordination_collaboration` to assign an accountable unit of work. List first with `coordination_collaboration({"action":"list"})`. Reuse a relevant visible duty; use a new valid ID for new work. The calling session becomes owner. Call `coordination_collaboration({"action":"agents"})` and select an observed native descendant `id` as the assignee DSH session ID; a native subagent messaging handle need not be its session ID. When that roster is unavailable or no eligible child is listed, do not assign.

For assignment, pass an object of this shape, replacing the illustrative session ID and criteria with observed facts:

```json
{"action":"assign","duty":{"id":"review-export","assigneeSession":"observed-assignee-session","role":"qualification","responsibilities":["Inspect the exported workbook against the source totals"],"acceptance":["Report observed totals and any mismatches with reproducible evidence"]}}
```

Call this object with `coordination_collaboration`. Required duty fields are id, assigneeSession, role, responsibilities and acceptance. Responsibilities and acceptance are string arrays; make each item concrete and nonempty. Supported roles are `decision`, `outcome`, `resource`, `personnel`, `qualification` and `execution`. Optional goal/plan/task links should reference the actual related records; inspect the current tool schema for their accepted shapes before supplying them. Do not invent links.

Describe the exact outcome, inputs, editable file scope, constraints, dependencies, verification and reporting expectations in the execution message. Role is duty metadata; assigning a role does not alter a locked profession or confer tools, access or authority. Use `subagent` for independent execution and `send_message` to convey the duty and returned ID. Saving an assignment does not notify or launch its assignee.

The assignee accepts and starts from its own session; only the owner verifies, rejects or cancels. Do not advance an assignee's state from the owner session to simulate acceptance. If the runtime cannot expose a usable assignee session ID, continue authorized native collaboration and report that durable assignment could not be linked; do not fabricate identity or state.

Acceptance criteria are recorded text. The tool does not automatically execute checks, assess responsibility fulfillment or prove competence. Track actual observations and retain unresolved conditions for review.

中文要点：职责要写清范围、责任和验收条件；受派会话必须真实可识别。通过 subagent/send_message 执行与通知，保存记录不会自动派工。角色不会更改锁定职能或授予权限，验收检查不会自动执行。
