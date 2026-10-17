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
