# deepseek-coordination

[English](README.md) · **简体中文** · [更新日志](CHANGELOG.zh-CN.md) · [English changelog](CHANGELOG.md)

一个面向 DeepSeek Harness 的双端 Cordis 插件：宿主端持有协调 SQLite 数据库、7 个模型可见工具和一组 HTTP 路由；浏览器端在输入框挂载五个下拉框，并提供设置目录与服务级接管对话框。

**当前版本：v0.10.0（2026-10-18）。** 它在 v0.9.2 的 tooltip 修复之后，加入设置目录、文件层和数据结构采用。包版本、更新日志和发布 tarball 来自同一棵树；下文按源码核对，不以设计文档代替实现。

| 状态 | 含义 |
|---|---|
| **已接线** | 由 `src/index.ts` 注册，或被已组合的 service、路由、工具实际调用。 |
| **仅库** | 模块已实现并有测试，但当前 Turn 生命周期不驱动它，也没有路由/工具暴露。 |
| **设计/计划** | 只写在文档、配置或 schema 中，尚无运行时消费者。 |

## 这是什么

| 组成 | 位置 | 作用 |
|---|---|---|
| Bundle | `cordis.patch.yml`、`package.json` 的 `dsh.bundle` | 把一行 `deepseek-coordination` 插入 DSH profile 的 bundle 列表。 |
| 宿主端 | `lib/index.mjs`（ESM，Node） | `CoordinationService`、`coordination` SQLite 库、7 个工具、14 条路由路径和 agent 钩子。 |
| 浏览器端 | `lib/client.js`（CJS，浏览器，`__ModuleLoader__` 包装） | React 18 + Material UI 9：输入框下拉框、设置页、接管对话框。 |
| 数据库 | 默认 `%DSH_HOME%\coordination\coordination.db` | 插件自有 SQLite 文件；60 张表、7 个触发器、40 个索引，schema 版本 23。从不打开 DSH 的 `harness` 库。 |

插件不替代 DSH 的 agent 循环。它记录协调状态、为每个任务锁定一个职能、提供输入框选择与文件元数据、在上下文压力越过阈值时请求 DSH 压缩，并把审批/提问转给人工对话框。

五个输入框控件是 **权限、职能、交互、情景、验证**。命令面（`/goal`、`/plan`、`/feedback`、`/compact`、`/permission`）是消息前缀，不占第六个下拉位。

## 安装与构建

