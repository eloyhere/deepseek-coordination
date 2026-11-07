# deepseek-coordination

**简体中文** · [English](README.md) · [更新日志](CHANGELOG.zh-CN.md)

面向 **DeepSeek Harness 0.2.2-rc.1**（Windows 桌面版）的注意力清单协议（AMP）宿主插件。
它把依赖从旧的 0.6 协调层升级到 **AMP 0.7.9**，移除过时的协调功能，保留通知组件，
并把 AMP 的模块面注册进 Harness 宿主。

```
AMP 0.7.9                              DeepSeek Harness 0.2.2-rc.1
┌───────────────────────────┐          ┌──────────────────────────────────┐
│ 智能体面（27 个模块）      │          │ ctx.tools   ← 15 个模块工具      │
│ 15 agent / 8 host / 4 hid │  ──────► │ ctx.systemPrompt ← AMP 契约      │
│ AgentGateway（49 个动词）  │          │ ctx.skills  ← 10 个 AMP 技能     │
│ 可执行内核                │          │ ctx.commands ← /amp、/amp-modules │
│ SQLite 存储 + 实体         │          │ ctx.webServer ← 只读路由         │
└───────────────────────────┘          │ session/event ← 轮次位置         │
                                       └──────────────────────────────────┘
```

## 0.24.0 变化

- **依赖**：`attention-manifest-protocol@0.7.9`（原 `0.6.0`），连同它的
  `semantic-typescript` 运行时依赖。
- **移除**：旧协调数据库、图/文本/认知引擎、输入框下拉、接管与审批对话框、
  400 KB 面板、旧 `src/protocol` 兼容层，以及所有既不属于 AMP 也不属于通知的工具。
  历史保留在 Git 中，`src/` 不再保留。
- **保持不变**：通知组件 —— `snackbar`、`alert`、`dialog`、`popover`
  （`src/host/notify.ts`、`src/client/notification.ts`、`src/shared/notification.ts`）
  与 `coordination_notification` 工具。只有它们外围的注册胶水是新的。
- **新宿主**：15 个 AMP 模块工具、`attention_manifest_protocol_discover`、
  SQLite 可执行内核、10 个技能、2 个人工命令、系统提示词契约和只读 HTTP 路由。
- **新客户端**：通知座位 + 紧凑的 AMP 状态条 + 设置页；旧 MUI 面板已删除
  （客户端包约 424 KB）。

## AMP 模块面

AMP 0.7.9 定义 27 个模块，本插件全部以三种方式之一注册：

| 层级 | 数量 | 注册方式 |
|---|---:|---|
| `agent` | 15 | 每个模块一个 `attention_manifest_protocol_<module>` DSH 工具，通过 `{ verb, arguments }` 暴露动词，共 49 个动词。 |
| `host` | 8 | 宿主服务/路由：`capability`、`manifest`、`provenance`、`receipt`、`verification`、`retrieval`、`model`、`runtime`；宿主发布 `ctx.amp`（`AmpHost`），其他插件可注入该服务访问内核端口、网关日志、收据与证据。 |
| `hidden` | 4 | 仅内部：`workflow`、`policy`、`profession`、`behaviour`，永不暴露给模型。 |

15 个智能体工具与动词见英文 README 的表格。`attention_manifest_protocol_discover`
支持 `query`、`module`、`tier` 过滤，返回完整目录及 mutating/authority 信息。`query`
可以是字符串或字符串数组；传 `regex: true` 时，每个条目按不区分大小写的正则表达式匹配。
同一工具还支持 `action: "search"` 搜索项目文件。开启设置里的「接管搜索」后，会使用
AMP 0.7.9 内置的 `createSessionFileDiscoveryProvider`、`collectDiscoveryCandidates` 和
`discover` 排名，不重复实现排序算法。通过 `scope` 选择 `files`、`content` 或 `both`，并可传入
相对工作区的 `path`、`include`/`exclude` glob、`maxFiles`、`maxFileBytes`、`limit`、
`maxPerModule`、`minimumScore`。
搜索限制在项目目录、跳过依赖和生成目录，并限制内容快照大小；结果提供文件路径和行号，
后续可用 `attention_manifest_protocol_workspace.read` 读取内容。

