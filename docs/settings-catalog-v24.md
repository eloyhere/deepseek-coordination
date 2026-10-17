# 设置目录 v24（settings catalog）

本文件是设置页的权威目录：**一个功能 / 一个配置键恰好一个控件**，控件由
`src/shared/selection.ts` 的 `SETTINGS_CONTROLS` 生成，文案由 `src/shared/i18n.ts`
的 `settings.catalog` 提供（中英逐键对应）。`test/settings-catalog.test.ts` 会检查：
配置叶子与控制一一对应、无重复 id / 键、六个情景全覆盖、数值行都有 min/max/step、
强制行不可写、补丁白名单拒绝未知键与 `databasePath`、越界值被拒、写入后投影可回读、
测试夹具（`test/helpers.ts`）与真实 schema 默认值一致。

## 路由与投影

| 路由 | 方法 | 请求 | 响应 |
|---|---|---|---|
| `/deepseek-coordination/config` | GET | — | `ConfigView = { values, defaults }` |
| `/deepseek-coordination/config` | POST | `{ patch: { "plan.threshold": 0.7 } }` | `{ applied, ignored, normalised, persisted, config }` |
| `/deepseek-coordination/config/compaction` | POST | `{ auto?, soft?, hard? }` | `{ auto, soft, hard }`（旧客户端兼容） |

- `values` 是当前生效配置；`defaults` 是 `resolveConfig(undefined)` 的真实默认值，
  客户端不复制任何默认字面量，因此页面上的“默认”永远来自主机。
- POST 的补丁是扁平点路径；未知键、`databasePath`、`database` 一律 `INVALID_ARGUMENT`。
  已知但不可写的键（强制 / 只读 / 计划中 / 本机）进入 `ignored`，不写入。
- 写入流程：校验 → 应用到活动配置 `CoordinationService.config` → 重新 `resolveConfig`
  （恢复所有权重归一、别名镜像、压缩阈值夹取等不变量）→ 若含压缩阈值则重建
  `TokenGovernor` → 尝试 `ctx.settings.update` 持久化。持久化失败仍先本进程生效并返回
  `persisted: false`，页面据此显示“已在本进程生效；主机未保存”。

### 状态（chip）

| chip | 含义 | 可否写入 |
|---|---|---|
| 主机 | 主机配置，写回 DSH | 是 |
| 本机 | 浏览器本地偏好（localStorage），不属于主机配置 | 本地存储 |
| 强制 | 解析器强制固定为 true，只显示 | 否 |
| 只读 | 部署策略 / 别名 / 派生值 / 已废弃 | 否 |
| 计划中 | 已写入配置，但当前版本没有消费者 | 否 |

### 接线状态

“有计划中/未接线”的行不是假开关：它们显示的是真实配置值，只是当前版本没有任何
模块读取该字段。目录的“消费者”列写明实际读取位置（`无` 表示尚未接线），页面会
显示“已保存；当前版本尚未读取这一项”。

## 总览

- 控件总数：**151**（其中可写 134）
- 覆盖配置键：**155**（配置共 18 个顶层键）
- 未暴露：`databasePath`、`database`（部署路径 / 文件名，见文末）

## 会话与默认值（`session`）

| 功能 | 控件 id | 配置键 | 类型 | 默认 | 范围 | 状态 | 消费者 | 备注 |
|---|---|---|---|---|---|---|---|---|
| 会话轮次上限 | `setting:maxTurnPerSession` | `maxTurnPerSession` | number | 1000 | 1–1000000（步长 1） | 可编辑 | src/host/turn.ts begin() · src/host/profession.ts start() |  |
| 默认租约 | `setting:defaultLease` | `defaultLease` | number | 30000 | 1000–86400000（步长 1000） | 可编辑 | src/host/resource.ts lock() · src/host/coordination.ts cleanupExpired() |  |
| 澄清与接管超时 | `setting:clarifyTimeout` | `clarifyTimeout` | number | 30000 | 1000–600000（步长 1000） | 可编辑 | src/host/takeover-gate.ts · src/host/compact.ts · src/host/coordination.ts maybeCompact() |  |
| 默认职能 | `setting:defaults.profession` | `defaults.profession` | enum: decision / outcome / resource / personnel / qualification / execution | execution | decision / outcome / resource / personnel / qualification / execution | 可编辑 | src/host/selection.ts get() · src/host/session.ts defaults() |  |
| 默认交互 | `setting:defaults.interaction` | `defaults.interaction` | enum: emotion / think / heuristic / converge / orchestrate | think | emotion / think / heuristic / converge / orchestrate | 可编辑 | src/host/selection.ts get() · src/host/session.ts defaults() · comprehension fallback |  |
| 默认情景 | `setting:defaults.scene` | `defaults.scene` | enum: dialogue / writing / office / research / engineering / iterate | dialogue | dialogue / writing / office / research / engineering / iterate | 可编辑 | src/host/selection.ts get() · src/host/session.ts defaults() · comprehension fallback |  |
| 默认验证 | `setting:defaults.validation` | `defaults.validation` | enum: low / medium / high | medium | low / medium / high | 可编辑 | src/host/selection.ts get() · src/host/session.ts defaults() · comprehension fallback |  |
| 默认命令 | `setting:defaults.command` | `defaults.command` | enum: none / goal / plan / feedback / compact / permission | none | none / goal / plan / feedback / compact / permission | 可编辑 | src/host/selection.ts get() |  |