| 要求 | 说明 |
|---|---|
| Node.js | `package.json` 声明 `>=18`，但宿主端使用 `node:sqlite`，必须使用带该模块的 Node 构建。本次验证使用 Node 24.21.0。 |
| pnpm | 发布工作流使用 pnpm 11；npm 也能运行同一组 scripts。 |
| DSH | 装有 `dsh` CLI 的 DSH，且 profile 含 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app`。 |
| Peer 包 | 见下表；它们由 DSH 安装提供，不由本包携带。 |

```powershell
cd deepseek-coordination
pnpm install
pnpm typecheck          # tsc -p tsconfig.json --noEmit
pnpm test               # tsdown 测试构建 + node --test
pnpm build              # 生成 lib/index.mjs、lib/index.d.mts、lib/client.js
pnpm pack               # 先执行 prepack，生成可安装 tarball
```

`pnpm run test:tsc` 检查测试树；`pnpm run pack:check` 校验 tarball 中的运行时文件并检查宿主入口语法。npm 的对应命令同样可用，因为这些 scripts 就是普通 npm scripts。

| Peer 包 | 范围 | 端 |
|---|---|---|
| `@deepseek-ai/cordis` | `^4.0.1` | 宿主运行时 |
| `@deepseek-ai/dsh-host-webserver` | `^0.1.0-rc.7 \|\| ^0.2.0-rc.0` | 宿主路由 |
| `@deepseek-ai/dsh-client-runtime`、`-locale`、`-ui-slots`、`-ui-settings` | `^0.1.0-rc.7 \|\| ^0.2.0-rc.0` | 浏览器模块表 |
| `react` | `^18.2.0` | 浏览器模块表；不会被打包 |

### 安装到 profile

安装打包后的 tarball，不要装 GitHub 源码：

```powershell
pnpm pack
dsh plugin --profile <name> add .\deepseek-coordination-0.10.0.tgz
dsh --profile <name> --dump-config   # 应出现 deepseek-coordination 层
```

**不支持从 `github:eloyhere/deepseek-coordination` 直接安装。** `lib/` 被 gitignore，pnpm 11 会拒绝未经批准的 git prepare 脚本，安装后的包在激活时会因找不到 `lib/index.mjs` 报 `ERR_MODULE_NOT_FOUND`。打 tag 时触发的 GitHub Actions（`.github/workflows/release.yml`）会构建并把校验过的 tarball 附到 Release，请安装该产物。

**npm 上的 latest 仍是旧的 `0.1.9` dsh-os 线。** 目前不要按包名安装。本地 checkout 在 `pnpm build` 之后可以用 `dsh plugin --profile <name> add .` 链接。

`dsh plugin add` 会写入依赖和 bundle 行。如果 profile 里仍记录着别的包 spec，请替换它，不要假定新代码已经加载；用 `dsh --profile <name> --dump-config` 和已安装的 `package.json` 版本核对。

| 产物 | 格式 | 本次构建大小 |
|---|---|---|
| `lib/index.mjs` | 宿主 ESM，`platform: node` | 715,867 B |
| `lib/index.d.mts` | 宿主类型声明 | 8,653 B |
| `lib/client.js` | 浏览器 CJS，包在 `__ModuleLoader__.load()` 中 | 995,762 B |

Material UI 与 emotion 被打进 `lib/client.js`，React 来自宿主模块表。客户端体积大是因为内联了 MUI，不是因为多带了一份 React。

## 架构

宿主端（`src/index.ts`）：

- 导出 `name`、`inject = ['webServer', 'tools']` 和 `Config`；`apply()` 解析配置、创建 service、恢复被中断的 Turn，并通过 `ctx.effect` 安装所有 effect。
- `CoordinationService`（`src/host/coordination.ts`）是 Cordis 的 `coordination` service，持有数据库、module host 和已组合模块：session、selection、turn、profession、plan、goal、compact、directive、permission、takeover/gate、provider、cache、command。
- SQLite 使用 `node:sqlite` 的 `DatabaseSync`，开启外键、5 秒 busy timeout，非 `:memory:` 时使用 WAL。触发器拒绝修改已锁定职能，`orchestration_trace` 只允许追加。
- `/deepseek-coordination` 前缀路由返回 JSON `{ ok, value | error }`；请求体上限 1 MiB；未知路径返回 404 路由信封。
- 7 个工具通过 `ctx.tools` 注册；三个输入框工具在 `POST /locale` 后重新注册，因为工具描述属于模型提示词。
- 钩子：`agent/pre-step` 打开协调 Turn 并运行压缩治理器；`agent/turn-stopping` 以 `done` 关闭；`agent/error` 以失败关闭；`approval/request` 与 `user-questions/request` 进入接管闸门。60 秒定时器清理过期 lock 行。

浏览器端（`src/client/index.ts`）：

- `inject = ['slots', 'locale']`；`package.json` 的 `dsh.client.inject` 另行列出四个模块表包。
- `settings.section`（order 50）挂载 `CoordinationSettings`；`conversation.input.left`（order 40）挂载输入框控件，接管对话框作为兄弟节点。
- 语言跟随 `ctx.locale.getLocale().active`，把 `zh*`/`en*` 归一为 `zh-CN`/`en-US`，并上报 `POST /locale`；宿主据此重建本地化工具描述。
- 客户端 bridge 使用同源 `fetch`：选择接口 3 秒超时，接管/语言接口 2 秒超时。宿主不可达时，五个选择回退到每会话的 `localStorage`；权限预设永不离线写入。
- 输入框组件只按 `sessionId` memo；slot 每次击键也会传 `input`，若按默认浅比较重渲染，emotion 会触碰 `<head>`，导致宿主的弹层关闭。

```text
deepseek-coordination/
├─ src/
│  ├─ index.ts                 # 宿主组合根：service、路由、工具、钩子
│  ├─ host/
│  │  ├─ coordination.ts      # CoordinationService（Cordis service "coordination"）
│  │  ├─ config.ts             # Schemastery schema + resolveConfig()
│  │  ├─ database.ts           # SQLite schema（23），60 表，触发器
│  │  ├─ dsh.ts                # 窄 DSH port + Turn 生命周期
│  │  ├─ tools.ts              # 7 个模型可见工具
│  │  ├─ chain.ts              # 有界 Chain 投影引擎
│  │  ├─ node-registry.ts      # NodeCard 注册表与 describe()
│  │  ├─ parse-service.ts      # 工作区内的解析与读取服务
│  │  ├─ token.ts              # TokenGovernor 与纯策略
│  │  ├─ takeover-gate.ts      # 审批/提问瀑布闸门
│  │  ├─ selection.ts turn.ts profession.ts …   # 选择、锁定、生命周期
│  │  ├─ bayesian.ts comprehension.ts organization.ts … # 库级引擎
│  │  └─ text/                 # P0 解析器：JS/TS、CSS/HTML/MD、TeX、公式、依赖图
│  ├─ client/
│  │  ├─ index.ts              # slots、语言 store、导航图标、接管 CSS
│  │  ├─ controls.ts           # 五个输入框下拉框、tooltip、离线重放
│  │  ├─ settings.ts           # 13 组、151 控件的设置目录页
│  │  ├─ takeover.ts           # 审批/提问对话框
│  │  ├─ bridge.ts store.ts i18n.ts theme.ts selection-cache.ts
│  └─ shared/                  # entity/enum/selection/i18n/error + 数据结构
├─ test/                       # 24 个 *.test.ts + helpers.ts
├─ docs/                       # 10 份设计、审计、文案与契约文档
├─ lib/                        # 构建产物；gitignore，不手改
├─ cordis.patch.yml            # 插入 profile 的 bundle 行
├─ scripts/check-pack.mjs      # tarball 运行时文件校验
└─ .github/workflows/release.yml
```

## 输入框控件

| 控件 | 选项 | 行为 |
|---|---|---|
| 权限 | DSH 预设目录，或中性的“跟随 DSH” | 通过 `ctx.permissionPresets` 立即写入 DSH，不写入协调库。仅在本机“权限接管”开关打开时显示。 |
| 职能 | 决策 / 成果 / 资源 / 人员 / 任职 / 执行 | 活动任务内锁定；选择其他值会返回 `PROFESSION_LOCKED`，并打开重建/丢弃对话框。 |
| 交互 | 感情 / 思维 / 启发 / 收束 / 统筹 | 写入 `selection` 行，供下一 Turn 使用。 |
| 情景 | 对话 / 写作 / 办公 / 研究 / 工程 / 迭代 | 写入下一 Turn；`writing` 位于“对话”和“办公”之间。 |
| 验证 | low / medium / high | 写入下一 Turn；文案明确三档都会检索。 |

- 每个控件和每个选项都有 tooltip。`tooltipVisibility` 单所有权 store 保证同一时刻只有一个输入框 tooltip 可见；位置在左/右，退出为 160 ms 淡出，淡出中的 popper 不接收指针事件。
- 下拉框第一次点击就打开菜单；pointerdown/mousedown 不改变状态，因此不会吞掉 Select 的点击。
- 锁定的职能触发器被禁用，其无障碍名称带锁定解释；选项 `MenuItem` 带标签和提示，键盘与读屏用户无需悬停即可获得说明。
- tooltip 受宿主 `ui.showTooltip` 总开关约束；本机“显示提示”只能收窄，不能恢复宿主已关闭的 tooltip。
- 保存是乐观的，并做 120 ms 防抖。保存被拒绝时回退到最近一次宿主确认的状态；离线编辑在宿主恢复后重放。完全权限预设需要第二次显式确认。
- 宿主状态加载中时下拉框保持禁用并显示 loading；权限目录缺失就显示缺失，不编造预设。

验证预算是策略，不等于整条流水线已经在跑：

| 档位 | 检索预算（次数 × 条数） | 证据范围 | 交互范围 |
|---|---|---|---|
| low | 1 × 3 | 仅当前 Turn | 当前选择的交互 |
| medium | 2 × 5 | 当前会话 | 当前选择的交互 |
| high | 4 × 8 | 本地全部内容 | 全部交互 |

预算定义在 `src/host/comprehension.ts` 和共享的 `ValidationBudgetByLevel` 表。`ComprehensionModule` 目前仅库级存在，`CoordinationService` 的 Turn 生命周期并不驱动它，因此输入框只持久化档位，尚未真正执行这些检索。

### 情景与写作档

| 情景 | 思考 / effort | 计划 | 大纲 | 修订 | 评分 | Bash | 联网 | 最大轮次 |
|---|---|---|---|---|---|---|---|---|
| 对话 | 关闭 / medium | – | – | – | – | 否 | 是 | 1 |
| 写作 | 开启 / high | 是 | 是 | 是 | 是 | 否 | 是 | 3 |
| 办公 | 关闭 / medium | 是 | – | – | – | 否 | 是 | 1 |
| 研究 | 开启 / high | 是 | – | – | – | 否 | 是 | 3 |
| 工程 | 开启 / high | 是 | – | – | – | 是 | 是 | 3 |
| 迭代 | 开启 / high | – | – | – | 是 | 否 | 是 | 3 |

“写作”要求大纲和至少一轮修订，必须有质量评分，不允许 bash，允许联网，最多三轮。通过阈值为 `0.6`，`plan.ts` 使用该写作阈值。除这个阈值外，情景表目前主要是配置与文案，尚未由完整的情景流水线执行。

## 职能锁定与 Turn 生命周期

- 一个任务只有一个职能。`turn.create` 写入 `profession NOT NULL`、`locked = 1`，并写一条职能记录和一条 `lock` 追踪事件。
- 只要存在未终结 Turn，`SelectionModule.set` 就以 `ProfessionLockedError` 拒绝改职能；HTTP 层返回 409 `PROFESSION_LOCKED`，选择不会被修改。
- `POST /profession/rebuild` 把活动任务以 `abandoned` 结束，创建带新序号、新职能的替代 Turn，复制 prompt/command，并写 `rebuild` + `lock` 追踪事件。它要求存在活动 Turn。
- `POST /profession/abandon` 结束活动任务但不创建替代；下一个任务可重新选择。两个重选开关都由 `resolveConfig` 强制为 true。
- SQLite 再兜一层：`trg_turn_profession_lock`、`trg_profession_record_lock`、`trg_subtask_profession_lock` 在锁定时拒绝改职能；`trg_turn_profession_unlock`、`trg_subtask_profession_unlock` 拒绝清除锁定标记。

| 钩子 | 作用 |
|---|---|
| `agent/pre-step` | 确保协调 session，打开（或复用）当前 DSH Turn 对应的协调 Turn；同时在 `next()` 前运行 Token 治理器。 |
| `agent/turn-stopping` | 以 `done` 关闭 Turn，下一 Turn 解锁职能。 |
| `agent/error` | 以 `failed` 关闭 Turn。 |
| 宿主启动 | `recoverInterrupted()` 把所有未终结 Turn 标为 failed，原因 `turn was interrupted by a host restart`。 |
| 每 60 秒 | 删除超过 `defaultLease` 的已结束 lock 行。 |

`done`、`failed`、`cancelled`、`abandoned` 是不可逆终态。Turn 钩子只记录 Turn 元数据和一条空 prompt 行，不把 DSH 对话镜像进协调库。

## 设置与配置

设置页由 `src/shared/selection.ts` 的 `SETTINGS_CONTROLS` 生成：**13 组、151 个控件、130 个可写宿主行，覆盖 155 个非秘密配置叶子**。18 个顶层配置键包含 `database` 与 `databasePath`，这两个键故意不投影、不可写。

| 组 | 默认值 / 范围 | 写入路径 |
|---|---|---|
| `session` | `maxTurnPerSession=1000`、`defaultLease=30000 ms`、`clarifyTimeout=30000 ms` | 宿主行，经 `/config` |
| `profession` | enabled/lock/rebuild/abandon 强制 `true`；default 镜像 `defaults.profession`；audit/errorHint `true` | 强制项只读；audit/errorHint 为宿主行（audit 无消费者） |
| `plan` | threshold `0.5`、maxRebuild `3`、8 个权重和为 1、8 个维度阈值 | 宿主行；保存后权重重新归一 |
| `orchestration` | maxReject `2`、maxSubTask `32`、groundTruth `true`、timeout `5000 ms`、shell ground truth `false`、modelRouting `true` | 宿主行；`groundTruthTimeout` 无消费者 |
| `cache` | enabled `true`、ttl `60000 ms`、fingerprintWindow `50`、effortWarning `true` | 宿主行；`fingerprintWindow` 无消费者 |
| `bayesian` | prior `0.5`、stopEntropy `0.05`、infoGain `0.01`、maxRoutes `12`、calibrationFloor `0.1` | 宿主行；`calibrationFloor` 无消费者 |
| `comprehension` | stageTimeout `30000 ms`、searchEnabled `true`、maxEvidence `8`、highHistoryWindow `50` | 宿主行 |
| `compaction` | auto `true`、soft `0.70`、hard `0.88`、reserve `2048`、recentTurns `6`、cooldown `30000 ms`、maxPerSession `20` | auto/soft/hard 为宿主行；结构字段只读 |
| `ui` | toolbar `true`（废弃别名）、showTooltip `true`、takeover `false`、refreshInterval `5000 ms`、compact `true`、locale `auto` | 宿主行 + 两个本机开关；toolbar/locale 只读 |
| `scenes` | 六个情景各 13 个字段；写作阈值 `0.6` | 宿主行；只有写作评分阈值被 `plan.ts` 读取 |
| `parser` | enabled `true`、1 MiB、200k tokens、depth `256`、2 s、cache `256`、graph 20k/100k | enabled + 四个上限为宿主行；depth 与 graph 上限仍是计划 |
| `chain` | depth `8`、links `50`、tokenBudget `1500` | 宿主行 |
| `tools` | maxResultBytes `0` | 计划/只读；未被消费 |
| `defaults` | 职能 `execution`、交互 `think`、情景 `dialogue`、验证 `medium`、命令 `none` | 宿主行 |

`GET /deepseek-coordination/config` 返回 `{ values, defaults }`；`defaults` 来自 `resolveConfig(undefined)`，页面不复制默认字面量。`POST /config` 接收扁平点路径补丁（如 `{ "plan.threshold": 0.7 }`），按目录和真实 Schemastery schema 校验，写入活动配置，重新执行不变量（权重归一、别名镜像、强制开关、压缩阈值夹取），在压缩变化时重建 `TokenGovernor`，最后尽力通过 `ctx.settings.update` 持久化。

持久化是显式的：只有 DSH 接受设置写入时 `persisted` 才为 true；否则修改只在当前进程生效，页面会如实说明。未知键、`databasePath`、`database` 会以 `INVALID_ARGUMENT` 拒绝；已知但不可写的键进入 `ignored`，绝不写入。`POST /config/compaction` 保留为旧的 auto/soft/hard 兼容小路由。

设置页整体使用 Material UI：每组一个默认展开的 `Accordion`，行放在 `List` 中；六个情景各一张 `Table`（页面没有情景下拉框）；布尔用 `Checkbox`，枚举用 `RadioGroup`，比例型数字用 `Slider`，计数/字节/毫秒用 `TextField type="number"`；`Chip` 只表示 `主机 / 本机 / 强制 / 只读 / 计划中` 状态和连接状态。没有保存按钮，控件在 change/blur 时提交。强制行画禁用控件，只读行显示值，计划行明确说明当前运行时尚未读取。设置导航图标是宿主 shell 的限制所致：section 只接受 `{ id, order, label }`，插件只能用 CSS mask 给导航按钮补一个 Material `sync` 图标。

## 服务级接管

- 打开 `ui.takeover` 后，`TakeoverGate` 监听 DSH 的 `approval/request` 与 `user-questions/request` 瀑布。它写一条持久 pending 行、发出 `takeover/pending`，等待客户端路由送来人工答案。
- 超时、请求 signal 中止、显式取消或插件卸载都会调用 `next()`；闸门绝不把“没人回答”变成 `allowed-once` 或编造的问题答案。`unavailable` 是宿主 fail-closed 的结果，不作为用户决定接受。
- 对话框只在以下条件同时成立时每 1 秒轮询 `/takeover/pending`：本机“权限接管”开关打开、session id 真实、页面可见。它渲染第一条 pending 请求；队列多于一条时显示 `1 / N` 徽标。
- 审批提供 仅本次允许 / 拒绝 / 取消；只提交 `allowed-once` 与 `rejected`，取消/Esc/点背景走 cancel 路由。提问按单选渲染 radio、多选渲染 checkbox，并允许每题自由文本；所有问题答完前提交按钮禁用。
- **两个开关都需要**：宿主 `ui.takeover`（默认 `false`）负责打开闸门，本机“权限接管”负责让对话框轮询。宿主开关关闭时闸门立即委托，没有窗口可显示。

## 自动压缩与 Token 治理器

`TokenGovernor` 估算上下文（CJK 感知的 O(n) 估算器，带 256 项有界 memo），按 `contextWindow - reserve` 规划预算，并在 `agent/pre-step` 利用率越过阈值时请求 DSH 的 `compactIfNeeded`。默认：soft `0.70`、hard `0.88`、reserve `max(2048, 窗口的 8%)` 且不超过窗口 25%、recentTurns `6`、cooldown `30 s`、maxPerSession `20`。

soft 阈值可按 0.30–0.90 的比例编辑；hard 为 0.30–0.98，且必须严格高于 soft。旧界面里的 60/70/80/88% 仍是合法取值（`0.60`、`0.70`、`0.80`、`0.88`），只是目录页现在用 slider，而不是四项选择器。`compaction.auto=false` 只关闭自动压缩，不约束显式 compact 命令。

失败封闭是刻意设计：钩子绝不阻塞 step；压缩 port 缺失、返回 `null`/`undefined`、超时、抛错、每会话额度用尽或 cooldown 未到，全部按 no-op 处理，agent 继续执行 `next()`。治理器在构造时快照策略，所以设置热更新会同时重建它。实际安全范围和替换由 DSH 负责，本插件只决定何时值得请求。

## 文件工具、解析器与 Chain

文件层以四个模型可见工具接线，加上三个输入框/职能工具，共 7 个：

| 工具 | 用途 |
|---|---|
| `coordination_parse` | 解析工作区文件或给定文本。`path`/`text` 二选一；返回引用、诊断、字符集、截断标记和节点卡片，绝不返回文件正文。 |
| `coordination_describe` | 按 handle 返回一个 `NodeCard`，可选 `summary`/`description`/`usage`/`purpose`；不返回正文。 |
| `coordination_chain` | 查询一条有界关系链：dependencies、dependents、satisfies、satisfied_by、baseline、prerequisites、unmet、path、cycle。深度 ≤ 8、链接 ≤ 50、约 1,500 tokens；不返回 AST 或图对象。 |
| `coordination_read` | 唯一返回文件内容的工具。读字节范围（end 不含）或行范围（1 基，end 含），单次上限 256 KiB / 2,000 行 / 16k tokens。 |

P0 解析器是词法级、确定性的：JS/TS/JSX（import/export/`require`/动态 import/符号/注释）、CSS/HTML/Markdown（`@import`/`url()`、script/link/img、链接/图片/标题/front matter/fenced div/公式）、TeX（定理类环境、证明、label/ref、数学、`\input`/`\include`）、通用公式（Markdown/TeX/表格/MathML/OMML/unknown；不求值）、词法依赖图（外部过滤、拓扑序、环、层级、孤立点）。畸形输入产生诊断和 `truncated`，不崩溃。

每个解析节点都是**蓝图式元数据**：`path`、UTF-8 `byteStart`/`byteEnd`、1 基 `lineStart`/`lineEnd`、`sha256:<hex>` 指纹和 `charset`；没有 `text`、`body`、`content` 或 AST。`NodeCard` 与 `ChainLink` 同样如此。`coordination_read` 是唯一内容路径；它拒绝绝对路径、UNC、目录穿越和符号链接逃逸，拒绝 NUL/二进制/不可解码内容，并对返回内容做哈希。

| 上限 | 值 |
|---|---|
| 单次解析源文本 | 1 MiB；只解析前缀并标 `truncated` |
| 单次解析 token | 200,000 |
| AST 深度 | 256 |
| 解析墙钟时间 | 2,000 ms |
| 诊断保留 | 100 条 |
| 单次解析节点元数据 | 20,000 |
| 依赖图 | 20,000 节点 / 100,000 边，超限 fail-closed |
| 公式 | 单次扫描 5,000 个 / 512 条引用 |
| 解析缓存 | 256 文件，按 `path+mtime+size+parserId` 做 LRU |
| 读取范围 | 256 KiB / 2,000 行 / 16,000 估算 token |
| Chain 投影 | 深度 ≤ 8 / 链接 ≤ 50 / 约 1,500 tokens；50k 节点 / 200k 边 fail-closed |

`parser.enabled` 在注册文件工具时读取；parser 各上限与 `chain.depth`/`links`/`tokenBudget` 在惰性工具运行时创建 `ParseService`/`ChainEngine` 时捕获。因此 `/config` 的热改不会调整已创建的运行时，要到下一次注册（目前是语言切换或重启）才生效。工作区根默认回退到 `process.cwd()`，因为插件入口没有拿到 DSH 的 workspace root；cwd 不是工作区的宿主必须通过工具选项传入根目录。

**没有写入或刷新工具。** v24 的写入契约需要 `expectedFingerprint` 冲突检测、事务式重解析与范围重算、显式 charset/BOM 变更以及 watcher/rename 策略；这些都没有实现，贸然提供 writer 会覆盖并发编辑或返回过期范围。`coordination_write` 与 `coordination_refresh` 属于设计/计划。

## 数据结构

`src/shared/` 的共享库是纯 ES2022：hash/LRU、节点、二叉树/B+ 树/红黑树、堆、栈/双端队列/队列、有序 map/set/skip list、AST/TokenStream、有向图、Trie、稀疏网格。当前运行时实际使用：

- `LruList`：token 估算 memo、解析缓存、节点注册表、Chain 投影缓存。
- `BinaryHeap`：`selectContext`，保持原全序（value 降序 → created 升序 → id 字节升序 → 输入下标）。
- `RedBlackTree` 前驱/后继：数值一致性（numeric agreement）；精确 argmax 证明在采用文档中。
- `OrderedSet`：comprehension/emotion/permission 的首次出现去重；`Queue`：权限命令 tokenizer。
- `DirectedGraph`：依赖图，以及每个 Chain relation 一张图。

第二轮采用有随机化等价测试，也有一个诚实 caveat：在 20k chunk 的 **wide** 合成用例里，堆并不比 V8 sort 快（17.7 ms 对 15.9 ms）；它在预算提前填满时占优，且结果不劣于 sort。`SparseGrid` 与 `BPlusTree` 只在共享库里有回归测试，**没有接到运行时路径**；不要据此认为它们在用。

## 工具与路由

| 工具 | 返回 |
|---|---|
| `coordination_selection` | 读取或修改某 session 的五个选择（含 `command` 与 DSH `preset`）；返回带锁、预设和配置投影的 `SelectionState`。 |
| `coordination_profession` | 读取当前职能记录；仅在活动任务之前/不存在时设置职能。任务已锁时返回 `PROFESSION_LOCKED`，不改选择。 |
| `coordination_professionlock` | 读取活动 Turn 的锁定状态/职能，或指定序号 Turn 的状态。 |
| `coordination_parse` | 无正文的解析投影（引用、诊断、字符集、截断、卡片）。 |
| `coordination_describe` | 无正文的 `NodeCard` 和请求的元数据字段。 |
| `coordination_chain` | 只返回有界 `ChainProjection`。 |
| `coordination_read` | 唯一返回内容的工具；有上限的字节/行范围。 |

所有路由都在 `/deepseek-coordination` 下，共 **14 条路径 / 16 个方法处理器**：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/ping` | 存活检查；返回插件名、`pong`、当前语言。 |
| POST | `/echo` | 回显 JSON body（诊断用）。 |
| GET, POST | `/selection` | 读 `SelectionState`；修改五个选择。 |
| GET | `/presets` | 投影 DSH 权限预设目录。 |
| POST | `/permission` | 立即应用一个 DSH 预设。 |
| GET, POST | `/config` | 读 `{ values, defaults }`；应用扁平配置补丁。 |
| POST | `/config/compaction` | `auto`/`soft`/`hard` 的兼容补丁。 |
| GET | `/takeover/pending` | 某 session 的待处理审批/提问窗口。 |
| POST | `/takeover/answer` | 提交合法人工答案；非法答案保持窗口。 |
| POST | `/takeover/cancel` | 取消窗口并交还宿主默认处理。 |
| POST | `/profession/rebuild` | 结束活动任务，用新职能创建替代 Turn。 |
| POST | `/profession/abandon` | 结束活动任务，不创建替代。 |
| POST | `/locale` | 上报客户端语言；重新注册本地化工具描述。 |
| GET | `/state` | 选择 + 协调指标（`session`、`turn`、`plan`、`subtask`、`trace`、`takeover`、`schema`）。 |

