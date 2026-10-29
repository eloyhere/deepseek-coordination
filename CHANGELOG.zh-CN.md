# 更新日志

中文 · [English](CHANGELOG.md)

本文件记录本仓库所有重要变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **范围说明。** 仓库在 2026 年 10 月经历了两次形态变化：`87ddab9` 把
> dsh-os 树替换为独立的 Vite 应用，`0.2.0` 又替换为当前的 DeepSeek Harness
> 插件 bundle。`0.1.x` 各版本描述的是 **dsh-os**——一个跨平台原子 OS 交互面，
> 已不在当前分支顶端，但仍保留在 git 历史中，并有 `v0.1.5` … `v0.1.9` 标签。
> 历史中的 `Auto-commit: typecheck-passing snapshot` 是内部检查点，不单独列为版本。

## 版本索引

| 版本 | 日期 | 提交 | 摘要 |
|---|---|---|---|
| 0.22.0 | 2026-10-29 | — | 宽泛任务拆解为可验收的计划步骤 |
| 0.21.0 | 2026-10-29 | — | /amp/story、具体请求/计划/忽略项、全 MUI 面板 |
| 0.20.0 | 2026-10-29 | — | 面向普通读者的面板、移除输入框下拉框、16px 下限 |
| 0.19.0 | 2026-10-29 | — | 由已记录验收标准生成的 `Goal` + `Plan` 制品 |
| 0.18.0 | 2026-10-29 | — | 单一 AMP 面板、浮动最小化按钮、`coordination_profession_lock` |
| 0.17.3 | 2026-10-29 | — | 工具 schema 补齐 frozen 与 config.compaction（真机验证） |
| 0.17.2 | 2026-10-29 | — | 真机边界修复：工具输出无损 JSON、/ping 带版本 |
| 0.17.0 | 2026-10-29 | — | 接管窗口变成 AMP 注意请求、中断记录与 ask 回执 |
| 0.16.0 | 2026-10-29 | — | comprehension → warrant 校验的 claim 与 unknown（只有逐字锚定才升 T1） |
| 0.15.0 | 2026-10-29 | — | AMP v0.1 协议层：清单、注意帧、回执、账本、检查点与 `/amp/*` 路由 |
| 0.14.10 | 2026-10-18 | `8c9ff34` | 项目级依赖、文件级导入各自成环、纯文本聊天、右键菜单 |
| 0.14.9 | 2026-10-18 | `12115b5` | 面板崩溃与 portal/内缩布局 |
| 0.14.8 | 2026-10-18 | `26936c1` | 面板虚拟化、路由页签、大纲/预览页、四个图工具 |
| 0.14.7 | 2026-10-18 | `d5f80c6` | 预览保留选择并解析工作区 |
| 0.14.6 | 2026-10-18 | `f4549a7` | WebGL2 关系画布、优先级渲染队列 |
| 0.14.5 | 2026-10-18 | `3927d61` | 语义缩放、可折叠树、密集图自动适配 |
| 0.14.4 | 2026-10-18 | `94aa48a` | 图索引解析会话工作区 |
| 0.14.3 | 2026-10-18 | `088e2f6` | 底部堆叠、reducer 导航、工作区索引 |
| 0.14.2 | 2026-10-18 | `5b5fdf8` | 客户端不再引用 Node 内建模块 |
| 0.14.1 | 2026-10-18 | `c5f333b` | 面板错误隔离、面板懒加载、逃生开关 |
| 0.14.0 | 2026-10-18 | `429d05e` | 只读工作区/关系双面板、canvas 关系图、预览矩阵、代理名册、缓存策略接线 |
| 0.13.0 | 2026-10-18 | `83d3601` | TS、Java、Rust、PHP 的 `interface`/`type`/`enumeration`/`namespace` 成为一等 kind |
| 0.12.0 | 2026-10-18 | `84af8b8` | 领域体系：tex、book、markdown、html、各语言、office、包管理器；kind 过滤与目录层 |
| 0.11.0 | 2026-10-18 | `19bfedf` | 设置持久化、推理交还 DSH、缓存代理与品牌策略、对话框与标签修复 |
| 0.10.0 | 2026-10-18 | `8a8d0f7` | 设置目录、持久文件层、Turn 流水线、阶段冻结、数据结构采纳、可安装包 |
| 0.9.2 | 2026-10-18 | `73a273d` | 同一时刻只允许一个下拉框 tooltip |
| 0.9.1 | 2026-10-18 | `31f64da` | 恢复可用的下拉框 tooltip，移除全局合成锚点 |
| 0.9.0 | 2026-10-18 | `ad7d59f` | 共享算法库、蓝图领域模型、P0 解析器、全局 tooltip 宿主 |
| 0.8.0 | 2026-10-18 | `bef97b1` | 自动压缩、服务级接管、TokenGovernor、设置页重写 |
| 0.7.0 | 2026-10-17 | `8c196ce` | 五个下拉框接入工作流、tooltip、i18n、v24 写作情景 |
| 0.6.5 | 2026-10-17 | `81b6296` | 新增 low/medium/high 选择器 |
| 0.6.4 | 2026-10-17 | `118d5b7` | 工作流开关 |
| 0.6.3 | 2026-10-17 | `6aa9bb9` | 权限下拉标签对齐宿主 |
| 0.6.2 | 2026-10-17 | `16a38e7` | 新增“统筹”，修复 “+” 弹层闪烁 |
| 0.6.1 | 2026-10-17 | `dce5374` | 修复浏览器 `process` 崩溃 |
| 0.6.0 | 2026-10-17 | `2a33ef0` | 迁移到 Material UI |
| 0.5.0 | 2026-10-17 | `d318be5` | 移除 MDUI，改用纯 React |
| 0.4.0 | 2026-10-17 | `bf32401` | 移除 Angular，改用 MDUI 2 |
| 0.3.0 | 2026-10-17 | `c118132` | Angular Elements UI 与权限接管 |
| 0.2.0 | 2026-10-17 | `2b977cf` | 重塑为 DSH 双端插件 bundle |
| 0.1.9 | 2026-10-13 | `3ba4a45` | 修复字符串 target 被当作通配符 |
| 0.1.8 | 2026-10-13 | `8ee68dd` | 权限规则实际生效，接通审批 seam |
| 0.1.7 | 2026-10-13 | `0a2c2c0` | 修复 0.1.5/0.1.6 的激活故障 |
| 0.1.6 | 2026-10-13 | `42ff514` | 工具描述补上工具名 |
| 0.1.5 | 2026-10-13 | `b29c0e3` | workflow_plan 与缓存实测 |
| 0.1.2 | 2026-10-13 | `e4fade7` | permissions 在无 permission.json 时可用 |
| 0.1.0–0.1.1 | 2026-10-13 | `c2dae0c` | dsh-os 初始发布与 README 重写 |

## [未发布]

## [0.22.0] — 2026-10-29

### 变更

- **宽泛任务改为在计划里拆解，而不是记成一条条件。** comprehension 一直会把模糊任务标记成 `任务描述过于宽泛（A / B）`，而组织器此前把整条发现塞进一个笼统的 “resolve the open ambiguity” 步骤。现在 `broadTaskMarkers()` 会把括号里用户自己的任务片段拆出来，每条生成一个计划步骤 —— `Turn the broad request into a verifiable sub-task: A` —— 并带具体验收标准（`"A" has an observable done condition and its evidence is recorded`）。这条发现在计划里不再作为条件残留；其余歧义（指代不明、输入过短）仍保留自己的步骤。
- 同样的拆解适用于写作计划、编排草稿与写作草稿；共享过滤器是 `ambiguityWithoutBroadTask()`。

### 已验证

- `npm run typecheck`、`npm run test:tsc`、`npm test`（877 项，876 通过，1 跳过）、`npm run build`、`npm run pack:check`。
- `test/broad-task.test.ts`：辅助函数解析、逐片段生成带验收的步骤、不再残留宽泛任务条件、非宽泛歧义保留原步骤、编排草稿同样拆解。
## [0.21.0] — 2026-10-29

### 新增

- **`GET /amp/story?session=…`** —— 一个只读、非协议视图，把最新 turn 与它自己的请求摘录（折叠空白、截断 220 字）、目标文本、解码后的计划步骤（`intent` + 已记录 `expect`）以及最新注意帧的忽略列表拼在一起。注意帧本身只有 id 和理由，所以面板此前说不出“问的是什么、计划做什么”。
- 面板第一张卡片现在显示**真实请求**、轮次、职责/交互/情景标签及其理由、目标，以及一张**计划表**（步骤 · 内容 · 验收）。忽略项改成表格：具名条目 + 原因 + “何时会重新考虑”的具体条件。动作与可信度也用表格。

### 变更

- **面板内部全部改用 MUI 组件。** 原来的 `details`/`summary`、裸 `div`/`span` 与手写 flex 行，换成 `Card`/`CardContent`、`Table`/`TableContainer`/`TableBody`/`TableRow`/`TableCell`、`Accordion`/`AccordionSummary`/`AccordionDetails`、`Chip`、`Alert`、`Button`、`Typography`、`Box`。技术细节收在一个折叠的 MUI `Accordion` 里。
- 技术细节表把每个注意槽的 `role · target` 与原始 `why` 并排保留，原文不被丢掉。

### 已验证

- `npm run typecheck`、`npm run test:tsc`、`npm test`（873 项，872 通过，1 跳过）、`npm run build`、`npm run pack:check`。
- 测试：真实 turn 上验证 `/amp/story` 的请求摘录、目标与计划；面板源码使用 `parseAmpStory`、`MuiTable`、`MuiAccordion`，且不再有 `h('details')`/`h('summary')`。

### 已知限制（明说，不隐藏）

- 请求摘录截断在 220 字，是面板里唯一的请求文本；完整消息仍在对话记录里。
- `expect.check` 仍是记录下来的验收文本，不是可执行命令（P3b）。
## [0.20.0] — 2026-10-29

### 变更