> AMP 0.7.9 只发布工具**名称与权限**，不发布参数 schema。因此本宿主为每个模块
> 提供一个带类型的 `verb` 和一个无损 `arguments` 对象，而不是 49 个带点的工具名。
> 网关仍然强制宿主绑定身份、mutating 动词的幂等键、权限钩子，并为每次调用记录一条日志。

## 内核与持久化

AMP 数据跟随项目保存。`src/host/amp.ts` 为每个工作区根（`session.header.cwd`）
打开一个可执行内核，目录为：

```
<工作区>/.deepseek-coordination/
  amp.sqlite          内核库：实体、工作流事件、收据、证据
  host-state.json     状态行、备注、信箱、引用、执行句柄
  preferences.json    本工作区的接管开关
  project.json        项目环境与规则（project 动词）
```

会改变状态的 AMP 调用（以及只更新 `host-state.json` 的宿主动词，例如
`session.report_status`）在返回前落盘，因此重启 DSH 后可见状态能与库内聚合同步恢复。
`workspace.diff` 的文件快照只留在内存中：它们可以由工作区重新推导。

该目录是缓存，因此宿主也会把它排除在版本控制之外。首次建立工作区存储时，
宿主会向仓库自己的忽略文件追加 `.deepseek-coordination/` 规则：Git 与 jj 使用
`.gitignore`，Mercurial 使用 `.hgignore`（沿用文件当前的 regexp/glob 语法），
Fossil 使用 `.fossil-settings/ignore-glob`，Bazaar 使用 `.bzrignore`，Pijul 使用
`.ignore`。宿主从工作区向上查找仓库根，因此嵌套工作区按相对仓库根的路径忽略；
已有规则不会重复追加，不在任何仓库内的普通文件夹也不会被改动。

另外两种布局仍然可用：`storage: 'user'` 把数据放回
`$DSH_HOME/storages/deepseek-coordination/`；显式 `storePath` 让所有工作区
共用一个库（0.24 之前的行为）。已有的机器级存储不会自动搬迁：继续使用就设
`storage: 'user'`，或者在 DSH 停止时运行

```powershell
node scripts/migrateStore.mjs --to <工作区>
```

该脚本用 SQLite 的 `VACUUM INTO` 复制旧库，不需要手工处理 WAL 旁文件。
工作区首次使用时还会继承机器级的 `preferences.json`，接管开关不会因布局切换而丢失。
「接管文件写入」由工具守卫真正执行：开启后该工作区的原生 `write`/`replace`/`edit`
会被拒绝，并指向 `attention_manifest_protocol_workspace.write`；其 `content` 模式用于完整写入，
`startLine`/`endLine` 加 `replacement` 模式用于定向替换，均以 `workspace.read` 返回的
revision 做 CAS 校验。

内核创建 AMP 的 32 张实体表和索引、工作流写入器、预算账本、注意力/上下文编译器、
收据、验证与证据链。`session`、`turn`、`intent`、`mission`、`goal`、`plan`、
`task`、`action` 由处理函数按需创建，空闲会话不写库。

工具调用按调用方智能体的工作区根选择存储；HTTP 路由接受 `?root=` 或
`?session=` 指定某个存储，`GET /deepseek-coordination/amp/status` 的 `storage`
字段返回计划路径、已打开的存储与回退记录，`kernel` 字段仍是当前内核快照。

宿主对象发布为 Cordis 服务 `ctx.amp`：

```ts
export const inject = ['amp']
export function apply(ctx: Context) {
  const kernel = ctx.amp.kernel(root)        // 每个工作区一个内核
  const modules = ctx.amp.modules            // 全部 27 个 AMP 模块
  const journal = ctx.amp.journalEntries()   // 每次网关调用一条记录
}
```