没有 `coordination_write`、`coordination_refresh`、`outline`、`findSymbol`、`searchSummary`、`commentsOf` 工具。四个文件工具的说明目前是内联中英双语，因为共享 `ToolName` 表还没有它们的键；三个输入框/职能工具使用共享 copy 表。

## 数据、隐私与安全

- 插件使用独立 SQLite 库，从不打开 DSH 的 `harness` 库。默认路径是 `%DSH_HOME%\coordination\coordination.db`；`database`/`databasePath` 只属于部署配置，既不投影也不允许 `/config` 写入。
- 解析节点、`NodeCard`、`ChainLink` 及其工具结果都不带文件正文、附件或 AST。只有 `coordination_read` 返回文本，而且只返回请求的范围。
- 文件路径必须是工作区相对路径；绝对路径、盘符路径、UNC、`..` 逃逸与符号链接逃逸在读取前拒绝。二进制/NUL/不可解码内容直接拒绝，不猜。
- Turn 钩子只写 Turn 元数据和一条空 prompt 行，不镜像 DSH 对话，也不把文件内容复制进协调库。
- 权限预设立即写给 DSH（完全权限需二次确认），从不进入离线 localStorage；离线重放只覆盖五个已存选择字段。
- 接管绝不自动批准。超时、中止、取消、卸载都以 `next()` 委托；只有通过 answer 路由送达的人工决定才会结算窗口。
- 失败封闭是明确的：非法接管答案保持窗口；`PROFESSION_LOCKED` 不改选择；解析不确定标 `unverifiable`；解析/图溢出标 `truncated`；压缩失败是 no-op；Chain 的 `unknown` 不会自动通过。
- 协调库保存任务/审计行（包括 `prompt` 与追踪行），不保存凭据或 provider secret。配置投影中没有 DSH 凭据、token 或 provider key。

