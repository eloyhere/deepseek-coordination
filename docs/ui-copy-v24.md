# DeepSeek Coordination · 界面文案设计 v24

> **状态：** 可实施（implementer-ready）。字符串逐字复制即可。
> **范围：** 输入框五个下拉框的 tooltip、锁定/离线/错误提示、设置页的信息架构与全部文案。
> **非范围：** 颜色、圆角、阴影等视觉样式；行为逻辑；模型可见的 `coordination_*` 工具描述。
> **行为依据：** `docs/deepseek-coordination-v23.md` §3、§6.2、§6.3、§14、§15、§16、§19、§22；`src/shared/enum.ts` 的 `SceneProfiles`（v24 写作情景）。
> **文案落点：** `src/shared/i18n.ts`。本文所有字符串按 §5 逐字复制，不另写第二份。

**替换关系。** 本文取代 v23 §15.1 / §15.2 里的中文 tooltip 与设置文案，不改变枚举值、默认值与执行逻辑。现有 `src/shared/i18n.ts` 已存在，本文的字符串是对它的**替换与扩充**，不是新建字典。

**三个前提，先对齐：**

1. **v24 写作情景插在“对话”和“办公”之间。** 顺序固定为 `对话 → 写作 → 办公 → 研究 → 工程 → 迭代`。菜单、设置下拉、文档表格都按这个顺序；写作不得排到办公之后。写作策略取自 `SceneProfiles.writing`：先提纲、至少改一稿、最多 3 轮，允许联网，不允许跑命令。
2. **第五个下拉是“权限”，不是“命令”。** v23 §15.1 的示意图把“命令”画成第五个下拉，但 §6.4 明确命令是消息前缀（`/goal`、`/plan`…），不占下拉位；`src/client/controls.ts` 当前实现的也是权限。本文沿用“职能 / 交互 / 情景 / 验证 / 权限”五个下拉，不新增命令下拉。
3. **`low / medium / high` 是唯一保留在界面上的技术标识。** 它们出现在 tooltip 里是为了让操作者能和日志、文档对上；其余内部词一律换成后果描述。

---

## 0. 结论摘要（给实施者）

| 交付项 | 数量 | 说明 |
|---|---|---|
| 控件 tooltip | 5 条 | 每个下拉框一条，≤90 汉字 / ≤160 英文 |
| 选项 tooltip | 23 条 | 职能 6 + 交互 5 + 情景 6 + 验证 3 + 权限 3，≤70 / ≤120 |
| 权限目录与异常 tooltip | 8 条 | 目录项模板、空目录、自定义预设、审批后缀、写入提示、离线、拒绝 |
| 锁定 / 离线 / 错误 tooltip | 9 条 | 含锁定、未锁定、离线、拒绝、无效、验证说明 |
| tooltip 合计 | 45 条 | 含 5 个控件、全部选项与状态句 |
| 设置页设置 | 24 项 | 6 组；其中可编辑 5 项、强制 3 项、只读 16 项 |
| 设置说明文案 | 24 条 | 每条 ≤70 汉字 / ≤120 英文 |
| i18n 键（zh/en 成对） | 198 条 | 无孤儿键；模板键单独计数 |

**五条关键结论：**

1. **五个下拉共 5 条控件 tooltip + 23 条选项 tooltip**，全部落在 90/160 与 70/120 的预算内；另有 8 条权限目录/异常文案和 9 条状态/拒绝文案。
2. **验证文案统一为“三档都联网；差异只在 1×3 / 2×5 / 4×8 和证据范围”。** 当前 `controls.ts` 里那句「medium 与 high 允许联网搜索；low 不做贝叶斯推断」与 §6.3、§14 冲突，必须删除；这是本次唯一的**事实性**文案错误。
3. **设置页从 2 个裸开关 + 1 个职能组扩到 6 组 24 项。** 其中 5 项本机可编辑、3 项强制（只读）、13 项主机配置只读、3 项运行时派生；强制项不提供关闭入口。
4. **`config.ts` 不需要新增键，但有 4 组必须修或确认。** `profession.rebuildCanReselect` 与 `profession.abandonCanReselect` 当前无人读取、也没被强制；`ui.showTooltip` 已随 `SelectionState` 下发但客户端从未消费；`profession.default` 与 `defaults.profession` 重复，真正生效的是后者；`profession.audit` 有键但无人读取。
5. **每个字符串都有 zh/en 成对；没有孤儿键。** 长度、配对、禁用词、占位符一致性由 §4.6 的 lint 测试守住，不靠人工目测。

**config key 映射总览：**

| 类别 | 行数 | 说明 |
|---|---|---|
| 主机配置键（config.ts） | 16 | 13 项只读 + 3 项强制；覆盖 ui.takeover、profession.*、defaults.*、scenes.writing、ui.locale、cache.enabled、comprehension.searchEnabled、orchestration.* |
| 本机可编辑（localStorage） | 5 | takeover、workflow、tooltips、compact、refresh |
| 只读派生 | 3 | 接管控件、权限目录、当前语言 |

---

## 1. 文案策略（先读这一节）

### 1.1 读者与语气

- **读者：** 会用 DSH、但不了解插件内部结构的操作者。他知道“任务、文件、权限、模型、会话”，不知道“问责轴、贝叶斯、Provider、Trace、编排”。
- **阅读场景：** 鼠标停 1 秒；键盘 Tab 一下；出错时扫一眼。所以文案必须**一句话、先后果、可执行**。
- **语气：** 同事在旁边解释，不是产品宣传。不用“强大、智能、无缝、极致、一站式”，不用感叹号。
- **判断标准：** 一个从没用过本插件的人，读完能不能回答“我现在改了什么？会变好还是变坏？出问题怎么办？”——三问都答得上，才算合格。

### 1.2 术语替换表

| 内部说法 | 不要出现在操作者界面 | 换成 |
|---|---|---|
| 问责轴 / 问责维度 | tooltip、设置 | 这份责 / 职能 |
| 贝叶斯推断 / 先验 / 后验 | tooltip、设置 | 按证据更新判断（或直接说“查资料后判断”） |
| 检索预算 / 证据范围 | tooltip、设置 | 查多少资料 / 看多远 |
| Plan | tooltip、设置 | 方案 |
| Turn / Session / Thread | tooltip、设置 | 任务 / 会话（“本轮”只在确有必要时用） |
| OrchestrationTrace / 哈希链 | tooltip、设置 | 记录（改不掉） |
| 编排 / 派发 | tooltip、设置 | 拆任务 / 分给多个代理 |
| 沙箱 | tooltip、设置 | 工作区限制 / 只能在工作区内 |
| Token / 预算 | tooltip、设置 | 额度 / 花费 |
| Provider / Model | tooltip、设置 | 模型 |
| fail-closed | tooltip、设置 | 拿不准就不做 |
| MCP | 全部操作者界面 | 删除（本插件不在操作者界面提 MCP） |
| 能力资格 | tooltip、设置 | 能不能胜任 |
| 幂等 / 快照 | tooltip、设置 | 重复操作不会出错 / 备份 |
| 治理轨迹 | tooltip、设置 | 审计记录 |
| 子任务 | 可保留一次 | 拆出来的小任务（首次出现时解释） |

**保留的技术标识：** `DSH`、`low / medium / high`、`工作区`、`审批`、`模型`、`1×3 / 2×5 / 4×8`。它们要么是产品名，要么是操作者能在别处对上的稳定标识。

### 1.3 长度预算与测量方法

| 位置 | 中文上限 | 英文上限 | 测量方式 | 超了怎么办 |
|---|---|---|---|---|
| 控件 tooltip（下拉框本身） | 90 字 | 160 字符 | `Array.from(text).length` / `text.length` | 先删机制，再删例子，不删后果 |
| 选项 tooltip（菜单每一行） | 70 字 | 120 字符 | 同上 | 删“适合/优点/缺点”这类评价，只留“做什么 + 代价” |
| 设置说明（每行常驻） | 70 字 | 120 字符 | 同上 | 拆成“开关文案 + 组助记”，不要塞进一行 |
| 分组说明 / 组助记 | 70 字 | 120 字符 | 同上 | 只留一句判断标准 |
| 错误 / 状态提示 | 70 字 | 120 字符 | 同上 | 只留“发生了什么 + 下一步” |
| “为什么锁”解释段 | 200 字 | 320 字符 | 同上（最多 2 句） | 只保留因果与出口 |

**计数口径：** 中文按 Unicode 码点计（一个汉字、一个全角标点都算 1）；英文按字符计（含空格与标点）。**不截断、不加省略号**：放不下就改写，不用小字号硬塞。上表的预算已经含标点。

### 1.4 五条硬规则

1. **先说后果，再说代价。** “会隐藏宿主按钮”是后果，“关掉后宿主控件回来”也是后果；不要先解释实现。
2. **一句话只做一个区分。** 一句里同时讲“三档都联网”和“三档检索量不同”可以；再塞“贝叶斯融合范围”就超载。
3. **不在 tooltip 里罗列菜单。** 菜单已经列了五个选项；tooltip 的职责是解释“我换了会怎样”，不是复述选项名。
4. **数字只保留能改变决策的。** `1×3 / 2×5 / 4×8`、`3 轮`、`5 秒`保留；“8 个维度”“12 条路线”不进操作者文案。
5. **同一句话只有一份。** 输入框和设置页共享 `i18n.ts` 里的同一条字符串；不许为了“语气不同”写两份，最后一定漂移。

---

## 2. TOOLTIP SYSTEM

### 2.1 一行式公式

```text
[它管什么] + [换了会怎样] + [一句提醒]
   ≤20 字       ≤35 字          ≤20 字
```

- **它管什么：** 用操作者的词说出这个控件控制的**一件事**，不要用功能名。例：“定查多少资料、看多远的历史”，不写“决定检索预算与证据范围”。
- **换了会怎样：** 写**可观察的变化**。例：“三档都会联网，只差检索量和证据范围”；不写“执行轻量先验/后验更新”。
- **一句提醒：** 只在有真实代价时写：锁定、立即生效、更慢更贵、风险最高。没有代价就不写，不要凑第三句。

**合格例（验证）：**

> 定查多少资料、看多远的历史；三档都会联网，只差检索量和证据范围。

**不合格例（当前）：**

> 决定检索预算与证据范围：low 当轮 / medium 当前会话 / high 本地全部内容。三档都联网并做贝叶斯更新。

问题有三：①“检索预算 / 证据范围 / 贝叶斯”是内部词；②把菜单又列了一遍；③渲染后 102 字，超过 90 字上限。

**选项 tooltip 的公式：**

```text
[具体做什么] + [一句代价或锁定提醒]
```

选项不重复控件已经说过的“它管什么”，只回答“选了这个，和别的有什么不同”。例：“决定做不做、方案过不过；能叫停，也能放行。任务内锁定。”

### 2.2 两层 tooltip：控件一层，选项一层

| 层 | 位置 | 内容 | 何时出现 |
|---|---|---|---|
| 控件 tooltip | 下拉框本身 | `标题（职能 · 当前：成果）` + 一句说明 + 状态行（锁定 / 离线 / 拒绝） | 悬停 400ms 或键盘聚焦 |
| 选项 tooltip | 菜单每一行 | 只有一句选项说明，无标题、无状态行 | 悬停 250ms 或键盘聚焦该行 |

- **标题行是生成的，不是翻译的。** `{control} · {currentLabel}：{current}`，中文用全角冒号，英文用半角冒号；标题不计入 90 字预算，但整块渲染后不超过 3 行。
- **状态行不覆盖说明。** 锁定或离线时，先保留“这个控件是干什么的”，再补一行状态；不要整块换成“已锁定”四个字，否则操作者不知道锁的是什么。
- **只读控件仍然有 tooltip。** 原生 `disabled` 会让控件无法聚焦、也不触发鼠标事件；实现上应使用 `aria-disabled="true"` + 可聚焦的外层容器（见 §2.7），让锁定原因可被键盘读到。

### 2.3 渲染与交互规格

| 项 | 规格 |
|---|---|
| 触发延迟 | 控件 400ms；选项 250ms；键盘聚焦 0ms（立即出现） |
| 位置 | 控件：上方；选项：右侧。贴近视口边缘时自动翻转，不遮挡当前行 |
| 宽度 | 最大 320px；中文按 14px、英文按 13px 换行；允许 3 行（控件）/ 2 行（选项） |
| 截断 | **禁止**省略号截断；超长即改写 |
| 关闭 | `Esc` 先关 tooltip，再按一次关菜单；失焦即关；指针离开 150ms 后关 |
| 触摸 | 长按 500ms 出现；设置页每个设置行另有一个常驻“?”按钮，点按切换说明 |
| 动效 | 120ms 淡入；`prefers-reduced-motion` 时无动效 |
| 视觉层级 | 标题 600 字重；说明 0.85 透明度；状态行 0.7，错误用琥珀色；正文对比度 ≥ 4.5:1 |
| 语义 | `role="tooltip"`；关闭时 `aria-hidden="true"`；用 `aria-describedby` 关联，不用 `title` 属性 |
| 层级 | z-index 高于菜单；不遮住当前聚焦行；不与弹窗抢焦点 |

### 2.4 现在 → 改成：7 个太长或术语过重的例子

