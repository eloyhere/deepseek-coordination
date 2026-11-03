---
name: amp-missions
description: Queue, activate and settle session missions backed by AMP goals.
---

Use `coordination_mission` to maintain a session's durable work queue. Omit `session` for the calling session. List first: `coordination_mission({"action":"list"})`.

Create a mission by supplying a complete, new AMP Goal object, for example:

```json
{"action":"create","goal":{"amp":"0.1","kind":"goal","id":"release-guide","statement":"Publish a verified release guide","success":[{"id":"guide-reviewed","statement":"The guide reflects the shipped release","check":"Review the guide against observed release changes","kind":"observe"}],"value":0.8,"priority":1,"horizon":"session"}}
```

Call this object with `coordination_mission`. Creation creates the Goal and moves it to committed; do not first create the same goal using `coordination_goal`. Goal IDs must be new, start with a lowercase letter, contain only lowercase letters, digits, `.`, `_`, `:`, or `-`, and be at most 64 characters.

Activate the next runnable mission with `coordination_mission({"action":"activate"})`. This operation takes no `id`: the queue selects by priority and enqueue order. At most one mission is active per session. A null result means no runnable mission was selected; do not claim one started. Save the returned mission ID separately from the goal ID.

Use `coordination_mission({"action":"complete","id":"<returned-mission-id>"})` only for an active mission after completing its work, checking its success criteria and finishing every linked plan and task. Completion transitions its Goal to achieved. To abandon a queued or active mission, use `coordination_mission({"action":"abandon","id":"<returned-mission-id>"})` and explain the actual reason. Abandoning the goal also abandons its nonterminal plans. Terminal missions cannot be settled again.

The tool records queue state. It does not launch a worker, execute checks, validate evidence or schedule DSH continuation. Missions are a host projection around AMP Goals; do not describe them as standalone AMP mission artifacts. List state again after a failed or uncertain operation instead of guessing its effect.

中文要点：创建使命会同时创建并承诺其目标；activate 不接受 id，每个会话最多一个活动使命。使用返回的使命 id 完成或放弃；完成必须有实际结果支持，检查文本不会自动执行。