- **底部不再有协调下拉框。** 输入框左侧的四个下拉框（职能、交互、情景、验证）以及权限接管下拉框都已移除，`conversation.input.left` 只保留接管对话框与停靠面板；DSH 自己的控件不受影响。职能 / 交互 / 情景 通过 `coordination_selection` 或主机配置默认值设定，现在**在面板里展示**。
- **面板改成写给普通读者看。** 一个只读、已本地化的叙述取代了原来的清单/注意帧/账本原始字段堆叠：*这次回答用了什么设置*（职能/交互/情景三项日常标签）、*它关注了什么、又主动放下了什么*（注意槽翻译成句子，被忽略项注明“条件变化时会重新考虑”）、*它做了什么*（最近五条回执用 读取/关注/回顾/询问/工具调用 表达）、*这份记录是否可信*（一行“完整/未通过”加校验器原因）。摘要、id、槽的 `why` 原文、`revisit_if`、能力等级与限制都收进可折叠的**技术细节**。
- **面板排版以 rem 为基础并设 1rem（16px）下限**（`PANEL_TYPE_SX`）。停靠面板里所有 9–14px 的小字号（chip、注释、摘要）统一提升到至少 16px；chip 高度改为 `1.5rem`。

### 新增

- `panel.selection` 与 `panel.plain` 两组中英文 copy：新面板的每个标签、句子与占位符（`{cycle}`、`{slots}`、`{count}`、`{label}`）都走 i18n，面板里没有硬编码文案。
- `useAmpSelection` 读取 `GET /selection?session=…`，随面板刷新按钮重新加载；读取失败显示“选择不可用”，不用默认值冒充这一轮的真实选择。

### 已验证

- `npm run typecheck`、`npm run test:tsc`、`npm test`（872 项，871 通过，1 跳过）、`npm run build`、`npm run pack:check`。
- 新增源码测试：输入框不再挂载 `ComposerControls`；面板读取 selection 且使用 plain copy；`panel.ts` 中不再有 `fontSize: 9–14`。

### 已知限制（明说，不隐藏）

- **验证等级不再在任何界面显示。** 它仍在服务端生效并按会话存储，只是没有展示；将来在面板加一行即可恢复可见性，无需恢复下拉框。
- 16px 下限会让面板的行距变宽，信息密集时滚动会比以前多。
## [0.19.0] — 2026-10-29

### 新增

- **`Goal` 与 `Plan` 制品，以“已记录验收标准”为闸门。** turn 结束且 plan 行可监控时，账本写入一条 `goal`（statement 与每个步骤一条 success criterion）和一条 `plan`（每个步骤一个带必填 `expect` 的 task、顺序边、由 plan 约束文本生成的 `abandon_if`、`commitment_window: 1`）。id 与注意帧引用的 ref 一致（`goal-<handle>`、`plan-<handle>`）。
- **闸门是显式的。** 只有同时满足：存在 goal 行、每个解码出的步骤都有 acceptance、plan 有约束、`validateGoal`/`validatePlan` 均通过，才写入这对制品；否则写一条 `plan.deferred` 事件说明原因（`missing-goal`、`no-steps`、`missing-expect`、`missing-abandon-if`、`invalid-artifact`），且不落库。
- **两种步骤形态都计入。** 普通 plan 步骤（`{ step, acceptance? }`）与编排草稿（`{ task, acceptance }`）都是同一 plan 的 task，一起供给制品。
- **协议移植**：`src/protocol/plan.ts`，含 `Goal`、`Expectation`、`PlanTask`、`Plan`、`validateGoal`、`validatePlan` 以及会抛错的 `assertGoal`/`assertPlan`。
- **测试**：goal/plan 校验（缺 criterion、缺 expect、空 check、重复 task id、非法 irreversibility、缺 `abandon_if`）、写入器的三种延后原因，以及真实 `CoordinationService` 上带 acceptance 的 turn。

### 已知限制（明说，不隐藏）

- `expect.check` 是记录下来的验收文本，不是可执行命令；插件没有 check 运行器，因此 plan 可被人监控、暂不能被内核监控（路线 P3b）。
- `Goal.value` / `priority` 取中性值（`0.5` / `1`），因为插件不对目标排序；`PlanTask.irreversibility` 默认 `1`（可撤销且有明确回退）。

### 已验证

- `npm run typecheck`、`npm run test:tsc`、`npm test`（870 项，869 通过，1 跳过）、`npm run build`、`npm run pack:check`。
## [0.18.0] — 2026-10-29

### 变更

- **只保留一个停靠面板：AMP 注意面板。** 原来的上下两个面板（关系 + 工作区）合并为一个只读面板，展示签名清单、当前注意帧（槽、排除项、预算）、最新回执，以及带校验结果的账本链头。工作区页签（文件/大纲/依赖/导入/导出/职能）不再挂载；它们的 hash 路由与视图仍留在模块里，但没有任何入口。
- **最小化后面板变成一个浮动按钮，而不再是一条标题栏。** 收起后只在会话右上角（头部操作按钮下方、对话区上方）留一个圆形按钮，点击即恢复停靠列。持久化状态改为 `{ open, width }`，旧的 `{ openRight, width }` 会被迁移，升级不会改变用户原有的展开状态。
- **工具重命名：`coordination_professionlock` → `coordination_profession_lock`。** 模型可见名称、copy 键、AMP capability id 与所有引用同步改名；工具行为与 schema 不变。

### 已验证

- `npm run typecheck`、`npm run test:tsc`、`npm test`（864 项，863 通过，1 跳过）、`npm run build`。
## [0.17.3] — 2026-10-29

### 修复

- **工具声明的输出 schema 与实际值脱节。** JSON 边界修好后，DSH 的下一道检查立刻命中：`coordination_selection` 返回了 `value.frozen` 与 `value.config.compaction`，而 `SELECTION_STATE_SCHEMA` 两者都没声明（两个对象都是 `additionalProperties: false`）。于是路由、客户端和单测都正常，真机调用却每次都失败。
  - `SELECTION_STATE_SCHEMA` 现在声明 `frozen`（逐维冻结表）。
  - `SELECTION_CONFIG_SCHEMA` 现在声明 `compaction`（auto/soft/hard/reserve/recentTurns/cooldown/maxPerSession）。
- **防回归**：`test/json-safety.test.ts` 遍历投影出的 `SelectionState`（顶层与 `config`），断言每个键都在声明的 schema 中，投影字段不可能再跑在 schema 前面。

### 真机验证（桌面客户端，0.17.3）

- `coordination_selection` 在运行中的客户端返回完整 `SelectionState`，包含 `frozen` 映射与 `config.compaction`。
- 该调用写入 `attend success` 回执；同一链上还有一条已关闭 turn 的 `reflect success` 回执（`ms = 135246`）。
- `GET /amp/verify` → `{ ok: true, reasons: [], tip: sha256:063e1e1…, count: 40, checkpoint: { seq: 0, count: 19 } }`——后续追加相对更早的检查点仍然合法，正是 §3.6 的行为。
- `GET /amp/manifest` 中 `coordination_selection` 为 **T2 / 置信度 0.833**，证据引用三条回执 id，即 M-1 推导在真机上成立。

### 已验证

- `npm run typecheck`、`npm run test:tsc`、`npm test`（864 项，863 通过，1 跳过）、`npm run build`、`npm run pack:check`。
## [0.17.2] — 2026-10-29

### 修复

- **真实客户端里一次工具调用被 harness 的 JSON 边界拒绝。** `coordination_selection` 在运行中的桌面客户端返回 “value is not lossless JSON”：DSH 会把每个工具结果解构成纯 JSON，一旦有损就拒绝整次调用。插件有两处投影可能携带“存在但值为 undefined”的键（`presets[].description` 与 `defaultMode`），外部 port 还可能引入新的。
  - `SelectionModule.listPreset` 在 `description` 缺失时直接省略，不再写入 `undefined`。
  - `SelectionModule.state` 只在 `defaultMode` 是非空字符串时才投影它。
  - **边界保证**：`withAmpReceipts` 现在把每个成功返回值先经 `jsonSafe`（`src/shared/json-safe.ts`）解构——嵌套 `undefined` 丢弃、`NaN`/`Infinity` → `null`、`-0` → `0`、`bigint` → 字符串、`Date` → ISO、`Map`/`Set` → 对象/数组、环被切断；发生改动只记 debug 日志，而不是让模型的调用失败。
- **`GET /deepseek-coordination/ping` 现在返回正在运行的插件版本**（`version: "0.17.2"`），无需重启即可确认到底加载了哪个构建。

### 新增

- `test/json-safety.test.ts`：真实形态（外部预设目录 + 缺 `defaultMode` 的 sandbox port）、完全缺失 sandbox port、`jsonSafe` 覆盖各类有损值，以及工具包装器在有损时仍写成功回执。
- `test/helpers.ts` 支持可选 `sandboxPolicy` port。

### 真机验证（桌面客户端，2026-10-29）

用 `dsh plugin --profile desktop add` 安装进 `%DSH_HOME%\profiles\desktop`。运行中的 harness 热加载了该包，以下均在**当前客户端**实测：

- `GET /deepseek-coordination/ping` → `{plugin, pong, locale}`；`GET /amp/identity` → 真实 Ed25519 `kid`。
- `GET /amp/manifest` → 11 个 capability、1 个 self 签名；在插件之外用独立的规范 JSON + WebCrypto 实现验证：`digestMatches: true`、`signatureValid: true`、`kidMatches: true`。
- 账本里已有真实会话：19 条记录、三张注意帧（各 4 槽、2 条排除）、`turn.opened` 映射、工具回执（`attend`/`read`）、一个已关闭 turn 的 `reflect` 回执，以及镜像的 `pipeline.report` 事件（其文本字段为 `[text omitted]`）。
- `GET /amp/frame?session=…` 返回真实注意帧（mode、cycle、digest、带 `why` 的槽、带 `revisit_if` 的 `ignored`）。
- `POST /amp/checkpoint` 在 `count 19`、tip `sha256:c9c3a69…` 上封出 `seq 0` 检查点；`GET /amp/verify` → `{ok: true, reasons: [], checkpoint: {seq: 0, count: 19}}`。
- 客户端模块 `plugins/??deepseek-coordination/client.js&rev=…` 为 3,441,910 字节，并出现在 `__DSH_BOOT__.entries` 中。

