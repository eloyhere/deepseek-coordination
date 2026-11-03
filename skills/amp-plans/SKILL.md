---
name: amp-plans
description: Build bounded AMP task plans and track dependencies, execution and results.
---

Use `coordination_plan` to record and advance a bounded plan for an existing nonterminal AMP goal. Read `coordination_goal({"action":"list"})` and `coordination_plan({"action":"list"})` first. Omit `session` for the calling session. Create the goal first, or use a goal created by a mission.

A minimal draft plan passed to `coordination_plan` looks like this; replace the goal ID, task and checks with the actual work, and set `created` to a current RFC 3339 timestamp:

```json
{"action":"create","plan":{"amp":"0.1","kind":"plan","id":"export-plan","goal":{"kind":"goal","id":"verify-export"},"tasks":[{"id":"export-file","intent":"Create and inspect the requested export","actor":"self","pre":[],"expect":{"observation":"The exported file opens and its totals match","check":"Inspect the export and compare the totals"},"irreversibility":0,"status":"pending"}],"edges":[],"commitment_window":1,"budget":{"calls":6},"abandon_if":[{"id":"source-unavailable","statement":"Required source cannot be read","check":"Observe whether the source is accessible","kind":"observe"}],"status":"draft","created":"2026-01-01T00:00:00Z"}}
```

Plans require 1–12 tasks and at least one `abandon_if` criterion. New plans must be draft and every task pending. Each task needs `id`, `intent`, `actor` (`self`, `tool` or `other`), `pre` string array, `expect` with observation and check, `irreversibility` integer 0–3, and status. `edges` are `[predecessorId, successorId]` pairs within this plan and must be acyclic. `commitment_window` is 1–5. `budget` may contain nonnegative `tokens`, `ms`, `calls`, `interrupts` and `money`; choose realistic bounds. The goal reference must have kind `goal`. IDs start with a lowercase letter, use lowercase letters/digits/`._:-`, and contain at most 64 characters.

Advance a plan using `coordination_plan({"action":"transition","id":"export-plan","status":"committed"})`, then status executing. Execution requires an active goal. Valid plan edges are draft → committed → executing → done; each nonterminal state also permits abandoned.

Update one task with `coordination_plan({"action":"task","id":"export-plan","task":"export-file","status":"running"})`. Tasks change only on executing plans. Valid task edges: pending → running or skipped; running → done or failed; failed → running or skipped. All predecessor tasks must be done before a task starts running. Perform the work and inspect its expected observation before marking done.

A plan can become done only when every task is done. A skipped or failed task does not satisfy this gate; report that situation accurately and abandon or create a revised plan with a new ID when appropriate. Completing a plan does not automatically achieve its goal.

`pre`, `expect.check`, `abandon_if`, budgets and optional monitor triggers are recorded, not automatically executed, enforced as a resource scheduler, or monitored by these tools. Evaluate them during the work; record state only when supported by observed results. Never invent verification or completion evidence.

中文要点：计划必须关联已有目标，新计划和任务分别从 draft/pending 开始。先激活目标，再执行计划；依赖任务完成后才能启动后继任务。只有全部任务 done 才能完成计划，检查与监控文本不会自动执行。