| # | 位置 | 现在 | 字数 | 改成 | 字数 | 变化 | 问题 / 改法 |
|---|---|---|---|---|---|---|---|
| 1 | 验证 · 控件 tooltip（渲染后） | 验证 · 当前：中<br>决定检索预算与证据范围：low 当轮 / medium 当前会话 / high 本地全部内容。三档都联网并做贝叶斯更新。medium 与 high 允许联网搜索；low 不做贝叶斯推断。 | 102 | 定查多少资料、看多远的历史；三档都会联网，只差检索量和证据范围。 | 32 | −69% | 102 字，含“检索预算 / 证据范围 / 贝叶斯”三个内部概念；附加句还与 §6.3 矛盾（三档都联网、都做贝叶斯）。 |
| 2 | 职能 · 控件 tooltip（渲染后） | 职能 · 当前：执行<br>任务内唯一且锁定的问责维度。选择后本 Turn 不可切换，只能重建或丢弃任务。本 Turn 的职能已锁定为「执行」。重建（rebuild）或丢弃（abandon）任务后才能重新选择。 | 101 | 定这个任务由谁负哪一份责；选定后任务内不能改，要换只能重建或丢弃任务。 | 35 | −65% | 101 字；“问责维度”“Turn”“rebuild / abandon”都要背景知识，锁定规则说了两遍。 |
| 3 | 情景 · 写作选项 | 内容创作与文本打磨，适合文章、文案、报告、邮件、技术文档。优点：结构化产出、多轮打磨。缺点：需要多轮交互，不适合即时问答。 | 61 | 文章、文案、报告、邮件；先列提纲再写，至少改一稿，最多 3 轮。要来回沟通。 | 38 | −38% | 61 字的规格书：优点 / 缺点两段式，读起来像需求文档，不像菜单提示。 |
| 4 | 设置 · 权限接管 | 已接管时隐藏 DSH 输入框的访问模式控件，改用协调面板的权限下拉；未接管时保留 DSH 自带控件。 | 50 | 隐藏 DSH 的访问模式按钮，改用本插件的权限下拉。 | 26 | −48% | 50 字两段对照（已接管 / 未接管），把状态说明混进了开关本身。 |
| 5 | 设置 · 职能审计 | 每次锁定、重建、丢弃写入 OrchestrationTrace，形成不可篡改的哈希链。 | 43 | 每次锁定、重建、丢弃都留一条改不掉的记录。 | 21 | −51% | 43 字，出现 OrchestrationTrace 与“哈希链”，非技术操作者无法判断后果。 |
| 6 | 职能 · 决策选项 | 对是否执行、Plan 是否通过拥有最终批准权或否决权。任务内锁定，不可切换。 | 38 | 决定做不做、方案过不过；能叫停，也能放行。任务内锁定。 | 27 | −29% | 38 字，Plan / 最终批准权 / 否决权都是内部或法律化措辞。 |
| 7 | 情景 · 迭代选项 | generate → critique → revise 闭环，适合打磨。优点：质量高。缺点：多轮调用。 | 52 | 先写、再批、再改，循环打磨；质量高，调用次数多。 | 24 | −54% | 52 字，把 generate → critique → revise 内部流程名直接摆进菜单。 |

**读法说明：** “字数”是渲染后的中文字符数；百分比是相对现在的缩减。**缩减不是目的**——“验证”从 102 字降到 32 字，仍然保留了“三档都联网”和“只差检索量与证据范围”两个决策信息，删掉的只是机制名和重复的菜单列表。

### 2.5 五个下拉框的全量 tooltip

#### 2.5.1 控件本身（5 条，≤90 / ≤160）

| 控件 | 值 | 中文标签 | English | 中文 tooltip（≤90） | English tooltip（≤160） | 长度检查 |
|---|---|---|---|---|---|---|
| 职能 | —（控件本身） | 职能 | Profession | 定这个任务由谁负哪一份责；选定后任务内不能改，要换只能重建或丢弃任务。 | Sets which single duty this task is accountable for. It cannot change mid-task; rebuild or abandon to choose again. | zh 35/90 · en 115/160 ✅ |
| 交互 | —（控件本身） | 交互 | Interaction | 定它怎么回应你：陪你聊、深入想、找可行方向、排掉失败方向，或拆给多个代理。 | Sets how it responds: listen, reason deeply, find what works, rule out what fails, or split work across agents. | zh 37/90 · en 111/160 ✅ |
| 情景 | —（控件本身） | 情景 | Scene | 定这次用哪种工作方式；会改变流程、查资料的方式，以及能不能改文件。 | Sets the working mode; it changes the process, how evidence is gathered, and whether files can be changed. | zh 33/90 · en 106/160 ✅ |
| 验证 | —（控件本身） | 验证 | Validation | 定查多少资料、看多远的历史；三档都会联网，只差检索量和证据范围。 | Sets how much evidence is gathered and how far back it looks; all three levels search the web, and only the volume and scope differ. | zh 32/90 · en 132/160 ✅ |
| 权限 | —（控件本身） | 权限 | Permission | 定这个会话能改什么；切换立刻生效，可能影响正在跑的任务。 | Sets what this session may change; the switch applies immediately and can affect a running task. | zh 28/90 · en 96/160 ✅ |

**共同规则：** 控件 tooltip 不写“当前值是什么”（标题已经写了），不写“有哪些选项”（菜单已经列了）。只写“管什么 + 换了会怎样 + 一句提醒”。

#### 2.5.2 职能（6 条，≤70 / ≤120）

| 控件 | 值 | 中文标签 | English | 中文 tooltip（≤70） | English tooltip（≤120） | 长度检查 |
|---|---|---|---|---|---|---|
| 职能 | `decision` | 决策 | Decision | 决定做不做、方案过不过；能叫停，也能放行。任务内锁定。 | Decides whether to proceed and whether the plan passes; can stop or approve. Locked for the task. | zh 27/70 · en 97/120 ✅ |
| 职能 | `outcome` | 成果 | Outcome | 对最后交付的东西负责：达不达标由它签字。任务内锁定。 | Owns the final deliverable and signs off on whether it meets the goal. Locked for the task. | zh 26/70 · en 91/120 ✅ |
| 职能 | `resource` | 资源 | Resource | 管额度和花费：用多少模型、搜索和缓存。任务内锁定。 | Owns budget and cost: how much model, search, and cache the task uses. Locked for the task. | zh 25/70 · en 91/120 ✅ |
| 职能 | `personnel` | 人员 | Personnel | 管分工：谁来做、几个人、合不合规。任务内锁定。 | Owns staffing: who does the work, how many, and whether that is allowed. Locked for the task. | zh 23/70 · en 93/120 ✅ |
| 职能 | `qualification` | 任职 | Qualification | 只检查模型能不能胜任，不参与干活。任务内锁定。 | Checks whether a model is qualified, without doing the work. Locked for the task. | zh 23/70 · en 81/120 ✅ |
| 职能 | `execution` | 执行 | Execution | 按给定条件把活做完，不验收自己的成果。任务内锁定。 | Completes the work under the given conditions and does not verify itself. Locked for the task. | zh 25/70 · en 94/120 ✅ |

**说明：** 六个选项都保留“任务内锁定”的提醒，因为每个选项都可能被单独读到（菜单项 tooltip 不共享上下文）。锁定规则本身只在“职能”控件 tooltip 里完整解释一次，选项里用“任务内锁定”四个字提示即可。

#### 2.5.3 交互（5 条，≤70 / ≤120）

| 控件 | 值 | 中文标签 | English | 中文 tooltip（≤70） | English tooltip（≤120） | 长度检查 |
|---|---|---|---|---|---|---|
| 交互 | `emotion` | 感情 | Emotion | 先接住情绪：听你说、理解感受，不急着给方案。 | Listens first: acknowledges feelings before offering solutions. | zh 22/70 · en 63/120 ✅ |
| 交互 | `think` | 思维 | Think | 把推理摊开，给深度分析和答案。 | Lays out the reasoning and gives a deep analysis and answer. | zh 15/70 · en 60/120 ✅ |
| 交互 | `heuristic` | 启发 | Heuristic | 先找走得通的路，按成功经验排序，给最值得试的方向。 | Finds routes that work, ranked by past successes, and names the best direction to try. | zh 25/70 · en 86/120 ✅ |
| 交互 | `converge` | 收束 | Converge | 先排除走不通的路，说清边界、失败原因和止损点。 | Rules out routes that fail, with the boundary, the cause, and the point to stop. | zh 23/70 · en 80/120 ✅ |
| 交互 | `orchestrate` | 统筹 | Orchestrate | 拆成子任务分给多个代理，独立验收后汇总；更慢更贵，简单对话不必用。 | Splits work into subtasks, verifies each independently, then synthesises. Slower and costlier; not for simple chat. | zh 33/70 · en 115/120 ✅ |

**说明：** “统筹”是唯一带成本提醒的选项（更慢更贵），因为它是唯一会显著增加调用次数的交互；其余四项不加“优点/缺点”，避免菜单变成评测表。

#### 2.5.4 情景（6 条，≤70 / ≤120；写作在对话与办公之间）

> **顺序硬约束：** `dialogue → writing → office → research → engineering → iterate`。写作必须排在对话之后、办公之前；`SceneValues`、菜单、设置页“默认情景”下拉、文档表格一致。

| 控件 | 值 | 中文标签 | English | 中文 tooltip（≤70） | English tooltip（≤120） | 长度检查 |
|---|---|---|---|---|---|---|
| 情景 | `dialogue` | 对话 | Dialogue | 闲聊和简单问答；快，但不够深入。 | Small talk and quick Q&A; fast but shallow. | zh 16/70 · en 43/120 ✅ |
| 情景 | `writing` | 写作 | Writing | 文章、文案、报告、邮件；先列提纲再写，至少改一稿，最多 3 轮。要来回沟通。 | Articles, copy, reports, email; outline first, then at least one revision (max 3 rounds). Needs back-and-forth. | zh 38/70 · en 111/120 ✅ |
| 情景 | `office` | 办公 | Office | 整理文件、生成报告；只在工作区内操作。 | Organises files and generates reports; limited to the workspace. | zh 19/70 · en 64/120 ✅ |
| 情景 | `research` | 研究 | Research | 查资料、给证据和引用；慢，但结论有出处。 | Searches sources and cites evidence; slow, but conclusions are traceable. | zh 20/70 · en 73/120 ✅ |
| 情景 | `engineering` | 工程 | Engineering | 写代码、构建、调试；能跑命令，改动不出工作区。 | Writes code, builds, and debugs; can run commands, with changes confined to the workspace. | zh 23/70 · en 90/120 ✅ |
| 情景 | `iterate` | 迭代 | Iterate | 先写、再批、再改，循环打磨；质量高，调用次数多。 | Draft, critique, revise in a loop; high quality, more model calls. | zh 24/70 · en 66/120 ✅ |

**说明：** 情景 tooltip 只写“做什么 + 一个代价”，不写“优点/缺点”两段式。写作的“最多 3 轮”来自 `SceneProfiles.writing.maxIteration`，不是文案自创；如果部署把 `scenes.writing.maxIteration` 改掉，这条文案要同步改。

#### 2.5.5 验证（3 条，≤70 / ≤120）

> **事实约束（§6.3 / §14）：** 三档**都联网检索**、**都做贝叶斯更新**；差异只在检索预算（1×3 / 2×5 / 4×8）、证据范围（当轮 / 当前会话 / 本地全部内容）与融合范围。任何“low 不联网”“low 不做推断”的文案都是错的。当前 `controls.ts` 的附加句必须删除。

| 控件 | 值 | 中文标签 | English | 中文 tooltip（≤70） | English tooltip（≤120） | 长度检查 |
|---|---|---|---|---|---|---|
| 验证 | `low` | 低 | Low | 也联网：1 次 × 3 条，只看这一轮，不翻旧会话。 | Also searches: 1 query × 3 results, this turn only; no older sessions. | zh 26/70 · en 70/120 ✅ |
| 验证 | `medium` | 中 | Medium | 也联网：2 次 × 5 条，看当前会话全部内容，不翻旧会话。 | Also searches: 2 queries × 5 results across this whole session; no older sessions. | zh 30/70 · en 82/120 ✅ |
| 验证 | `high` | 高 | High | 也联网：4 次 × 8 条，加上全部本地会话和工作区文件，最全也最慢。 | Also searches: 4 queries × 8 results plus all local sessions and workspace files; the most complete and slowest. | zh 35/70 · en 112/120 ✅ |

**说明：** 每条都以“也联网”开头，这样即使操作者只读到一条，也不会误以为低档不搜索。预算写成“1 次 × 3 条”，不用“1×3”单独出现，避免读者把它当成版本号。

#### 2.5.6 权限（3 条兜底，≤70 / ≤120）

> **来源约束：** 权限选项由 DSH 的 `ctx.permissionPresets` 目录动态提供；本插件不定义权限档位、不翻译 DSH 的预设名、不另存一份。下表是**目录为空时的兜底三条**，也是 DSH 目录项 tooltip 追加的“后果句”。

| 控件 | 值 | 中文标签 | English | 中文 tooltip（≤70） | English tooltip（≤120） | 长度检查 |
|---|---|---|---|---|---|---|
| 权限（兜底） | `read-only` | 仅可查看 | Read-only | 只能看：不改文件，也不跑会改东西的命令。 | View only: no file changes and no commands that change anything. | zh 20/70 · en 64/120 ✅ |
| 权限（兜底） | `workspace-write` | 工作区内修改 | Workspace write | 能改工作区里的文件；改工作区外会被拒绝。 | Can change files inside the workspace; writes outside it are refused. | zh 20/70 · en 69/120 ✅ |
| 权限（兜底） | `danger-full-access` | 完全权限 | Full access | 能改任何路径，不受工作区限制；风险最高，慎用。 | Can change any path, outside the workspace too; highest risk, use with care. | zh 23/70 · en 76/120 ✅ |

#### 2.5.7 DSH 目录项与异常（8 条，≤70 / ≤120）