### 已知发现

- **包更新不会热替换**：应用运行时安装 0.17.1，内存里仍是旧模块，因此 0.17.2 的修复需要重启后生效（用 `/ping` 的版本确认当前生效构建）。
- 插件声明 `inject: ['webServer']`，所以**无 webserver 的 headless profile** 中该条目会一直 pending。组合服务本身不需要路由，但激活会等待该服务；headless 部署需要挂载 webserver 插件或放宽 inject。

### 已验证

- `npm run typecheck`、`npm run test:tsc`、`npm test`（864 项，863 通过，1 跳过）、`npm run build`、`npm run pack:check`。
## [0.17.0] — 2026-10-29

### 新增

- **接管窗口成为 AMP 注意事务。** gate 的可选 observer 在窗口开启时以 `attention.requested` 事件承载 `AttentionRequest`（`kind: "attention-request"`），在结算时以 `interrupt.settled` 事件承载 `InterruptRecord`（`kind: "interrupt"`），并恰好写入一条 `ask` 回执。
- **对象策略固定且写入文档。** 审批是 `commitment`、紧急度 4、目标为工具；提问是 `curiosity`、紧急度 3、目标为窗口。`cost: { interrupts: 1 }`、`fallback: escalate`，`expires` 使用 gate 自己的 `clarifyTimeout`，对象与定时器一致。
- **诚实的结算映射。** `allowed-once → granted/success`、已回答提问 → `answered/success`、`rejected → denied/blocked`、取消/卸载 → `withdrawn/partial`、超时 → `expired/partial`；`usage.interrupts` 仅在 `granted`/`answered` 时为 1，`usage.ms` 是实测窗口时长。`granted` 由 builder 从 `status` 推导，二者不可能互相矛盾。
- **协议移植**：`src/protocol/social.ts`，含 `AttentionRequest`、`InterruptRecord`、校验/构造器与 `interruptOutcome`。
- **测试**：对象校验（紧急度/fallback/状态矛盾）、gate observer（requested 与 granted/denied/withdrawn/expired）、AMP 写入器，以及真实 `CoordinationService` 上经 `handleApproval` → `answerPendingTakeover` 的窗口。

### 变更

- `TakeoverGate` 接受可选 `observer`，并把 `expired` 与 `withdrawn` 分开上报；没有 observer 时行为不变（既有测试全部原样通过）。
- `AmpService` 提前到 gate 之前构造，便于 gate 上报窗口；只移动了构造位置，公开 API 未变。
- `docs/amp-conformance.md` 新增 §3.10 并把 P2 标为完成；剩余缺口只是 interrupt **策略**（上限、免打扰、债务），不再是对象本身。

### 已验证

- `npm run typecheck`、`npm run test:tsc`、`npm test`（859 项，858 通过，1 跳过）、`npm run build`、`npm run pack:check`。
## [0.16.0] — 2026-10-29

### 新增

- **comprehension 产出经 warrant 校验的 claim。** turn 结束时，comprehension 行被转成最多四条 `claim`（`intent`、`requirement`、`constraint`、`assumption`）与一条 `unknown`（歧义），写入 AMP 账本，并用一条 `cognition.recorded` 事件汇总。
- **分级诚实规则。** 只有语句**逐字**出现在用户提示词中（大小写/空白不敏感；整句或其中一句）才升到 `T1`；证据是一条 `testimony` 项：`trust: asserted`、`independence: 1`、`entails: true`、`origin: prompt:<turn>`、`memory` 引用、≤200 字摘录及其 `digest`。改写/转述保持 `T0` 且无证据。
- **置信度只推导、不读取。** 每条 claim 的 `confidence` 都是 `deriveConfidence({tier, warrant})`（T1 为 `0.7`，受 asserted 信任上限约束；T0 为 `0.35`）。comprehension 行自己的 `confidence` 只用于 unknown 的 `importance`（`1 − confidence`）。
- **非法 claim 直接丢弃。** 写入前先跑 `validateClaim`；不通过只记日志、不入账。占位值（`none`、`n/a`、`-`、`无`、`暂无`、`不适用`、`null`、`undefined`）不产生任何对象。
- **测试**：两个内核接线用例（T1/T0 分界、证据形状、unknown importance、所有已存 claim 均可校验）以及一个真实流水线的生命周期断言。

### 变更

- `AmpTurnFacts` 增加可选的 `cognition` 块；`CoordinationService.ampFactsFor` 从 comprehension 行与提示词填充。
- `docs/amp-conformance.md`：Warrant 一节从“仅内核”改为“已接线”，新增 §3.9 记录 claim/unknown 规则，不变量表新增 W-4b，路线图把 P1 标为完成并列出 P1b。

### 已验证

- `npm run typecheck`、`npm run test:tsc`、`npm test`（853 项，852 通过，1 跳过）、`npm run build`、`npm run pack:check`。

## [0.15.0] — 2026-10-29

### 新增

- **AMP v0.1 协议层**（`src/protocol/`）：公共原语、规范 JSON 与 `sha256` 摘要、id 语法、AMP 错误族、Ed25519 封签信封及其接收运行时、签名清单、注意帧构造边界（9 槽上限、必填 `why`、自算摘要、溢出排除返回 `deferred`、引用必须可解析）、回执与事件、warrant 推导规则（分级门槛、置信度推导、修订保留旧值）以及带签名检查点的 append-only 账本。移植自 `attention-manifest-protocol` v0.4.1，归属见 `NOTICE`。
- **`AmpService`**（`src/host/amp.ts`）：插件状态被投影成协议制品。签名清单的 capability 分级/置信度由已记录回执推导；每个 turn 一张注意帧，`ignored` 列出本宿主故意不执行的场景策略项；turn 结束写一条 `reflect` 回执，`usage.ms` 为实测时长；每次工具调用经 `withAmpReceipts` 写一条回执；模块事件按白名单脱敏后进入账本。
- **Schema 25**（`src/host/database.ts`）：新增 `amp_object`（哈希链）、`amp_key`（Ed25519 身份）、`amp_manifest`、`amp_checkpoint`，以及八个使 AMP 表只能写一次的触发器。纯增量：schema 24 的库一行不动。
- **`/amp/*` 路由**：`GET /amp/identity`、`/amp/manifest`、`/amp/frame?session=`、`/amp/receipts`、`/amp/ledger`、`/amp/verify`，以及 `POST /amp/checkpoint`。沿用 `{ ok, value | error }` 信封；私钥永不出现在响应中。
- **`docs/amp-conformance.md`**：逐制品映射、带参考规则编号（A-1、F-2、M-1、W-4、X-1 …）的不变量表、插件概念映射、刻意未实现的清单与 P1–P5 路线图。
- **测试**：`test/amp-protocol.test.ts`（内核：规范 JSON、id、帧边界、warrant、信封篡改/过期/FIFO、账本/快照/检查点、清单）、`test/amp-wiring.test.ts`（推导分级、帧排除、实测回执、SQLite 不可改写、篡改检测、检查点前缀语义、工具装饰器、事件脱敏）、`test/amp-lifecycle.test.ts`（临时库上的真实 `CoordinationService`）与 `test/amp-routes.test.ts`（`/amp/*` 路由表及其 400/404 形状）。

### 变更

- **Schema 版本 25，68 张表、15 个触发器、67 个索引。** `test/persistence.test.ts` 现在断言 schema-23 库会补上 AMP 表。
- **`ConfigPatchResult` 补上 `normalised` 字段**（`POST /config` 早已返回它）。
- **`GET /ping` 要求 GET 方法**，其它动词落到 404 信封。
- **`BUSY` 与 `UNSUPPORTED_MEDIA` 纳入 `CoordinationErrorCode`** 并补齐中英文案，类型消费者可以穷举联合。

### 修复

- **`npm run typecheck` 恢复通过。** `src/host/adapters/sqlite/turn-store.ts` 使用了未导入的 `PromptSnapshot`/`CommandSnapshot`。
- **`/graph/intra` 与其它图路由一样按请求解析工作区根**；此前它回退到默认根，同一文件可能与 `/graph/outline` 描述的不是同一个工作区。
- **数据库 schema 注释不再截断模板字符串**（SQL 注释里的反引号曾提前结束字符串）。

### 已验证

- `npm run typecheck`、`npm run test:tsc`、`npm test`（851 项，850 通过，1 跳过）、`npm run build`、`npm run pack:check`。

## [0.14.10] — 2026-10-18

### 变更

- **依赖改为项目级，导入保持文件级。** `/graph/dependencies` 只返回项目之间的引入边：
  `{ from, to, relation:'depends', kind:'project', medium:'code'|'document', manager?:'npm'|'maven'|'tex', label?, external, cyclic }`。
  代码工程来自 `package.json` 与 `pom.xml` 的依赖条目（from = manifest 路径；to = 声明名称能绑定的工作区项目 manifest，否则是带包名/坐标的 `external:true` stub）；文档来自 `.tex` 的 `\cite` 系列命令，**`\ref`/`\label` 刻意不算依赖**。
  `/graph/imports` 保持文件级行，并新增自己的文件级 `cyclic` 与 `cycles`（基于已解析的文件 `depends` 边），项目环与文件环不再混算。
- **`NodeKind` 新增 `dependency` 与 `citation`。** npm/maven 本已产出 `dependency` 节点、chain 也已持久化；投影现在读取这些证据而不是合成边。

### 新增

- **TeX `\cite` 扫描**：`cite`、`citep`、`citet`、`citealp`、`citealt`、`citeauthor`、`citeyear`、`citeyearpar`、`cites`，支持可选 `*`、最多两个可选参数与逗号分隔键；每个键产出带独立 span 的 body-free `citation` 节点。
- **项目级环检测**：在项目边集上做 SCC 标记 + 有界简单环列表，排序 `medium → from → to`，上限仍为 2000 边 / 50 环。

### 修复