## 测试、质量与限制

| 检查 | 结果 |
|---|---|
| `pnpm test` | **433 tests，432 pass，1 skipped（仅 GC），0 fail**，Node 24.21.0 上约 2.5 s |
| `pnpm typecheck` / `pnpm test:tsc` | 通过 |
| `pnpm build` | 宿主 + 客户端 bundle 通过；MUI 的 `"use client"` directive 警告不致命 |
| `pnpm run pack:check` | OK：`deepseek-coordination-0.10.0.tgz`（410,582 B），四个运行时文件齐全 |
| 发布 CI | `.github/workflows/release.yml` 运行 typecheck、test:tsc、测试、pack:check，并在 `v*` Release 附上 tarball |

解析器与结构的数字是守卫，不是承诺：100k 字符解析测试保持在 3 秒内；数据结构报告记录 B+ 树 10k 插入 8.3/9.8 ms、skip list 10k 插入 6.4 ms、红黑树 10k 随机 set/delete 13.5 ms、稀疏网格 10k 单元 5.1 ms、`hashString` 100k 次 4.3 ms；复杂度审计记录 Turn 序号从 `COUNT(*)` 改为 `MAX(ordinal)`（2,000 条语句约 65–69 ms → 约 12–14 ms）以及路由排序（200 × 12 条路由的 2,400 次 posterior 查询降到 200 次）。