| 场景 | 值 | 中文 tooltip（≤70） | English tooltip（≤120） | 长度检查 / 规则 |
|---|---|---|---|---|
| DSH 目录项 | {name} | {name}：{consequence} | {name}: {consequence} | zh 20/70 · en 21/120 ✅ |
| 目录为空 | — | DSH 没有提供权限预设，这里只显示说明，不能切换。 | DSH exposes no permission presets; this is informational and cannot be switched. | zh 26/70 · en 80/120 ✅ |
| 自定义预设 | 当前值 | 自定义权限预设，DSH 目录里没有；切换前先确认影响。 | A custom permission preset not in DSH's catalog; check the impact before switching. | zh 27/70 · en 83/120 ✅ |
| 审批后缀 | {approval} | 审批方式：{approval} | Approval: {approval} | zh 15/70 · en 20/120 ✅ |
| 无法判断档位 | — | 权限档位由 DSH 的权限预设定义。 | The permission tier is defined by DSH permission presets. | zh 18/70 · en 57/120 ✅ |
| 写入提示 | — | 切换会立刻写进本会话的 DSH 权限。 | Switching applies the DSH permission to this session immediately. | zh 19/70 · en 65/120 ✅ |
| 主机离线 | — | 主机未连接，权限不能切换。 | Host unreachable; the permission cannot be switched. | zh 13/70 · en 52/120 ✅ |
| DSH 拒绝 | — | DSH 没有接受这个权限预设，已保持原样。 | DSH did not accept that permission preset; the previous one stays in force. | zh 21/70 · en 75/120 ✅ |

**动态拼接规则：**

1. 目录存在时，选项 label 用 DSH 的 `name` 原样显示；tooltip 用 `{name}：{consequence}`，`consequence` 取上表对应档位的后果句（20–23 字）。整块仍受 70/120 预算约束，超出时只显示后果句。
2. **不把 DSH 的长 `description` 直接塞进 tooltip。** 如果 DSH 预设名超过 40 字符，菜单只显示名称（可换行），tooltip 只显示后果句；名称本身不截断。
3. 找不到档位映射时，用 `composer.permissionPresetDefault`：「权限档位由 DSH 的权限预设定义。」这句话只在无法判断后果时出现，且必须与“切换会立即生效”一起出现。
4. `approval` 后缀只在 DSH 提供审批策略时追加；追加后仍要保证整块 ≤ 2 行，超出就只保留后果句。
5. 目录为空、主机离线、DSH 拒绝三种情况分别用 `permissionCatalogMissing`、`permissionOffline`、`permissionRejected`；**不要**用同一句“操作失败”糊过去。

### 2.6 锁定 / 离线 / 错误 tooltip

| 状态 | 何时出现 | 中文 | English | 长度检查（≤70 / ≤120） |
|---|---|---|---|---|
| `lockedLine` | 任务已开始（职能只读时） | 任务已开始，职能锁定；完成或新建任务后可改。 | Task started: profession locked. Finish it or start a new task to change it. | zh 22/70 · en 76/120 ✅ |
| `unlockedLine` | 任务尚未开始 | 现在可以选；任务一开始就锁定。 | You can choose now; it locks when the task starts. | zh 15/70 · en 50/120 ✅ |
| `lockedAria` | 只读控件的可访问名后缀 | 已锁定 | locked | zh 3/70 · en 6/120 ✅ |
| `offlineLine` | 主机未连接 | 主机未连接；这里的选择只存本机，不影响任务。 | Host unreachable; choices here are saved on this device only and do not affect the task. | zh 22/70 · en 88/120 ✅ |
| `localOnly` | 离线句的短片段 | 只存本机 | saved on this device only | zh 4/70 · en 25/120 ✅ |
| `professionLocked` | 尝试修改已锁定职能 | 职能已锁定，改动没有生效；重建或丢弃任务后可改。 | Profession is locked, so the change was not applied. Rebuild or abandon the task to choose again. | zh 24/70 · en 97/120 ✅ |
| `invalidSelection` | 主机返回 INVALID_ARGUMENT | 这个选项无效，已恢复原选择。 | That option is not valid; the previous choice was restored. | zh 14/70 · en 59/120 ✅ |
| `requestFailed` | 主机拒绝或网络失败 | 主机拒绝了这次修改，已恢复原选择。 | The host rejected the change; the previous choice was restored. | zh 17/70 · en 63/120 ✅ |
| `validationNote` | 验证控件的固定说明（aria-describedby） | 三档都联网：低 1×3 当轮 / 中 2×5 当前会话 / 高 4×8 本地全部。 | All three levels search: low 1×3 this turn / medium 2×5 this session / high 4×8 all local content. | zh 41/70 · en 98/120 ✅ |

**使用规则：**

- **锁定**（任务已开始）：「任务已开始，职能锁定；完成或新建任务后可改。」——这是用户指定的基准句。控件标题追加 `composer.lockedSuffix`「（已锁定）」，`aria-label` 追加 `composer.lockedAria`；只读控件仍可聚焦。
- **离线**（主机 3 秒无响应）：「主机未连接；这里的选择只存本机，不影响任务。」——只作为**第二行**追加，不替换控件原有说明；离线时仍要让人知道这个控件是干什么的。
- **拒绝**：先说“没生效”，再说“原值还在”，最后给出口。不出现错误码；错误码只进日志和 `errors.*` 的排查文档。
- **无效选项**：「这个选项无效，已恢复原选择。」——不解释校验细节；细节留给日志。
- **验证说明**（`validationNote`）不是 tooltip，而是验证控件的 `aria-describedby` 与设置页“默认验证”的常驻说明；它保证“三档都联网”这句话在不悬停时也能被读到。

### 2.7 可访问性

**键盘路径（必须逐条验收）：**

| 操作 | 期望 |
|---|---|
| `Tab` 到下拉框 | 控件获得可见焦点；tooltip 立即出现（不等待 400ms） |
| `Enter` / `Space` | 打开菜单；焦点落在当前选项 |
| `↑` / `↓` | 在选项间移动；每个选项获得焦点时显示它自己的 tooltip |
| `Esc` | 第一次关闭 tooltip；第二次关闭菜单；焦点回到下拉框 |
| `Tab` / `Shift+Tab` | 离开控件；tooltip 关闭；焦点顺序不被 tooltip 打断 |
| 只读控件上 `Tab` | 仍能聚焦；tooltip 说明“已锁定”和出口；不能展开菜单 |
| 设置页 `?` 按钮 | `Enter` / `Space` 切换说明；`aria-expanded` 同步；`aria-label` 用 `settings.values.help`；说明文字常驻在 DOM 中 |

**实现要求：**

1. **tooltip 必须由焦点触发，不只由 hover 触发。** MUI 的 `describeChild` 只解决语义关联，不解决聚焦；外层容器需要 `tabIndex=0`，并把 `aria-describedby` 指向 tooltip 内容。
2. **锁定控件不要用原生 `disabled` 承担全部语义。** 原生 `disabled` 元素不可聚焦、不触发鼠标事件，键盘用户永远读不到锁定原因。用 `aria-disabled="true"` + 外层可聚焦容器；`select` 的 `aria-label` 用 `controlAria` 拼上 `lockedAria`。
3. **屏幕阅读器文本必须自足。** 读到“职能，当前：成果，已锁定”时，用户不需要看到 tooltip 也知道不能改；tooltip 只是补充后果。
4. **对比度与缩放：** tooltip 正文对比度 ≥ 4.5:1；200% 缩放下不裁切、不出现横向滚动；不用颜色单独表达状态（状态 chip 必须带文字）。
5. **触摸与无悬停设备：** 长按 500ms 打开；设置页的“?”按钮是常驻入口；不存在“只有 hover 才能知道”的规则。
6. **语言切换：** tooltip 随宿主语言切换，宽度按中英文分别校验；不做 RTL（本插件只发 `zh-CN` / `en-US`）。

### 2.8 tooltip 不是唯一载体（记录矩阵）

| 规则 | tooltip | 设置页常驻文字 | 错误 / 提示 | 设计文档 |
|---|---|---|---|---|
| 职能任务内锁定 | 职能控件 + 6 个选项 | “职能锁定”行 + `强制` chip + “为什么锁”段 | `PROFESSION_LOCKED` | v23 §3.3 |
| 重建 / 丢弃后可重选 | 职能控件 + 设置行 | “重建后可重选”“丢弃后可重选”两行 | `professionLocked` | v23 §3.4 |
| 三档验证都联网 | 验证控件 + 3 个选项 | “默认验证”说明 + 组助记 | — | §6.3 / §14 |
| 权限切换立即生效 | 权限控件 + 目录项 | “权限预设来源”说明 + 组助记 | `permissionRejected` | §16 |
| 工作流关闭只是隐藏 | — | “工作流下拉框”说明 | — | §15.1 |
| 只读项来自主机 | — | `只读（主机）` chip + 页脚 | — | §19 |
| 写作最多 3 轮 | 写作选项 | “写作流程”行 | — | v24 SceneProfiles |

**结论：** 任何“改了会怎样”的规则，至少有两个可读位置；tooltip 可以更详细，但不能是唯一记录。设置页每一行都必须有常驻说明（不是 hover 才出现），因为设置页是操作者做决定的地方。

---

## 3. SETTINGS PAGE

### 3.1 信息架构

**分组顺序与理由：**

1. **权限与接管**放最前：它决定“能改什么”，风险最高，先看。
2. **工作流与下拉框**第二：它决定输入框长什么样，是每天第一眼看到的东西。
3. **职能与审计**第三：核心安全约束，但不需要每天改。
4. **情景与验证默认**第四：新任务的默认工作方式。
5. **语言与显示**第五：不影响正确性，只影响阅读。
6. **高级**最后：部署级开关，普通操作者不需要动。

**页面骨架：**

- 标题：`协调 / Coordination`（沿用设置分区 label）。
- 副标题：`为下一个任务设默认值；界面开关立即生效。`
- 状态 chip：`主机已连接` / `主机未连接`；离线时整页顶部出现离线条。
- 六组，每组：组标题 + 一句话说明 + 设置行 + 组助记（常驻小字）。
- 页脚：只读来源说明 + `开关立即生效，没有保存按钮。`

| # | 分组 | English | 组说明 | 组内设置 |
|---|---|---|---|---|
| 1 | 权限与接管 | Permission & takeover | 这个会话能改什么，以及权限控件由谁提供。 | 权限接管 / 接管权限控件 / 接管宿主弹窗 / 权限预设来源 |
| 2 | 工作流与下拉框 | Workflow & selectors | 输入框里显示哪些选择器，要不要提示。 | 工作流下拉框 / 显示提示 |
| 3 | 职能与审计 | Profession & audit | 一个任务只有一个职能：怎么锁、怎么留痕。 | 职能锁定 / 默认职能 / 重建后可重选 / 丢弃后可重选 / 职能审计 / 锁定错误提示 |
| 4 | 情景与验证默认 | Scene & validation defaults | 新任务默认怎么做、查多少资料。 | 默认情景 / 默认验证 / 默认交互 / 写作流程 |
| 5 | 语言与显示 | Language & display | 界面语言、刷新快慢和疏密。 | 默认语言 / 当前语言 / 紧凑模式 / 自动刷新间隔 |
| 6 | 高级 | Advanced | 主机级开关，影响所有会话；通常保持默认。 | 缓存优化 / 联网检索 / 确定性验收 / 模型分流 |

**层级规则：**

- 组标题 13px/600，上方 1px 分隔线；组说明 12px 次要色；行标签 13px；行说明 12px 次要色，最多 2 行。
- 开关在右，标签在左；状态 chip 跟在控件右侧（`强制` / `只读（主机）` / `只读` / `本机`）。
- 只读行不画开关，避免“看起来能点”；用值 + chip 表示。
- 不做折叠面板：折叠会把“说明”藏起来，违背“tooltip 不是唯一载体”。高级组用更低的视觉权重（组标题仍可见）而不是默认收起。
- 不做“保存 / 取消”：开关即改即生效，页脚明说“没有保存按钮”。

**状态 chip 与取值的 key（避免孤儿键）：**

| 显示 | key | 用在哪 |
|---|---|---|
| 强制 | `settings.values.forced` | 三个强制行的 chip |
| 只读（主机） | `settings.values.readOnlyHost` | 主机配置只读行 |
| 只读（策略） | `settings.values.readOnlyPolicy` | 写作流程行 |
| 只读 | `settings.values.readOnly` | 派生行（接管控件、目录、当前语言） |
| 本机 | `settings.values.local` | 五个可编辑行 |
| 本机设置 | `settings.values.localOnly` | 离线条与页脚 |
| 查看说明 | `settings.values.help` | `?` 按钮的 `aria-label` |
| 主机配置 | `settings.values.hostConfig` | 只读行的来源说明 |
| 开关 / 下拉的当前值 | `settings.values.on` / `off` / `followHost` / `chinese` / `english` / `refresh2` / `refresh5` / `refresh10` / `refreshPaused` | 控件朗读与选项 |
| 读取中 / 连接后显示 / 默认 / 已连接 / 未连接 | `settings.values.loading` / `unavailable` / `default` / `connected` / `disconnected` | 页面状态 |

### 3.2 设置全量表（标签、类型、config key、默认值、说明、强制/只读）

> **持久化铁律：** config key 必须是 `src/host/config.ts` 里真实存在的，或明确标注为客户端 `localStorage`。**不要为了设置页新增一个“看起来能存”的键。** 标 `只读（主机）` 的行，本页不写入主机；要改请改 `cordis.patch.yml`。