- **聊天排版与 Markdown 误用。** 消息正文改为纯文本（`white-space: pre-wrap`、`overflow-wrap: anywhere`），不解析 Markdown、不注入 HTML；行使用固定槽位（`estimateMessageHeight`、`computeRowLayout`、累计偏移），气泡不再重叠。旧聊天路径把已构建的 `rehype-katex` transformer 当作 unified 插件传入，抛错后每条消息静默回退原始文本；预览里的同类误用一并修正。
- **右键菜单落地。** `PanelContextMenu`（光标锚定 MUI `Menu`，Esc/遮罩/选中关闭）接到文件行、目录行（预览/定位/复制禁用，展开可用）、大纲分组与节点、职能行；职能菜单附只读信息/目标/计划弹窗，发送/停止保持禁用并注明"宿主命令未接入"。复制走 clipboard API 并有 textarea 兜底，失败只 warn。

## [0.14.9] — 2026-10-18

### 修复

- **两个面板挂载即崩溃。** MUI `Fade`/`Grow` 会克隆唯一子节点，在 appear 过渡开始时调用 `reflow(node)`（即 `node.scrollTop`）。面板内容过渡包着 `PanelScrollProvider`，而它只渲染 `Context.Provider`，过渡拿不到 DOM 节点，抛出 `Cannot read properties of null (reading 'scrollTop')`，被边界捕获后两个面板只剩崩溃徽标。现在所有过渡子节点都是真实的 `div`/`span` 宿主元素（预览、状态、作用域 Chip、内容区全部包括），ref 一定挂得上，动画照常。预览过渡里的同类隐患一并修掉。
- **列改为 portal 并内缩。** DSH 外壳存在带 `transform` 的祖先，`position: fixed` 会相对它解析，导致面板溢出右边并忽略上下间距。现在通过 `createPortal(column, document.body)` 渲染（SSR 回退内联），`top:72 / right:16 / bottom:120`、`width:min(440px, calc(100vw - 32px))`、`maxHeight:calc(100dvh - 192px)`；面板项 `box-sizing:border-box` + `minWidth:0`，长路径用省略号而不是把面板撑宽。
- **回归测试**：挂载两个面板、刷新过渡计时器，断言无边界报告、无崩溃徽标，并钉住 portal 目标与完整的边距/宽度契约。

### 变更

- `column.width` 与「重置面板宽度」菜单项不再参与渲染：宽度改为上面的固定响应式预算，持久化字段为兼容保留。

## [0.14.8] — 2026-10-18

### 新增

- **面板虚拟化。** `visibleTreeRows()` + `VirtualTree`（slot `(depth, index, value)`）与 `VirtualList`（slot `(index, value)`），各自独立 Adapter 与工厂。文件、大纲、职能、依赖行按固定 48px 渲染，2000 文件的工作区不再挂 2000 个 DOM 行。
- **MUI List 行样式。** `ListItemButton` dense + `ListItemIcon`/`ListItemText`，`action.hover`/`action.selected`、内嵌焦点环、ripple；树行 `role="treeitem"`/`aria-level`/`aria-expanded`，列表行 `role="option"`/`aria-selected`；`prefers-reduced-motion` 关闭过渡但保留 ripple。
- **每个页签都是路由页。** 底部：`files/outline/dependencies/imports/exports`；顶部：`files/agents/dependencies/imports/exports`。导入/导出在两个面板都是 WebGL canvas 页；`right/preview?path=…` 与 `left/agent?id=…` 是可深链、但不进导航的路由。
- **预览改为路由页。** 移除预览页签与所有眼睛按钮；预览在面板内整页打开，带返回按钮与 `Esc`，复用现有净化后的 Markdown/HTML/代码/xlsx/pptx 管线。
- **两级大纲。** 全局大纲以工作区为根、按**最外层** manifest 项目分组；局部分大纲（`outline?path=…`）以文件为根、只列结构节点，支持返回/Esc，并保留滚动与折叠状态。
- **职能详情页。** `left/agent?id=…` 只读虚拟化聊天：Markdown 经共享懒加载管线 → `renderToStaticMarkup` → DOMPurify + 二次 scrub；失败降级纯文本。无输入框、无发送/重试。
- **四个只读工具。** `coordination_file`、`coordination_outline`、`coordination_importation`、`coordination_exportation`：有界、确定性、body-free，带 `truncated` 与结构化 `INVALID_ARGUMENT`。
- **工作区树与项目作用域。** `buildTree` 原样回显解析出的工作区根（绝不用公共前缀），并返回 `projects` 与 `nestedManifests`；`projectScopeOf()` 取**最外层** manifest，否则回退工作区根。`DEFAULT_MANIFEST_NAMES` 覆盖 package.json、pom.xml、Cargo.toml、go.mod、pyproject.toml、build.gradle、settings.gradle、composer.json、Gemfile、mix.exs、dune-project；忽略名单仍优先。
- **任务队列单例。** `Task` 三个队列：high 每个 `requestAnimationFrame` 执行一个，medium/low 每个 `requestIdleCallback` 执行一个（剩余 <4ms 让出），无 rAF/rIC 时回退 `setTimeout(16)`；单任务异常隔离，空闲零回调。

### 修复

- **面板不再溢出。** 列容器夹在 `top:72 / bottom:120 / max-height:calc(100dvh - 192px)`；移除 320px 最小高度；`splitPanelHeights()` 保证两个面板都在容器内（空间不足时都折叠为 48px）。
- **搜索框从右侧展开。** 标题栏搜索用 220ms 横向 MUI `Collapse`（向左生长），再次点击/点外部/`Esc` 关闭并清空查询；reduced-motion 下瞬时切换。
- **`panel.agentInfo.id` 两语言不再相同**（`代理 ID` / `Agent ID`），由文案一致性测试发现。

## [0.14.7] — 2026-10-18

### 修复

- **预览保留选中的文件。** 预览页签现在从 `navigation.path ?? lastPathRef.current` 解析路径：点底部「预览」会带上当前选中文件，作用域芯片、过渡 key 与视图正文统一读同一个 `viewPath`，不会再出现"芯片显示文件、正文说没选文件"。
- **预览解析会话工作区。** `/graph/preview` 之前仍用同步的 `resolveToolWorkspaceRoot(service)`，桌面端会解析成安装目录，导致工作区文件预览 404。现在与其他 graph 路由一致，用按请求的异步解析器（仅工作区相对路径、不接受 `root` 覆盖），把根目录传给 `previewOf(path, root)`；路径规范化、realpath 越界检查与 64 KiB/Office 上限不变。

## [0.14.6] — 2026-10-18

### 变更

- **关系画布改用 WebGL2 渲染。** 节点、边、箭头与虚线走实例化四边形/三角形，虚线相位与循环脉冲在着色器里算；世界坐标随缩放变化，但标记保持屏幕尺寸（语义缩放修复保留）。样式缓冲只在 hover/选中/细节级别/主题变化时重建，动画帧只更新 uniform。
- **用一个优先级 `RenderTaskQueue` 取代常驻帧循环。** `INTERACTIVE(0) > ANIMATION(1) > LAYOUT(2)`，同 key 合并，单一 `requestAnimationFrame` 泵，8ms 预算，异常任务隔离，空闲时零帧；动画约 30fps。
- **2D 只负责文字。** 标签与点击涟漪画在透明叠加层，只在视口/hover/选中/场景/涟漪变化时重绘。
- **廉价回退。** 没有 WebGL2、着色器初始化或运行时绘制失败时，退回原 2D 渲染器并重挂 canvas，不会白屏。
- **hover 不再触发 React 重渲染。** 指针移动只更新 ref 并调度绘制；画布下方最多 500 行的文本替代按 graph/locale 记忆化。

## [0.14.5] — 2026-10-18

### 修复

- **放大不再放大标记。** 节点圆点、标签、线宽、虚线、箭头与点击涟漪都用 `1/scale` 反向缩放：放大是看清细节，而不是把圆点变成大团块；视口仍缩放位置与边长，命中检测（本来就是 `(radius + slop) / scale`）保持正确。
- **目录树可以展开收起。** `FilesView` 之前把 `/graph/tree` 拍平成列表、目录行 `onClick: undefined`，箭头只是装饰。现在目录支持点击/Enter/空格切换并带 `aria-expanded`，用祖先前缀过滤隐藏后代，同根刷新保留状态、换根自动重置。
- **密集图打开就可读。** 每次载入数据/切换视图后自动 fit（包围盒 → 缩放夹在 `[0.15, 1]`、居中、48px 边距）；布局半径随 `√节点数` 增长（`min(640, 48 + √n · 40)`）；`scale < 0.55` 时隐藏非活动节点标签（hover/选中/追踪路径始终显示）；`scale < 0.3` 时不画箭头、边按 1 屏幕像素。滚轮/`+`/`−`/平移会置 `userAdjusted`，窗口缩放不再与手动缩放打架；fit 按钮复用同一路径，最小缩放改为 `0.15`。

## [0.14.4] — 2026-10-18

### 修复

- **索引器现在能找到会话工作区。** `resolveToolWorkspaceRoot()` 之前回退到 `process.cwd()`，而桌面应用的 cwd 是安装目录，导致 `POST /graph/index` 扫描不到文件（`indexed: 0`、2 毫秒），而从仓库启动的 CLI 却能索引 155 个文件。解析器改为**异步、按请求**：显式 `root` → `service.workspaceRoot` → `host.workspaceRoot` → `sandboxPolicy.resolve({ session })` → `workingDirectory.ensure(agent)`（1.5 秒超时）→ 会话记录的 `workingDirectory` → `cwd`。每个候选都做 stat 校验，非目录会被跳过。
- **根目录错了要看得见。** `/graph/index` 返回 `root`；没有任何文件命中时返回 `diagnostics: [{ code: 'no-workspace-files', root }]`；客户端在空态显示解析到的根路径，`indexed === 0` 时用带路径的 warning 提示而不是成功提示。

## [0.14.3] — 2026-10-18

### 修复

