# AMP ↔ 本插件 ↔ DeepSeek Harness 映射

本文只记录**代码里能读到的事实**，不描述尚未实现的能力。判断一次同步是否成立的依据是：

- 同步实现：`src/host/harnessSync.ts`（`HarnessPlanningSync`）
- push 调用点：`src/host/ampPlanning.ts`（`transitionGoal`、`savePlan`）
- Harness 端口定义与装配：`src/host/module.ts`（`GoalPort`、`PlanModePort`）、`src/host/dsh.ts`（`makeGoalPort`、`makePlanModePort`）
- skills：可写注册表是插件 control registry `skills`（`POST /control/registry`）；`src/host/ampSkills.ts` 的 provider 把带 `content` 的启用记录投影成 DSH 运行时 skill（`ctx.skills`），`src/index.ts` 的 `controlRegistrySkills` 按 **session → workspace → global** 读取，写后 invalidate；只读发现源 `sessionSkillCatalog.list` 因而也能看到新增/停用的 skill
- 可写注册中心：`src/shared/control.ts`（`CONTROL_REGISTRIES`）、`src/host/control.ts`、`src/host/controlRoutes.ts`

## 1. 同步方向与失败规则

| 规则 | 代码事实 |
| --- | --- |
| **push（先本地、后 Harness）** | AMP 目标/计划先写入插件 SQLite（`amp_planning_goal`、`amp_planning_plan`、`amp_mission`）并提交事务，然后才调用 Harness。Harness 拒绝不会回滚 AMP 事务。 |
| **pull（只读回填）** | 读取 `/amp/planning` 时，`AmpPlanning.syncStatus` 对每个目标调用 `pullGoal`，把 Harness 现状写回 link 行并与旧 link 比较；不一致时状态为 `diverged`，只报告、不写回 AMP。 |
| **CAS** | Harness goal 的 `resume` / `complete` / `clear` 都携带 link 行记录的 `{ id, revision }`。revision 过期或目标被替换时，Harness 的拒绝被记录为 `harness_link.note`，不会覆盖本地状态。注册中心的 `expectedVersion` 是另一套 CAS：`POST /control/registry` 校验 `expectedVersion`，冲突返回 `INVALID_STATE`，版本号由 `ControlMutationResult.version` 返回。 |
| **失败不抛异常** | `pushGoal` 整体 `try/catch`，失败写入 `harness_link.note` 并返回 link；`pushGoal` 的调用方再把失败追加为 `harness.goal.sync` 事件。`pullGoal` 也捕获异常并返回 `note`。`pushPlanMode` 捕获异常后返回 `undefined`，因此 plan mode 失败既不写 link 也不抛异常（只有成功返回结果时才追加 `harness.plan.sync` 事件）。 |

`harness_link` 表的一行记录就是一次 goal 同步的账本：

```sql
session, goal, remote_id, revision, phase, note, synced
```

## 2. 一一对应表