| # | id | 中文标签 | English | 类型 | config key / 存储 | 默认 | 中文说明（≤70） | English（≤120） | 强制 / 只读 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `takeoverPermission` | 权限接管 | Permission takeover | 开关 / switch | localStorage `deepseek-coordination:takeover` · 仅本机（客户端） | 关 | 隐藏 DSH 的访问模式按钮，改用本插件的权限下拉。 | Hides DSH's access-mode button and uses this plugin's permission dropdown instead. | 可编辑 |
| 2 | `takeoverControl` | 接管权限控件 | Taken-over control | 只读 / read-only | 无（由 takeoverPermission 派生） · 派生，不持久化 | 宿主访问模式按钮 | 只替换输入框的权限控件；DSH 的弹窗不受影响。 | Replaces only the composer's permission control; DSH dialogs are unaffected. | 只读 |
| 3 | `takeoverDialogs` | 接管宿主弹窗 | Host dialog takeover | 只读 / read-only | `ui.takeover` · 主机配置（config.ts） | 关 | 允许本插件接管 DSH 的审批、权限等弹窗；关掉就仍由 DSH 显示。 | Lets this plugin take over DSH approval and permission dialogs; off keeps DSH's own. | 只读（主机） |
| 4 | `permissionCatalog` | 权限预设来源 | Permission preset source | 只读 / read-only | 无（DSH `ctx.permissionPresets`） · DSH 运行时 | DSH 目录 | 权限选项和审批方式由 DSH 提供；本插件不定义、不改写。 | Permission options and approval policy come from DSH; this plugin does not define or rewrite them. | 只读 |
| 5 | `composerWorkflow` | 工作流下拉框 | Composer selectors | 开关 / switch | localStorage `deepseek-coordination:workflow` · 仅本机（客户端） | 开 | 显示职能、交互、情景、验证四个下拉框；关掉只是隐藏，不改选择。 | Shows the profession, interaction, scene, and validation dropdowns; off only hides them. | 可编辑 |
| 6 | `composerTooltips` | 显示提示 | Show hints | 开关 / switch | localStorage `deepseek-coordination:tooltips`；默认取 `ui.showTooltip` · 仅本机（客户端） | 开（跟随主机） | 鼠标悬停或键盘聚焦时显示说明；关掉不影响功能。 | Shows explanations on hover or keyboard focus; turning it off changes nothing else. | 可编辑 |
| 7 | `professionLock` | 职能锁定 | Profession lock | 开关 / switch | `profession.lock`（resolveConfig 强制 true） · 主机配置 | 开 | 强制开启：一个任务只能有一个职能，中途不能换。 | Forced on: a task has exactly one profession and cannot switch mid-task. | 强制 |
| 8 | `professionDefault` | 默认职能 | Default profession | 下拉 / select | `defaults.profession` · 主机配置（config.ts） | 执行 | 新任务没选时用这个；任务一开始仍会锁定。 | Used when a new task has no choice; it still locks when the task starts. | 只读（主机） |
| 9 | `professionRebuild` | 重建后可重选 | Reselect after rebuild | 开关 / switch | `profession.rebuildCanReselect`（需强制 true） · 主机配置 | 开 | 重建会新建任务，新任务可以重新选职能。 | A rebuild creates a new task, which may choose a new profession. | 强制 |
| 10 | `professionAbandon` | 丢弃后可重选 | Reselect after abandon | 开关 / switch | `profession.abandonCanReselect`（需强制 true） · 主机配置 | 开 | 丢弃不新建任务；下一个任务可以重新选职能。 | Abandoning creates no new task; the next task may choose a new profession. | 强制 |
| 11 | `professionAudit` | 职能审计 | Profession audit | 只读 / read-only | `profession.audit` · 主机配置（config.ts） | 开 | 每次锁定、重建、丢弃都留一条改不掉的记录。 | Every lock, rebuild, and abandon leaves a record that cannot be altered. | 只读（主机） |
| 12 | `professionErrorHint` | 锁定错误提示 | Lock error hint | 只读 / read-only | `profession.errorHint` · 主机配置（config.ts） | 开 | 改不动时，提示里直接说重建或丢弃该怎么做。 | When a change is refused, the message says how to rebuild or abandon. | 只读（主机） |
| 13 | `defaultScene` | 默认情景 | Default scene | 下拉 / select | `defaults.scene` · 主机配置（config.ts） | 对话 | 新任务默认的工作方式；写作会先列提纲再改稿。 | The default working mode for new tasks; writing outlines first, then revises. | 只读（主机） |
| 14 | `defaultValidation` | 默认验证 | Default validation | 下拉 / select | `defaults.validation` · 主机配置（config.ts） | 中 | 新任务默认查多少资料；三档都会联网检索。 | How much evidence new tasks gather by default; all three levels search the web. | 只读（主机） |
| 15 | `defaultInteraction` | 默认交互 | Default interaction | 下拉 / select | `defaults.interaction` · 主机配置（config.ts） | 思维 | 新任务默认怎么回应；选统筹会拆子任务。 | How new tasks respond by default; orchestrate splits them into subtasks. | 只读（主机） |
| 16 | `writingFlow` | 写作流程 | Writing flow | 只读 / read-only | `scenes.writing.*`（生效策略） · 主机配置（v24 情景策略） | 提纲→初稿→修订（最多 3 轮） | 写作流程固定：先提纲、再初稿、至少改一稿，最多 3 轮。 | Writing always outlines, drafts, then revises at least once, up to 3 rounds. | 只读（策略） |
| 17 | `defaultLocale` | 默认语言 | Default language | 下拉 / select | `ui.locale` · 主机配置（config.ts） | 跟随宿主 | 界面跟随 DSH 语言；这里只设 DSH 还没报语言时的兜底。 | The UI follows DSH's language; this only sets the fallback before DSH reports one. | 只读（主机） |
| 18 | `currentLocale` | 当前语言 | Current language | 只读 / read-only | 无（DSH `ctx.locale`） · DSH 运行时 | 中文（跟随 DSH） | 当前实际显示的语言；由 DSH 设置决定。 | The language actually shown; decided by DSH's own setting. | 只读 |
| 19 | `compact` | 紧凑模式 | Compact mode | 开关 / switch | localStorage `deepseek-coordination:compact`；默认取 `ui.compact` · 仅本机（客户端） | 开（跟随主机） | 下拉框更窄、行距更小，小屏能多放几个控件。 | Narrower dropdowns and tighter spacing so more controls fit on small screens. | 可编辑 |
| 20 | `refreshInterval` | 自动刷新间隔 | Auto-refresh interval | 下拉 / select | localStorage `deepseek-coordination:refresh`；默认取 `ui.refreshInterval` · 仅本机（客户端） | 5 秒 | 多久和主机同步一次选择状态；暂停后锁定状态可能过期。 | How often choices sync with the host; when paused, lock state can go stale. | 可编辑 |
| 21 | `cacheEnabled` | 缓存优化 | Cache optimization | 只读 / read-only | `cache.enabled` · 主机配置（config.ts） | 开 | 复用相同请求的结果，省时间省额度；关掉可能更慢。 | Reuses results for identical requests to save time and budget; off can be slower. | 只读（主机） |
| 22 | `webSearch` | 联网检索 | Web search | 只读 / read-only | `comprehension.searchEnabled` · 主机配置（config.ts） | 开 | 允许各档位联网；关掉后只能用手头资料。 | Lets every level search the web; off leaves only the material at hand. | 只读（主机） |
| 23 | `groundTruth` | 确定性验收 | Deterministic checks | 只读 / read-only | `orchestration.groundTruth` · 主机配置（config.ts） | 开 | 能用命令或文件核对时，不靠模型自己说做完了。 | When a command or file can prove it, the model's own word does not count as done. | 只读（主机） |
| 24 | `modelRouting` | 模型分流 | Model routing | 只读 / read-only | `orchestration.modelRouting` · 主机配置（config.ts） | 开 | 允许按子任务难度换模型；关掉统一用当前模型。 | Lets subtasks switch models by difficulty; off keeps the current model throughout. | 只读（主机） |

**逐项说明（实现者必读）：**

- **可编辑的 5 项：** `takeoverPermission`、`composerWorkflow`、`composerTooltips`、`compact`、`refreshInterval`。它们只写 `localStorage`；其中 `composerTooltips`、`compact`、`refreshInterval` 在用户从未改过时，分别取主机配置 `ui.showTooltip`、`ui.compact`、`ui.refreshInterval` 作为默认值。**默认值来自主机，但开关的持久化在本机**——不要声称“修改了主机配置”。
- **强制的 3 项：** `professionLock`、`professionRebuild`、`professionAbandon`。前者的 `profession.lock` 已由 `resolveConfig` 强制为 `true`；后两者对应的 `rebuildCanReselect` / `abandonCanReselect` 目前**没有被强制、也没有被任何模块读取**，必须在 `resolveConfig` 里一并强制为 `true`，否则设置页写“强制”就是撒谎。
- **主机只读的 13 项：** `takeoverDialogs`、`professionDefault`、`professionAudit`、`professionErrorHint`、`defaultScene`、`defaultValidation`、`defaultInteraction`、`writingFlow`、`defaultLocale`、`cacheEnabled`、`webSearch`、`groundTruth`、`modelRouting`。它们来自 `config.ts`；本页只展示，不提供写入入口。
- **派生 / 运行时的 3 项：** `takeoverControl`（由权限接管开关派生）、`permissionCatalog`（DSH 目录）、`currentLocale`（DSH `ctx.locale`）。不持久化，刷新即重算。
- **重复键警告：** `profession.default` 与 `defaults.profession` 同时存在，但 `SelectionModule.get()` 只读 `defaults.profession`。设置页写“默认职能”时，config key 只能标 `defaults.profession`；`profession.default` 应删除或改为别名，**不要**在页面里展示一个不生效的键。

### 3.3 分组说明、组助记与“为什么锁”

| 分组 | 一句话说明 | 组内助记（常驻显示） |
|---|---|---|
| 权限与接管 / Permission & takeover | 这个会话能改什么，以及权限控件由谁提供。 | 权限选项来自 DSH；本插件只展示并写回，不另存一份。 |
| 工作流与下拉框 / Workflow & selectors | 输入框里显示哪些选择器，要不要提示。 | 关掉工作流只会隐藏下拉框，不会改变已保存的选择。 |
| 职能与审计 / Profession & audit | 一个任务只有一个职能：怎么锁、怎么留痕。 | 锁只在任务内生效；换任务时可以换职能。 |
| 情景与验证默认 / Scene & validation defaults | 新任务默认怎么做、查多少资料。 | 验证三档都联网：低 1×3 当轮 / 中 2×5 会话 / 高 4×8 本地全部。 |
| 语言与显示 / Language & display | 界面语言、刷新快慢和疏密。 | 语言跟随 DSH；这里不提供强制切换。 |
| 高级 / Advanced | 主机级开关，影响所有会话；通常保持默认。 | 这些值来自主机配置，在本页只读。 |

**“为什么锁”（放在“职能与审计”组底部，常驻，≤2 句）：**

> 一个任务只有一个职能，出事时才能找到唯一责任人：干活的不能自己验收，验收的不能自己改口。锁定只在任务内有效，换任务随时可以换。

> One duty per task means one accountable owner: whoever does the work cannot sign it off, and whoever signs off cannot quietly change it. The lock lasts only for the task; a new task can choose another duty.

**写法约束：** 这段只能有两句。第一句讲原因（唯一责任人 + 执行/验收分离），第二句讲边界（只在任务内，换任务可换）。不要在这段里提 `Turn`、`rebuild`、`abandon` 或数据库触发器；出口在 `锁定错误提示` 行和错误文案里已经写了。

### 3.4 空 / 离线 / 主机拒绝状态

| 状态 | 触发 | 页面显示 | 可操作 | 文案 key |
|---|---|---|---|---|
| offline | 请求失败 / 3 秒超时 | 主机未连接，以下为本地设置。 | 本机开关可改；主机行不可改 | `settings.states.offline` |
| loading | 首次渲染或刷新中 | 正在读取主机设置… | 无 | `settings.states.loading` |
| empty | 主机已连接但还没有任务 | 还没有任务；下面显示的是默认值。 | 主机行只读，显示默认值 | `settings.states.empty` |
| hostRejected | 选择写入被主机拒绝 | 主机拒绝了这次修改，已保持原值。 | 保持原值；原因只进详情与日志 | `settings.states.hostRejected` |
| noCatalog | DSH 返回的权限预设为空 | DSH 没有提供权限预设，只能查看说明。 | 权限下拉禁用 | `settings.states.noCatalog` |
| unknownLocale | 宿主语言不是 zh / en | 宿主语言无法识别，先按中文显示。 | 无（自动回退中文） | `settings.states.unknownLocale` |
| readOnlyHost | 查看主机配置行 | 主机配置，只能查看；需要部署者修改。 | 只读 | `settings.states.readOnlyHost` |
| settingsLocked | 本会话有进行中的任务 | 本会话有任务在跑，职能已锁定。 | 职能只读；其它选择可改 | `settings.states.settingsLocked` |
| storageBlocked | localStorage 抛错 | 浏览器禁用了本地存储，这次改动只在当前页面有效。 | 本次改动只在当前页生效 | `settings.states.storageBlocked` |

**状态规则：**