- **面板从底部向上堆叠。** 停靠列使用 `justify-content: flex-end`：工作面板贴底，展开时把关系面板顶上去；两个面板展开时按 `1 1 0px` 均分高度。
- **面板内部改为有界 flex 链。** 移除 320px 最小高度；标题栏 48px、作用域条固定、内容 `flex:1; min-height:0` 且自行滚动、底部导航固定 56px。MUI `Collapse` 的包装层只在 `entered` 后加入填充链，保证高度测量正常。
- **Tab 点击不再依赖 URL hash。** 每个面板用 `useReducer` 保存视图状态；hash 只在挂载时读一次，之后仅用 `history.replaceState`（try/catch）镜像，DSH 路由不会再把点击覆盖掉。
- **空图可以主动填充。** 新增 `POST /graph/index`：遍历工作区（深度 ≤8，跳过 `node_modules`/`.git`/`dist`/`.tmp`，按扩展名白名单，200 文件 / 10 秒，串行 409 BUSY），走既有解析/图路径建立索引；文件视图空态提供「索引工作区」按钮。只读：不写文件、不构建、不执行。

### 变更

- **标题栏改用 `primary.main`**，两个面板呈现为 MUI AppBar。
- **搜索改为 MUI `Autocomplete`**：250ms 防抖、键盘选择、自绘滚动条（`ScrollBar`，隐藏原生滚动条）。

## [0.14.2] — 2026-10-18

### 修复

- **客户端 bundle 不再引用 Node 内建模块。** `vfile`（`react-markdown` 的依赖）从
  Node 入口 import 了 `node:path`、`node:process`、`node:url`，而它的 `exports`
  没有暴露浏览器变体，于是被打包器外部化。DSH 客户端模块表只认已注册的包 id，
  整个 web boot 因此失败：`client-modules: require("node:process") missed the
  module table`。现在客户端构建把三个浏览器 shim
  （`src/client/shims/node-{path,process,url}.ts`）alias 进去；产物中不再有
  `require("node:*")`，factory 只向模块表要 `react`。

## [0.14.1] — 2026-10-18

### 修复

- **面板出错不再拖垮整个 harness。** 两个面板、固定列与预览子树各自包了错误边界：
  渲染 `null`、只打一条 `[coordination] panel failed`（含组件栈）、标题栏显示小号
  “Panel crashed” 徽标。`panel.ts` 改为 `React.lazy` 加载（配合
  `codeSplitting:false`，客户端仍是单文件、模块体仍延迟执行），可兜住依赖求值期
  的失败。
- **无需重装的逃生开关。** `localStorage['coordination.panel.disabled'] = '1'`
  时不挂载任何面板。
- **可诊断性。** `error`/`unhandledrejection` 统一以 `[coordination]` 前缀打印；
  预览用的 markdown/KaTeX/Prism/DOMPurify 改为懒加载，不影响面板首屏。

### 变更

- **发布布局约束：** 客户端必须保持单个 `lib/client.js`——DSH 客户端加载器只解析
  已注册 id，tarball 也只带一个客户端文件。

## [0.14.0] — 2026-10-18

### 新增

- **右侧停靠的两个只读面板。** 关系面板（文件/职能/依赖/导入/导出）与工作面板
  （文件/大纲/依赖/导入与导出/预览）共用一个外壳：菜单、搜索、最小化/还原的标题栏，
  由 hash 路由的 Card 内容（`#coordination/panel/right/<view>?path=…`），以及
  flex 堆叠——一个还原会把另一个顶上去。只持久化 `{ openLeft, openRight, width }`；
  最小化只保留 48px 标题栏，**没有浮动按钮**。
- **canvas 关系图。** 原生 2D canvas，确定性环形/分层/星形布局，方向虚线流动、环脉动、
  hover 高亮与自绘 tooltip、边/节点命中、点击选中、滚轮缩放、拖拽平移、键盘遍历与
  文本替代；颜色取自 MUI 主题，`prefers-reduced-motion` 下静态渲染。
- **预览矩阵。** Markdown/GFM + `remark-math`/`rehype-katex`；HTML 与 `docx` 经
  DOMPurify；代码用 Prism（主题由 MUI 派生）；纯文本；`xlsx` 表格；`pptx` 卡片。
  全部只读，64 KiB / 行 / 页上限以 `truncated` 呈现。
- **代理名册。** 关系面板列出主代理与子代理的目标、状态、**预计**进度环
  （`completed`/`turns`/`unknown`）与总体进度条；点击进入只读消息页。
- **工作区图路由。** `GET /graph/tree|outline|dependencies|imports|search|preview|
  intra|agents`、`GET /graph/agents/messages`、`POST /graph/rebuild`。查询支持可选
  `path` 作用域与 `kind` 过滤；依赖用 SCC 报环且不删边。只有 `preview` 与
  `agents/messages` 承载正文：有界、`no-store`、不落日志、不缓存。
- **二级缓存与环检测。** L1 请求内，L2 以"图版本 + 作用域 + 路径"为键（容量 512、
  FIFO、不缓存正文）；迭代 Kosaraju SCC 保证深链不爆栈。
- **缓存策略表。** `src/host/cache-strategy.ts` 提供 18 条预置（10 品牌 + 5 模型 +
  3 agent）与 18 条引用来源；`presetFor()` 接入代理的 normalize 门控，并以
  `status.cacheStrategy` 暴露。
- **代理服务抽取与度量。** `createProxyService()` 负责 install/status/trace/adapter；
  `status` 新增 `mode`、`upstreamProvider`、`metrics { inputTokens, cachedInputTokens,
  hitRate, window }`、`prefix { current, stable, changes }` 与 `cacheStrategy`；
  新 trace 事件 `compat`/`prefix`/`prefix-churn` 均为结构化。

### 变更

- **代理默认 `measure`。** 开启代理不再改写请求；`normalize` 需 `proxy.mode`、
  `proxy.rewrite` 或 `DSH_COORDINATION_PROXY_REWRITE=1`，先让基线可观。
- **`effortBreaksCache` 改为三态。** 没有抓取到任何厂商文档说明 effort 会改变缓存键，
  因此所有 profile 报 `'unknown'` + `effortEvidence: 'assumed'`，**未知不等于 false**。
- **HTML 的 `<article>` 是分区容器。** HTML/Markdown 不再产出文学意义的 `article`，
  只有 book 解析器产出。
- **许可证改为 Apache-2.0**（原 MIT）。
- **停靠布局后移除 `react-rnd`。**

### 修复

- **代理路由下 web 搜索的账户回退**（宿主侧）：记录的路由 id 不再阻断账户令牌；
  已在 app asar 打补丁并附备份与回滚脚本，缓存与代理代码未动。
- **声明跳过初始化器时丢失 `import`/`require` 引用**，以及 `handleDeclaration`
  用原始 token 索引导致的崩溃。
- **解析器过期断言**已对齐新 kind；公共导出白名单钉住每个新模块。

## [0.13.0] — 2026-10-18

### 新增

- **声明类 kind 一等化。** `interface`、`type`、`enumeration`、`namespace` 进入
  `NodeKind`，解析器不再把它们折进更粗的 kind：
  - TypeScript：`interface` → `interface`，`type` 别名 → `type`，
    `enum`/`const enum` → `enumeration`，`namespace`/`module` → `namespace`。
  - Java：`interface` 与 `@interface`（`label: 'annotation'`）→ `interface`，
    `enum` → `enumeration`；`record` 仍为 `class`（`label: 'record'`）。
  - Rust：`enum` → `enumeration`（`label: 'enum'`）；`struct`/`trait`/`impl` 仍为
    `class` 并保留各自 label。
  - PHP：`interface` → `interface`，`enum` → `enumeration`；`trait` 仍为 `class`
    （`label: 'trait'`）。
- **`enum` 作为历史拼写留在联合里**（有注释说明无解析器产出），避免旧数据与精确
  kind 无声冲突。

### 变更

- 声明的 locator 与引用 target 现在由映射后的 kind 派生（如
  `java:interface:Runner`、`java:enumeration:Mode`），因此 handle 按声明种类稳定，
  而不是按粗分组。

## [0.12.0] — 2026-10-18

### 新增

- **按体系拆分的领域概念层。** `src/host/text/` 每个体系一个解析器，统一产出
  body-free 的 `NodeMetadata`：
  - **tex** — `calculation`/`computation`/`derivation` 语句；显式条件标记扫描
    （`\requires`、`\meets`、`\necessary`、`\sufficient`、`\adequate`、
    `\invariant`、`\assumption`、`\hypothesis`、`\guard`、`\constraint`、`\goal`）。
    `relation` **只**由 `\requires`/`\meets` 设置。
  - **book** — `SUMMARY.md` 目录（`part`/`chapter`/`section`）与 front matter
    （`type: book|article`、`author`→`person`、`venue`）。`article` 只在这里产出。
  - **markdown** — 一级标题 → `chapter`，每个链接/图片 → `link`，每个围栏代码块 →
    body-free `code`，`document` 无条件产出。
  - **html** — `a`/`img`/`link`/`script` → `link`，`pre`/`code` → `code`；
    `<article>` 是分区容器，映射为 `section`/`document`，绝不产出文学意义的 `article`。
  - **javascript/typescript** — `variable` 节点（含解构绑定）、`binding`/`scope`
    （`global|local|static`），以及 TS 的 `interface`、`type`、`enum`、`namespace`。
  - **java**、**python**、**c/c++**、**rust**、**php** — 各自一个词法解析器，产出
    `importation` 引用、类型、函数/方法与文件级变量；`struct`/`trait`/
    `implementation`/`interface` 等细分放在 `label`，不新增 kind。
  - **maven** / **npm** — 从 `pom.xml` 与 `package.json` 产出 `project`、`module`、
    `dependency`、`parent`、`script`，按精确文件名匹配。
  - **office** — 有界 ZIP + OOXML 读取：`docx`（`document`/`chapter`/`section`/
    `link`）、`xlsx`（`workbook`/`sheet`/`range`/`formula`）、`pptx`
    （`document`/`slide`）；`pub`/`accdb` 返回显式 `unsupported-format` 诊断，不臆测。
  - **text** — `sentence` 切分与 `line` 区间（坐标，不是节点）。