## 职能与审计（`profession`）

| 功能 | 控件 id | 配置键 | 类型 | 默认 | 范围 | 状态 | 消费者 | 备注 |
|---|---|---|---|---|---|---|---|---|
| 职能功能 | `setting:profession.enabled` | `profession.enabled` | boolean | 开 | — | 强制（只读） | src/host/config.ts resolveConfig()（强制 true） | 解析器强制为 true，不可关闭 |
| 职能锁定 | `setting:profession.lock` | `profession.lock` | boolean | 开 | — | 强制（只读） | src/host/config.ts resolveConfig() + SQLite trg_turn_profession_lock | 解析器强制为 true，不可关闭 |
| 职能默认（别名） | `setting:profession.default` | `profession.default` | enum: decision / outcome / resource / personnel / qualification / execution | execution | decision / outcome / resource / personnel / qualification / execution | 只读 | src/host/config.ts resolveConfig()（defaults.profession 的镜像别名） | `defaults.profession` 的别名；只能通过默认职能行修改；配置已保存；当前版本没有读取它（见“接线状态”） |
| 重建后可重选 | `setting:profession.rebuildCanReselect` | `profession.rebuildCanReselect` | boolean | 开 | — | 强制（只读） | src/host/selection.ts rebuildProfession() | 解析器强制为 true，不可关闭 |
| 丢弃后可重选 | `setting:profession.abandonCanReselect` | `profession.abandonCanReselect` | boolean | 开 | — | 强制（只读） | src/host/selection.ts abandonProfession() | 解析器强制为 true，不可关闭 |
| 职能审计 | `setting:profession.audit` | `profession.audit` | boolean | 开 | — | 可编辑 | 无（保留键：审计事件始终写入） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| 锁定错误提示 | `setting:profession.errorHint` | `profession.errorHint` | boolean | 开 | — | 可编辑 | src/host/selection.ts set() · src/host/profession.ts hint |  |

## 情景策略（`scenes`）

### 情景选择器

| 控件 id | 类型 | 说明 |
|---|---|---|
| `setting:scene:selector` | enum: dialogue / writing / office / research / engineering / iterate | 切换要编辑的情景；一次只渲染该情景的 11 个字段，78 个字段不会同时出现 |

### 每个情景 11 个字段（六个情景各一行）