处理函数按职责拆分在 `src/host/handlers/`：会话/轮次、规划、注意力/证据/预算、
工作区、项目、执行、协作。工作区写入使用 `sha256` 修订号与 CAS；所有路径限制在
会话工作区根内。`execution.run` 通过 `ctx.tools.execute` 走 DSH 的策略流水线，
大结果转为可分页句柄。

## 上下文优化（注意力）

AMP 注意力已经接入真实模型请求，而不只是面板展示：

1. `src/host/context.ts` 每回合收集 Harness 的注意力项：当前用户提示、DSH 目标、
   todo 计划、最近工具结果、工作区根。
2. 调用 `kernel.flow.compileTurnContext`，使用 `contextBudgetTokens`
   （默认 1200）和单项预算。
3. 编译结果作为 `<amp_attention>` 运行时上下文注入；放不下的项记录为 AMP
   `exclusions`，不会伪装成已读。
4. `GET /deepseek-coordination/amp/context` 返回编译次数、条目数、排除数和
   最近一次包大小。

配置：

```yaml
- id: deepseek-coordination
  name: 'deepseek-coordination'
  config:
    contextOptimization: true
    contextBudgetTokens: 1200
```

整体流程也持续投影：session → turn → goal → todo plan/tasks → tool action；
`plan.propose_draft` 与 `/amp` 桥接会反向写回 Harness。最终上下文窗口与压缩
策略仍由 DSH 拥有；AMP 在预算内决定哪些内容值得注意，并记录被刻意排除的内容。

## Harness ↔ AMP 双向绑定

| 方向 | 路径 |
|---|---|
| DSH → AMP | `src/host/sync.ts` 把 `agent/created`、`turn/start`、`turn/end`、`tool/call`、`tool/result`、`goal/changed`、`todo/write` 映射为 AMP 的 session、turn、goal、plan/task 与 action attempt。 |
| AMP → DSH | `attention_manifest_protocol_harness` 与 `/amp goal|mission|plan|todos|feedback`，通过 Harness 自己的 `/goal`、`/plan` 命令和 `todo_write` 写入；`plan.propose_draft` 会把草稿镜像到 Harness 的 todo 列表并进入计划模式。 |
| Feedback | AMP 的 `turn.report`、`goal.submit_evidence` 调用 `ctx.sessionFeedback.record`（分类 `task-result`）；桥接工具的 `feedback` 操作也可显式触发。 |

AMP 要求独立的 verification 与 evidence 才能结算 Goal/Task。DSH 报告目标/todo 完成时，
投影在 `/deepseek-coordination/amp/sync` 中记录 **deferred settlement**，不伪造证据；
状态仍然可见、诚实。

用 `GET /deepseek-coordination/amp/sync` 查看实时投影计数。AMP 状态栏宽度限制为
`--dsh-composer-card-max-width`，与输入框卡片对齐。

## 通知（保留）

`coordination_notification` 支持 `snackbar`、`alert`、`dialog`、`popover`、
最多四个仅关闭按钮、严重级别、锚点和自动关闭时间。宿主维护有界的按会话队列，
客户端每 1.2 秒轮询 `GET /deepseek-coordination/notify/pending?session=`，
一次只渲染一个界面；`dialog` 永不自动关闭，投递是单向的，不会阻塞智能体循环。

开启设置里的「接管宿主弹窗与通知」后，审批和提问通过优先 waterfall 处理器截断，
不会进入 Harness 原生弹窗。通用宿主 Modal 使用其 `role="dialog"` / `aria-modal`
契约接管呈现，隐藏原弹层并保留原动作回调。支持信息、确认、单选、多选和文本输入；
使用 MUI 控件与原生 `<dialog>.showModal()`，阻塞背景页面，外部点击和 Esc 均不关闭。
必须通过弹窗内的明确操作结束；关闭接管开关后，新请求恢复原生路径。

## 客户端

| Slot | 注册项 | 作用 |
|---|---|---|
| `conversation.input.dock` | `deepseek-coordination.notifications` | 保持不变的通知界面。 |
| `conversation.composer.dock` | `deepseek-coordination.amp` | 紧凑的 `AMP 15/49` 状态按钮与模块对话框。 |
| `settings.section` | `deepseek-coordination` | 27 个模块的完整目录（层级、动词、权限、保留原因）。 |