- **`coordination_chain` 的 `kind` 过滤。** 所有返回节点的动作都接受可选 `kind`
  （去空格、大小写不敏感）；过滤只收窄遍历，无匹配返回空列表而不是报错。中英文案齐备。
- **目录层。** 索引 `pkg/src/a.ts` 会为 `pkg` 与 `pkg/src` 建立 `directory` 节点及
  `contains`/`part_of` 边；按 handle 幂等，且只从无歧义的工作区路径派生。
- **`NodeRecord`**（`src/shared/node-record.ts`）：规范的 body-free 记录
  `{ path, charset, byte:{start,end}, line:{start,end}, fingerprint, dirty,
  summary, brief, description, reference, purpose, children }`，坐标用 `number`，
  可 JSON 往返，内联深度由调用方传入。
- **新依赖**：`fflate` 与 `fast-xml-parser`，已内联进宿主与客户端产物，无运行时 `require`。

### 变更

- **方向不变量。** `part_of`（子→父）只由可证明的证据写入；`contains`（父→子）允许
  不完整，属"尽力而为"。通用 `path`/`cycle` 遍历默认跳过目录端点，除非调用方显式指定关系。
- **`SUMMARY.md` 由 book 解析器处理**（注册表的文件名优先规则）；`README.md` 等仍走 Markdown。
- **`TexStatementKind` 改为 `StatementKind` 的别名**，解析器与枚举不会再漂移。

### 修复

- **动态 import 与 `require` 丢失**：声明跳过初始化器时未回扫，现在对跳过区间做有界重扫。
- **`handleDeclaration` 崩溃**：把原始 token 索引当 `sig` 下标用，前置空白一多就越界；
  现在 span 用正确位置、符号保留原始索引。
- **`test:tsc` 夹具类型**（无名权限预设、`current()` 返回 `undefined`、`Forwarded` 缺
  `model`/`temperature`）已修正，未削弱断言。
- **解析器测试的过期断言**已对齐新语义：HTML 不再产出 `article`、Markdown `#` 恒为
  `chapter`、公共导出白名单补上新模块（`node-record.ts` 用空类表钉死）。

## [0.11.0] — 2026-10-18

### 新增

- **设置持久化。** 页面通过宿主自己的覆盖文档 `<数据库目录>/config.overrides.json`
  保存：一个扁平的 `{ "plan.threshold": 0.7 }` 映射，原子写在协调数据库旁边，
  下次启动覆盖在 profile 配置之上。`POST /config` 只有在文档确实写入时才报
  `persisted: true`。这里刻意不用 DSH 的 `ctx.settings.update`——它只接受
  `.volatile()` schema，而 volatile 节点会把每个解析值变成引用包装，本宿主无法接受。
- **品牌缓存策略。** `src/host/model-brand.ts` 把宿主 `resolveModelInfo` 返回的身份
  （provider + model + 显示名 + 描述）分类到 DeepSeek、OpenAI、Anthropic、Google、
  xAI、Moonshot、Qwen、Zhipu、Mistral、Meta 或保守的未知档；每档带
  `automaticPrefixCache`、`explicitCacheBreakpoints`、`minPrefixTokens`、
  `effortBreaksCache`、`stripVolatileHelps`。显式断点家族如实报告"没有本地杠杆"，
  而不是假装有。
- **实验性缓存代理。** 通过 `ctx.llm.registerAdapter` 注册 `coordination-proxy`
  路由，把每个已冻结的请求重建后转发给真实 provider——这是请求仍作为输入的
  唯一位置。`GET /proxy/status` 只暴露计数与标识。
- **发布脚本**：`upgrade.ps1`（版本自增）、`deprecate.ps1`（注册表弃用）、
  `publish.ps1`。

### 变更

- **推理交还 DSH。** `beginTurn` 不再用 `scene.reasoningEffort` 播种；Turn 记录会话
  自身 `requestHeader().config.reasoningEffort` 的值，流水线也不再报告
  effort/thinking 的延迟诊断。
- **所有数值控件改为数字输入框。** 移除 `Slider`；权重与比例改用
  `TextField type="number"`，显示按该行 `step` 取整（0.01 → 两位小数），线上仍传精确值。
- **完全权限确认改为模态框。** 用位于 tooltip 层之上的 MUI `Dialog` 取代原先的内联
  色块——后者与 tooltip 互抢层级，还会抢走触发器的点击。
- **包管理器改回 npm。** 删除 `pnpm-lock.yaml` 与 `pnpm-workspace.yaml`，改用
  `package-lock.json`（lockfile v3）；发布工作流改为 `npm ci` 并以 `cache: npm`
  缓存；README 命令统一为 `npm ci`、`npm run build`、`npm test` 与 `npm pack`。
  pnpm 的 `allowBuilds` 白名单不再需要，因为 npm 默认执行安装脚本。
- **显式声明 `react-dom`。** Material UI 对 `react-dom` 有 peer 依赖，而 npm 的
  严格 peer 解析不会为 React 18 的 `react` 自动配一个 React 19 的 `react-dom`；
  现在把 `react-dom@^18.2.0` 写成依赖，客户端 bundle 内联的就是同一代 React 18。
- **DSH peer 范围改为跟随新版本。** `^0.1.0-rc.7 || >=0.2.1-rc.2` 取代
  `^0.1.0-rc.7 || ^0.2.0-rc.0`：后者匹配不到 `0.2.1-rc.2`——SemVer 范围只有在某个
  比较器重复了该版本的 `major.minor.patch` 且自身带预发布时才会接受预发布版，
  所以 `^0.2.0-rc.0` 到 0.2.0 为止。客户端半现在针对桌面运行时携带的
  0.2.1-rc.2 `-locale`、`-ui-settings`、`-ui-slots`、`-ui-conversation` 包编译；
  `-ui-slots` 不再停在 0.1 线，`-ui-conversation` 也不再固定 0.1.0-rc.8。
  `@deepseek-ai/dsh-client-runtime` 与 `@deepseek-ai/dsh-host-webserver` 没有发布
  0.2.x，devDependency 保持 0.1.0-rc.8——装了 0.2.1 的 `host-webserver` 会让 0.1 线
  `dsh-client-connection` 的 peer 范围无解，`npm ci` 直接失败——而它们的 peer 范围
  仍接受宿主提供的 0.2.1+ 运行时。

### 修复

- **所有设置行都写不进去。** `persistConfig` 读取 `ctx.settings` 前没有 inject，
  触发 Cordis 代理守卫，`POST /config` 全部 500。现在防御式解析端口，持久化走
  覆盖文档。
- **接管控件永远收不到请求。** 两个瀑布订阅都没带 `{ prepend: true }`，DSH 自己的
  审批/提问 UI 先认领了请求。另外部署审批策略为 `never` 时，DSH 在进入瀑布前就直接拒绝。
- **权限标签显示原始 key。** 目录返回的 `name` 与 `value` 相同时短路了标签回退，
  下拉里出现 `read-only` 而不是“仅可查看”。现在把"与 key 相同的 name"视为没有标签。
- **代理 adapter 注册失败。** 普通对象缺少 `providerRetryPolicy`、
  `imageRequestPricing`、`imageRequestTarget`，而 `registerAdapter` 校验路由时会调用
  它们。四个钩子已补齐并有回归测试。
- **设置页出现浮点噪声。** 归一化后的权重显示成 `0.15000000000000002`；现在按行
  step 取整，仅影响显示。

### 安全

- 缓存代理没有传输层与凭据面：它通过 `ctx.llm.stream` 转发，从不读 `ctx.credentials`，
  模块没有 `fetch`/`http`/`https`/`net`/`WebSocket`。追踪只记录结构化字段
  （provider、model、brand、计数、大小），拒绝信息只报路由名，且只拦截 `deepseek*`。
  静态不变量测试会扫描源码中的禁止面。

## [0.10.0] — 2026-10-18

设置页、文件层、数据结构采纳和发布打包一起落地。这是第一个提供可安装
tarball 的版本；`lib/` 不提交进 git，因此裸 `github:` 源码安装仍不受支持。

### 新增

- **设置目录** —— 13 组共 151 个控件，覆盖全部 155 个非秘密配置叶子且每项恰好一次
  （134 个可写主机行）。`GET /config` 返回 `{ values, defaults }`；`POST /config`
  接受扁平点路径补丁，按真实 Schemastery schema 校验类型/范围，实时应用并重新解析
  权重归一、别名镜像、强制开关、压缩夹取等不变量；压缩相关改动会重建
  `TokenGovernor`，最后尽力通过 `ctx.settings.update` 持久化。未知键、`databasePath`
  和 `database` 被拒绝；强制/只读/计划中键返回 `ignored`。
- **设置页** —— MUI 折叠面板（默认全部展开）、List 行、六张情景表、复选/单选/
  滑块/数字控件、状态 chip 和重试入口。宿主设置区的导航只接受
  `{id, order, label}`，因此本插件在自己的导航行上绘制 Material `sync` 图标；
  输入栏主题未改。
- **文件层** —— `coordination_parse`、`coordination_describe`、
  `coordination_chain`、`coordination_read`：有界解析服务、持久 node/edge/snapshot
  图（schema 24）、跨重启保留的确定性 handle、宿主侧关系链投影，以及唯一会返回
  正文的工具。解析器深度/词元/时间/缓存与依赖图上限、关系链预算和
  `tools.maxResultBytes` 已即时生效并会 retune 已有运行时；`parser.enabled` 仍需
  重新注册才能增删工具。workspace root 依次取工具参数、service、host、sandbox
  policy，最后才回退 `process.cwd()`。
- **Turn 流水线** —— 普通 `command=none` Turn 驱动 comprehension（使用 turn 行的
  validation/interaction/scene）、organization、plan 创建/评分和需要的 Predict
  行；有端口的 scene 策略生效，无端口的项记录为诊断。pre-step 有界且永远不阻塞
  `next()`。
- **阶段冻结** —— Turn → 职能，Plan → 验证，Goal → 交互。冻结状态每轮从主机重新
  推导，禁用对应下拉框但保留可聚焦的 aria-label/tooltip，并由 `POST /selection`
  以 `INVALID_STATE` 强制，而不只是前端禁用。