| 情景 | 功能 | 控件 id | 配置键 | 类型 | 默认 | 范围 | 状态 | 消费者 | 备注 |
|---|---|---|---|---|---|---|---|---|---|
| dialogue | 思考模式 | `setting:scenes.dialogue.thinking` | `scenes.dialogue.thinking` | enum: enabled / disabled | disabled | enabled / disabled | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| dialogue | 推理强度 | `setting:scenes.dialogue.reasoningEffort` | `scenes.dialogue.reasoningEffort` | text | medium | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| dialogue | 必须出计划 | `setting:scenes.dialogue.requirePlan` | `scenes.dialogue.requirePlan` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| dialogue | 必须评分 | `setting:scenes.dialogue.requireScore` | `scenes.dialogue.requireScore` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| dialogue | 必须先列提纲 | `setting:scenes.dialogue.requireOutline` | `scenes.dialogue.requireOutline` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| dialogue | 必须修订 | `setting:scenes.dialogue.requireRevision` | `scenes.dialogue.requireRevision` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| dialogue | 必须预测 | `setting:scenes.dialogue.requirePredict` | `scenes.dialogue.requirePredict` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| dialogue | 必须引用 | `setting:scenes.dialogue.requireCitation` | `scenes.dialogue.requireCitation` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| dialogue | 允许命令 | `setting:scenes.dialogue.allowBash` | `scenes.dialogue.allowBash` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| dialogue | 仅限工作区 | `setting:scenes.dialogue.sandboxOnly` | `scenes.dialogue.sandboxOnly` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| dialogue | 最大迭代 | `setting:scenes.dialogue.maxIteration` | `scenes.dialogue.maxIteration` | number | 1 | 1–1000（步长 1） | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| writing | 思考模式 | `setting:scenes.writing.thinking` | `scenes.writing.thinking` | enum: enabled / disabled | enabled | enabled / disabled | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| writing | 推理强度 | `setting:scenes.writing.reasoningEffort` | `scenes.writing.reasoningEffort` | text | high | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| writing | 必须出计划 | `setting:scenes.writing.requirePlan` | `scenes.writing.requirePlan` | boolean | 开 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| writing | 必须评分 | `setting:scenes.writing.requireScore` | `scenes.writing.requireScore` | boolean | 开 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| writing | 必须先列提纲 | `setting:scenes.writing.requireOutline` | `scenes.writing.requireOutline` | boolean | 开 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| writing | 必须修订 | `setting:scenes.writing.requireRevision` | `scenes.writing.requireRevision` | boolean | 开 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| writing | 必须预测 | `setting:scenes.writing.requirePredict` | `scenes.writing.requirePredict` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| writing | 必须引用 | `setting:scenes.writing.requireCitation` | `scenes.writing.requireCitation` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| writing | 允许命令 | `setting:scenes.writing.allowBash` | `scenes.writing.allowBash` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| writing | 仅限工作区 | `setting:scenes.writing.sandboxOnly` | `scenes.writing.sandboxOnly` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| writing | 最大迭代 | `setting:scenes.writing.maxIteration` | `scenes.writing.maxIteration` | number | 3 | 1–1000（步长 1） | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| office | 思考模式 | `setting:scenes.office.thinking` | `scenes.office.thinking` | enum: enabled / disabled | disabled | enabled / disabled | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| office | 推理强度 | `setting:scenes.office.reasoningEffort` | `scenes.office.reasoningEffort` | text | medium | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| office | 必须出计划 | `setting:scenes.office.requirePlan` | `scenes.office.requirePlan` | boolean | 开 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| office | 必须评分 | `setting:scenes.office.requireScore` | `scenes.office.requireScore` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| office | 必须先列提纲 | `setting:scenes.office.requireOutline` | `scenes.office.requireOutline` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| office | 必须修订 | `setting:scenes.office.requireRevision` | `scenes.office.requireRevision` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| office | 必须预测 | `setting:scenes.office.requirePredict` | `scenes.office.requirePredict` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| office | 必须引用 | `setting:scenes.office.requireCitation` | `scenes.office.requireCitation` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| office | 允许命令 | `setting:scenes.office.allowBash` | `scenes.office.allowBash` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| office | 仅限工作区 | `setting:scenes.office.sandboxOnly` | `scenes.office.sandboxOnly` | boolean | 开 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| office | 最大迭代 | `setting:scenes.office.maxIteration` | `scenes.office.maxIteration` | number | 1 | 1–1000（步长 1） | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| research | 思考模式 | `setting:scenes.research.thinking` | `scenes.research.thinking` | enum: enabled / disabled | enabled | enabled / disabled | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| research | 推理强度 | `setting:scenes.research.reasoningEffort` | `scenes.research.reasoningEffort` | text | high | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| research | 必须出计划 | `setting:scenes.research.requirePlan` | `scenes.research.requirePlan` | boolean | 开 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| research | 必须评分 | `setting:scenes.research.requireScore` | `scenes.research.requireScore` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| research | 必须先列提纲 | `setting:scenes.research.requireOutline` | `scenes.research.requireOutline` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| research | 必须修订 | `setting:scenes.research.requireRevision` | `scenes.research.requireRevision` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| research | 必须预测 | `setting:scenes.research.requirePredict` | `scenes.research.requirePredict` | boolean | 开 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| research | 必须引用 | `setting:scenes.research.requireCitation` | `scenes.research.requireCitation` | boolean | 开 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| research | 允许命令 | `setting:scenes.research.allowBash` | `scenes.research.allowBash` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| research | 仅限工作区 | `setting:scenes.research.sandboxOnly` | `scenes.research.sandboxOnly` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| research | 最大迭代 | `setting:scenes.research.maxIteration` | `scenes.research.maxIteration` | number | 3 | 1–1000（步长 1） | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| engineering | 思考模式 | `setting:scenes.engineering.thinking` | `scenes.engineering.thinking` | enum: enabled / disabled | enabled | enabled / disabled | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| engineering | 推理强度 | `setting:scenes.engineering.reasoningEffort` | `scenes.engineering.reasoningEffort` | text | high | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| engineering | 必须出计划 | `setting:scenes.engineering.requirePlan` | `scenes.engineering.requirePlan` | boolean | 开 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| engineering | 必须评分 | `setting:scenes.engineering.requireScore` | `scenes.engineering.requireScore` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| engineering | 必须先列提纲 | `setting:scenes.engineering.requireOutline` | `scenes.engineering.requireOutline` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| engineering | 必须修订 | `setting:scenes.engineering.requireRevision` | `scenes.engineering.requireRevision` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| engineering | 必须预测 | `setting:scenes.engineering.requirePredict` | `scenes.engineering.requirePredict` | boolean | 开 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| engineering | 必须引用 | `setting:scenes.engineering.requireCitation` | `scenes.engineering.requireCitation` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| engineering | 允许命令 | `setting:scenes.engineering.allowBash` | `scenes.engineering.allowBash` | boolean | 开 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| engineering | 仅限工作区 | `setting:scenes.engineering.sandboxOnly` | `scenes.engineering.sandboxOnly` | boolean | 开 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| engineering | 最大迭代 | `setting:scenes.engineering.maxIteration` | `scenes.engineering.maxIteration` | number | 3 | 1–1000（步长 1） | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| iterate | 思考模式 | `setting:scenes.iterate.thinking` | `scenes.iterate.thinking` | enum: enabled / disabled | enabled | enabled / disabled | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| iterate | 推理强度 | `setting:scenes.iterate.reasoningEffort` | `scenes.iterate.reasoningEffort` | text | high | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| iterate | 必须出计划 | `setting:scenes.iterate.requirePlan` | `scenes.iterate.requirePlan` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| iterate | 必须评分 | `setting:scenes.iterate.requireScore` | `scenes.iterate.requireScore` | boolean | 开 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| iterate | 必须先列提纲 | `setting:scenes.iterate.requireOutline` | `scenes.iterate.requireOutline` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| iterate | 必须修订 | `setting:scenes.iterate.requireRevision` | `scenes.iterate.requireRevision` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| iterate | 必须预测 | `setting:scenes.iterate.requirePredict` | `scenes.iterate.requirePredict` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| iterate | 必须引用 | `setting:scenes.iterate.requireCitation` | `scenes.iterate.requireCitation` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| iterate | 允许命令 | `setting:scenes.iterate.allowBash` | `scenes.iterate.allowBash` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| iterate | 仅限工作区 | `setting:scenes.iterate.sandboxOnly` | `scenes.iterate.sandboxOnly` | boolean | 关 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| iterate | 最大迭代 | `setting:scenes.iterate.maxIteration` | `scenes.iterate.maxIteration` | number | 3 | 1–1000（步长 1） | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 配置已保存；当前版本没有读取它（见“接线状态”） |