1. **不显示假值。** 主机未连接时，主机配置行显示 `—` + `连接后显示`，不要回退成硬编码默认值假装读到了。
2. **本机开关仍然可用。** 离线时 `权限接管`、`工作流下拉框`、`显示提示`、`紧凑模式`、`自动刷新间隔` 照常工作，因为它们只写本机；页脚要说明“以下为本地设置”。
3. **主机拒绝写在本行下面，不用全局 toast。** `role="alert"`，保留 6 秒并可被屏幕阅读器读到；值保持原样，不乐观更新后不回滚。
4. **空状态不是空白。** 没有任务时显示默认值 + `默认` chip，并说明“新任务会用这些值”，让人知道现在看到的是什么。
5. **本地存储被禁用时明说。** `localStorage` 抛错不是静默失败：提示“这次改动只在当前页面有效”，开关仍在内存里生效。
6. **DSH 没有权限目录时，权限下拉禁用而不是消失。** 行内说明“只能查看说明”，避免用户以为插件坏了。

### 3.5 页面线框图（顺序与视觉层级）

```text
┌─ 设置 › 协调 ──────────────────────────────────────────────────────┐
│ 协调 / Coordination                              [● 主机已连接]     │
│ 为下一个任务设默认值；界面开关立即生效。                            │
│                                                                    │
│ 权限与接管                                                          │
│ 这个会话能改什么，以及权限控件由谁提供。                            │
│   接管权限控件      宿主访问模式按钮 · 只读              [ ? ]      │
│   权限接管          [ ● ]                                           │
│     隐藏 DSH 的访问模式按钮，改用输入框里的协调权限下拉。            │
│   接管宿主弹窗      关 · 主机配置 · 只读                  [ ? ]      │
│   权限预设来源      DSH 目录 · 只读                       [ ? ]      │
│ 权限选项来自 DSH；本插件只展示并写回。                              │
│ ─────────────────────────────────────────────────────────────────  │
│ 工作流与下拉框                                                      │
│ 输入框里显示哪些选择器，要不要提示。                                │
│   工作流下拉框      [ ● ]                                           │
│     显示职能、交互、情景、验证四个下拉框；关掉只是隐藏。            │
│   显示提示          [ ● ]                                           │
│     鼠标悬停或键盘聚焦时显示说明；关掉不影响功能。                  │
│ 关掉工作流只会隐藏下拉框，不会改变已保存的选择。                    │
│ ─────────────────────────────────────────────────────────────────  │
│ 职能与审计                                                          │
│ 一个任务只有一个职能：怎么锁、怎么留痕。                            │
│   职能锁定          [ ● ] 强制                            [ ? ]      │
│     强制开启：一个任务只能有一个职能，中途不能换。                  │
│   默认职能          执行 ▾ · 只读                         [ ? ]      │
│   重建后可重选      [ ● ] 强制                                      │
│   丢弃后可重选      [ ● ] 强制                                      │
│   职能审计          [ ● ] 只读（主机）                              │
│   锁定错误提示      [ ● ] 只读（主机）                              │
│   为什么锁：一个任务只有一个职能，出事时才能找到唯一责任人……        │
│ ─────────────────────────────────────────────────────────────────  │
│ 情景与验证默认                                                      │
│ 新任务默认怎么做、查多少资料。                                      │
│   默认情景          对话 ▾ · 只读                                   │
│   默认验证          中 ▾ · 只读                                     │
│   默认交互          思维 ▾ · 只读                                   │
│   写作流程          提纲→初稿→修订（最多 3 轮）· 只读               │
│ 验证三档都联网：低 1×3 当轮 / 中 2×5 会话 / 高 4×8 本地全部。      │
│ ─────────────────────────────────────────────────────────────────  │
│ 语言与显示                                                          │
│ 界面语言、刷新快慢和疏密。                                          │
│   当前语言          中文（跟随 DSH）· 只读                          │
│   默认语言          跟随宿主 ▾ · 只读                               │
│   紧凑模式          [ ● ]                                           │
│   自动刷新间隔      5 秒 ▾                                          │
│ 语言跟随 DSH；这里不提供强制切换。                                  │
│ ─────────────────────────────────────────────────────────────────  │
│ 高级                                                                │
│ 部署级开关，影响所有会话；通常保持默认。                            │
│   缓存优化          [ ● ] 只读（主机）                              │
│   联网检索          [ ● ] 只读（主机）                              │
│   确定性验收        [ ● ] 只读（主机）                              │
│   模型分流          [ ● ] 只读（主机）                              │
│ 这些值来自主机配置，在本页只读。                                    │
│ ─────────────────────────────────────────────────────────────────  │
│ 只读项来自主机配置；本页不写入主机。开关立即生效，没有保存按钮。    │
└────────────────────────────────────────────────────────────────────┘
图例： ▾ 下拉   [ ● ] 开关   [ ? ] 常驻说明按钮（触摸设备的主要入口）
```

**视觉层级：** 页面标题 > 组标题 > 行标签 > 行说明 > 状态 chip > 组助记。只读行用值 + chip，不画开关；强制行画“开”的开关但禁用，并在右侧写 `强制`，让人一眼看出“不是坏了，是不让关”。

### 3.6 不要添加的设置（会撒谎或存不住）

| 不要加 | 为什么 |
|---|---|
| 关闭“职能锁定”的开关 | 插件核心安全约束；`resolveConfig` 强制 `true`。给一个关不掉的开关等于骗人。 |
| 第二个“接管权限控件”开关 | 它是“权限接管”的派生状态，不是独立设置；两个开关写同一状态必然不同步。 |
| 给职能/交互/情景/验证各做一个显示开关 | 与“工作流下拉框”重复，组合爆炸；要隐藏就整组隐藏。 |
| “强制中文 / 强制英文”语言覆盖 | §22 规定语言权威是 DSH `ctx.locale`；本插件不自建语言选择器。`ui.locale` 只是宿主未上报时的兜底。 |
| 客户端可写的“接管宿主弹窗 / 缓存优化 / 联网检索” | 这些是主机配置，客户端没有写入路由；做成开关只会改本地状态，刷新即失效。 |
| 每个会话单独的默认值编辑 | 设置页是全局的；会话级选择在输入框里改，不要在这里再造一份。 |
| 主题 / 字体 / 强调色 | 没有对应 config key；`theme.ts` 是固定主题，加开关会变成只改自己那一半。 |
| “实时刷新（0 秒）” | 轮询会打爆主机；最小 2 秒，暂停时明确提示“锁定状态可能过期”。 |
| “关闭检索”的验证档 | 与 §6.3 冲突：三档都联网，`comprehension.searchEnabled` 才是总开关（高级组只读）。 |
| “无职能 / 自动职能”选项 | `turn.profession` 是 NOT NULL；没有“无职能”这种合法状态。 |
| 关闭“职能审计” | 审计是安全记录；即使 `profession.audit` 存在，也不在本页暴露成开关（当前实现也从未读取该键）。 |
| “重置全部设置”按钮 | 客户端没有写主机的路由；重置只能清 localStorage，却会让人以为主机配置也回去了。 |

---

## 4. COPY RULES

### 4.1 中英配对与标点

- **每个 key 必须有 zh-CN 与 en-US 两条**；缺一条即失败，不允许“英文稍后补”。
- **中文：** 全角标点（，。；：）；中英文之间留半角空格（“DSH 的”“1 次”“3 轮”）；不用感叹号；tooltip 以“。”结尾；标签、chip、按钮不带句号。
- **英文：** 半角标点；句首大写；tooltip 以“.”结尾；标签用 Title case（`Default scene`），句子用 Sentence case；不缩写成 `&`。
- **数字与符号：** 预算用 `×`（不是 `x`）；写作流程的“→”只出现在“写作流程”这一行的值里，不写进 tooltip；范围用 `–` 或“到”，不混用。
- **引号：** 中文用「」或“”；英文用 `"`；同一句不混用两套引号。
- **占位符：** 只用 `{name}` 形式的命名占位符；不拼接半句翻译；zh 与 en 的占位符集合必须完全一致。

### 4.2 禁用词与替换（lint 会扫）

**禁用词（操作者界面，含 tooltip、设置说明、状态、错误）：**

```text
问责轴 问责维度 贝叶斯 先验 后验 检索预算 证据范围 MCP Provider Token
Turn Session Thread Plan Trace 哈希链 编排 派发 沙箱 fail-closed 幂等 快照
治理轨迹 能力资格 赋能 闭环 抓手 打通 极致 无缝 智能 强大
```

**允许出现：** `DSH`、`low`、`medium`、`high`、`工作区`、`审批`、`模型`、`任务`、`会话`、`子任务`（首次出现时用“拆出来的小任务”解释）。

**例外：** 模型可见的 `tools.*` 文案不受本表约束（见 §5.12）；日志与错误码不受约束。

### 4.3 模板与占位符

| 占位符 | 含义 | 出现位置 |
|---|---|---|
| `{control}` | 控件标签（职能/交互/情景/验证/权限） | `composer.controlTitle`、`composer.controlAria` |
| `{current}` | 当前选项标签 | 同上 |
| `{currentLabel}` | “当前 / Current” | 同上 |
| `{profession}` | 锁定的职能标签 | `composer.lockedLine` |
| `{name}` | DSH 权限预设名 | `composer.permissionCatalogEntry` |
| `{consequence}` | 该预设对应的后果句 | 同上 |
| `{approval}` | DSH 审批策略原文 | `composer.approvalPolicy` |
| `{message}` | 校验失败详情（仅调试可见） | 不在操作者文案里直接展示 |

**规则：** 模板只做一次替换；不嵌套模板；占位符缺失时保留原样（fail loud），不要静默变成空字符串。

### 4.4 数字、单位与量词

- 检索预算：`1 次 × 3 条`、`2 次 × 5 条`、`4 次 × 8 条`；不写 `1x3`、`1*3`。
- 轮次：`最多 3 轮`；不写 `≤3`。
- 时间：`5 秒`、`2 秒`、`10 秒`；不写 `5000ms`。
- 人数/个数：`几个人`、`多个代理`；不用“若干”。
- 百分比、分数、评分阈值不进操作者文案。

### 4.5 错误文案

- **结构：** 发生了什么 + 现在怎么办。最多两句。
- **不出现：** 错误码（`PROFESSION_LOCKED` 等）、堆栈、模块名、数据库表名。
- **不指责用户：** 用“这个选项无效”，不用“你选错了”。
- **保留用户数据：** 明确说“已恢复原选择 / 已保持原值”，让人知道没有丢东西。
- **可执行：** 能给的出口必须给（重建、丢弃、检查配置、稍后重试）；给不了出口就说明“只能查看”。

### 4.6 长度与一致性 lint（实现建议）

新增 `test/i18n.test.ts`，对 `COPY_BY_LOCALE` 做静态检查：

1. **键配对：** 递归比较 `zh-CN` 与 `en-US` 的路径集合，必须完全相等；缺键/多键都失败。
2. **长度：** 按 key 前缀套用预算：`controls.*.hint` 90/160；`*.hint`（选项）70/120；`settings.fields.*.hint` 70/120；`settings.groups.*` 70/120；`errors.*` 70/120；`settings.whyLock` 200/320。
3. **禁用词：** 对操作者 key 扫 §4.2 的词表；命中即失败。例外：`tools.*`。
4. **占位符：** 同一 key 的 zh/en 提取 `{...}` 集合，必须相等。
5. **空值：** 不允许空字符串或纯空格。
6. **顺序：** 断言 `SceneValues` 等于 `['dialogue','writing','office','research','engineering','iterate']`，防止写作被排到办公后面。
7. **真实性：** 断言 `validations.*.hint` 都含“联网”，且 `composer.validationNote` 同时含 `1×3`、`2×5`、`4×8`——防止再次出现“low 不做推断”。

---

## 5. I18N STRINGS（逐字复制）

### 5.1 结构与命名

- 顶层沿用现有 `Copy` 结构：`controls`、`professions`、`interactions`、`scenes`、`validations`、`permissions`、`composer`、`settings`、`errors`、`tools`。
- 键名：`<area>.<entity>.<field>`，camelCase；选项键**必须用规范值**（`decision`、`writing`、`low`…），不用中文。
- 中文是参考语言；英文逐键对应，不合并、不省略。
- `settings.fields.<id>` 的 `<id>` 与 §3.2 的 id 一致；不要另起别名。
- 删除 `settings.professionGroup` 整个子树（被 `settings.fields.*` 取代）；删除 `composer.professionLockedRebuild`（与 `professionLocked` 重复）。
- 数据层仍存英文规范值；本文只改展示层。

### 5.2 controls（5 个控件 × label/hint）

| key | zh-CN | en-US | 长度 |
|---|---|---|---|
| `controls.profession.label` | 职能 | Profession | zh 2/10 · en 10/20 ✅ |
| `controls.profession.hint` | 定这个任务由谁负哪一份责；选定后任务内不能改，要换只能重建或丢弃任务。 | Sets which single duty this task is accountable for. It cannot change mid-task; rebuild or abandon to choose again. | zh 35/90 · en 115/160 ✅ |
| `controls.interaction.label` | 交互 | Interaction | zh 2/10 · en 11/20 ✅ |
| `controls.interaction.hint` | 定它怎么回应你：陪你聊、深入想、找可行方向、排掉失败方向，或拆给多个代理。 | Sets how it responds: listen, reason deeply, find what works, rule out what fails, or split work across agents. | zh 37/90 · en 111/160 ✅ |
| `controls.scene.label` | 情景 | Scene | zh 2/10 · en 5/20 ✅ |
| `controls.scene.hint` | 定这次用哪种工作方式；会改变流程、查资料的方式，以及能不能改文件。 | Sets the working mode; it changes the process, how evidence is gathered, and whether files can be changed. | zh 33/90 · en 106/160 ✅ |
| `controls.validation.label` | 验证 | Validation | zh 2/10 · en 10/20 ✅ |
| `controls.validation.hint` | 定查多少资料、看多远的历史；三档都会联网，只差检索量和证据范围。 | Sets how much evidence is gathered and how far back it looks; all three levels search the web, and only the volume and scope differ. | zh 32/90 · en 132/160 ✅ |
| `controls.permission.label` | 权限 | Permission | zh 2/10 · en 10/20 ✅ |
| `controls.permission.hint` | 定这个会话能改什么；切换立刻生效，可能影响正在跑的任务。 | Sets what this session may change; the switch applies immediately and can affect a running task. | zh 28/90 · en 96/160 ✅ |