- **领域提取** —— Book/Article/Part/Chapter/Section/Paragraph、Person/Venue、
  Condition、Sheet/Cell/Range、CSV/TSV、TeX 证明状态和解析器层领域元数据；
  body-free，且对 P0 节点模型保持增量兼容。
- **数据结构采纳** —— `LruList` 记忆、保持旧全序的 `BinaryHeap` 选择、共享
  `hashString`、`RedBlackTree` 数值一致性、`OrderedSet` 首次出现去重，以及
  `Queue` 权限命令解析。随机引用测试与实测取舍见
  `docs/data-structure-adoption-v24.md`。
- **打包** —— `prepack` 在 `npm pack` 前构建；`npm run pack:check` 校验 tarball
  中的四个运行时文件并检查宿主入口语法；tag 触发的 GitHub Actions 工作流会把
  打包产物附加到 Release。

### 变更

- 文件工具运行时已消费 `parser.enabled`、包括深度/依赖图在内的全部解析上限、
  全部 `chain.*` 和 `tools.maxResultBytes`，因此这些行改为可写主机行；除
  `parser.enabled` 仍需重新注册增删工具外，其余限制都会 retune 已有运行时。
- 六个模块测试的配置字面量补上 `ui.locale`、`compaction`、`parser`、`chain`、
  `tools` 和 `scenes`，`npm run test:tsc` 重新通过。

### 修复

- 用 `github:eloyhere/deepseek-coordination` 安装会得到一个没有
  `lib/index.mjs` 的五文件包，激活时报 `ERR_MODULE_NOT_FOUND`。仓库现在提供
  经过校验的 Release tarball，并明确把裸 git 安装标为不支持。
- `selectContext` 的堆补上零词元候选路径与随机等价测试，不会漏掉仍可接受的候选
  或打乱平局顺序。
- 数值一致性使用前驱/后继覆盖 argmax 的精确证明，而不是近似采样；随机暴力对照
  覆盖负数与重复值。

### 验证

`npm run typecheck`、`npm run test:tsc` 通过；`npm test` 为 **473 个测试，
472 通过，1 个仅 GC 跳过，0 失败**；`npm run build`、`npm run pack:check`
（tarball 492,156 B）通过。

## [0.9.2] — 2026-10-18

### 修复

- 打开一个下拉框后点击另一个下拉框时，两个 tooltip 可能同时留在屏幕上。
  每个控件仍持有自己的 MUI Tooltip 与锚点（不使用合成锚点，因此不抖动），
  但新增极小的 `tooltipVisibility` 所有权仓库：任意时刻只有一个 id 拥有显示权，
  请求另一个控件会立即撤销前一个。点击、选择、菜单打开、mouseout、mouseleave
  都会释放所有权；退出淡出期间的 popper 为 `pointer-events: none`。

## [0.9.1] — 2026-10-18

### 修复

- 全局 tooltip 宿主重构后，下拉框 tooltip 消失且整行抖动。回退为每个下拉框
  一个受控 MUI Tooltip：触发器保留真实锚点，不再测量固定定位的合成锚点，
  因而没有布局回环。第一次点击仍能打开菜单（pointerdown/mousedown 阶段不改状态）；
  点击、选择、菜单打开、mouseout、mouseleave 关闭 tooltip；位置在左右；
  退出为 160ms Fade，popper 不接收指针事件。

## [0.9.0] — 2026-10-18

插件获得共享算法库、仅存蓝图的文档模型与 P0 文本/依赖/导入解析层；
下拉框 tooltip 不再遮挡已打开的菜单，并以短淡出消失。

### 新增

- `src/shared/` 共享数据结构库：hash/LRU、节点、二叉树/B+ 树/红黑树、堆、
  栈/双端队列/队列、有序 map/set/skip list、AST/TokenStream、有向图、Trie、
  稀疏网格。每个导出都注明时间/空间复杂度；`docs/data-structures-report.md`
  是后续采用契约。
- `src/host/text/` P0 解析器：JS/TS/JSX 的 import/export/require/符号，
  CSS/HTML/Markdown 引用，TeX theorem/proof/label/math，通用公式提取，
  依赖图（拓扑序、环路径），有界解析缓存。仅产出蓝图：不保存正文；
  扁平记录 `path/byteStart/byteEnd/lineStart/lineEnd/fingerprint/charset`。
- `docs/domain-model-v24.md`：39 个概念、38 种关系，Book/Article、Sheet/
  Formula、Statement/Condition/Require/Meet、Sign，以及仅主机可见的 Chain
  投影（深度 ≤8、50 条链接、约 1,500 token）。
- `docs/complexity-audit-v24.md`：实测采用项（索引化 ordinal、批量 posterior、
  批量 blockedBy、有界缓存、行扫描 memo）。
- Tooltip UX：左右定位；点击/选择/mouseout/mouseleave 关闭；不吞第一次点击；
  淡出动画；popper 不接收指针事件。

### 变更

- `HashLruList`/`HashWeakLruList` 不再导出；`lru.ts` 成为唯一 canonical LRU，
  其变体通过组合实现。架构测试强制导出面、无环导入、无重复 LRU 核心。
- 复杂度：provider/effort/compaction/selection 等无界缓存改为有界；SQL 使用
  索引化 `MAX(ordinal)` 与增量索引；路由排序消除 N+1。
- 389 个测试（388 通过，1 个 GC 专用跳过）；`tsc` 干净；host + client 构建成功。

## [0.8.0] — 2026-10-18

Token 压力与人类在环决策成为一等能力：上下文越过阈值时请求 DSH 压缩，
并通过 React + Material UI 接管审批/提问 waterfall。

### 新增

- `TokenGovernor`（`src/host/token.ts`）：CJK 感知 O(n) token 估算（256 项有界
  memo）、预算/阈值规划、O(n log k) 的 value-per-token 上下文选择与哈希去重
  （无 O(n²) MMR）、EIG 门控检索、压缩策略。自动压缩在 `agent/pre-step`
  调用 DSH `compactIfNeeded('pressure' | 'context-overflow')`，带冷却、
  每会话上限、超时与失败回退。
- `compaction` 配置与设置组：自动开关、60/70/80/88% soft 阈值、只读 hard
  阈值与 reserve；`POST /config/compaction` 热更新。
- 服务级接管（`src/host/takeover-gate.ts`）：`approval/request` 与
  `user-questions/request` answerer、待决队列、`GET /takeover/pending`、
  `POST /takeover/answer`、`POST /takeover/cancel`。超时/中止/取消回退
  `next()`，绝不自动放行。
- React + Material UI 接管弹窗（`src/client/takeover.ts`）：审批（仅本次允许/
  拒绝/取消）与提问（单选/多选/自定义）表单、队列徽标、焦点陷阱、
  可见性门控轮询。
- 设置页重写为 7 组 / 28 行，使用诚实的“主机/本机/强制/只读”标签与常显说明；
  完全权限需要二次确认；`PROFESSION_LOCKED` 打开重建/丢弃对话框，
  后端为 `POST /profession/rebuild` 与 `/profession/abandon`。
- v24 文件处理规格（`docs/file-processing-v24.md`）：JS/TS + CSS/HTML/Markdown
  解析、依赖/导入图、大小与时间上限。
- 新增 `coordination_profession`、`coordination_professionlock`、
  `coordination_selection` 工具，随语言变化重新注册。

### 验证

- `tsc -p tsconfig.json --noEmit`：干净。
- `npm test`：263 / 263 通过。
- `tsdown`：host + client 构建成功。

## [0.7.0] — 2026-10-17

协调面板成为可工作的 host+client 管线：五个下拉框通过主机持久化，
每个控件/选项都有 tooltip，职能在任务内锁定。

### 新增

- 主机组合：`ctx.coordination` 上的 `CoordinationService`、coordination SQLite
  数据库、模块装配、60 秒清理 effect，以及 agent-turn 生命周期
  （`agent/pre-step` 建立一个锁定 Turn；`agent/turn-stopping`/`agent/error` 关闭）。
- HTTP 路由 `/deepseek-coordination/{selection,presets,permission,locale,state,ping,echo}`；
  输入框实际使用 `GET/POST /selection`。
- 按情景执行策略与 v24 的“写作”情景（位于对话与办公之间）：大纲 → 草稿 → 修订、
  质量评分、不启用 bash、可选联网。
- 三档验证都联网并做贝叶斯先验/后验：low 1×3 当轮、medium 2×5 当前会话、
  high 4×8 本地全部内容，high 做全局加权融合。
- 中英文字典跟随 DSH `ctx.locale`，覆盖 tooltip、设置、错误与模型可见的工具描述。
- 203 个主机测试、共享内存 fixture、`test:tsc` 门禁。

### 变更

- 第五个下拉框是“验证”（low/medium/high），不再使用临时的“强度”。
- 情景有六个选项；默认仍为“对话”。
- 触发器和每个选项都有 tooltip，文案来自同一来源。
- 规格迁移到 `docs/deepseek-coordination-v24.md`（v23 + v24 修订）。

## [0.6.5] — 2026-10-17

### 新增

- 情景之后的第四个选择器“强度”，选项 low / medium / high，默认 medium；
  属于“工作流”组，随工作流开关一起隐藏。

## [0.6.4] — 2026-10-17

### 新增

- `协调` 设置页新增“工作流”开关，显示/隐藏输入框工具栏中的三个协调选择器
  （职能/交互/情景）；关闭时该 slot 不贡献任何控件。“权限接管”开关独立，
  仍负责隐藏宿主访问模式控件并渲染替代下拉框。两个选择都持久化到
  `localStorage`；工作流默认开启。

## [0.6.3] — 2026-10-17

### 修复

- 替代权限下拉框使用了猜测标签（只读/工作区可写/完全权限）。宿主菜单实际为
  仅可查看/工作区内修改/完全权限，插件改为完全一致。此时只对齐了文字：
  选择仍不派发 `/permission`，因为写入路径在 `conversation.composer.bar`，
  不在本插件占用的 slot 上。

## [0.6.2] — 2026-10-17

### 新增

- “交互”在“收束”之后新增第五个选项“统筹”。

