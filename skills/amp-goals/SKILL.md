---
name: amp-goals
description: Create observable AMP goals and move their lifecycle using evidence.
---

Use `coordination_goal` for observable outcomes and their durable lifecycle. Start with `coordination_goal({"action":"list"})`; omit `session` to address the calling session. Reuse a relevant existing goal rather than duplicating it.

Create a goal with the full AMP Goal object:

```json
{"action":"create","goal":{"amp":"0.1","kind":"goal","id":"verify-export","statement":"Export a workbook with verified totals","success":[{"id":"totals-match","statement":"Exported totals match the expected values","check":"Open the exported workbook and compare computed totals with the source","kind":"observe"}],"value":0.7,"priority":1,"horizon":"task"}}
```

Required fields are `amp:"0.1"`, `kind:"goal"`, `id`, `statement`, at least one `success` criterion, `value` in [0,1], and nonnegative integer `priority`. Every success criterion needs `id`, `statement` and nonempty `check`; optional `kind` is `observe`, `query` or `assert`. Optional `horizon` is `task`, `session` or `long`; optional `deadline` is an RFC 3339 timestamp with a timezone. IDs start with a lowercase letter, use lowercase letters/digits/`._:-`, and contain at most 64 characters. Choose criteria the available environment can actually observe.

Creation returns a proposed goal. Transition with `coordination_goal({"action":"transition","id":"verify-export","state":"committed"})`, then `state:"active"` when execution starts. Supported lifecycle states are proposed, committed, active, achieved and abandoned; follow valid edges returned or enforced by the host. Do not repeat terminal transitions or attempt to mutate a terminal goal.

Before `state:"achieved"`, perform and inspect every success check and ensure every linked plan and task is done. The host checks structural completion but does not execute success checks or certify evidence. A successful transition records your assertion; it does not provide independent proof. If checks fail or cannot run, keep an accurate active state or abandon with a clear explanation. Never fabricate achieved state or evidence.

If a mission is needed, create it with `coordination_mission` instead: mission creation already creates and commits its goal. Mission-linked goal transitions also update mission state; inspect both views when coordinating them.

中文要点：目标应有可观察的成功条件，先承诺再执行。成功检查是记录文本，必须另行实际验证。所有关联计划和任务完成且证据充分后，才能将目标标记为 achieved。