### 5.3 professions（6 × label/hint）

| key | zh-CN | en-US | 长度 |
|---|---|---|---|
| `professions.decision.label` | 决策 | Decision | zh 2/10 · en 8/20 ✅ |
| `professions.decision.hint` | 决定做不做、方案过不过；能叫停，也能放行。任务内锁定。 | Decides whether to proceed and whether the plan passes; can stop or approve. Locked for the task. | zh 27/70 · en 97/120 ✅ |
| `professions.outcome.label` | 成果 | Outcome | zh 2/10 · en 7/20 ✅ |
| `professions.outcome.hint` | 对最后交付的东西负责：达不达标由它签字。任务内锁定。 | Owns the final deliverable and signs off on whether it meets the goal. Locked for the task. | zh 26/70 · en 91/120 ✅ |
| `professions.resource.label` | 资源 | Resource | zh 2/10 · en 8/20 ✅ |
| `professions.resource.hint` | 管额度和花费：用多少模型、搜索和缓存。任务内锁定。 | Owns budget and cost: how much model, search, and cache the task uses. Locked for the task. | zh 25/70 · en 91/120 ✅ |
| `professions.personnel.label` | 人员 | Personnel | zh 2/10 · en 9/20 ✅ |
| `professions.personnel.hint` | 管分工：谁来做、几个人、合不合规。任务内锁定。 | Owns staffing: who does the work, how many, and whether that is allowed. Locked for the task. | zh 23/70 · en 93/120 ✅ |
| `professions.qualification.label` | 任职 | Qualification | zh 2/10 · en 13/20 ✅ |
| `professions.qualification.hint` | 只检查模型能不能胜任，不参与干活。任务内锁定。 | Checks whether a model is qualified, without doing the work. Locked for the task. | zh 23/70 · en 81/120 ✅ |
| `professions.execution.label` | 执行 | Execution | zh 2/10 · en 9/20 ✅ |
| `professions.execution.hint` | 按给定条件把活做完，不验收自己的成果。任务内锁定。 | Completes the work under the given conditions and does not verify itself. Locked for the task. | zh 25/70 · en 94/120 ✅ |

### 5.4 interactions（5 × label/hint）

| key | zh-CN | en-US | 长度 |
|---|---|---|---|
| `interactions.emotion.label` | 感情 | Emotion | zh 2/10 · en 7/20 ✅ |
| `interactions.emotion.hint` | 先接住情绪：听你说、理解感受，不急着给方案。 | Listens first: acknowledges feelings before offering solutions. | zh 22/70 · en 63/120 ✅ |
| `interactions.think.label` | 思维 | Think | zh 2/10 · en 5/20 ✅ |
| `interactions.think.hint` | 把推理摊开，给深度分析和答案。 | Lays out the reasoning and gives a deep analysis and answer. | zh 15/70 · en 60/120 ✅ |
| `interactions.heuristic.label` | 启发 | Heuristic | zh 2/10 · en 9/20 ✅ |
| `interactions.heuristic.hint` | 先找走得通的路，按成功经验排序，给最值得试的方向。 | Finds routes that work, ranked by past successes, and names the best direction to try. | zh 25/70 · en 86/120 ✅ |
| `interactions.converge.label` | 收束 | Converge | zh 2/10 · en 8/20 ✅ |
| `interactions.converge.hint` | 先排除走不通的路，说清边界、失败原因和止损点。 | Rules out routes that fail, with the boundary, the cause, and the point to stop. | zh 23/70 · en 80/120 ✅ |
| `interactions.orchestrate.label` | 统筹 | Orchestrate | zh 2/10 · en 11/20 ✅ |
| `interactions.orchestrate.hint` | 拆成子任务分给多个代理，独立验收后汇总；更慢更贵，简单对话不必用。 | Splits work into subtasks, verifies each independently, then synthesises. Slower and costlier; not for simple chat. | zh 33/70 · en 115/120 ✅ |

### 5.5 scenes（6 × label/hint，写作在对话与办公之间）

| key | zh-CN | en-US | 长度 |
|---|---|---|---|
| `scenes.dialogue.label` | 对话 | Dialogue | zh 2/10 · en 8/20 ✅ |
| `scenes.dialogue.hint` | 闲聊和简单问答；快，但不够深入。 | Small talk and quick Q&A; fast but shallow. | zh 16/70 · en 43/120 ✅ |
| `scenes.writing.label` | 写作 | Writing | zh 2/10 · en 7/20 ✅ |
| `scenes.writing.hint` | 文章、文案、报告、邮件；先列提纲再写，至少改一稿，最多 3 轮。要来回沟通。 | Articles, copy, reports, email; outline first, then at least one revision (max 3 rounds). Needs back-and-forth. | zh 38/70 · en 111/120 ✅ |
| `scenes.office.label` | 办公 | Office | zh 2/10 · en 6/20 ✅ |
| `scenes.office.hint` | 整理文件、生成报告；只在工作区内操作。 | Organises files and generates reports; limited to the workspace. | zh 19/70 · en 64/120 ✅ |
| `scenes.research.label` | 研究 | Research | zh 2/10 · en 8/20 ✅ |
| `scenes.research.hint` | 查资料、给证据和引用；慢，但结论有出处。 | Searches sources and cites evidence; slow, but conclusions are traceable. | zh 20/70 · en 73/120 ✅ |
| `scenes.engineering.label` | 工程 | Engineering | zh 2/10 · en 11/20 ✅ |
| `scenes.engineering.hint` | 写代码、构建、调试；能跑命令，改动不出工作区。 | Writes code, builds, and debugs; can run commands, with changes confined to the workspace. | zh 23/70 · en 90/120 ✅ |
| `scenes.iterate.label` | 迭代 | Iterate | zh 2/10 · en 7/20 ✅ |
| `scenes.iterate.hint` | 先写、再批、再改，循环打磨；质量高，调用次数多。 | Draft, critique, revise in a loop; high quality, more model calls. | zh 24/70 · en 66/120 ✅ |

### 5.6 validations（3 × label/hint/budget/scope）

| key | zh-CN | en-US | 长度 |
|---|---|---|---|
| `validations.low.label` | 低 | Low | zh 1/10 · en 3/20 ✅ |
| `validations.low.hint` | 也联网：1 次 × 3 条，只看这一轮，不翻旧会话。 | Also searches: 1 query × 3 results, this turn only; no older sessions. | zh 26/70 · en 70/120 ✅ |
| `validations.low.budget` | 1×3 | 1×3 | zh 3/10 · en 3/10 ✅ |
| `validations.low.scope` | 当轮 | this turn | zh 2/10 · en 9/20 ✅ |
| `validations.medium.label` | 中 | Medium | zh 1/10 · en 6/20 ✅ |
| `validations.medium.hint` | 也联网：2 次 × 5 条，看当前会话全部内容，不翻旧会话。 | Also searches: 2 queries × 5 results across this whole session; no older sessions. | zh 30/70 · en 82/120 ✅ |
| `validations.medium.budget` | 2×5 | 2×5 | zh 3/10 · en 3/10 ✅ |
| `validations.medium.scope` | 当前会话 | this session | zh 4/10 · en 12/20 ✅ |
| `validations.high.label` | 高 | High | zh 1/10 · en 4/20 ✅ |
| `validations.high.hint` | 也联网：4 次 × 8 条，加上全部本地会话和工作区文件，最全也最慢。 | Also searches: 4 queries × 8 results plus all local sessions and workspace files; the most complete and slowest. | zh 35/70 · en 112/120 ✅ |
| `validations.high.budget` | 4×8 | 4×8 | zh 3/10 · en 3/10 ✅ |
| `validations.high.scope` | 本地全部 | all local content | zh 4/10 · en 17/20 ✅ |

### 5.7 permissions（3 个兜底档位 × label/hint）

| key | zh-CN | en-US | 长度 |
|---|---|---|---|
| `permissions.read-only.label` | 仅可查看 | Read-only | zh 4/10 · en 9/20 ✅ |
| `permissions.read-only.hint` | 只能看：不改文件，也不跑会改东西的命令。 | View only: no file changes and no commands that change anything. | zh 20/70 · en 64/120 ✅ |
| `permissions.workspace-write.label` | 工作区内修改 | Workspace write | zh 6/10 · en 15/20 ✅ |
| `permissions.workspace-write.hint` | 能改工作区里的文件；改工作区外会被拒绝。 | Can change files inside the workspace; writes outside it are refused. | zh 20/70 · en 69/120 ✅ |
| `permissions.danger-full-access.label` | 完全权限 | Full access | zh 4/10 · en 11/20 ✅ |
| `permissions.danger-full-access.hint` | 能改任何路径，不受工作区限制；风险最高，慎用。 | Can change any path, outside the workspace too; highest risk, use with care. | zh 23/70 · en 76/120 ✅ |

### 5.8 composer（模板、状态、拒绝、权限目录）

| key | zh-CN | en-US | 长度 |
|---|---|---|---|
| `composer.controlTitle` | {control} · {currentLabel}：{current} | {control} · {currentLabel}: {current} | zh 36/70 · en 37/120 ✅ |
| `composer.controlAria` | {control}，{currentLabel}：{current} | {control}, {currentLabel}: {current} | zh 34/70 · en 36/120 ✅ |
| `composer.lockedSuffix` | （已锁定） |  (locked) | zh 5/70 · en 9/120 ✅ |
| `composer.currentLabel` | 当前 | Current | zh 2/10 · en 7/20 ✅ |
| `composer.lockedLine` | 任务已开始，职能锁定；完成或新建任务后可改。 | Task started: profession locked. Finish it or start a new task to change it. | zh 22/70 · en 76/120 ✅ |
| `composer.unlockedLine` | 现在可以选；任务一开始就锁定。 | You can choose now; it locks when the task starts. | zh 15/70 · en 50/120 ✅ |
| `composer.lockedAria` | 已锁定 | locked | zh 3/70 · en 6/120 ✅ |
| `composer.offlineLine` | 主机未连接；这里的选择只存本机，不影响任务。 | Host unreachable; choices here are saved on this device only and do not affect the task. | zh 22/70 · en 88/120 ✅ |
| `composer.localOnly` | 只存本机 | saved on this device only | zh 4/70 · en 25/120 ✅ |
| `composer.professionLocked` | 职能已锁定，改动没有生效；重建或丢弃任务后可改。 | Profession is locked, so the change was not applied. Rebuild or abandon the task to choose again. | zh 24/70 · en 97/120 ✅ |
| `composer.invalidSelection` | 这个选项无效，已恢复原选择。 | That option is not valid; the previous choice was restored. | zh 14/70 · en 59/120 ✅ |
| `composer.requestFailed` | 主机拒绝了这次修改，已恢复原选择。 | The host rejected the change; the previous choice was restored. | zh 17/70 · en 63/120 ✅ |
| `composer.validationNote` | 三档都联网：低 1×3 当轮 / 中 2×5 当前会话 / 高 4×8 本地全部。 | All three levels search: low 1×3 this turn / medium 2×5 this session / high 4×8 all local content. | zh 41/70 · en 98/120 ✅ |
| `composer.permissionCatalogEntry` | {name}：{consequence} | {name}: {consequence} | zh 20/70 · en 21/120 ✅ |
| `composer.permissionCatalogMissing` | DSH 没有提供权限预设，这里只显示说明，不能切换。 | DSH exposes no permission presets; this is informational and cannot be switched. | zh 26/70 · en 80/120 ✅ |
| `composer.permissionCustomPreset` | 自定义权限预设，DSH 目录里没有；切换前先确认影响。 | A custom permission preset not in DSH's catalog; check the impact before switching. | zh 27/70 · en 83/120 ✅ |
| `composer.approvalPolicy` | 审批方式：{approval} | Approval: {approval} | zh 15/70 · en 20/120 ✅ |
| `composer.permissionPresetDefault` | 权限档位由 DSH 的权限预设定义。 | The permission tier is defined by DSH permission presets. | zh 18/70 · en 57/120 ✅ |
| `composer.permissionWriteNow` | 切换会立刻写进本会话的 DSH 权限。 | Switching applies the DSH permission to this session immediately. | zh 19/70 · en 65/120 ✅ |
| `composer.permissionOffline` | 主机未连接，权限不能切换。 | Host unreachable; the permission cannot be switched. | zh 13/70 · en 52/120 ✅ |
| `composer.permissionRejected` | DSH 没有接受这个权限预设，已保持原样。 | DSH did not accept that permission preset; the previous one stays in force. | zh 21/70 · en 75/120 ✅ |

### 5.9 settings

#### 5.9.1 settings 元信息

| key | zh-CN | en-US | 长度 |
|---|---|---|---|
| `settings.title` | 协调 | Coordination | zh 2/10 · en 12/20 ✅ |
| `settings.intro` | 为下一个任务设默认值；界面开关立即生效。 | Defaults for the next task; display switches apply immediately. | zh 20/70 · en 63/120 ✅ |
| `settings.applyNote` | 开关立即生效，没有保存按钮。 | Switches apply immediately; there is no save button. | zh 14/70 · en 52/120 ✅ |
| `settings.whyLock` | 一个任务只有一个职能，出事时才能找到唯一责任人：干活的不能自己验收，验收的不能自己改口。锁定只在任务内有效，换任务随时可以换。 | One duty per task means one accountable owner: whoever does the work cannot sign it off, and whoever signs off cannot quietly change it. The lock lasts only for the task; a new task can choose another duty. | zh 63/200 · en 206/320 ✅ |
| `settings.footer` | 只读项来自主机配置；本页不写入主机。下拉框提示与设置说明使用同一份文案。 | Read-only items come from host config; this page never writes to the host. Tooltips and hints share one source. | zh 36/70 · en 111/160 ✅ |