已知限制，直接列出而不是隐藏：

1. **没有持久化 node/edge 图。** 领域模型里的 `node`/`edge`/`snapshot`（schema 24 设计）没有建表，实际库是 schema 23。`NodeRegistry` 与 `ChainEngine` 是每个工具运行时的内存态：handle 是确定性的但不持久，证据/状态无法落库。
2. **Book/Article 层级、Person/Venue、Chapter/Section/Paragraph 节点、Condition 状态、Sign 提升、office sheet、证明状态**均为设计/计划。当前只投影文件级 `book`/`article`、通用 heading、TeX statement/proof 和文档公式。
3. **验证/comprehension 与更宽的流水线仅库级。** 输入框会持久化交互/情景/验证；`ComprehensionModule`、`OrganizationModule`、`OrchestrationModule`、`BayesianModule`、`CognitionModule`、`EmotionModule`、`LearningModule`、`PredictModule`、`ResourceModule`、`ScoreModule` 是有测试的模块，但当前组合 Turn 生命周期不驱动它们。情景策略除写作阈值外同理。
4. **`parser.maxAstDepth`、`parser.dependencyGraphMaxVertices`/`Edges`、`tools.maxResultBytes` 仍是计划。** 它们会被保存和展示，但没有运行时消费者；`renderJson` 仍未限长。
5. **工作区根是 `process.cwd()`**，除非工具调用方显式传入根目录；插件入口没有把 DSH workspace root 接进 `registerCoordinationTools`。
6. **`parser.enabled` 与文件层上限在注册/首次运行时创建时捕获。** `/config` 热改不会调整已存在的运行时；需要重新注册（语言切换或重启）才生效。
7. **没有浏览器 E2E。** UI 由类型、构建、settings-catalog 测试以及 takeover/bridge 测试覆盖；视觉验证仍是人工/截图。
8. **Node 引擎声明不一致。** `package.json` 写 `>=18`，宿主实际需要带 `node:sqlite` 的 Node（实践上 22.5+；CI 与本次验证使用 24.21.0）。
9. **profile 里可能仍记录着旧的包 spec。** 请核对实际安装的版本（`dsh --profile <name> --dump-config` 或 profile 的 `package.json`）；安装 0.10.0 tarball 或链接已构建的 checkout，不要假定上一次安装已被升级。