### 六情景相同、只保留一个共享控件（一次写六项）

| 功能 | 控件 id | 配置键 | 类型 | 默认 | 范围 | 状态 | 消费者 | 备注 |
|---|---|---|---|---|---|---|---|---|
| 允许联网（所有情景） | `setting:scene.all.allowWeb` | `scenes.dialogue.allowWeb`<br>`scenes.writing.allowWeb`<br>`scenes.office.allowWeb`<br>`scenes.research.allowWeb`<br>`scenes.engineering.allowWeb`<br>`scenes.iterate.allowWeb` | boolean | 开 | — | 可编辑 | 无（已声明的情景策略；执行器尚未读取） | 一次写入六个情景的同一字段；配置已保存；当前版本没有读取它（见“接线状态”） |
| 情景评分阈值（所有情景） | `setting:scene.all.scoreThreshold` | `scenes.dialogue.scoreThreshold`<br>`scenes.writing.scoreThreshold`<br>`scenes.office.scoreThreshold`<br>`scenes.research.scoreThreshold`<br>`scenes.engineering.scoreThreshold`<br>`scenes.iterate.scoreThreshold` | number | 0.6 | 0–1（步长 0.01） | 可编辑 | src/host/plan.ts planScoreThreshold()（仅 writing） | 一次写入六个情景的同一字段；六个值中只有 writing 被计划评分读取 |

### 只读策略

| 功能 | 控件 id | 类型 | 状态 | 消费者 | 备注 |
|---|---|---|---|---|---|
| 写作流程 | `setting:policy.writingFlow` | text | 只读 | src/host/organization.ts writing flow | 只读；写作流程的固定策略 |

## 计划评分（`plan`）