#### 5.9.2 settings.groups（6 组 × title/desc/helper）

| key | zh-CN | en-US | 长度 |
|---|---|---|---|
| `settings.groups.permission.title` | 权限与接管 | Permission & takeover | zh 5/12 · en 21/30 ✅ |
| `settings.groups.permission.desc` | 这个会话能改什么，以及权限控件由谁提供。 | What this session may change, and who provides the permission control. | zh 20/70 · en 70/120 ✅ |
| `settings.groups.permission.helper` | 权限选项来自 DSH；本插件只展示并写回，不另存一份。 | Permission options come from DSH; this plugin only displays and writes back the chosen one. | zh 27/70 · en 91/120 ✅ |
| `settings.groups.composer.title` | 工作流与下拉框 | Workflow & selectors | zh 7/12 · en 20/30 ✅ |
| `settings.groups.composer.desc` | 输入框里显示哪些选择器，要不要提示。 | Which selectors appear in the composer, and whether hints show. | zh 18/70 · en 63/120 ✅ |
| `settings.groups.composer.helper` | 关掉工作流只会隐藏下拉框，不会改变已保存的选择。 | Turning workflow off only hides the selectors; saved choices are unchanged. | zh 24/70 · en 75/120 ✅ |
| `settings.groups.profession.title` | 职能与审计 | Profession & audit | zh 5/12 · en 18/30 ✅ |
| `settings.groups.profession.desc` | 一个任务只有一个职能：怎么锁、怎么留痕。 | One duty per task: how it locks and how it is recorded. | zh 20/70 · en 55/120 ✅ |
| `settings.groups.profession.helper` | 锁只在任务内生效；换任务时可以换职能。 | The lock lasts only for the task; a new task can choose another profession. | zh 19/70 · en 75/120 ✅ |
| `settings.groups.scene.title` | 情景与验证默认 | Scene & validation defaults | zh 7/12 · en 27/30 ✅ |
| `settings.groups.scene.desc` | 新任务默认怎么做、查多少资料。 | How new tasks work and how much evidence they gather by default. | zh 15/70 · en 64/120 ✅ |
| `settings.groups.scene.helper` | 验证三档都联网：低 1×3 当轮 / 中 2×5 会话 / 高 4×8 本地全部。 | All validation levels search: low 1×3 this turn / medium 2×5 the session / high 4×8 all local content. | zh 41/70 · en 102/120 ✅ |
| `settings.groups.language.title` | 语言与显示 | Language & display | zh 5/12 · en 18/30 ✅ |
| `settings.groups.language.desc` | 界面语言、刷新快慢和疏密。 | Interface language, refresh rate, and density. | zh 13/70 · en 46/120 ✅ |
| `settings.groups.language.helper` | 语言跟随 DSH；这里不提供强制切换。 | Language follows DSH; there is no forced override here. | zh 19/70 · en 55/120 ✅ |
| `settings.groups.advanced.title` | 高级 | Advanced | zh 2/12 · en 8/30 ✅ |
| `settings.groups.advanced.desc` | 主机级开关，影响所有会话；通常保持默认。 | Host-level switches that affect every session; usually keep the defaults. | zh 20/70 · en 73/120 ✅ |
| `settings.groups.advanced.helper` | 这些值来自主机配置，在本页只读。 | These values come from host config and are read-only here. | zh 16/70 · en 58/120 ✅ |

#### 5.9.3 settings.fields（24 项 × label/hint）

| key | zh-CN | en-US | 长度 |
|---|---|---|---|
| `settings.fields.takeoverPermission.label` | 权限接管 | Permission takeover | zh 4/12 · en 19/32 ✅ |
| `settings.fields.takeoverPermission.hint` | 隐藏 DSH 的访问模式按钮，改用本插件的权限下拉。 | Hides DSH's access-mode button and uses this plugin's permission dropdown instead. | zh 26/70 · en 82/120 ✅ |
| `settings.fields.takeoverControl.label` | 接管权限控件 | Taken-over control | zh 6/12 · en 18/32 ✅ |
| `settings.fields.takeoverControl.hint` | 只替换输入框的权限控件；DSH 的弹窗不受影响。 | Replaces only the composer's permission control; DSH dialogs are unaffected. | zh 24/70 · en 76/120 ✅ |
| `settings.fields.takeoverDialogs.label` | 接管宿主弹窗 | Host dialog takeover | zh 6/12 · en 20/32 ✅ |
| `settings.fields.takeoverDialogs.hint` | 允许本插件接管 DSH 的审批、权限等弹窗；关掉就仍由 DSH 显示。 | Lets this plugin take over DSH approval and permission dialogs; off keeps DSH's own. | zh 35/70 · en 84/120 ✅ |
| `settings.fields.permissionCatalog.label` | 权限预设来源 | Permission preset source | zh 6/12 · en 24/32 ✅ |
| `settings.fields.permissionCatalog.hint` | 权限选项和审批方式由 DSH 提供；本插件不定义、不改写。 | Permission options and approval policy come from DSH; this plugin does not define or rewrite them. | zh 29/70 · en 98/120 ✅ |
| `settings.fields.composerWorkflow.label` | 工作流下拉框 | Composer selectors | zh 6/12 · en 18/32 ✅ |
| `settings.fields.composerWorkflow.hint` | 显示职能、交互、情景、验证四个下拉框；关掉只是隐藏，不改选择。 | Shows the profession, interaction, scene, and validation dropdowns; off only hides them. | zh 31/70 · en 88/120 ✅ |
| `settings.fields.composerTooltips.label` | 显示提示 | Show hints | zh 4/12 · en 10/32 ✅ |
| `settings.fields.composerTooltips.hint` | 鼠标悬停或键盘聚焦时显示说明；关掉不影响功能。 | Shows explanations on hover or keyboard focus; turning it off changes nothing else. | zh 23/70 · en 83/120 ✅ |
| `settings.fields.professionLock.label` | 职能锁定 | Profession lock | zh 4/12 · en 15/32 ✅ |
| `settings.fields.professionLock.hint` | 强制开启：一个任务只能有一个职能，中途不能换。 | Forced on: a task has exactly one profession and cannot switch mid-task. | zh 23/70 · en 72/120 ✅ |
| `settings.fields.professionDefault.label` | 默认职能 | Default profession | zh 4/12 · en 18/32 ✅ |
| `settings.fields.professionDefault.hint` | 新任务没选时用这个；任务一开始仍会锁定。 | Used when a new task has no choice; it still locks when the task starts. | zh 20/70 · en 72/120 ✅ |
| `settings.fields.professionRebuild.label` | 重建后可重选 | Reselect after rebuild | zh 6/12 · en 22/32 ✅ |
| `settings.fields.professionRebuild.hint` | 重建会新建任务，新任务可以重新选职能。 | A rebuild creates a new task, which may choose a new profession. | zh 19/70 · en 64/120 ✅ |
| `settings.fields.professionAbandon.label` | 丢弃后可重选 | Reselect after abandon | zh 6/12 · en 22/32 ✅ |
| `settings.fields.professionAbandon.hint` | 丢弃不新建任务；下一个任务可以重新选职能。 | Abandoning creates no new task; the next task may choose a new profession. | zh 21/70 · en 74/120 ✅ |
| `settings.fields.professionAudit.label` | 职能审计 | Profession audit | zh 4/12 · en 16/32 ✅ |
| `settings.fields.professionAudit.hint` | 每次锁定、重建、丢弃都留一条改不掉的记录。 | Every lock, rebuild, and abandon leaves a record that cannot be altered. | zh 21/70 · en 72/120 ✅ |
| `settings.fields.professionErrorHint.label` | 锁定错误提示 | Lock error hint | zh 6/12 · en 15/32 ✅ |
| `settings.fields.professionErrorHint.hint` | 改不动时，提示里直接说重建或丢弃该怎么做。 | When a change is refused, the message says how to rebuild or abandon. | zh 21/70 · en 69/120 ✅ |
| `settings.fields.defaultScene.label` | 默认情景 | Default scene | zh 4/12 · en 13/32 ✅ |
| `settings.fields.defaultScene.hint` | 新任务默认的工作方式；写作会先列提纲再改稿。 | The default working mode for new tasks; writing outlines first, then revises. | zh 22/70 · en 77/120 ✅ |
| `settings.fields.defaultValidation.label` | 默认验证 | Default validation | zh 4/12 · en 18/32 ✅ |
| `settings.fields.defaultValidation.hint` | 新任务默认查多少资料；三档都会联网检索。 | How much evidence new tasks gather by default; all three levels search the web. | zh 20/70 · en 79/120 ✅ |
| `settings.fields.defaultInteraction.label` | 默认交互 | Default interaction | zh 4/12 · en 19/32 ✅ |
| `settings.fields.defaultInteraction.hint` | 新任务默认怎么回应；选统筹会拆子任务。 | How new tasks respond by default; orchestrate splits them into subtasks. | zh 19/70 · en 72/120 ✅ |
| `settings.fields.writingFlow.label` | 写作流程 | Writing flow | zh 4/12 · en 12/32 ✅ |
| `settings.fields.writingFlow.hint` | 写作流程固定：先提纲、再初稿、至少改一稿，最多 3 轮。 | Writing always outlines, drafts, then revises at least once, up to 3 rounds. | zh 28/70 · en 76/120 ✅ |
| `settings.fields.defaultLocale.label` | 默认语言 | Default language | zh 4/12 · en 16/32 ✅ |
| `settings.fields.defaultLocale.hint` | 界面跟随 DSH 语言；这里只设 DSH 还没报语言时的兜底。 | The UI follows DSH's language; this only sets the fallback before DSH reports one. | zh 31/70 · en 82/120 ✅ |
| `settings.fields.currentLocale.label` | 当前语言 | Current language | zh 4/12 · en 16/32 ✅ |
| `settings.fields.currentLocale.hint` | 当前实际显示的语言；由 DSH 设置决定。 | The language actually shown; decided by DSH's own setting. | zh 21/70 · en 58/120 ✅ |
| `settings.fields.compact.label` | 紧凑模式 | Compact mode | zh 4/12 · en 12/32 ✅ |
| `settings.fields.compact.hint` | 下拉框更窄、行距更小，小屏能多放几个控件。 | Narrower dropdowns and tighter spacing so more controls fit on small screens. | zh 21/70 · en 77/120 ✅ |
| `settings.fields.refreshInterval.label` | 自动刷新间隔 | Auto-refresh interval | zh 6/12 · en 21/32 ✅ |
| `settings.fields.refreshInterval.hint` | 多久和主机同步一次选择状态；暂停后锁定状态可能过期。 | How often choices sync with the host; when paused, lock state can go stale. | zh 26/70 · en 75/120 ✅ |
| `settings.fields.cacheEnabled.label` | 缓存优化 | Cache optimization | zh 4/12 · en 18/32 ✅ |
| `settings.fields.cacheEnabled.hint` | 复用相同请求的结果，省时间省额度；关掉可能更慢。 | Reuses results for identical requests to save time and budget; off can be slower. | zh 24/70 · en 81/120 ✅ |
| `settings.fields.webSearch.label` | 联网检索 | Web search | zh 4/12 · en 10/32 ✅ |
| `settings.fields.webSearch.hint` | 允许各档位联网；关掉后只能用手头资料。 | Lets every level search the web; off leaves only the material at hand. | zh 19/70 · en 70/120 ✅ |
| `settings.fields.groundTruth.label` | 确定性验收 | Deterministic checks | zh 5/12 · en 20/32 ✅ |
| `settings.fields.groundTruth.hint` | 能用命令或文件核对时，不靠模型自己说做完了。 | When a command or file can prove it, the model's own word does not count as done. | zh 22/70 · en 81/120 ✅ |
| `settings.fields.modelRouting.label` | 模型分流 | Model routing | zh 4/12 · en 13/32 ✅ |
| `settings.fields.modelRouting.hint` | 允许按子任务难度换模型；关掉统一用当前模型。 | Lets subtasks switch models by difficulty; off keeps the current model throughout. | zh 22/70 · en 82/120 ✅ |

#### 5.9.4 settings.values（状态与选项值）

