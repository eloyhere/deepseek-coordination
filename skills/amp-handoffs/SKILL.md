---
name: amp-handoffs
description: Submit traceable results and verify or reject collaboration handoffs.
---

Use this skill to hand over a completed unit of work or review an assignee's submission. Inspect `coordination_collaboration({"action":"list"})` first and use the actual duty ID. List returns `{duties:[...]}`; state-changing calls return `{duty:...}`. The caller's execution session determines authority; do not provide a session argument to act as someone else.

After accepting, starting and performing the work, the assignee submits a concise summary and a nonempty list of evidence strings:

```json
{"action":"submit","id":"review-export","summary":"Compared the exported totals against the source and documented the result","evidence":["Path to the actual comparison artifact and the observed check result"]}
```

Call this object with `coordination_collaboration`, replacing the illustrative content with real observations. Evidence strings are recorded references or observations, not uploaded attachments or automatically validated proofs. Include usable artifact locations, relevant test commands and actual outcomes, limitations and unresolved checks. Do not fabricate logs, passing checks or files. Use native `send_message` to notify the owner with the duty ID and result location; the record does not deliver the message.

The owner inspects the submitted artifacts against each acceptance criterion and runs appropriate available checks. If supported, call `coordination_collaboration({"action":"verify","id":"review-export","review":"Describe the actual acceptance checks and observed results"})`. To request correction, call the same tool with action reject and an actionable review describing the concrete unmet criteria. Only the owner can verify, reject or cancel; the assignee cannot certify its own submitted duty from its session.

Rejected work can be started again by the assignee and resubmitted after correction. The owner may cancel work that should no longer proceed, with a clear explanation communicated to the worker. Cancelling a duty record does not interrupt a native worker; use the available native cancellation tool separately when appropriate and authorized.

Verification records the owner's review. It does not execute acceptance checks, authenticate evidence strings or automatically complete linked tasks, plans, goals or missions. Advance those records separately only when their own requirements and observed results support it. If verification is unavailable, report that limitation instead of claiming a verified result.

中文要点：受派者提交真实 summary/evidence，所有者检查验收条件后 verify 或 reject，并用 send_message 沟通交接。记录不自动发送消息或停止代理。检查不会自动执行，verified 不会自动完成关联目标。