| 功能 | 控件 id | 配置键 | 类型 | 默认 | 范围 | 状态 | 消费者 | 备注 |
|---|---|---|---|---|---|---|---|---|
| 计划通过线 | `setting:plan.threshold` | `plan.threshold` | number | 0.5 | 0–1（步长 0.01） | 可编辑 | src/host/plan.ts scorePlan() |  |
| 最多重建次数 | `setting:plan.maxRebuild` | `plan.maxRebuild` | number | 3 | 0–100（步长 1） | 可编辑 | src/host/plan.ts rebuildPlan() |  |
| 权重 · 可行性 | `setting:plan.weights.feasibility` | `plan.weights.feasibility` | number | 0.15 | 0–1（步长 0.01） | 可编辑 | src/host/plan.ts computePlanTotal() | 保存后按八项总和归一，页面显示归一后的值 |
| 权重 · 覆盖度 | `setting:plan.weights.coverage` | `plan.weights.coverage` | number | 0.15 | 0–1（步长 0.01） | 可编辑 | src/host/plan.ts computePlanTotal() | 保存后按八项总和归一，页面显示归一后的值 |
| 权重 · 清晰度 | `setting:plan.weights.clarity` | `plan.weights.clarity` | number | 0.1 | 0–1（步长 0.01） | 可编辑 | src/host/plan.ts computePlanTotal() | 保存后按八项总和归一，页面显示归一后的值 |
| 权重 · 具体性 | `setting:plan.weights.specificity` | `plan.weights.specificity` | number | 0.1 | 0–1（步长 0.01） | 可编辑 | src/host/plan.ts computePlanTotal() | 保存后按八项总和归一，页面显示归一后的值 |
| 权重 · 一致性 | `setting:plan.weights.alignment` | `plan.weights.alignment` | number | 0.2 | 0–1（步长 0.01） | 可编辑 | src/host/plan.ts computePlanTotal() | 保存后按八项总和归一，页面显示归一后的值 |
| 权重 · 风险 | `setting:plan.weights.risk` | `plan.weights.risk` | number | 0.1 | 0–1（步长 0.01） | 可编辑 | src/host/plan.ts computePlanTotal() | 保存后按八项总和归一，页面显示归一后的值 |
| 权重 · 成本 | `setting:plan.weights.cost` | `plan.weights.cost` | number | 0.1 | 0–1（步长 0.01） | 可编辑 | src/host/plan.ts computePlanTotal() | 保存后按八项总和归一，页面显示归一后的值 |
| 权重 · 效率 | `setting:plan.weights.efficiency` | `plan.weights.efficiency` | number | 0.1 | 0–1（步长 0.01） | 可编辑 | src/host/plan.ts computePlanTotal() | 保存后按八项总和归一，页面显示归一后的值 |
| 门槛 · 可行性 | `setting:plan.dimensions.feasibility` | `plan.dimensions.feasibility` | number | 0.5 | 0–1（步长 0.01） | 可编辑 | src/host/plan.ts dimension check |  |
| 门槛 · 覆盖度 | `setting:plan.dimensions.coverage` | `plan.dimensions.coverage` | number | 0.6 | 0–1（步长 0.01） | 可编辑 | src/host/plan.ts dimension check |  |
| 门槛 · 清晰度 | `setting:plan.dimensions.clarity` | `plan.dimensions.clarity` | number | 0.5 | 0–1（步长 0.01） | 可编辑 | src/host/plan.ts dimension check |  |
| 门槛 · 具体性 | `setting:plan.dimensions.specificity` | `plan.dimensions.specificity` | number | 0.5 | 0–1（步长 0.01） | 可编辑 | src/host/plan.ts dimension check |  |
| 门槛 · 一致性 | `setting:plan.dimensions.alignment` | `plan.dimensions.alignment` | number | 0.7 | 0–1（步长 0.01） | 可编辑 | src/host/plan.ts dimension check |  |
| 门槛 · 风险 | `setting:plan.dimensions.risk` | `plan.dimensions.risk` | number | 0.7 | 0–1（步长 0.01） | 可编辑 | src/host/plan.ts dimension check |  |
| 门槛 · 成本 | `setting:plan.dimensions.cost` | `plan.dimensions.cost` | number | 0.8 | 0–1（步长 0.01） | 可编辑 | src/host/plan.ts dimension check |  |
| 门槛 · 效率 | `setting:plan.dimensions.efficiency` | `plan.dimensions.efficiency` | number | 0.5 | 0–1（步长 0.01） | 可编辑 | src/host/plan.ts dimension check |  |

## 子任务与验收（`orchestration`）

| 功能 | 控件 id | 配置键 | 类型 | 默认 | 范围 | 状态 | 消费者 | 备注 |
|---|---|---|---|---|---|---|---|---|
| 退回上限 | `setting:orchestration.maxReject` | `orchestration.maxReject` | number | 2 | 0–100（步长 1） | 可编辑 | src/host/orchestration.ts reject loop |  |
| 子任务上限 | `setting:orchestration.maxSubTask` | `orchestration.maxSubTask` | number | 32 | 1–1000（步长 1） | 可编辑 | src/host/orchestration.ts dispatch() · src/host/organization.ts |  |
| 确定性验收 | `setting:orchestration.groundTruth` | `orchestration.groundTruth` | boolean | 开 | — | 可编辑 | src/host/orchestration.ts verify() · src/host/organization.ts |  |
| 验收超时 | `setting:orchestration.groundTruthTimeout` | `orchestration.groundTruthTimeout` | number | 5000 | 100–600000（步长 100） | 可编辑 | 无（保留键：确定性检查尚未使用超时） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| 允许命令验收 | `setting:orchestration.allowShellGroundTruth` | `orchestration.allowShellGroundTruth` | boolean | 关 | — | 可编辑 | src/host/orchestration.ts groundTruth() |  |
| 模型分流 | `setting:orchestration.modelRouting` | `orchestration.modelRouting` | boolean | 开 | — | 可编辑 | src/host/orchestration.ts dispatch() |  |

## 缓存（`cache`）

| 功能 | 控件 id | 配置键 | 类型 | 默认 | 范围 | 状态 | 消费者 | 备注 |
|---|---|---|---|---|---|---|---|---|
| 缓存优化 | `setting:cache.enabled` | `cache.enabled` | boolean | 开 | — | 可编辑 | src/host/cache.ts decorate() |  |
| 缓存有效期 | `setting:cache.ttl` | `cache.ttl` | number | 60000 | 0–2592000000（步长 1000） | 可编辑 | src/host/provider.ts route catalog cache |  |
| 指纹窗口 | `setting:cache.fingerprintWindow` | `cache.fingerprintWindow` | number | 50 | 1–10000（步长 1） | 可编辑 | 无（保留键） | 配置已保存；当前版本没有读取它（见“接线状态”） |
| 推理强度提醒 | `setting:cache.effortWarning` | `cache.effortWarning` | boolean | 开 | — | 可编辑 | src/host/cache.ts decorate() |  |

## 概率推断（`bayesian`）