| AMP 概念 | 本插件侧（表 / 工具 / 路由） | Harness 服务（`ctx.*`） | 方向 | 事实依据与边界 |
| --- | --- | --- | --- | --- |
| **AMP goal / mission** | 表 `amp_planning_goal`、`amp_mission`；工具 `coordination_goal`、`coordination_mission`；路由 `GET /amp/planning`、`/amp/goals`、`/amp/missions` | `ctx.goals`：`get` / `create` / `edit` / `pause` / `resume` / `complete` / `clear`，phase 为 `active \| paused \| blocked \| complete`，带 revision CAS | push + pull | `AmpPlanning.transitionGoal` 在本地状态提交后调用 `pushGoal`：`active → create/resume`，`achieved → complete`，`abandoned → clear`；`proposed` / `committed` 不镜像。Harness 每个 agent 只有一个当前 goal，因此排队的 mission 不会提前 push；只有 mission 激活/结算引发的 goal 迁移会同步。`pullGoal` 读取 Harness 现状并写回 link 行，与旧 link 比较后返回 `diverged`；不写 AMP 目标状态。 |
| **AMP plan** | 表 `amp_planning_plan`；工具 `coordination_plan`；路由 `GET /amp/plans` | `ctx.planMode`：布尔 plan mode，`get` 返回 `{ active, pending? }`，`set` 返回 `committed \| queued \| cancelled \| noop` | push（单向） | Harness **没有 plan 文档**。`AmpPlanning.savePlan` 用“该会话是否有 plan 处于 `executing`”得出布尔值并调用 `pushPlanMode`；`transitionPlan`、`updateTask`、以及放弃 goal 时逐个放弃 plan 都经过 `savePlan`。plan mode 的现状由 `syncStatus` 的 `planModeState` 读取为 `on/off/unavailable`，不写回 AMP。 |
| **skills（可写注册表）** | **可写注册表**：control registry `skills`（工具 `coordination_control`、路由 `GET/POST /control/registry`、面板 Knowledge → 注册中心；skills 行使用 session 作用域）；**写透**：`src/host/ampSkills.ts` 的 provider 把启用且带 `content` 的记录投影为运行时 candidate，`src/index.ts` 的 `controlRegistrySkills` 按 session → workspace → global 读取，写后调用 provider `invalidate`；只读投影：`GET /amp/insights` | `ctx.skills`：provider 注册表（`register` / `registerProvider`，可写）→ `ctx.sessionSkillCatalog.list` 是它的只读 session 投影 | 写：control registry → `ctx.skills` provider → session catalog；读：`sessionSkillCatalog.list` | `sessionSkillCatalog` 本身没有 register/update/remove；写入口是 `ctx.skills`。记录必须带非空 `content`；session 行优先于 workspace、workspace 优先于 global。session 作用域只在 DSH 传入 live agent（`options.scope.id`）时生效：cold catalog 传的是 preset scope key，没有 session id，此时会话行不参与投影。`/amp/insights` 仍用 control registry 行覆盖 catalog 行，停用行以 `disabled` 保留。 |
| **knowledge（文件型）** | 文件标记：工具 `coordination_knowledge`、`GET/POST /graph/knowledge`；control registry `knowledge` 记录会合并进 insights | 无对应：Harness 没有知识文件标记或知识注册表服务 | 插件本地 | `CONTROL_REGISTRIES` 含 `knowledge`；该注册域和其他域一样存 JSON 元数据，而文件标记另由 `KnowledgeService`（`src/host/knowledge.ts`）与 `/graph/knowledge` 管理，两者在 `/amp/insights` 中并列展示。 |
| **environments / modules / tools / cognition / capabilities / abilities / progress / protocols / concepts** | control registry（`CONTROL_REGISTRIES` 中的这些域）；工具 `coordination_control`；路由 `GET/POST /control/registry`；面板 Knowledge → 注册中心 | 无对应：Harness 不暴露注册中心服务 | 插件本地（全局 → 工作区 → 会话作用域继承，带 `expectedVersion` CAS） | 记录只有 JSON 元数据；`enable`/`disable` 翻转 `value.enabled` 但保留行。面板读取 `GET /control/registry?scope=&registry=`，开关走 `POST /control/registry`。 |
| **manifest** | 签名 manifest：`AmpService.manifest()`（`ampSignManifest`），表 `amp_manifest`，路由 `GET /amp/manifest` | 无对应：Harness 没有 manifest 的签名、过期或校验服务 | 仅 AMP | manifest 由 receipts、frame 引用和策略摘要生成并签名；Harness 不参与。`/amp/verify` 校验的是账本链与最新 checkpoint，不是 manifest 签名。 |
| **receipts** | 每轮 / 每次工具调用生成 receipt（`makeReceipt`），写入 AMP store，路由 `GET /amp/receipts` | 无对应：Harness 不持久化按轮的 tool receipt / 结算记录 | 仅 AMP | receipt 记录 op、outcome、usage 和指针，不存正文；是 manifest 校准与能力统计的输入。 |
| **ledger** | 哈希链账本（`attention-manifest-protocol` 的 entry/checkpoint），路由 `GET /amp/ledger`、`/amp/verify`，表 `amp_checkpoint` | 无对应：Harness 没有账本、链式摘要或 checkpoint 服务 | 仅 AMP | 账本只存指针与度量（`ledgerProjection`），不存 prompt/文件正文；checkpoint 与 snapshot 由插件侧封存/校验。 |
| **frame** | 每轮 attention frame（`frameFrom`），路由 `GET /amp/frame?session=` | 无对应：Harness 没有 attention frame 产物 | 仅 AMP | frame 记录本轮注意力分配、被忽略项和 refs，id 由 turn 派生；插件侧生成并消费。 |
| **AMP duty（协作职责）** | 表 `amp_duty`；协作工具；路由 `GET /amp/collaboration` | 无对应：Harness 没有协作职责/指派服务 | 仅 AMP | 职责的 owner/assignee、accept/start/submit/verify 状态机完全在 `src/host/ampCollaboration.ts`。 |

## 3. 阅读代码时的几个易混点

1. **表名与工具名不同**：用户可见的规划工具是 `coordination_goal` / `coordination_mission` / `coordination_plan`，它们读写的表是 `amp_planning_goal` / `amp_mission` / `amp_planning_plan`。本文表格把两者都列出，避免把“插件表”误当成“Harness 服务”。
2. **`/amp/planning` 是唯一同时返回 AMP 规划记录与 Harness 同步状态的读接口**：它返回 `{ missions, goals, plans, harness: syncStatus }`；其它 `/amp/goals`、`/amp/plans` 路由只返回 AMP 记录。
3. **`ctx.goals` 与 `ctx.planMode` 都是可选端口**：profile 未注入时 `hasGoals` / `hasPlanMode` 为 false，`syncStatus` 返回 `unavailable`，AMP 仍照常工作。
4. **skills 的写路径是“registry → provider → catalog”**：`sessionSkillCatalog` 自身是只读 Remote（只有 `list`）；control registry `skills` 的启用记录经 `src/host/ampSkills.ts` 投影为 `ctx.skills` 的 provider candidate，`sessionSkillCatalog.list` 与模型侧 `skill` 工具因此能看到它。优先级是 session → workspace → global，记录必须带 `content`；cold session 没有 live agent 时 session 行不投影。
5. **注册中心的 `knowledge` 域与知识文件不是同一张表**：control registry `knowledge` 存 JSON 元数据记录；知识文件标记由 `coordination_knowledge` / `/graph/knowledge` 管理。两者在 `/amp/insights` 合并展示，但写入路径不同。

## 4. 修改同步行为时的检查清单

- 改 `HarnessPlanningSync` 的任何 push/pull：同步更新本文件的“方向 / CAS / 失败规则”三行，并跑 `test/ampPlanning.test.ts`、`test/ampRoutes.test.ts`。
- 改 `CONTROL_REGISTRIES` 或 `ControlRecordView`：同步更新 `src/shared/control.ts`、`src/host/controlRoutes.ts`、`src/client/bridge.ts` 的 `ControlRegistryRow`，以及本文第 2 节。
- 改 `sessionSkillCatalog` 的消费：它仍是只读 Remote；写路径走 control registry `skills` → `ampSkills.ts` provider。新增/停用记录后必须经 `src/index.ts` 的 `invalidateSkills` 刷新 provider，否则 DSH 缓存的 catalog 不会更新。
