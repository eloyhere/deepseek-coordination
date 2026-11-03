---
name: amp-collaboration
description: Coordinate agents with explicit duties, accountable assignments and verified results.
---

Use this skill when work spans multiple agents or sessions and needs accountable duties and result acceptance. Use `subagent` to start authorized independent work and `send_message` to communicate with an existing addressable agent. Use `coordination_collaboration` to persist who owns each duty, who performs it and whether the submitted result was accepted. These records do not automatically spawn agents, deliver messages, run checks or finish goals.

Read current state with `coordination_collaboration({"action":"list"})`. The result is `{duties:[...]}` for duties visible to the calling session. Mutation results use `{duty:...}`. Actor identity comes from tool execution, not a supplied `session` parameter. Never impersonate another session or assume an agent messaging ID equals its DSH session ID. Call `coordination_collaboration({"action":"agents"})` and use the returned native descendant `id` as the assignee session. An unavailable roster or unrelated target cannot be assigned.

Assign using a `duty` object with `id`, `assigneeSession`, `role`, nonempty `responsibilities` and `acceptance` string arrays. Optional `goal`, `plan` and `task` link the duty to existing planning records. The supported roles are decision, outcome, resource, personnel, qualification and execution. Roles describe the assignment; they do not switch a session's locked profession or grant permission. Load `amp-duties` for the assignment workflow.

The normal lifecycle is assigned → accepted → working → submitted → verified. The assignee calls accept, start and submit; the owner calls verify, reject or cancel. Rejected work can return to working through start. Submission needs summary and evidence strings; verify/reject require review. Use the returned duty ID in later operations. A sent message proves dispatch only; a worker response is a submitted claim until the owner checks it. Load `amp-delegation` to execute with native agents and `amp-handoffs` to submit or review results.

Give independent agents bounded scopes, clear file ownership and explicit expected results. Resolve dependencies before starting dependent work, integrate the returned artifacts, and observe relevant checks. Record only work actually performed. Verification is an owner's recorded review, not automatic certification; preserve failures and unavailable checks. A verified duty does not automatically complete linked plan tasks, goals or missions.

中文要点：原生 subagent/send_message 负责执行与沟通，coordination_collaboration 记录职责和交接。调用会话身份由宿主确定，不能用 session 参数冒充他人。检查不会自动执行；提交不等于验证，验证也不会自动完成目标。