| key | zh-CN | en-US | 长度 |
|---|---|---|---|
| `settings.values.followHost` | 跟随宿主 | Follow host | zh 4/10 · en 11/20 ✅ |
| `settings.values.chinese` | 中文 | 中文 | zh 2/10 · en 2/20 ✅ |
| `settings.values.english` | English | English | zh 7/10 · en 7/20 ✅ |
| `settings.values.on` | 开 | On | zh 1/10 · en 2/20 ✅ |
| `settings.values.off` | 关 | Off | zh 1/10 · en 3/20 ✅ |
| `settings.values.forced` | 强制 | Forced | zh 2/10 · en 6/20 ✅ |
| `settings.values.readOnly` | 只读 | Read-only | zh 2/10 · en 9/20 ✅ |
| `settings.values.readOnlyHost` | 只读（主机） | Read-only (host) | zh 6/10 · en 16/20 ✅ |
| `settings.values.readOnlyPolicy` | 只读（策略） | Read-only (policy) | zh 6/10 · en 18/20 ✅ |
| `settings.values.hostConfig` | 主机配置 | Host config | zh 4/10 · en 11/20 ✅ |
| `settings.values.localOnly` | 本机设置 | On this device | zh 4/10 · en 14/20 ✅ |
| `settings.values.local` | 本机 | This device | zh 2/10 · en 11/20 ✅ |
| `settings.values.help` | 查看说明 | Show help | zh 4/10 · en 9/20 ✅ |
| `settings.values.loading` | 读取中… | Loading… | zh 4/10 · en 8/20 ✅ |
| `settings.values.unavailable` | 连接后显示 | Shown when connected | zh 5/10 · en 20/20 ✅ |
| `settings.values.default` | 默认 | Default | zh 2/10 · en 7/20 ✅ |
| `settings.values.connected` | 主机已连接 | Host connected | zh 5/10 · en 14/20 ✅ |
| `settings.values.disconnected` | 主机未连接 | Host unreachable | zh 5/10 · en 16/20 ✅ |
| `settings.values.refresh2` | 2 秒 | 2 s | zh 3/10 · en 3/20 ✅ |
| `settings.values.refresh5` | 5 秒 | 5 s | zh 3/10 · en 3/20 ✅ |
| `settings.values.refresh10` | 10 秒 | 10 s | zh 4/10 · en 4/20 ✅ |
| `settings.values.refreshPaused` | 暂停 | Paused | zh 2/10 · en 6/20 ✅ |

#### 5.9.5 settings.states（空 / 离线 / 拒绝）

| key | zh-CN | en-US | 长度 |
|---|---|---|---|
| `settings.states.offline` | 主机未连接，以下为本地设置。 | Host unreachable; the settings below are local. | zh 14/70 · en 47/120 ✅ |
| `settings.states.loading` | 正在读取主机设置… | Reading host settings… | zh 9/70 · en 22/120 ✅ |
| `settings.states.empty` | 还没有任务；下面显示的是默认值。 | No task yet; the values below are defaults. | zh 16/70 · en 43/120 ✅ |
| `settings.states.hostRejected` | 主机拒绝了这次修改，已保持原值。 | The host rejected the change; the previous value was kept. | zh 16/70 · en 58/120 ✅ |
| `settings.states.noCatalog` | DSH 没有提供权限预设，只能查看说明。 | DSH exposes no permission presets; descriptions only. | zh 20/70 · en 53/120 ✅ |
| `settings.states.unknownLocale` | 宿主语言无法识别，先按中文显示。 | The host language is not recognised; Chinese is used for now. | zh 16/70 · en 61/120 ✅ |
| `settings.states.readOnlyHost` | 主机配置，只能查看；需要部署者修改。 | Host config, read-only here; a deployment admin can change it. | zh 18/70 · en 62/120 ✅ |
| `settings.states.settingsLocked` | 本会话有任务在跑，职能已锁定。 | A task is running in this session, so the profession is locked. | zh 15/70 · en 63/120 ✅ |
| `settings.states.storageBlocked` | 浏览器禁用了本地存储，这次改动只在当前页面有效。 | The browser blocked local storage, so this change lasts only on this page. | zh 24/70 · en 74/120 ✅ |

### 5.10 errors（13 个错误码）

| key | zh-CN | en-US | 长度 |
|---|---|---|---|
| `errors.PROFESSION_LOCKED` | 任务已开始，职能不能改；请完成它，或重建/丢弃后再选。 | The task has started, so the profession cannot change. Finish it, or rebuild/abandon it to choose again. | zh 27/70 · en 104/120 ✅ |
| `errors.PROFESSION_REQUIRED` | 还没选职能；先选一个再开始任务。 | No profession yet; choose one before the task starts. | zh 16/70 · en 53/120 ✅ |
| `errors.NOT_FOUND` | 没找到这条记录，可能已被删除。 | That record was not found; it may have been deleted. | zh 15/70 · en 52/120 ✅ |
| `errors.INVALID_STATE` | 当前状态不允许这么做。 | The current state does not allow this. | zh 11/70 · en 38/120 ✅ |
| `errors.INVALID_ARGUMENT` | 这次填写的内容无效，请检查后重试。 | The submitted value is not valid; check it and try again. | zh 17/70 · en 57/120 ✅ |
| `errors.ORCHESTRATION` | 子任务没走通；检查任务拆分和前后依赖。 | The subtasks did not go through; check the split and the dependencies. | zh 19/70 · en 70/120 ✅ |
| `errors.VERIFICATION` | 独立验收没通过，任务不能算完成。 | Independent verification failed, so the task cannot count as done. | zh 16/70 · en 66/120 ✅ |
| `errors.TAKEOVER` | 接管窗口处理失败，请重试。 | Handling the takeover window failed; try again. | zh 13/70 · en 47/120 ✅ |
| `errors.PERMISSION` | 权限不够，或这个权限档位不可用。 | Permission is insufficient, or this tier is unavailable. | zh 16/70 · en 56/120 ✅ |
| `errors.DATABASE` | 读写本地记录失败。 | Reading or writing the local records failed. | zh 9/70 · en 44/120 ✅ |
| `errors.CONFIG` | 插件配置有问题，请检查配置项。 | The plugin configuration has a problem; check its settings. | zh 15/70 · en 59/120 ✅ |
| `errors.UPSTREAM` | 模型服务返回了错误，请稍后重试。 | The model service returned an error; try again later. | zh 16/70 · en 53/120 ✅ |
| `errors.NOT_IMPLEMENTED` | 当前部署没有提供这个功能。 | This deployment does not provide that feature. | zh 13/70 · en 46/120 ✅ |

### 5.11 迁移映射（现有 `i18n.ts` → 本文）

| 现有 key | 本文 key | 动作 |
|---|---|---|
| `settings.takeover.*` | `settings.fields.takeoverPermission.*` | 改写并改名；`onLine/offLine` 删除，状态由 chip 表达 |
| `settings.workflow.*` | `settings.fields.composerWorkflow.*` | 改写并改名 |
| `settings.professionGroup.lock` | `settings.fields.professionLock` | 改名；文案重写 |
| `settings.professionGroup.defaultProfession` | `settings.fields.professionDefault` | 改名；config key 改成 `defaults.profession` |
| `settings.professionGroup.rebuildReselect` | `settings.fields.professionRebuild` | 改名 |
| `settings.professionGroup.abandonReselect` | `settings.fields.professionAbandon` | 改名 |
| `settings.professionGroup.audit` | `settings.fields.professionAudit` | 改名；删除 `OrchestrationTrace` |
| `settings.professionGroup.lockErrorHint` | `settings.fields.professionErrorHint` | 改名；删除 `rebuild/abandon` 内部词 |
| `settings.title` | `settings.title` | 保留 |
| `settings.footer` | `settings.footer` | 改写 |
| `composer.validationNote` | `composer.validationNote` | 改写（必须含 1×3/2×5/4×8 与“都联网”） |
| `composer.professionLockedRebuild` | — | 删除；合并进 `professionLocked` |
| `composer.permissionCatalogMissing` | `composer.permissionCatalogMissing` | 改写 |
| `composer.permissionPresetDefault` | `composer.permissionPresetDefault` | 保留 key；仅在无法判断权限档位时使用 |
| `composer.customPreset` | `composer.permissionCustomPreset` | 改名 |
| `composer.permissionWriteNow` | `composer.permissionWriteNow` | 保留 key，改写 |
| `controls.*.hint` | 同名 | 全部替换 |
| `professions.*.hint` / `interactions.*.hint` / `scenes.*.hint` | 同名 | 全部替换 |
| `validations.*.hint` | 同名 | 全部替换（新增 `budget`/`scope`） |
| `permissions.*.hint` | 同名 | 全部替换 |
| `errors.*` | 同名 | 全部替换 |
| `settings.professionGroup.title` | — | 删除；组标题用 `settings.groups.profession.title` |

### 5.12 不在本文范围

- `tools.*`（`coordination_selection` / `coordination_profession` / `coordination_professionlock`）是模型可见文案，保留现有描述；本文不逐字给出。它们已包含写作情景，无需改动。
- 视觉 token（颜色、圆角、阴影）见主题实现，不在文案文档范围。
- 日志、审计、数据库字段保持英文规范值。

---

## 6. 实施清单

### 6.1 需要改的文件（只列范围，本文不改代码）

| 文件 | 要做什么 |
|---|---|
| `src/shared/i18n.ts` | 按 §5 替换/新增所有字符串；补 `settings.fields`、`settings.groups`、`settings.values`、`settings.states` 类型；保留 zh/en 两套。 |
| `src/shared/enum.ts` | 迁移后删除 `*Label` / `*Hint` 文案常量（§22 要求唯一文案源）；保留枚举值数组与 `toSandboxMode` 的**历史值反查表**（那是数据兼容，不是 UI 文案）。 |
| `src/client/controls.ts` | 改为从 `copyFor(locale)` 取文案；删除「low 不做贝叶斯推断」；用 `lockedAria` 拼 `aria-label`；离线/拒绝用新句；把 `state.tooltip` 真正消费掉（或接客户端覆盖）；把硬编码的 5000ms 轮询改为读取 `refreshInterval`。 |
| `src/client/settings.ts` | 从 2 个开关 + 1 个组，改为 §3.1 的 6 组 24 行；每行常驻说明、状态 chip、`?` 按钮；离线/空/拒绝状态；页脚。 |
| `src/client/store.ts` | 新增 3 个本机键：`deepseek-coordination:tooltips`、`:compact`、`:refresh`；默认值分别取 `ui.showTooltip`、`ui.compact`、`ui.refreshInterval`（需要从 `SelectionState` 或新投影读取）。 |
| `src/client/bridge.ts` | 如果不在 `SelectionState` 里加 `ui` 投影，就不改；若要读 3 个主机默认值，在现有 selection 路由里附带 `ui` 字段，**不要**新增一套持久化。 |
| `src/host/selection.ts` | 如加 `ui` 投影，在这里只读返回；不改数据库。 |
| `src/host/config.ts` | 强制 `profession.rebuildCanReselect = true`、`profession.abandonCanReselect = true`；`profession.default` 删除或与 `defaults.profession` 同步；如果保留 `profession.audit`，让它真的生效或从设置页移除。 |
| `test/i18n.test.ts` | 新增 §4.6 的 lint。 |

### 6.2 config key 结论（实现者不要猜）

**需要的键都已存在，不需要新增。** 具体：

- **16 个主机配置键**已在 `config.ts`：`ui.takeover`、`profession.lock`、`profession.rebuildCanReselect`、`profession.abandonCanReselect`、`profession.audit`、`profession.errorHint`、`defaults.profession`、`defaults.scene`、`defaults.validation`、`defaults.interaction`、`scenes.writing.*`、`ui.locale`、`cache.enabled`、`comprehension.searchEnabled`、`orchestration.groundTruth`、`orchestration.modelRouting`。
- **5 个本机键**：`deepseek-coordination:takeover`、`:workflow` 已存在；`:tooltips`、`:compact`、`:refresh` 为本文新增的 **localStorage** 键（不是 config.ts 键），默认值来自对应的 `ui.*`。
- **3 个派生/运行时项**：接管控件状态、DSH 权限目录、当前语言；不持久化。

**需要修（不是新增）：**

1. `profession.rebuildCanReselect` / `profession.abandonCanReselect`：现在无人读取、也未强制；要么在 `resolveConfig` 强制 `true` 并让重建/丢弃路径真正允许重选，要么不要把这两行写成“强制”。
2. `ui.showTooltip`：已随 `SelectionState.tooltip` 下发，但 `controls.ts` 从未读取；新开关必须消费它，否则“显示提示”是假开关。
3. `profession.default`：与 `defaults.profession` 重复且不生效；删除或别名，设置页只认 `defaults.profession`。
4. `profession.audit`：`config.ts` 有键但代码从未读取；如果短期不实现，设置页应把它标成“始终开启（设计约束）”，不要给一个看起来能关的开关。
5. `ui.toolbar` 与 `profession.enabled`：存在但无人读取；`ui.toolbar` 与“工作流下拉框”语义重复。**不要**为它们新增开关，否则又是一个刷新即失效的假设置。

**可选（本文不做）：** `defaults.permission`——如果将来想让部署有“默认权限预设”，再加；当前 DSH 拥有预设目录，插件不应复制一份权限状态。

### 6.3 验收清单（10 条）

1. 五个下拉的 5 条控件 tooltip 与 23 条选项 tooltip 全部来自 `i18n.ts`，页面里没有硬编码中文。
2. 所有 tooltip 通过 §4.6 的长度检查；没有省略号截断。
3. 验证三档都写“联网”，且 `composer.validationNote` 同时出现 `1×3`、`2×5`、`4×8`；旧的错误句已删除。
4. 情景顺序是 对话 → 写作 → 办公 → 研究 → 工程 → 迭代；设置页“默认情景”包含写作。
5. 职能锁定后可聚焦、可读出“已锁定 + 出口”，不依赖鼠标悬停。
6. 设置页 6 组、24 项；可编辑 5、强制 3、主机只读 13、派生 3；没有第二个接取开关。
7. 主机未连接时显示“以下为本地设置”，主机行显示 `—`/`连接后显示`，不伪造默认值。
8. 每个设置行都有常驻说明；没有任何规则只存在于 tooltip。
9. zh/en 键完全配对；禁用词扫描通过；占位符一致。
10. `config.ts` 没有为设置页新增假键；`profession.default` 不再被展示为生效键。

---

*本文档只定义文案与信息架构，不修改任何代码。实现时如与 `docs/deepseek-coordination-v23.md` 的行为描述冲突，以 v23 行为为准、以本文文案为准。*