客户端包使用 DSH 的 lazy-CJS 封装（`window.__ModuleLoader__.load({ id, factory })`），
只从页面模块表取 `react`；MUI 与 emotion 被打进单文件。

## 路由

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/deepseek-coordination/ping` | 名称、版本、协议。 |
| GET | `/deepseek-coordination/amp/status?root=&session=` | 模块计数、存储布局、内核快照、最近调用日志。 |
| GET | `/deepseek-coordination/amp/modules?q=&tier=` | 模块目录。 |
| GET | `/deepseek-coordination/amp/kernel` | 当前工作区的内核快照。 |
| GET | `/deepseek-coordination/amp/journal?limit=&session=&root=` | 网关调用日志。 |
| GET | `/deepseek-coordination/amp/preferences` | 当前工作区的接管开关（PUT/POST 更新）。 |
| GET | `/deepseek-coordination/amp/client` | 本插件的 Web 客户端入口。 |
| GET | `/deepseek-coordination/notify/pending?session=` | 取出并清空一个会话的通知。 |
| GET | `/deepseek-coordination/dialogs/pending?session=` | 当前会话待处理的审批与提问。 |
| POST | `/deepseek-coordination/dialogs/answer` | 提交 `{session,id,outcome}` 或 `{session,id,answers}`。 |
| POST | `/deepseek-coordination/dialogs/cancel` | 取消 `{session,id}`，不回落原生弹窗。 |

## 安装

```powershell
npm run build
dsh plugin --profile desktop add R:\project\deepseek-coordination
```

配置字段与英文 README 一致：`tenantId`、`rootId`、`storage`、`storeDirectory`、
`storePath`、`modules`、`notifications`、`prompt`、`skills`、`commands`、`routes`、
`maxJournal`、`maxReadChars`、`maxWriteChars`。

## 开发

```powershell
npm install
npm run typecheck
npm test
npm run build
```

宿主包把每个 `@deepseek-ai/*`、Cordis 与 AMP 外部化；客户端包内联 MUI/emotion、
外部化 React。两个预设都在 `tsdown.config.ts`。

测试覆盖：17 个工具注册、27/15/49 模块面计数、内核创建、模块分发、工作区 CAS
与根目录限制、项目环境 CAS、`plan.propose_draft` 的内核路径、通知、以及客户端
bundle 的 factory 与三个 slot 注册。`test/persistence.test.mjs` 另外用临时工作区
重启宿主，验证内核库、草稿计划、宿主状态行与工作区之间的隔离都能恢复，并验证
`storage: 'user'` 与显式 `storePath` 的布局。

### `semantic-typescript` 冻结保护

AMP 0.7.9 依赖的 `semantic-typescript@2` 在 `Optional` 模块里执行
`Object.freeze(Object.getPrototypeOf(Optional))`，会冻结 `Function.prototype`，
从而破坏 DSH 所有插件配置使用的 schemastery。`src/host/freezeGuard.ts` 在任何
AMP 导入之前运行，拒绝冻结 `Function.prototype`/`Object.prototype`/`Array.prototype`，
并且所有 AMP 导入都是动态的（`src/host/protocol.ts`）。这是本插件能与 Harness
其余部分同进程加载的关键。

## 已知限制

- AMP 0.7.9 不提供参数 schema；模块工具的 `arguments` 由各处理函数校验，而非协议。
- `workspace.document_outline` 返回 `supported: false`，指向 DSH 的 Office 工具；
  未内置二进制大纲解析器。
- `execution.run` 拒绝分发 AMP 协议工具，避免递归。
- `turn.respond` 在 AMP 中记录模型响应意图；对话转录仍由 DSH 拥有。
- 内核执行器端口未接线：工作流动作属于宿主，模型效果通过 `execution.run`
  或普通 DSH 工具执行。
- AMP 0.7.9 与 0.6.0 不兼容，旧 AMP 数据库不会迁移。