| 功能 | 控件 id | 配置键 | 类型 | 默认 | 范围 | 状态 | 消费者 | 备注 |
|---|---|---|---|---|---|---|---|---|
| 初始概率 | `setting:bayesian.prior` | `bayesian.prior` | number | 0.5 | 0–1（步长 0.01） | 可编辑 | src/host/comprehension.ts · src/host/bayesian.ts |  |
| 停止熵 | `setting:bayesian.stopEntropy` | `bayesian.stopEntropy` | number | 0.05 | 0–10（步长 0.01） | 可编辑 | src/host/bayesian.ts convergencePolicy() |  |
| 信息增益下限 | `setting:bayesian.infoGain` | `bayesian.infoGain` | number | 0.01 | 0–10（步长 0.01） | 可编辑 | src/host/bayesian.ts convergencePolicy() |  |
| 路线上限 | `setting:bayesian.maxRoutes` | `bayesian.maxRoutes` | number | 12 | 1–1000（步长 1） | 可编辑 | src/host/comprehension.ts route ranking |  |
| 校准下限 | `setting:bayesian.calibrationFloor` | `bayesian.calibrationFloor` | number | 0.1 | 0–1（步长 0.01） | 可编辑 | 无（保留键） | 配置已保存；当前版本没有读取它（见“接线状态”） |

## 理解与检索（`comprehension`）

| 功能 | 控件 id | 配置键 | 类型 | 默认 | 范围 | 状态 | 消费者 | 备注 |
|---|---|---|---|---|---|---|---|---|
| 阶段超时 | `setting:comprehension.stageTimeout` | `comprehension.stageTimeout` | number | 30000 | 100–600000（步长 100） | 可编辑 | src/host/comprehension.ts searchTimeout() |  |
| 联网检索 | `setting:comprehension.searchEnabled` | `comprehension.searchEnabled` | boolean | 开 | — | 可编辑 | src/host/comprehension.ts policy |  |
| 证据条数上限 | `setting:comprehension.maxEvidence` | `comprehension.maxEvidence` | number | 8 | 1–1000（步长 1） | 可编辑 | src/host/comprehension.ts evidence cap |  |
| 历史窗口 | `setting:comprehension.highHistoryWindow` | `comprehension.highHistoryWindow` | number | 50 | 0–100000（步长 1） | 可编辑 | src/host/comprehension.ts history cap |  |

## 自动压缩（`compaction`）

| 功能 | 控件 id | 配置键 | 类型 | 默认 | 范围 | 状态 | 消费者 | 备注 |
|---|---|---|---|---|---|---|---|---|
| 自动压缩 | `setting:compaction.auto` | `compaction.auto` | boolean | 开 | — | 可编辑 | src/host/token.ts TokenGovernor.plan() |  |
| 压缩触发阈值 | `setting:compaction.soft` | `compaction.soft` | number | 0.7 | 0.3–0.9（步长 0.01） | 可编辑 | src/host/token.ts TokenGovernor.plan() |  |
| 硬性裁剪阈值 | `setting:compaction.hard` | `compaction.hard` | number | 0.88 | 0.3–0.98（步长 0.01） | 可编辑 | src/host/token.ts TokenGovernor.plan() |  |
| 保留额度 | `setting:compaction.reserve` | `compaction.reserve` | number | 2048 | 512–10000000（步长 512） | 只读 | src/host/token.ts normaliseCompactionPolicy() |  |
| 保留轮次 | `setting:compaction.recentTurns` | `compaction.recentTurns` | number | 6 | 2–20（步长 1） | 只读 | src/host/token.ts normaliseCompactionPolicy() |  |
| 压缩冷却 | `setting:compaction.cooldown` | `compaction.cooldown` | number | 30000 | 5000–600000（步长 1000） | 只读 | src/host/coordination.ts maybeCompact() |  |
| 每会话上限 | `setting:compaction.maxPerSession` | `compaction.maxPerSession` | number | 20 | 1–10000（步长 1） | 只读 | src/host/coordination.ts maybeCompact() |  |

## 界面与显示（`ui`）

| 功能 | 控件 id | 配置键 | 类型 | 默认 | 范围 | 状态 | 消费者 | 备注 |
|---|---|---|---|---|---|---|---|---|
| 工作流下拉框（旧键） | `setting:ui.toolbar` | `ui.toolbar` | boolean | 开 | — | 只读 | src/host/selection.ts configuration()（已废弃别名） | 已废弃；仅保留兼容投影；配置已保存；当前版本没有读取它（见“接线状态”） |
| 显示提示 | `setting:ui.showTooltip` | `ui.showTooltip` | boolean | 开 | — | 可编辑 | src/host/selection.ts configuration() · src/client/controls.ts tooltipsStore |  |
| 接管宿主弹窗 | `setting:ui.takeover` | `ui.takeover` | boolean | 关 | — | 可编辑 | src/host/takeover-gate.ts install() · src/host/takeover.ts |  |
| 自动刷新间隔 | `setting:ui.refreshInterval` | `ui.refreshInterval` | number | 5000 | 500–86400000（步长 500） | 可编辑 | src/host/selection.ts configuration() · src/client/controls.ts poll |  |
| 紧凑模式 | `setting:ui.compact` | `ui.compact` | boolean | 开 | — | 可编辑 | src/client/settings.ts · src/client/controls.ts compactStore |  |
| 默认语言 | `setting:ui.locale` | `ui.locale` | enum: auto / zh-CN / en-US | auto | auto / zh-CN / en-US | 只读 | src/host/coordination.ts locale fallback · src/host/tools.ts registration |  |
| 权限接管 | `setting:local.takeoverPermission` | — | boolean | — | — | 本机 | src/client/store.ts takeoverStore · composer |  |
| 工作流下拉框 | `setting:local.composerWorkflow` | — | boolean | — | — | 本机 | src/client/store.ts workflowStore · composer |  |
| 接管权限控件 | `setting:derived.takeoverControl` | — | boolean | — | — | 只读 | src/client/store.ts takeoverStore（派生显示） |  |
| 权限预设来源 | `setting:derived.permissionCatalog` | — | text | — | — | 只读 | src/host/selection.ts listPreset()（DSH 目录） | 只读；目录来自 DSH |
| 当前语言 | `setting:derived.currentLocale` | — | text | — | — | 只读 | src/client/i18n.ts currentLocale() |  |

