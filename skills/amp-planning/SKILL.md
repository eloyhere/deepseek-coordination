---
name: amp-planning
description: Coordinate observable AMP missions, goals and plans with the coordination tools.
---

Use this skill for a task that needs durable coordination of an outcome, a mission queue, or a bounded execution plan. Follow the user's language when explaining the work.

Begin by reading existing state with `coordination_mission({"action":"list"})`, `coordination_goal({"action":"list"})`, and `coordination_plan({"action":"list"})` as needed. Omit `session` to use the calling session. Use an explicit session only when the user has identified that session. Reuse returned IDs; do not invent existing records or overwrite a terminal artifact.

A goal records the desired outcome and observable success criteria. A mission queues a goal for this session and permits one active mission at a time. A plan records 1–12 tasks, their dependencies, expected observations, budget, commitment window and abandonment criteria. Load `amp-missions`, `amp-goals` or `amp-plans` when you need its detailed workflow. For work spanning agents, use `amp-collaboration`, with `amp-duties` for assignment, `amp-delegation` for native execution and `amp-handoffs` for result review. Duties record accountable work; native subagent and send_message tools perform execution and communication.

Choose a standalone goal when no queue is needed. Creating a mission already creates and commits its Goal object; do not separately create the same goal ID. Create a draft plan against an existing nonterminal goal. Activate that goal before executing the plan. Move task states only after performing the corresponding work and observing its result.

Success `check`, task `expect.check`, `pre`, monitor triggers and `abandon_if` are recorded instructions. These tools do not execute checks, run tasks, monitor triggers or prove outcomes automatically. Perform appropriate observations using available tools, retain their actual results, and report any unavailable verification. Do not mark a task done, a plan done, a goal achieved or a mission complete merely because the record was saved.

These AMP records are plugin-owned coordination data. Creating them does not start a DSH automatic continuation goal or background worker. Use available DSH mechanisms only when separately appropriate and authorized. Mission entries are a host scheduling projection backed by AMP Goal objects, not an AMP mission artifact.

中文要点：先查询当前会话，按实际需要使用使命、目标和计划。检查条件只会被记录，不会自动执行。只有实际工作和验证支持时才能推进完成状态；不得编造证据或宣称目标已达成。
