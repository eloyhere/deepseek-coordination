# AMP 0.14.0 接入审计报告

日期：2026-11-11
依赖：`attention-manifest-protocol@0.14.0`（自 0.9.1 升级）

## 方法与过程说明

1. 升级后用 `SURFACE_MODULES` 枚举真实面：agent 18 / hidden 4 / host 8，共 30；agent 暴露动词 64。
2. 逐模块审计最初交给互斥子代理（一次一个）。首个独立子代理在输出阶段失败；改用 workflow 串行编排后，`session` 报告已写入本目录，但第二个模块卡住超过 40 分钟，已终止。
   **因此本报告不是 18 份子代理报告的汇总**，而是改用可重复的静态验证：
   - 从 handler 源码提取 `AMP_PREFIX_<module>.<verb>` 键；
   - 用 `from 'attention-manifest-protocol/<module>'` 扫描直接依赖；
   - 用 `kernel.flow.*` / `kernel.ports.*` 调用点确认间接使用；
   - 以 `npm test`（含真实 kernel/store 的集成测试）作为行为证据。
3. 子代理产物 `session.md` 保留，作为该方法可行但成本过高的样本。

## agent 层：18/18 模块、64/64 动词有宿主 handler

旧版本已覆盖 17 个模块 / 61 个动词；0.14.0 新增的 `question` 带来 3 个动词，正是此前的唯一缺口。

| 模块 | 动词数 | handler 证据 | 直接 import | 结论 |
|---|---:|---|---|---|
| session | 3 | `handlers/session.ts:21,38,48` | 否（host 投影） | wired |
| turn | 4 | `handlers/session.ts:56,64,77,110` | 否（host 投影） | wired |
| intent | 3 | `handlers/session.ts:122,132,137` | 否（kernel flow） | wired |
| mission | 1 | `handlers/session.ts:158` | 否（kernel flow） | wired |
| goal | 3 | `handlers/planning.ts:29,39,44` | 否（kernel flow） | wired |
| plan | 4 | `handlers/planning.ts:65,75,80,90` | 否（kernel flow） | wired |
| elaboration | 4 | `handlers/elaboration.ts`（AMP `createElaborationToolHandlers`） | 是（`/agent`） | wired |
| draft | 7 | `handlers/draft.ts`（AMP `createDraftToolHandlers`） | 是（`/agent`） | wired |
| **question** | 3 | 本次新增 `handlers/question.ts:58,69,85` | **是（`/question`）** | **wired（新）** |
| task | 3 | `handlers/planning.ts:161,171,184` | 否（kernel flow） | wired |
| action | 2 | `handlers/planning.ts:194,204` | 否（kernel flow） | wired |
| attention | 3 | `handlers/attention.ts:25,65,72` | 是（`/attention`） | wired |
| project | 7 | `handlers/project.ts` + `projectOutline.ts` | 是（`/project`） | wired |
| workspace | 6 | `handlers/workspace.ts:195..349` | 是（`/workspace`、`/file`） | wired |
| cooperation | 3 | `handlers/cooperation.ts:24,31,52` | 是（`/cooperation`） | wired |
| evidence | 3 | `handlers/attention.ts:83,90,95` | 否（kernel flow） | wired |
| execution | 4 | `handlers/execution.ts:28..116` | 否（`ctx.tools` + handle） | wired |
| budget | 1 | `handlers/attention.ts:81` | 否（kernel snapshot） | wired |

## hidden / host 层（12）

这些模块不暴露 agent 工具，判定看核心 API 是否被用到：

- **直接 import**：`profession`（`src/host/subagent.ts:17`，PermissionScope）、`kernel`（全部 flow 调用点）。
- **间接应用**：`workflow`、`policy`、`provenance`、`receipt`、`verification`、`retrieval`、`model`、`runtime`、`capability`、`manifest` 随 `createKernel` 与 `kernel.flow.*` 运行（turn/context/receipt/evidence 路径），插件不直接调用它们。
- **判定**：transitive（间接应用），未做到 direct（直接调用）。若要求“每个模块都有直接调用点”，需另开接入项，典型如：`retrieval` 接 `execution.read_handle` 分页、`verification` 接 `goal.submit_evidence` 的校验路径。

## 本次实际变更

- `src/host/handlers/question.ts`（新）：`get`/`list`/`open`，用 AMP `createStoreQuestionStore(host.kernel().store)` 持久化，`open` 走 `createQuestion → askQuestion → put`。
- `src/host/handlers/index.ts`：注册 `questionHandlers`。
- `test/questionHandlers.test.mjs`（新）：open→asked、get、list、缺失 id、空 prompt、非法 kind 回退。
- `test/smoke.test.mjs`：计数更新为 18 模块 / 22 工具 / 30 发现 / 64 动词。
- `package.json`：依赖 0.14.0，描述更新，新测试入 scripts.test。
- 修复 `test/smoke.test.mjs` 与 `src/host/handlers/index.ts` 的混合换行（AMP 编辑工具拒绝混合 EOL）。

## 验证

- `npm test`：**183/183 通过**（构建 + 全量）。
- discovery：30 模块，agent 18，动词 64。
- `attention_manifest_protocol_question` 三个动词走真实 kernel store，重启 store 后仍可 list（由持久化测试间接覆盖）。

## 剩余风险

1. 隐藏/宿主层只是间接应用；若标准是“直接调用”，需逐模块补接入点。
2. `question.open` 没有与 DSH 的 `ask_user_question` 自动联动；目前由模型或宿主显式调用，避免劫持现有审批链路。
3. 子代理审计未能全部跑完，本报告的“core API 使用深度”按直接 import / kernel flow 两级判定，未做逐函数审计。