## 文档、布局与许可

| 文档 | 状态与用途 |
|---|---|
| [docs/deepseek-coordination-v24.md](docs/deepseek-coordination-v24.md) | 行为规格（v23 + v24 修订），是“应该怎样”的权威；代码实现其子集。 |
| [docs/domain-model-v24.md](docs/domain-model-v24.md) | 仅设计：39 个概念、38 种关系、Book/Article、Sheet/Formula、Statement/Condition/Require/Meet、Chain 投影。不是实际 schema。 |
| [docs/file-processing-v24.md](docs/file-processing-v24.md) | P0 解析/文件处理契约；已实现并通过四个文件工具接线。 |
| [docs/feature-wiring-audit-v24.md](docs/feature-wiring-audit-v24.md) | 已完成的发布面审计：v0.7–v0.9 到底交付了什么、agent 能触达什么、还差什么。 |
| [docs/settings-catalog-v24.md](docs/settings-catalog-v24.md) | 权威设置目录：151 控件、130 可写、155 个键、18 个顶层键。 |
| [docs/data-structure-adoption-v24.md](docs/data-structure-adoption-v24.md) | 第二轮采用：LruList、BinaryHeap、RedBlackTree、OrderedSet、Queue；含实测 caveat。 |
| [docs/complexity-audit-v24.md](docs/complexity-audit-v24.md) | 已完成的时空复杂度审计与第一轮采用。 |
| [docs/data-structures-report.md](docs/data-structures-report.md) | 第一阶段共享库契约与基准。 |
| [docs/module-contract.md](docs/module-contract.md) | 宿主/浏览器边界、命名与追踪规则。 |
| [docs/ui-copy-v24.md](docs/ui-copy-v24.md) | UI 文案设计；字符串落在 `src/shared/i18n.ts`。 |

### 仓库历史

`0.1.x` 是另一个项目 **dsh-os**，已不在分支顶端；`0.2.0` 变成 DSH 插件 bundle；`0.3`–`0.6` 的 UI 从 Angular 经 MDUI、纯 React 迁到 Material UI；`0.7`–`0.9` 加入五个下拉框、i18n、职能锁定、接管、压缩、P0 解析器、领域模型和共享数据结构；`0.10.0` 加入设置目录、四个文件工具、第二轮数据结构采用和可验证 tarball。旧状态仍在 git 历史和 tag 中。

MIT © 2026 Eloy Kim。见 [LICENSE](LICENSE)。源码：[github.com/eloyhere/deepseek-coordination](https://github.com/eloyhere/deepseek-coordination)。