### 变更

- 替代权限下拉框提供只读/工作区可写/完全权限，而不是单一“完全权限”回退。

### 修复

- 输入框 “+” 弹层闪烁并关闭：输入框在该菜单打开时会重渲染，本插件随之重渲染，
  每次渲染让 emotion 触碰 `<head>`，宿主将其视为外部 DOM 变更并关闭弹层。
  两个 slot 组件改为 memo，`sx` 对象提升为常量，无关重渲染不再生成样式规则。

## [0.6.1] — 2026-10-17

### 修复

- 客户端引用 `process`，浏览器抛出 “import failed: process is not defined”，
  整个 Web 启动失败（“1 entry did not activate”）。MUI/emotion 读取
  `process.env.NODE_ENV`；构建时定义该值，并让打包器移除开发分支。
- 客户端 bundle：748.89 kB → 525.35 kB（gzip 155.85 → 113.72 kB）。

## [0.6.0] — 2026-10-17

控件迁移到 Material UI：`@mui/material@9.5.0` + `@emotion/react` +
`@emotion/styled`，使用本地 `ThemeProvider`，不触碰宿主主题。

### 新增

- 三个选择器使用 MUI `Select`/`MenuItem`，接管开关使用 MUI `Switch`。

### 变更

- `@mui/material` 与 emotion 被打包进 `lib/client.js`（`alwaysBundle`）：
  它们不在宿主模块表中。bundle 12.80 kB → 748.89 kB（gzip 4.56 → 155.85 kB）。
- MUI 泛型不接受本插件的事件形状，两个组件收窄为实际传入的 props；
  运行时组件不变。

## [0.5.0] — 2026-10-17

移除 MDUI，改用纯 React。宿主唯一保证的 UI 框架是 React（通过模块表提供），
因此控件不再需要第三方组件库。

### 变更

- 下拉框与接管开关是本插件拥有的 React 组件；弹层由插件自绘
  （触发器 hover 状态、10px 圆角），不再交给操作系统。
- 控件 CSS 通过 `ctx.effect` 注入一次字符串，插件不携带样式资产，构建无需拷贝步骤。
- `pnpm build` 重新成为单次 `tsdown`；host 半不再提供静态文件。

### 移除

- `mdui@2.1.5`、`scripts/copy-mdui.mjs`、`lib/static/` 与 `/static/*` 路由。

## [0.4.0] — 2026-10-17

移除 Angular，改用 MDUI 2。Angular 需要第二套工具链（独立 `ng build`、
自己的 tsconfig、静态 element bundle），并把插件钉在特定 TypeScript 范围；
MDUI 2 是框架无关的 Web Components，控件变成 React 客户端直接渲染的自定义元素。

### 新增

- 权限接管开关使用 `<mdui-switch>`，三个选择器使用 `<mdui-select>` /
  `<mdui-menu-item>`，`mdui@2.1.5` 组件 JS 打进 `lib/client.js`。
- `scripts/copy-mdui.mjs`：把 MDUI 样式表复制到 `lib/static/mdui.css`，
  由 host 在 `/deepseek-coordination/static/` 提供；版本与 JS 锁定，不依赖 CDN。

### 变更

- `协调` 设置页只保留接管开关；选择器只存在于输入框工具栏。
- host 静态路由从 `/elements/*` 改为 `/static/*`；`files` 改为携带 `lib/static`。
- `pnpm build` 为 `tsdown` + 样式拷贝；移除 `build:elements`/`typecheck:elements`。

### 移除

- Angular 相关依赖、`angular.json`、`tsconfig.elements.json` 与 `src/elements/**`。

## [0.3.0] — 2026-10-17

插件拥有第一个真正的 UI：挂载到 DSH Web 宿主的 Angular 自定义元素，
以及对输入框访问模式控件的权限接管。

### 新增

- Angular Elements 应用（`src/elements/`，构建到 `lib/elements/browser/`）：
  zoneless、standalone 的 Angular 21 组件 `<dsh-coordination-controls>`，
  从左到右渲染三个协调选择器：职能（决策/成果/资源/人员/任职/执行）、
  交互（感情/思维/启发/收束）、情景（对话/办公/研究/工程/迭代）；
  接管开启时，前面还有替代权限下拉框。
- `协调` 设置区（`settings.section`）：权限接管开关、同样的选择器与
  Material Symbols 图标。
- 输入框挂载（`conversation.input.left`）：注入输入框工具栏右侧空白区。
- 权限接管：开关开启时注入规则隐藏宿主访问模式控件
  （`button[aria-label^="访问模式"]` / `^="Access mode"`），由插件渲染替代下拉框；
  选择持久化到 `localStorage`。
- host 路由 `GET /deepseek-coordination/elements/*` 提供构建产物，并防路径穿越。

## [0.2.0] — 2026-10-17

仓库成为 DeepSeek Harness 插件 **bundle**：双端 Cordis 插件，
host 半提供路由，client 半提供设置页。

### 新增

- bundle 清单：`dsh.bundle.patch` 指向 `cordis.patch.yml`，`dsh.client`
  （`platform: web`、`immediately: true`、模块表 `inject`），以及双 `exports`
  （`.`, `./client`, `./package.json`）。
- `cordis.patch.yml`：把 `deepseek-coordination` 行插入 profile bundle roster。
- 双端源码布局：`src/index.ts`（host 半，`/deepseek-coordination` 的
  `webServer` 前缀路由，暴露 `ping`/`echo`）与 `src/client/index.ts`
  （client 半，`zh`/`en` 字典 + 探测 host 的 `settings.section`）。
- `tsdown.config.ts`：两个构建目标，host 为 ESM，client 为 CJS 并包在
  `window.__ModuleLoader__.load()` 中；`neverBundle` 规则区分 host 进程与
  浏览器模块表。
- `tsconfig.json`（仅类型检查）、`build`/`typecheck`/`pack:check` 脚本。

### 变更

- 版本 `0.2.0`；与 `0.1.9` 形态不兼容（入口、`files`、产物均不同），
  在 `0.x` 线上 minor bump 是正确的语义化信号。
- 工具链从 Vite 迁移到 `tsdown`；DSH client 包同时声明为 peer 与 dev 依赖。
- `.gitignore` 忽略 `lib/` 而非 `dist/`。

### 移除

- `87ddab9` 引入的独立 Vite SPA 脚手架（`index.html`、`src/main.ts` 等）。
- 上一版清单中描述已移除 dsh-os 启动器的 `os`/`bin` 字段；插件不再绑定平台。

### 已知问题

- 两端仍是脚手架：host 只有 `ping`/`echo`，设置页只报告 host 存活。
- 依赖范围沿用 DSH 插件模板，发布前需按目标 DSH 版本复核。
- 故意不声明 `engines.dsh`，让安装校验 `@deepseek-ai/dsh*` peer 范围。

## [0.1.9] — 2026-10-13

### 修复

- 字符串 target 被读取为通配符，导致所有作用域权限规则失效（`b7e02b0`）。
- 因该修复版本升至 `0.1.9`（`3ba4a45`）。

## [0.1.8] — 2026-10-13

### 新增

- 端到端接通 approval seam（`8ee68dd`）。

### 修复

- 已存储的权限规则此前从不执行；现在真正生效（`8ee68dd`）。

## [0.1.7] — 2026-10-13

### 修复

- 修复 0.1.5/0.1.6 中的激活故障（`0a2c2c0`）。两个此前 mock 未能复现的
  Cordis 行为：未声明 config 的行收到 `null` 而非 `undefined`，导致
  `config = {}` 默认值不触发；未声明服务通过强制代理读取时会抛错，
  使 `typeof ctx.x?.y === 'function'` 守卫本身成为抛错语句。五个入口全部加固。

## [0.1.6] — 2026-10-13

### 修复

- 工具描述从未写出工具名，模型无法选择该工具（`42ff514`）。

## [0.1.5] — 2026-10-13

### 新增

- workflow 行：意图优先的规划（`intake → plan → choose → run`）以
  `workflow_plan` 工具暴露，并保持 system-prompt 段落恒定以维持 provider
  前缀缓存。
- 缓存改为实测：四次 workflow 调用平均 96.6% 前缀缓存命中，不可避免路径上
  四次工具调用与一次人工交互（`b29c0e3`）。

### 变更

- `0.1.3` 与 `0.1.4` 仅在 checkout 内部存在、从未发布；`0.1.5` 是
  `0.1.2` 之后的下一个发布版本。

## [0.1.2] — 2026-10-13

### 修复

- 当 `permission.json` 不存在时，`permission list/audit/query` 返回
  `E_INTERNAL The property 'empty' cannot be found on this object`；
  每个安装副本都是这种状态，因为包本身不携带该文件。在
  `Set-StrictMode -Version Latest` 下，守卫在自身测试中执行了抛错读取；
  现改为通过 `PSObject.Properties` 做字典查找（`e4fade7`）。

## [0.1.0 – 0.1.1] — 2026-10-13

初始发布，前置建设始于 2026-10-12（`c2dae0c`）。`0.1.0` 与 `0.1.1`
在同一窗口发布，故合并记录。

### 新增

- 跨平台原子 OS 交互面：`file`、`environment`、`task`、`service`、`system`、
  `permission`、`execute`、`window`、`screenshot`、`clipboard`、`wait`、
  `mouse`、`keyboard`、`text`、`structure` 的稳定参数动词集，每个动词返回
  单一 JSON envelope，并保证字符集、BOM 与换行字节精确。
- Windows 原生实现（PowerShell 5.1 + `Add-Type` P/Invoke）、PowerShell 7.6
  的 16 模块移植，以及 POSIX 实现；16 对镜像模块由确定性构建组装为
  每平台一个自包含产物。
- DSH 插件入口、bundle patch 与 Web 客户端。
- conformance/encoding/golden-case/permission/plugin/activation/takeover/workflow
  测试套件，以及打包与 bundle 校验工具。
- 英文 README 重写，随 `0.1.1` 发布（`8b8a808`）。

### 修复

- 发布前修复了本会随版本发布的缺陷（`faaa0b7`）。













