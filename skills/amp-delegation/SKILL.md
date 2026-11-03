---
name: amp-delegation
description: Delegate execution through native agents and track the corresponding AMP assignment.
---

Use this skill when parallel work or a specialist can deliver an independently reviewable result. Execute delegation with available native `subagent` and `send_message` tools. Persist the corresponding accountable duty with `coordination_collaboration`; saving a duty does not create a worker or send a message.

Prepare a self-contained execution request: objective, relevant context, exact owned files or read-only scope, constraints, expected output, verification and where to report. Keep overlapping edits under one owner. Delegate independent work together when the runtime permits and continue useful local work. Respect native delegation depth, available tools and existing authorization.

Start the agent through the native tool or select an already addressable worker. Use its returned messaging handle for native messages. Before assigning, call `coordination_collaboration({"action":"agents"})`; use only a listed descendant `id` as `duty.assigneeSession`. Do not infer equivalence from similar-looking handles or use a session outside this caller's native descendant tree. The tool rejects assignment when the native roster is unavailable or the target is not listed. The owner assigns a duty using `coordination_collaboration` and sends the returned duty ID and acceptance criteria to the assignee with `send_message`. When durable identity is unavailable, report that limitation accurately and retain native execution results without inventing a linked duty.

The assignee lists duties from its own execution context with `coordination_collaboration({"action":"list"})`. After understanding and accepting the scope it calls `coordination_collaboration({"action":"accept","id":"review-export"})`, then `coordination_collaboration({"action":"start","id":"review-export"})` when work actually starts. Replace the illustrative ID with the returned one. These actions require the assignee session; no explicit session parameter can supply actor identity.

If scope, dependencies or access prevent execution, communicate the concrete condition to the owner with `send_message`. Do not claim work started because a message was delivered. Start also permits the assignee to retry rejected work; inspect review feedback before retrying. Submit real results and evidence when ready, then let the owner perform review using `amp-handoffs`.

Inspect the native worker's actual completion and artifacts. Record verified outcomes separately from promises, tool dispatch receipts or unreviewed claims. Durable duty state does not automatically execute tasks, consume plan budgets, change locked professions or complete goals.

中文要点：subagent/send_message 负责实际委派与沟通，AMP 指派负责持久化责任状态。原生代理句柄不一定是 DSH 会话 id。受派者从自己的会话接受并启动任务；记录不会自动执行，检查不会自动执行。