## 文件解析（`parser`）

| 功能 | 控件 id | 配置键 | 类型 | 默认 | 范围 | 状态 | 消费者 | 备注 |
|---|---|---|---|---|---|---|---|---|
| 解析总开关 | `setting:parser.enabled` | `parser.enabled` | boolean | 开 | — | 可编辑 | src/host/tools.ts registerCoordinationTools() | 注册时读取；已注册的宿主需重启或重注册（如切换语言）才生效 |
| 单文件字节上限 | `setting:parser.maxFileBytes` | `parser.maxFileBytes` | number | 1048576 | 1024–16777216（步长 1024） | 可编辑 | src/host/tools.ts ToolRuntime · src/host/parse-service.ts | 文件工具运行时首次创建时读取；已创建的运行时保持旧值（重启后生效） |
| 词元上限 | `setting:parser.maxTokens` | `parser.maxTokens` | number | 200000 | 1–2000000（步长 1000） | 可编辑 | src/host/tools.ts ToolRuntime · src/host/parse-service.ts | 文件工具运行时首次创建时读取；上限只能收紧，不能突破解析器硬上限 |
| 语法树深度 | `setting:parser.maxAstDepth` | `parser.maxAstDepth` | number | 256 | 1–4096（步长 1） | 可编辑 | src/host/tools.ts ToolRuntime · src/host/parse-service.ts | 传入解析器 `maxDepth`；已创建运行时通过 retune 即时收紧 |
| 解析超时 | `setting:parser.timeoutMs` | `parser.timeoutMs` | number | 2000 | 50–60000（步长 50） | 可编辑 | src/host/tools.ts ToolRuntime · src/host/parse-service.ts | 文件工具运行时首次创建时读取；已创建的运行时保持旧值（重启后生效） |
| 解析缓存条数 | `setting:parser.cacheCapacity` | `parser.cacheCapacity` | number | 256 | 1–100000（步长 1） | 可编辑 | src/host/tools.ts ToolRuntime · src/host/parse-service.ts | 文件工具运行时首次创建时读取；已创建的运行时保持旧值（重启后生效） |
| 依赖图节点上限 | `setting:parser.dependencyGraphMaxVertices` | `parser.dependencyGraphMaxVertices` | number | 20000 | 1–1000000（步长 1000） | 可编辑 | src/host/parse-service.ts dependencyGraph() | 失败关闭；超出时 `coordination_parse` 返回截断摘要 |
| 依赖图边上限 | `setting:parser.dependencyGraphMaxEdges` | `parser.dependencyGraphMaxEdges` | number | 100000 | 1–5000000（步长 1000） | 可编辑 | src/host/parse-service.ts dependencyGraph() | 失败关闭；超出时 `coordination_parse` 返回截断摘要 |

## 关系链（`chain`）

| 功能 | 控件 id | 配置键 | 类型 | 默认 | 范围 | 状态 | 消费者 | 备注 |
|---|---|---|---|---|---|---|---|---|
| 关系链深度 | `setting:chain.depth` | `chain.depth` | number | 8 | 1–8（步长 1） | 可编辑 | src/host/tools.ts ToolRuntime · src/host/chain.ts | 文件工具运行时首次创建时读取；硬上限 8，只能收紧 |
| 关系链条数 | `setting:chain.links` | `chain.links` | number | 50 | 1–50（步长 1） | 可编辑 | src/host/tools.ts ToolRuntime · src/host/chain.ts | 文件工具运行时首次创建时读取；硬上限 50，只能收紧 |
| 关系链词元预算 | `setting:chain.tokenBudget` | `chain.tokenBudget` | number | 1500 | 100–100000（步长 100） | 可编辑 | src/host/tools.ts ToolRuntime · src/host/chain.ts | 文件工具运行时首次创建时读取；投影仍受 1500 词元左右的硬预算约束 |

## 工具输出（`tools`）

| 功能 | 控件 id | 配置键 | 类型 | 默认 | 范围 | 状态 | 消费者 | 备注 |
|---|---|---|---|---|---|---|---|---|
| 工具结果字节上限 | `setting:tools.maxResultBytes` | `tools.maxResultBytes` | number | 0 | 0–16777216（步长 1024） | 可编辑 | src/host/tools.ts renderJson() | 七个工具统一限长；超出返回带 `truncated`/`marker`/`preview` 的合法 JSON，0 = 不限制 |

