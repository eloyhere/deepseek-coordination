# AMP 0.14.0 模块审计索引

依赖：`attention-manifest-protocol@0.14.0`（本次自 0.9.1 升级）。

升级结果：agent 面 17→18 个模块，暴露动词 61→64；总模块 29→30（新增 hidden `workflow/policy/profession/behaviour` 与 host `capability/manifest/provenance/receipt/verification/retrieval/model/runtime` 的清单变化一并以 0.14.0 的 SURFACE_MODULES 为准）。`npm test` 181/181 通过。

审计方式：每个模块一个互斥子代理，串行执行；子代理只读代码、只写本目录报告，不改 `src/` 与测试。

## agent 层（18，可被模型调用）

| 模块 | 动词 | 审计报告 | 接入状态 |
|---|---|---|---|
| session | get, list, report_status | session.md | 待审计 |
| turn | current, respond, clarify, report | turn.md | 待审计 |
| intent | get, list, submit_clarification | intent.md | 待审计 |
| mission | get | mission.md | 待审计 |
| goal | get, list, submit_evidence | goal.md | 待审计 |
| plan | get, list, ready_tasks, propose_draft | plan.md | 待审计 |
| elaboration | get_build, list_diagnostics, explain, propose | elaboration.md | 待审计 |
| draft | get, list, open, write, patch, diff, check | draft.md | 待审计 |
| question | get, list, open | question.md | 审计中（0.14.0 新增） |
| task | get, list_ready, report_progress | task.md | 待审计 |
| action | get, list | action.md | 待审计 |
| attention | context, get, request_focus | attention.md | 待审计 |
| project | rules, metadata, environment, describe_environment, configure_environment, put_rule, outline | project.md | 待审计 |
| workspace | list, read, outline, document_outline, diff, write | workspace.md | 待审计 |
| cooperation | inbox, send, report_result | cooperation.md | 待审计 |
| evidence | get, list, cite | evidence.md | 待审计 |
| execution | find_tools, inspect_tool, run, read_handle | execution.md | 待审计 |
| budget | remaining | budget.md | 待审计 |

## hidden 层（4，内部服务，0 个 agent 动词）

workflow、policy、profession、behaviour。

## host 层（8，宿主面，0 个 agent 动词）

capability、manifest、provenance、receipt、verification、retrieval、model、runtime。

## 判定口径

- **wired**：该模块的核心 API 在插件里有真实调用点（不只是 HTTP 面板或被动读取），且其 agent 动词有宿主 handler。
- **partial**：有部分动词 handler，但核心能力未接入，或反向（核心已用、动词未接）。
- **missing**：动词落到 `not_implemented`，核心 API 未被引用。
- hidden/host 模块不暴露 agent 工具，判定只看核心 API 是否被插件使用。