## 未暴露（不是遗漏）

| 配置键 | 为什么没有控件 |
|---|---|
| `databasePath` | 部署方给出的数据库文件路径，属于主机秘密；`POST /config` 显式拒绝它（`INVALID_ARGUMENT`），`ConfigView` 也不投影它。页面能改它只会带来路径穿越与覆盖风险。 |
| `database` | 数据库文件名，同样是部署标识而非功能开关；改它等于让插件指向另一个库，必须由部署方在配置文件中完成。 |
| DSH 凭据 / token / provider 密钥 | 本插件从不读取或保存；`ConfigView` 里不存在这些字段。 |
| `profession.default` 的写入口 | 它是 `defaults.profession` 的文档别名，解析器每次都镜像；只保留一个可写控件（默认职能），别名行只读，避免两个入口互相覆盖。 |
| `takeover.timeout` | 不新增第二个超时键：`clarifyTimeout` 就是实际生效的超时（接管窗口、自动压缩都读它），目录里只有一行。 |

## 与文档的对应关系

| 文档 | 本目录如何落实 |
|---|---|
| v24 §5 缓存 | `cache.enabled / ttl / effortWarning` 可写；`fingerprintWindow` 为保留键，目录标注“未接线”。 |
| v24 §6.3 / §14 验证 | 验证档位的检索预算由 `comprehension.*` 控件承载；默认值仍来自 `validation` 档位表，页面的“默认验证”行可改默认档位。 |
| v24 §8 统筹 | `orchestration.*` 六个控件；`groundTruthTimeout` 为保留键。 |
| v24 §9.3 Plan 评分 | `plan.threshold / maxRebuild / 8 权重 / 8 维度`；权重保存后归一。 |
| v24 §12 贝叶斯 | `bayesian.*` 五个控件；`calibrationFloor` 为保留键。 |
| v24 §15.2 设置页 | 强制开关（职能锁定 / 重建 / 丢弃）只读，其余按本目录分组折叠展示。 |
| v24 §19 配置 | 新增 `parser.* / chain.* / tools.*` 三组（默认值取自 `docs/file-processing-v24.md` §4 与 `docs/domain-model-v24.md` §7）；文件工具读取全部解析上限、依赖图上限、`chain.*` 与 `tools.maxResultBytes`，并支持运行时 retune。 |
| v24 §22 i18n | 所有新文案在 `settings.catalog` 下中英逐键对应；`test/i18n.test.ts` + `test/settings-catalog.test.ts` 双向检查。 |

## 接线与生效时机

文件层的全部上限现在都有读取者。`parser.maxFileBytes / maxTokens / maxAstDepth /
timeoutMs / cacheCapacity`、两个依赖图上限、`chain.depth / links / tokenBudget`
以及 `tools.maxResultBytes` 由 `src/host/tools.ts` 的 `ToolRuntime` 消费；已创建的
运行时会比较配置签名并调用 `retune`，所以这些数值**即改即生效**，旧句柄仍然可用。
`parser.enabled` 是唯一仍受注册时机约束的开关：关闭后现有调用失败关闭，但要从工
具列表中真正移除/恢复四个文件工具，需要下一次注册（重启）。页面不把这一项写成即
改即生效。

## 消费者索引

| 模块 | 读取的配置键 |
|---|---|
| `src/host/plan.ts` | `plan.threshold`、`plan.maxRebuild`、`plan.weights.*`、`plan.dimensions.*`、`scenes.writing.scoreThreshold` |
| `src/host/orchestration.ts` | `orchestration.maxReject / maxSubTask / groundTruth / allowShellGroundTruth / modelRouting` |
| `src/host/comprehension.ts` | `comprehension.*`、`bayesian.prior / maxRoutes / stopEntropy`、`defaults.*` |
| `src/host/bayesian.ts` | `bayesian.prior / stopEntropy / infoGain / maxRoutes` |
| `src/host/cache.ts` | `cache.enabled / effortWarning` |
| `src/host/provider.ts` | `cache.ttl` |
| `src/host/token.ts` + `src/host/coordination.ts` | `compaction.auto / soft / hard / reserve / recentTurns / cooldown / maxPerSession` |
| `src/host/selection.ts` | `defaults.*`、`profession.errorHint`、`ui.*` 投影 |
| `src/host/takeover-gate.ts` + `src/host/takeover.ts` | `ui.takeover`、`clarifyTimeout` |
| `src/host/tools.ts` | `parser.enabled`（注册时）、其余 `parser.*`、`chain.*`、`tools.maxResultBytes`（每次调用签名检查 + retune） |
| `src/host/turn.ts` / `resource.ts` / `profession.ts` | `maxTurnPerSession`、`defaultLease`、`profession.errorHint` |
| `src/client/controls.ts` + `src/client/store.ts` | `ui.showTooltip / compact / refreshInterval`（本机偏好）以及本机两个开关 |
