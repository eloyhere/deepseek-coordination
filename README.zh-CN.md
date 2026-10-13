# deepseek-coordination

面向 DeepSeek Harness 的跨平台**原子 OS 交互层**。

一个通过**字符串**与操作系统对话的 agent，只要遇到路径含空格、文件带 UTF-8 BOM、行尾是 CRLF、文档不是 UTF-8，或命令由拼接产生，就会拿到错误答案。本项目用一套**参数稳定的动词集**取代字符串拼接，并把编码、字节序标记与行尾处理变成显式且逐字节精确的行为。

同一套动词面，在 Windows 与 POSIX 上各自原生实现，既可被 agent 通过单个 harness 工具调用，也可被人直接在终端里使用。

```console
$ dsh-os selfcheck
{"ok":true,"verb":"selfcheck","result":{"script":"bin/dsh-os.ps1","capabilities":{...}},"meta":{...}}

$ dsh-os file charset "C:\path with spaces\notes.txt"
{"ok":true,"verb":"file.charset","result":{"charset":"utf-8-bom","bom":true,"eol":"crlf"},"meta":{...}}
```

* **完全开源**，MIT 许可。无遥测、无账号、无网络请求。
* **零运行时依赖。** Windows 侧是 `Add-Type` P/Invoke；POSIX 侧使用 coreutils 一类的系统工具。运行时不会去获取任何东西。
* **每个平台一个自包含文件**，由确定性构建从模块拼装而成。

> [!WARNING]
> 本交互层可以**读取你的屏幕、截取屏幕截图、读写剪贴板、合成鼠标与键盘输入、启动与结束进程、删除文件、修改环境变量**。在授予它任何权限之前，请先读[危险权限](#危险权限)一章。

---

## 为什么需要它

失败模式永远是同一个形状：某个值被变成了字符串的一部分，然后在下游被重新解释。

| 故障 | 坏在哪里 | 本项目的做法 |
|---|---|---|
| `C:\Program Files\a b.exe` | 空格把一个路径拆成两个参数 | 值始终是**独立的 argv 元素**，绝不拼进 shell 字符串 |
| 文本中间冒出 UTF-8 BOM | 每个消费方都看见 `\uFEFF` | 读取时剥离 BOM，且**绝不**泄漏到结果里；写入时还原 |
| CRLF 文件被改写成 LF | diff 噪声、脚本损坏 | 读取报告 `eol`；写入还原原有约定 |
| GBK 文档被当作 UTF-8 读 | 静默乱码（或静默退化到 `latin1`） | 编码显式声明；先试严格 UTF-8，再考虑回退 |
| 命令靠拼接生成 | 注入、引号 bug | `execute.command` 接收真正的 **argv 数组**，永不经 shell |
| 字节偏移落在字符中间 | 文本被切碎 | 偏移会按编码的字符边界校验 |

每次调用都恰好返回**一个 JSON 信封**，调用方按 `error.code` 分支而不是解析散文——而且**失败**的调用同样会输出可解析的信封，因为裸退出码对 agent 毫无信息量。

---

## 仓库结构

```
deepseek-coordination/
├─ src/host/command.txt            权威动词契约，一个动词一行
├─ src/host/spec/verbs.tsv         机器可读动词表（单一真源），86 个动词
├─ src/host/spec/charsets.tsv      IANA 名 → .NET 码页 → iconv 名 → BOM 字节，15 个规范编码
├─ src/host/lib/powershell5.1/*.ps1  真源：Windows PowerShell 5.1 侧，build.ps1 登记的 16 个模块 + 独立脚本 git.ps1
├─ src/host/lib/powershell7.6/*.ps1  真源：PowerShell 7.6 侧，同样的 16 个模块 + 独立脚本 git.ps1
├─ src/host/lib/*.sh               真源：POSIX 侧，16 个 shell 模块 + 独立脚本 git.sh
├─ src/host/lib/powershell.md      5.1 → 7.6 的 API 变更参考（无任何代码/测试/package.json 引用，不随包发布）
├─ src/host/bin/dsh-os.ps1         【生成物】Windows PowerShell 5.1 实现（218,514 字节）
├─ src/host/bin/dsh-os7.ps1        【生成物】PowerShell 7.6 实现（255,565 字节）
├─ src/host/bin/dsh-os.sh          【生成物】POSIX 实现（142,744 字节）
├─ src/host/bin/dsh-os.bat         仅 ASCII 的 cmd.exe 外壳（手写，非生成物）
├─ src/host/docs/os-spec.md        完整规范：契约、错误码、黄金用例矩阵
├─ src/host/docs/permission-model.md  授权模型及其残余风险
├─ src/plugin/index.js             宿主插件：注册 `dsh_os` 工具
├─ src/plugin/invoke.js            共享调用层：生成物/版本解析、spawn、信封解析
├─ src/plugin/settings.js          设置服务 + 面板的两条 HTTP 路由（`/api/dsh-os/*`）
├─ src/plugin/takeover.js          `tools/execute` 拦截：把内置 read/write/edit/pwsh 交给 dsh-os 答复
├─ client.js                       浏览器半边：渲染设置面板的 `dsh.client` 生成物
├─ src/permission/index.js         同意写入委托：`permission.json` 的唯一写入方，注册 5 个 `os_permission_*` 工具
├─ tools/build.ps1                 拼装三个生成脚本；`-Check` 在漂移时失败
├─ tools/parse-check.ps1           在**将要执行代码的那个运行时**下解析检查模块，并报告非 ASCII 与 BOM
├─ tools/json-field.mjs            按点分路径读取信封里的一个字段（shell 测试用，`sed` 看不进嵌套对象）
├─ tools/verify-bundle.mjs         校验 loader 的解析契约（14 项）
├─ tools/verify-plugin-load.mjs    走真实 `apply()` 路径（30 项）
├─ tools/verify-editions.mjs       证明两个 PowerShell 生成物都可达（14 项）
├─ tools/probe-pipeline.mjs        在打桩的动词层上端到端驱动拦截链路（23 项）
├─ tests/                          黄金（Windows/POSIX/桌面注入）、两表一致性、编码、插件、授权、接管各套测试
│  ├─ conformance.ps1              `command.txt` 与 `spec/verbs.tsv` 必须描述同一个面（5 项）
│  ├─ takeover.test.mjs            字节级格式保留、读取窗口切片、可拦截资格（41 项）
│  ├─ smoke-desktop-sh.sh          POSIX 桌面动词**实际注入了什么**（52 项）
│  └─ fake-xdotool, fake-wmctrl    会记录调用的替身，使无 X server 的机器也能校验桌面动词
└─ permission.json                 授权数据（随仓库为空文件，这就是初始状态）
```

两套 PowerShell 运行时分目录存放，原因是差异并非表面性的：.NET Framework 4.8 没有 `ProcessStartInfo.ArgumentList`，且需要一条感知 ANSI 的编码路径；.NET 10 两者皆备。分开存放意味着任何一侧都不必背负另一侧的权宜写法。

`src/host/lib/` 中每个模块成对提供：

| 模块 | 职责 |
|---|---|
| `preamble` | 严格模式、编码钉死、仓库根定位 |
| `json` | 错误模型、JSON 序列化、信封写出 |
| `command` | 参数解析（位置与 `name="value"`）、断言、类型转换 |
| `charset` | 编码表、BOM 策略、字节级文本模型 |
| `native` | P/Invoke 声明与原子替换（仅 Windows；POSIX 侧为空） |
| `paths` | 路径解析与受保护路径边界 |
| `file` | `file.*`、`file verify.*`、`file search` |
| `system` | `system.*` 查询 |
| `execute` | `execute.command` / `.synchronous` / `.asynchronous` |
| `task` | `task.*` |
| `environment` | `environment.*` 与 `environment attribute.*` |
| `service` | `service.*` |
| `permission` | `permission.*`（只读）与 `selfcheck` |
| `window` | `window.*`、`mouse.*`、`keyboard.*`、`clipboard.*`、`wait.*`、观察面 |
| `dispatch` | 动词解析与分发表 |
| `entry` | 运行、输出、退出 |

生成脚本是**单个自包含文件**，而不是运行时 dot-source。在 Windows PowerShell 5.1 上，一个不带 BOM 的被 source 文件会按 ANSI 码页解码——这恰恰就是本项目要消灭的那类编码故障。

---

## 开始使用

已发布到 npm，因此 DSH profile 可以把它作为 bundle 安装：

```console
dsh plugin install deepseek-coordination
```

或从源码使用：

```console
git clone https://github.com/eloyhere/deepseek-coordination.git
cd deepseek-coordination
```

脚本无需构建或安装，直接运行：

```powershell
# Windows
src\host\bin\dsh-os.ps1 selfcheck
src\host\bin\dsh-os.ps1 file charset "C:\path with spaces\file.txt"
src\host\bin\dsh-os.ps1 file verify charset .\file.txt utf-8
src\host\bin\dsh-os.ps1 environment attribute get PATH --scope process
```

```sh
# POSIX
src/host/bin/dsh-os.sh selfcheck
src/host/bin/dsh-os.sh file charset "./a file.txt"
```

`dsh-os.bat` 是给人在 `cmd.exe` 里手敲的。能传 argv 数组的调用方——harness、Node 的 `execFile`、CI——应当**直接**调用 `.ps1` 或 `.sh` 并彻底绕开 `cmd.exe`，因为批处理文件的参数处理本身就是引号 bug 的来源。

### 从 harness 使用

`package.json` 声明了 `dsh.bundle.patch`，因此本包可以作为一个 bundle 安装进 DSH profile，并插入五行：

| 行 | 入口 | 作用 |
|---|---|---|
| `dsh-os` | `.` | 注册 `dsh_os` 工具 |
| `dsh-os-settings` | `./settings` | 面板编辑的设置，以及它的两条 HTTP 路由 |
| `dsh-os-takeover` | `./takeover` | 在开启时把内置 `read`/`write`/`edit`/`pwsh` 交给 dsh-os 答复 |
| `dsh-os-permission` | `./permission` | 同意写入委托，`permission.json` 的唯一写入方 |
| `dsh-os-workflow` | `./workflow` | 意图优先的工作流工具及其系统提示词小节 |

各行必须使用**不同的模块说明符**：`name` 按包说明符解析，若两行都用裸包名就会把同一个模块加载两次，从而抛出 `tool "dsh_os" is already registered` 并中止整个 entry。子路径导出正是为此存在。

| 工具 | 用途 |
|---|---|
| `dsh_os` | 执行动词面上的一个动词，并原样返回其 JSON 信封 |
| `os_permission_*` | 读取、授予、撤销与审计持久授权决定 |
| `workflow` | 执行意图优先工作流的一个阶段（见[工作流](#工作流)） |

只注册一个工具而非每个动词一个，理由有三：动词表就是契约且存放在 `src/host/spec/verbs.tsv`，新增动词时无需重新生成 schema；agent 用一次 `verb: "selfcheck"` 调用就能发现整个动词面；信封本身已是稳定的结果形状，不会出现第二份会与脚本漂移的契约。

```jsonc
// 调用形状
{ "verb": "file charset", "arguments": ["path=\"./a.txt\""], "allow": false }
{ "verb": "environment attribute get", "arguments": ["PATH"], "flags": ["--scope", "process"] }
```

实现以绝对路径加 argv 数组方式拉起，永不经 shell，因此含空格的值仍然是一个值。

### 接管内置操作

`dsh_os` 是一个**必须被告知才会用**的工具，而实际上永远不会被告知：内置的 `read`/`write`/`edit`/`pwsh` 就在手边，能力几乎完全重叠，提示词里也没有任何东西偏向其中一方。于是本项目存在的那些保证从未被真正走到——插件装上了，却感知不到。

**接管**消除了这个选择。在 **设置 → DSH OS** 里打开后，内置调用会由同一套机制答复，无论 agent 是否配合。逐工具开关可以只接管 `write`、或只接管 `edit`，其余保持不变。

它走的是 `tools/execute` 这条 around-dispatch waterfall：处理器返回 `{ value }` 并且不调用 `next()`，该值随后由**内置**工具自己的 `output.schema` 校验、由**内置**的 `output.render` 渲染。因此模型看到的文本、diff 卡片与展示元数据都没变，变的只是这个值的字节来源。

**不接管的部分及原因：**

* `glob` 与 `grep`。本动词面**完全没有按内容检索的动词**（`file search` 匹配的是**文件名**），所以 `grep` 的 `lineNumber`/`line` 物理上无法产出，glob 的忽略规则与 mtime 排序也没有对应物。接管它们会静默返回一个不同的结果集。
* 后台命令与沙箱升级。后台调用的结果是一个 harness 作业 id，本动词面造不出来；`sandbox_permissions` 则是 harness 自己的审批缝。
* 相对路径。内置工具经 `ctx.fs` 按会话工作区解析它们，本插件没有等价能力；去猜进程工作目录只会读到与调用方所指不同的文件。

**有两项性质是被刻意放弃的，开启前应当知道：**

1. **被接管的调用不再受文件系统沙箱约束。** 内置写路径经 `ctx.fs`，沙箱策略与"写前必读"的观察守卫都在那里；被接管的写直接执行动词，只剩 dsh-os 自己的受保护路径检查。这是真实的防御削弱，不是细节。
2. **上报的文本与磁盘上的字节可以不同。** 默认的*沿用原文件*格式下，CRLF 文件保持 CRLF、BOM 保持 BOM，而 `value.after` 是归一化后的 LF 文本——也就是内置 `read` 会显示、diff 卡片会比较的那份文本。若希望接管在字节上什么都不改，请选择*同内置*。

每一次被接管的调用在任何失败下都会回退到内置实现，因此接管只能改变结果**如何产生**，绝不会改变调用方**是否拿到结果**。面板的「最近活动」会显示实际接管了什么、以及任何回退的原因。

**选择 PowerShell 版本。** 默认仍是 5.1 产物（`bin/dsh-os.ps1`），**刻意不变**：已经工作的部署不应因为插件升级而在脚下改变行为。要选 7.6 产物（`bin/dsh-os7.ps1`）：

* `powershellEdition: '7.6'` —— 插件配置；
* `DSH_OS_POWERSHELL_EDITION=7.6` —— 无法改 profile 的部署；
* `'auto'` —— 仅当产物与可用的 `pwsh` **同时**存在时才用 7.6。

配置优先于环境变量；显式的 `scriptPath` 完全禁用该选择。`pwsh` 的查找顺序是显式 `DSH_OS_POWERSHELL` → `PATH` → 标准安装位置，因为 `pwsh` 并不总在 `PATH` 上（本仓库自己的环境里就不在，而 7.6.6 明明装在标准位置）。

> [!IMPORTANT]
> **仍未证明：harness 自身的 loader 会在活动 profile 里组合这个 bundle。** 插件的解析、装载与执行路径现由 `tools/verify-bundle.mjs`、`tools/verify-plugin-load.mjs` 与 `tools/verify-editions.mjs` 覆盖（详见[安装现状](#安装现状与已知缺陷)），但"装进用户的桌面活动 profile 并重启 harness"这一步**没有被跑过**。

### 工作流

本包其余各行让一次**操作系统调用**变正确；这一行让一个**需求**在被执行之前就被决定。它消除的失效模式是：一个从未成为规格的需求——模型直接开始改文件，等到评审时才发现方向偏了，而 token 已经花掉。

`dsh-os-workflow` 注册一个工具 `workflow`，以及一个系统提示词小节。

```
intake -> plan -> choose -> run -> done
```

| 阶段 | 动作 | 它确立了什么 |
|---|---|---|
| intake | `start` | **逐字**记录的提示词，外加 1–3 个关于真实意图的问题，**或**你所做的假设 |
| plan | `plan` | 方案与流程、**至少两个**各带利弊的备选、评判标准，以及你的推荐 |
| choose | `choose` | **用户的选择**，在同一次调用内经 `ctx.userQuestions` 取得 |
| run | `run` | 执行、步骤，以及在同一次调用内关闭工作流的结论 |
| — | `note` | 执行期间记下的一条备注或一个决定 |
| — | `checkpoint` | 把记录折叠进一个文件，并回传摘要 |
| — | `status`、`reset` | 读取状态；丢弃并重新开始 |

**门是硬的。** 入口尚未记录的阶段会被拒绝，且拒绝信息会点明必须先跑哪个阶段。`choose` 无法由模型自己回答：问题经与 `ask_user_question` 相同的缝交给用户，除此之外没有任何路径能进入 `run`。

**四次调用、一次提问。** 不可避免的路径是 `start` → `plan` → `choose` → `run`。它原本是八次调用、两次提问，差别来自三处刻意的合并——每一处都去掉一个来回，而没有去掉任何一个决定：

* **设计与备选是同一次调用**，因为它们本就是同一个决定。这就是 QOC（Questions、Options、Criteria）与 ADR（Context、Decision、Consequences）的形状：一条决策记录同时持有它被选出的那些备选、以及评判它们所用的标准。拆成两步会让第二步重新推导第一步，并让用户把同一份架构读两遍。
* **意图清晰的请求零提问。** `start` 接受 `assumptions` 而非 `questions`，因此不含歧义的提示词不会被打断——而假设被记录在案，用户可以纠正，这比它所替代的那个问题更便宜。"最小且相关"的提问优于盘问，其证据是 Ask-to-Act 这一线工作（[arXiv:2504.00907](https://arxiv.org/abs/2504.00907)）。
* **单步执行在开启的同一次调用内关闭。** 给 `run` 传 `outcome` 即结束工作流；只有多步工作才需要第二次调用。

**压缩是另一半。** 被叙述进对话的计划会随着之后每一步被重新发送，这正是短任务变贵的原因。所以它从不进入对话：每个阶段写下一份真正的文档，只回传一行——阶段、摘要、文件路径、下一个调用。`tests/workflow.test.mjs` 会度量这个比例，并断言任何阶段的信封都不超过 2000 字符。这个形状有实测依据而非风格偏好：剪枝加摘要能在降低 token 与运行时的同时提升完成率（[Less Context, Better Agents](https://export.arxiv.org/pdf/2608.16370)），而规划/执行分离能以 token 成本的一小部分达到与交错推理相当的准确率（[Plan Once, Ground Locally](https://zenodo.org/records/22904595)）。

**开销落在哪里**，以复杂度表述，因为它本来就是复杂度：

| 路径 | 开销 |
|---|---|
| 读取状态 | 每次工作流调用一次，按文件 mtime 缓存——而**绝不在模型步上**发生，因为提示词小节根本不读状态 |
| 一次阶段跃迁 | 一次原子状态写入；第一版每个动作写三次 |
| 执行期间的一条 note | 一次 `appendFileSync` 追加，O(1)，由压实维持有界——而不是"读-推-重写"那种在整个工作流上 O(n²) 的做法 |
| 提示词小节 | 一个**常量**：不读、不查、不格式化，在每个工作流的每个阶段都完全一致 |

### KV 缓存效应——提示词小节为何必须是常量

这一行注册进系统提示词的小节是一个**常量字符串**。这不是为了整洁，这就是设计本身。证据是实测的，而且很残酷：

| 对一个 7,384 token 的请求做改动 | 命中 | 命中率 |
|---|---:|---:|
| 什么都不改 | 7,296 | **98.8%** |
| 在末尾追加一条消息 | 7,296 | **98.7%** |
| 在**系统提示词末尾**加一行 | 0 | **0.0%** |
| 在**系统提示词开头**插一行 | 0 | **0.0%** |
| 在工具列表末尾追加一个 schema | 1,408 | 18.3% |
| 改最后一个工具描述的一个字符 | 1,280 | 17.3% |
| 对调两个工具的顺序 | 0 | **0.0%** |

十个变量，在 DeepSeek 官方端点上实测（[前缀稳定性一章](https://github.com/diguike/book-deepseek-harness/blob/main/book/11-prefix-stability.md)）。其背后的规则来自 provider 自己：一次缓存命中要求请求**完整匹配一个已持久化的 cache prefix unit**，而系统提示词排在工具目录与全部历史之前（[上下文硬盘缓存](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/)）。

harness 自己已经为这一课付过一次账：沙箱策略原本写在系统提示词里，用户切一次权限，缓存命中就从 **约 14,700 token 掉到 256**；修法是把会变的事实挪出提示词、放进消息序列（[DSH Agent Note](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-09-02-in-history-system-prompt-replacement.md)）。

**这一行的第一版犯的正是这个错误。** 它把当前阶段渲染进小节，于是四次调用的工作流会三次重写系统提示词，每次都付一次整段前缀的 miss。修法是结构性的，不是文案性的：

* 小节是常量，因此本行的**缓存效应是 `prefix-stable`**：每个工作流零次提示词变更，且由 `tests/workflow.test.mjs` 在每个阶段对注册文本逐字节断言；
* 当前阶段与**下一个该发的调用**改由 `workflow` 工具自身的结果携带——那是追加的历史，上表为它标价 98.7%；
* 顺序错误的调用会被拒绝，且拒绝信息点明必须先记录哪个阶段，因此模型无需提示词告知任何东西也能自我纠正；
* 发现入口放在工具**描述**里。它位于工具目录中：在前缀之内、只发送一次、整个会话不变。

> [!IMPORTANT]
> **读者应当为自己插件得出的结论。** 任何逐步变化的东西——时间、当前目录、分支、权限、阶段——都不能写进提示词小节。本 harness 为这类内容准备了专门的通道：用 `ctx.systemPrompt.context()` 注册，它会作为一条追加的 user 消息送达，并且只在内容变化时重新投影。小节只用于在整个会话内稳定的文本。

**状态存放在哪。** `$DSH_HOME/dsh-os/workflows/<session>/`，与设置文档同级，理由相同：包目录会在升级时被整体替换，而工作区属于用户。`state.json` 是紧凑记录，其余文件都是细节。已结束的工作流会被归档而不是覆盖，因此下一个从干净状态开始，而上一个仍然可读。

```
state.json          紧凑记录：阶段、意图、决定、步骤、产物路径
journal.jsonl       仅追加：备注与步骤，有界，由 checkpoint 折入
01-intent.md        逐字提示词，随后是问答（或假设）
02-plan.md          方案与流程、备选及其利弊、标准、决定
03-execution.md     选中的选项、目标、步骤、涉及文件、约束
04-outcome.md       交付了什么，以及任何仍未关闭的步骤
05-checkpoint.md    折叠：至今为止的全部决定，在需要压缩时写出
```

**可配置项。** `workflowRoot` 改变目录位置；`autoCompact`（默认 `true`）控制 checkpoint 是否报告引擎可能执行的压缩，`maxCheckpoints` 限制其数量。结构性的一半——细节落盘、只回传一行——**不可配置**，因为它正是这个功能能省下东西的原因。

> [!WARNING]
> **这一行会向用户提问，因此部署必须能回答。** 它注入 `userQuestions`；缺少该服务的宿主什么都不注册，而不是注册一个第二次调用就会失败的工具。有两次调用会阻塞等人：给了问题的 `start`，以及永远如此的 `choose`。

> [!NOTE]
> **这一行不会调用引擎的压缩服务。** `ctx.compaction` 确实存在，但从这里调用它意味着构造一个会话形状的上下文，而那个契约并未公开——那是把猜测包装成功能。本插件的做法是确定且可检查的：细节离开对话、进入文件，而 `checkpoint` 记录下压缩安全的边界。正因如此，这里的压缩是被 `tests/workflow.test.mjs` **度量**的，而不是仅仅被声称。

---

## JSON 契约

每次调用都向 stdout 写出**恰好一个** JSON 信封，UTF-8 **无 BOM**，以单个 LF 结尾。

```jsonc
// 成功
{ "ok": true,  "verb": "file.charset", "result": { "charset": "utf-8", "bom": false, "eol": "crlf" },
  "meta": { "durationMs": 3, "platform": "win32", "shell": "pwsh" } }

// 失败 —— 仍然恰好一个信封，仍然在 stdout 上
{ "ok": false, "verb": "file.charset",
  "error": { "code": "E_NOT_A_FILE", "message": "…", "hint": "…" },
  "meta": { "durationMs": 2, "platform": "win32", "shell": "pwsh" } }
```

* `error.hint` 仅在确有可操作建议时才出现。
* `--pretty` 缩进输出；`--quiet` 只输出 `result`（或只输出 `error`）。
* **stderr 只承载人类可读的诊断，绝不参与解析。** Windows 侧设置 `DSH_OS_TRACE=1` 可在 stderr 上得到失败追踪。

### `error.code` 才是权威

退出码只是粗分类，方便 shell 廉价地分支。**绝不要解析 `error.message`。**

| 退出码 | 类别 | 代表错误码 |
|---|---|---|
| 0 | 成功 | — |
| 1 | 用法 | `E_USAGE` |
| 2 | 类型／取值 | `E_TYPE`、`E_CHARSET_UNKNOWN`、`E_BOUNDARY`、`E_RANGE`、`E_WINDOW_AMBIGUOUS` |
| 3 | 授权 | `E_PERMISSION`、`E_ELEVATION_REQUIRED`、`E_PERMISSION_PROTECTED_PATH`、`E_PERMISSION_DELEGATE_ONLY`、`E_PERMISSION_FILE_UNTRUSTED`、`E_PERMISSION_DENIED_BY_RULE`、`E_PERMISSION_NO_ANSWERER` |
| 4 | 平台不支持 | `E_NOT_SUPPORTED`、`E_NO_DISPLAY`、`E_ACCESSIBILITY_DENIED`、`E_ACCESSIBILITY_UNAVAILABLE` |
| 5 | 目标／编码／IO | `E_NOT_FOUND`、`E_NOT_A_FILE`、`E_EXISTS`、`E_BINARY_CONTENT`、`E_CHARSET_MISMATCH`、`E_TRUNCATED`、`E_PARTIAL_WRITE`、`E_WINDOW_NOT_FOUND`、`E_IO` |
| 6 | 超时 | `E_TIMEOUT` |
| 7 | 内部／被中止 | `E_INTERNAL`、`E_ABORTED` |

Windows 实现登记了 **36** 个错误码；POSIX 实现以 `case` 分组。两者对每个**已具名**错误码的归类一致，但对**未登记**错误码不一致：Windows 返回 7，POSIX 返回 5。

### 调用约定

值始终是独立 argv 元素，**绝不**拼进 shell 字符串。两种写法等价，但同一参数不得混用：

```sh
# 位置形式
dsh-os file create "./a.txt" "123" "utf-8-bom"

# 具名形式 —— 顺序任意；实际顺序取自动词表的参数列表
dsh-os file create content="123" charset="utf-8-bom" path="./a.txt"
```

以下情况以 `E_USAGE` 拒绝：未知标志、空的 `--`、取值标志缺值、具名参数重复、未知名字、同一参数既给位置又给名字、多余的位置参数。读操作永不被要求 `--allow`；写操作总是被要求。

动词深度为一到三段——`selfcheck`、`file charset`、`file verify charset`——解析器只在扩展形状确实已知时才吞掉下一个 token，因此一个恰好以单词开头的路径参数不会被当成动词的一部分吃掉。

### 编码、BOM 与行尾

`src/host/spec/charsets.tsv` 定义了 15 个规范编码名，各含别名、.NET 码页、`iconv` 名与 BOM 字节：

`utf-8`、`utf-8-bom`、`utf-16le`、`utf-16be`、`utf-32le`、`utf-32be`、`gbk`、`gb18030`、`big5`、`shift_jis`、`euc-jp`、`euc-kr`、`latin1`、`windows-1252`、`ascii`。

探测顺序是先嗅 BOM，再试**严格** UTF-8，然后是 GBK，最后 latin1。读取时剥离 BOM 并把 `\r\n` 归一为 `\n` 用于输出；**任何写回操作都还原文件原有的 BOM 存在性与行尾约定。** 偏移是半开区间 `[start, end)` 的字节偏移，必须落在字符边界上，否则以 `E_BOUNDARY` 失败，而不是把一个字符切碎。

二进制判定是载荷前 8 KiB 内出现 NUL 字节，报 `E_BINARY_CONTENT`，而不是给出乱码。

---

## 动词面

`src/host/spec/verbs.tsv` 中**声明了 86 个动词**，它是单一真源。其中一部分只声明未实现；在依赖某个动词之前，请先看[实际可用范围](#实际可用范围)。

| 组 | 动词 |
|---|---|
| `file` | `create` `charset` `encode` `length` `information` `list` `delete` `move` `copy` `mkdir` `append` `insert` `view` `search` |
| `file verify` | `charset` `encoding` `completion` |
| `execute` | `command` `synchronous` `asynchronous` `query` `kill` |
| `system` | `brand` `cpu` `gpu` `version` `info` |
| `task` | `list` `query` `show` `kill` `launch` |
| `service` | `list` `query` `start` `stop` `restart` |
| `environment` | `list` `get` `add` `set` `delete` |
| `environment attribute` | `list` `get` `add` `set` `delete` |
| `permission` | `query` `list` `audit` `grant` `revoke` `acl init` |
| `window` | `find` `list` `active` `close` `top` `bottom` `move` `resize` `minimize` `maximize` `restore` |
| `mouse` | `click` `context` `over` `wheel` `down` `up` `cursor` |
| `keyboard` | `down` `up` `press` `combination` `type` `codes` |
| `clipboard` | `read` `write` `paste` |
| `wait` | `window` `ms` |
| 观察面 | `screenshot` `text` `structure` |
| 自检 | `selfcheck` |

几个值得先知道的设计点：

* **`file verify.*` 是断言，不是抛错。** `file verify charset` 会在返回观测值的同时给出 `match: false`，让调用方能区分"文件不对"与"我要求错了"。`file verify completion` 在你没给任何预期时返回 `complete: null`——这是刻意不写成 `false`。
* **`file insert` 的 `--charset` 是标志，不是位置参数。** 夹在 `content` 与 `offset` 之间时它会**静默顶掉 offset**。
* **`file.delete` 在 Windows 上默认进回收站。** 在 POSIX 上需要 `trash-put`，否则报 `E_NOT_SUPPORTED`——它**不会**静默地真删。
* **`environment` 有两层。** 变量持有一个字符串；**属性**（PATH、PATHEXT、LIB、INCLUDE）持有一个有序列表。写入会返回 `visibleToRunningProcesses`，因为 `user` 或 `machine` 级写入对已经在运行的进程不可见。
* **`keyboard type` 以 Unicode 为先。** 非 ASCII 文本走剪贴板粘贴，因为在有输入法的情况下 `KEYEVENTF_UNICODE` 并不可靠。

---

## 危险权限

在授予任何权限之前，这一章是必读的。本交互层刻意做得很有能力，而它给出的保证比功能列表看起来要窄。

### 一个被完全授权的 agent 能做什么

| 能力 | 涉及动词 | 授权要求 |
|---|---|---|
| **读取你的屏幕内容** | `screenshot`、`text`、`structure` | **只读，永不弹窗** |
| **读写你的剪贴板** | `clipboard.read`、`clipboard.write` | `read` 永不弹窗；`write` 需 `--allow` |
| **合成输入**——点击、拖拽、打字、组合键 | `mouse.*`、`keyboard.*` | `--allow` |
| **操纵你的窗口**——移动、改尺寸、关闭、置前 | `window.*` | `--allow` |
| **启动与结束进程** | `task.kill`、`execute.*` | `--allow` |
| **执行任意命令行** | `execute.synchronous`、`execute.asynchronous` | `--allow` |
| **删除、移动、覆盖文件** | `file.delete`、`file.move`、`file.copy` | `--allow` |
| **持久修改你的环境变量** | `environment.set`、`.add`、`.delete`、`attribute.*` | `--allow` |
| **控制系统服务**（已声明，未实现） | `service.start`、`.stop`、`.restart` | `--allow` + 提权 |
| **读取进程与系统清单** | `task.*`、`system.*` | **只读，永不弹窗** |

说得直白一些：`mouse.*` 与 `keyboard.*` 意味着一个被授权的 agent 能以你的权限操作**任何**你能操作的程序。又因为它能读屏，它还能观察自己刚刚做了什么。桌面之内没有沙箱。

### 授权实际上是怎么运作的

**B 层——结构强制（始终生效，跨平台）。**

* 每个变更类动词都要求 `--allow`。缺失即 `E_PERMISSION`，且**什么都不会发生**。
* **`permission.json` 的三个写入动词存在，但它们只走委托，不走脚本自身的授权。** 动词表里声明了 `permission grant`、`permission revoke`、`permission acl.init`（三个都是 `W` 类），而 `permission query`、`permission list`、`permission audit` 是只读的。`grant` 与 `revoke` 的 flags 只接受 `delegate`（外加 `allow`），也就是**只能由同意写入委托调用**；脚本本身不能凭 `--allow` 创建持久授权，缺委托时报 `E_PERMISSION_DELEGATE_ONLY`。
* 一条硬性的**受保护路径边界**拒绝任何对"决定本层能做什么"的文件的修改：`permission.json`（及 `.bak`）、`src/host/command.txt`、**四个** `src/host/bin/dsh-os.*`（`.ps1`、`dsh-os7.ps1`、`.sh`、`.bat`）、`src/host/spec/verbs.tsv` 与 `src/host/spec/charsets.tsv`，以及任何可能在其旁边暂存内容的同名临时文件。违反者报 `E_PERMISSION_PROTECTED_PATH`，且无任何副作用。读取仍然允许，以便你审阅规则。POSIX 侧的受保护清单有 8 项——同样的名单但**不含 `dsh-os7.ps1`**。
* 该检查作用于**解析并归一化之后**的路径，逐段比较——而不是正则匹配，因为 `..`、8.3 短名或结尾的句点都能绕过正则。`file.move` 与 `file.copy` **两端都检查**，因为移动受保护文件同样是一种破坏方式。

**A 层——内核 ACL（Windows，需显式开启，需提权）。**

`permission acl init` 会给 `permission.json` 的 DACL 追加一条针对 `Everyone`（`S-1-1-0`）的显式 **DENY**，覆盖 `FILE_GENERIC_WRITE | DELETE | WRITE_DAC | WRITE_OWNER`。该动作幂等；无法执行时报 `E_ELEVATION_REQUIRED`，而不是含糊地失败。

`selfcheck` 报告 `aclEnforced` 的方式是**读取文件真实的安全描述符**并遍历 DACL。早期版本是从一个状态文件里读标志位——那会声称一种并未生效的强制；该实现已被删除。`aclReason` 会解释 `false` 的原因，使其可被处置而不只是被疑惑。

### 四条需要如实说明的限制

这些在 `src/host/docs/permission-model.md` 中有记录，在此重述是因为它们改变了上述保证的含义。

1. **持久规则被记录了，但没有在动词层参与执法。** `permission.json` 的规则由同意写入委托及其 `os_permission_query` 工具来匹配；脚本读取该文件**仅用于展示**（`permission list/query/audit`）。没有任何动词在行动前查规则：真正的门禁是 `--allow`、受保护路径检查，以及（若已开启的）A 层。一条 `deny-always` 规则目前**并不能**拦住一个带着 `--allow` 到来的动词。
2. **`E_PERMISSION_DENIED_BY_RULE` 已登记但从未被抛出。** 它在错误表里并映射到退出码 3，但没有任何代码路径产生它——与第 1 条一致。
3. **脚本内的规则读取器没有实现 deny 优先。** 脚本侧的 `permission query` 取的是**第一条**匹配规则，不区分其决定是允许还是拒绝。委托侧正确实现了 deny 优先并有测试覆盖；因此两个读取器可能给出不同答案，而脚本侧是更弱的那个。
4. **`execute` 是绕过受保护路径边界的一条通道。** 该边界守卫的是 `file.*` 与 `environment.*`。它无法约束子进程：`execute.synchronous` 在 Windows 上把命令行交给 `cmd.exe /d /s /c`，在 POSIX 上交给 `sh -c`，因此被启动的程序可以写任何它自身权限允许的东西，包括 `permission.json`。只有 A 层能阻止这一点。当 `aclEnforced: false` 时，B 层做不到。

同意写入委托还有一个**设计缺口**需要直说：委托注册了五个工具（`os_permission_query`、`os_permission_grant`、`os_permission_revoke`、`os_permission_list`、`os_permission_audit`），但**没有注册 `approval/request` answerer**。它自己的设计文档写明应当注册，并且 `permission grant` **必须**经过用户确认的弹窗。就代码现状而言，强制手段是一段**工具描述**在告诉模型"只在用户选择之后才调用 `os_permission_grant`"；代码并不校验弹窗是否真的发生过。请把该委托当作可信基础设施，而不是对 agent 的检查。

关于 A 层还有两点：它要求 harness 与委托以**不同身份**运行（否则退化为 B 层）；其 POSIX 等价物更弱——一次改权限模式，同一用户即可撤销。`permission acl init` 在自己的返回结果里也这么说。

### 审阅已被授予了什么

```sh
dsh-os permission list                 # 规则、默认值，以及【实测】的 aclEnforced
dsh-os permission query file.delete "R:\project\**"
dsh-os permission audit --limit 50     # 追加式尾部；委托裁剪到 200 条
```

若 `permission.json` 的 `updatedBy` 不是 `consent-delegate`，它会被视为**不可信**：规则被忽略，一切退回默认值，并报告原因。也就是说，手工编辑该文件塞进去的恶意规则**不会**生效——它会被忽略，而且你会被告知。

要**创建**持久决定，必须使用委托的工具。通配目标（`target.value === "*"`）会被拒绝，除非显式传入 `acknowledgeBroad: true`——因为"对一切永久同意"必须是一个独立的决定，而不能是某次点击的副作用。

---

## 实际可用范围

统计方式：抽出各平台的分发表，与声明的动词表逐一比对。未实现的动词**从不静默失败**：它会返回一个指名道姓的 `E_NOT_SUPPORTED` 信封。

| 平台 | 已声明 | 已实现 |
|---|---|---|
| Windows PowerShell 5.1（`src/host/bin/dsh-os.ps1`） | 86 | **82** |
| PowerShell 7.6（`src/host/bin/dsh-os7.ps1`） | 86 | **82** |
| POSIX（`src/host/bin/dsh-os.sh`） | 86 | **61** |

两套 PowerShell 运行时的已实现集合**完全相同**（逐条比对两张分发表得出，不是目测）。

### Windows（5.1 与 7.6 相同）

**已实现（82）：** 全部 `file.*`（含 `file.encode`）；`file verify.*`；`file.search`；五个 `execute` 动词（`command`、`synchronous`、`asynchronous`、`query`、`kill`）；`system.*`；全部 `task.*`（含 `task.launch`）；`service.list/query`；整个 `environment` 面（含 `attribute.*`）；整个 `permission` 面（含 `grant`、`revoke`、`acl.init`）；整个 `window` 面；`screenshot`；`clipboard.read/write`；`wait.window/ms`；整个 `mouse` 与 `keyboard` 面；`text`；`structure`；`selfcheck`。

**未实现（4）：** `clipboard.paste`、`service.start`、`service.stop`、`service.restart`。

### POSIX

**已实现（61）：** 除 `file.encode` 外的整个 `file` 面；`file verify.*`；`file.search`；五个 `execute` 动词（含 Windows 侧同样具备的 `execute.command`）；`system.*`；`task.list`/`query`/`show`/`kill`（**不含 `task.launch`**）；整个 `environment` 变量层（含持久写入）与 `attribute.*` 五个动词；整个 `permission` 面；`wait.ms`；整个 `mouse` 面（7 个）与 `keyboard` 面（6 个）；`selfcheck`。

这 61 个里，**13 个需要 X display**（`mouse.*` 7 个 + `keyboard.*` 6 个），其余 48 个不需要。

**未实现（25）：** `file.encode`；全部 `window.*`（11 个）；`screenshot`、`text`、`structure`；`clipboard.read`、`clipboard.write`、`clipboard.paste`；`wait.window`；`task.launch`；全部 `service.*`（5 个：`list`、`query`、`start`、`stop`、`restart`）。这些会经分发表的默认分支返回**带类型的** `E_NOT_SUPPORTED`，而不是静默缺失。

> [!NOTE]
> POSIX 没有持久化变量的内核 API，因此 `environment add/set/delete --scope user` 是通过一个**托管块**去编辑 `${HOME}/.profile` 的，块由 `# >>> dsh-os managed environment >>>` 与 `# <<< dsh-os managed environment <<<` 标记界定。每次改动都会重新生成标记之间的全部内容，因此这些操作是幂等的，用户也可以直接删掉整个块来一次性撤销。若直接往文件里写裸赋值，第二次调用就会重复追加，而且无法撤销。`--scope machine` 不可用，会报 `E_NOT_SUPPORTED`。
>
> `environment attribute add/set/delete` 则是**仅进程作用域**，持久作用域一律以 `E_NOT_SUPPORTED` 拒绝。这是刻意的：POSIX 没有列表型变量的内核 API，要持久化就得重写 shell 启动文件，而那里一旦重建错 `PATH`，整台机器的 shell 都可能不可用。

> [!IMPORTANT]
> **POSIX 只有 `mouse.*`（7 个）与 `keyboard.*`（6 个）需要 X display。** 没有 `DISPLAY` 时它们返回**带类型的** `E_NO_DISPLAY`；装了显示但没有 `xdotool` 时返回 `E_NOT_SUPPORTED` 并点名缺失的工具。
>
> **`wait.ms` 不需要**——它只是一次 sleep，因此本机可以完整验收。`environment attribute.*` 五个动词同样不需要（它们动的是环境变量，不是桌面）。
>
> 本机（无 `DISPLAY`、无 xdotool）的黄金测试因此把它们断言成 `E_NO_DISPLAY`：**这断言的是"缺失路径"，不是"它们能用"。** 注入路径由 `tests/smoke-desktop-sh.sh` 用替身工具覆盖，见[测试](#测试)。

> [!NOTE]
> POSIX 上仍**结构性缺失**的是 `window.*`（11 个）、`screenshot`、`text`、`structure`、`clipboard.*`、`wait.window` 与全部 `service.*`。`native.sh`（515 字节）与 `service.sh`（333 字节）是刻意留空的桩，其文件头解释了原因：POSIX 上的对应物是外部程序（`wmctrl`、`import`、`xclip`、`scrot`），而不是可链接的库。
>
> **`window.sh` 不再是桩**（26 KB）：它现在实现了 `wait.ms`、全部 `mouse.*` 与 `keyboard.*`，通过 `xdotool` 驱动 X11，并在动手之前先做显示与工具的能力检查。其余桌面动词仍从分发表的默认分支返回 `E_NOT_SUPPORTED`。

### 两套实现并不对等

同名动词、同一调用约定，但在若干处**行为不同**。重要的那些：

| 方面 | Windows | POSIX |
|---|---|---|
| `execute.command` | 未实现 | 已实现（真 argv，不经 shell） |
| `file.encode` | 已实现 | 未实现 |
| `file.delete` 默认 | 进回收站 | 无 `trash-put` 则失败 |
| `file.search` 字面匹配 | 大小写不敏感 | 大小写敏感 |
| `file.view` 字符边界 | 强制校验（`E_BOUNDARY`） | **完全不校验** |
| `file.view --max-bytes` | 生效 | 被忽略（`truncated` 恒为 `false`） |
| 超过 32 MiB 的文件 | `E_TRUNCATED` | 无上限 |
| 创建／追加时的 `--eol crlf` | 精确字节 | 会多出一个结尾 CRLF |
| 追加时遇到混合行尾文件 | 原有行尾不动 | 整个文件被重新归一 |
| 无法表示的字符 | 静默写成 `?` | `E_ENCODING_INVALID` |
| `--pretty` / `--quiet` | 生效 | 接受但被忽略 |
| `--` | `E_USAGE` | 选项结束标记 |
| 受保护路径比较 | 大小写不敏感、已归一化 | 大小写敏感、按原参数 |
| 未登记错误码 | 退出码 7 | 退出码 5 |
| 失败时的 `meta.durationMs` | 真实耗时 | `0` |

`file.search` 的 `--type` 在两套实现上都是一个潜在缺陷：实现会读它，但它并未登记为已知标志，因此行为取决于解析器的兜底路径。

---

## 安装现状与已知缺陷

直说，以免有人措手不及。

### bundle 的装载路径已由三个校验器覆盖

此处曾记录：loader 端到端路径**未**验证。该缺口**已补齐**，方式是三个校验器，且它们找出了一个真实缺陷：

| 校验器 | 证明什么 | 用例 |
|---|---|---|
| `tools/verify-bundle.mjs` | loader 的**解析**契约：manifest 头、patch 文件、每一行都能从一个 profile 形态的 `node_modules` 解析、每个被解析模块都导出 loader 会调用的 Cordis 形状（`apply`/`inject`/`name`）、两行解析到**不同**模块（共享说明符会导致同一个工具注册两次并让整个入口中止）、以及版本闸门 | 10 |
| `tools/verify-plugin-load.mjs` | 真实的 `apply()` 路径：宿主插件以**根类型为 `object`** 的参数 schema 注册 `dsh_os`，授权插件注册其五个工具，并且**注册后的 handler 真的 spawn 了脚本**并返回真实信封（`selfcheck` → ok，`verbCount` 86）；不带 `allow` 的变更类动词以带类型的 `E_PERMISSION` 被拒，而不是抛异常。另含工作流一节：工具与提示词小节确实注册，且 `start → plan → choose → run` 经真实 handler 跑通、阶段门依然成立 | 30 |
| `tools/verify-editions.mjs` | 版本选择：默认仍是 PowerShell 5.1；`powershellEdition: '7.6'` 与 `DSH_OS_POWERSHELL_EDITION` 选中 7.6 产物；`'auto'` 仅在产物与可用的 `pwsh` **同时**存在时才用 7.6；配置优先于环境变量；显式 `scriptPath` 完全禁用该选择。`-ExecutionPolicy` 只传给 5.1 可执行文件 | 14 |

bundle 解析校验把包以 junction 链接进一个一次性的 profile 沙箱，因此解析行为与真实 profile 一致，而**活动 profile 从不被写入**。

它找出的缺陷是：`bin/dsh-os7.ps1` 此前**从插件侧不可达**——它存在、能构建、能测试，但 `resolveInvocation` 只找 `dsh-os.ps1`，于是全部 7.6 工作从插件角度看都是死代码。现已可选，且**默认不变**（仍为 5.1），因为一个已经工作的部署不应仅仅因为插件升级就改变行为。

**仍未证明、也不主张：** harness **自身的 loader** 真的会在活动 profile 里组合这些 bundle。那需要把本包装进用户的桌面活动 profile 并重启 harness，这一步没有做。

### Windows 黄金测试的顺序依赖已修复

此处曾记录：在干净检出上实测 `passed: 47 failed: 1`，失败用例是 `parser/one-two-three-token-verbs`，因为它断言 `file length` 作用于一个由**更晚**的用例才创建的夹具目录。

该缺陷**已修复**：`tests/golden.ps1` 的解析器用例现在自己创建夹具（`$fixtureDir = Join-Path $sandbox 'parser\verify'`，随后 `New-Item` 与 `Set-Content`），再对其断言。当前实测为 **50 通过，0 失败**。

### `tests/smoke-desktop-sh.sh` 查出的两个 POSIX 真实缺陷

这两个都在**写完之后、review 看不出来**——因为本机没有 `DISPLAY`，它们平时只表现为"反正都是 `E_NO_DISPLAY`"。用替身工具把注入路径打开后才暴露：

1. **校验发生在注入之后。** `mouse click 10 20 --count abc` **返回了错误，但指针已经被移走**——一次"失败"的调用已经改变了机器状态。Windows 侧是**先校验全部参数再注入**，POSIX 侧现已对齐。（`mouse over abc 20` 同理。）

2. **`$(...)` 里的 `fail` 不会终止动词。** 坐标校验器调用 `fail`，但调用方写的是 `x="$(window_int_arg ...)"`，于是 `exit` **只结束了子 shell**：动词带着空值继续往下走并**照常注入**——`mouse over abc 20` **移动了指针并返回 `ok`**。现在三个会拒绝输入的校验器改为**赋值变量**（`WINDOW_INT`、`WINDOW_BUTTON`、`WINDOW_KEY`），并在**调用者自己的 shell** 中读取。

   **这个陷阱本仓库的 `environment` 模块早已在注释里记录过**（`env_resolve_scope` 专门讲过为什么它赋值而不打印），而它仍然在这里被重复了一次。这两个缺陷现在由 3 个断言固化：非法入参必须**被拒绝且未注入任何东西**。

### 其他缺口

* **`tests/conformance.ps1` 曾经并不存在**，尽管 `spec/verbs.tsv` 的文件头声称它存在、并会校验与 `command.txt` 的一致性。**该文件现已创建**（见下文「两张表的一致性」），文件头的声明因此成为事实。一个"指名了守卫、而守卫并不存在"的注释比没有注释更糟，因为它会被当作保证来读。
* **同意写入委托从未注册审批 answerer**，如前所述。
* **委托在其 `query` 结果里无条件报告 `aclEnforced: false`**，而不是像脚本那样去实测 ACL。因此在 A 层已开启时，它会**低报**防护强度。
* **此处曾记载「`--shell`、`--env`、`--stdin`、`--background` 被接受但从不被读取」，以及「Windows 上 `--encoding` 构造了从未被应用的值」——两处记载均已过时，且曾经是真实缺陷，现已修复：**
  * **Windows 侧**：`--shell`、`--env`、`--stdin`、`--background` 都确实被读取（`execute.ps1` 中有对应分支）。`--encoding` 曾经**真的是惰性的**——它构造了 `$enc` 却从未使用，`StandardOutputEncoding` 在全套模块中一次都没出现，因此子进程输出始终按运行时默认解码。现已接上输出/错误流编码。**实测**：让子进程输出 GBK 字节 `D6 D0 CE C4`，默认解码得到 `����`（4 个替换字符），`--encoding gbk` 得到 `中文`（2 个字符）。
  * **POSIX 侧**：这些标志**确实从未被读取**。现已改为**显式拒绝**——`--shell`、`--env`、`--stdin`、`--background`、`--encoding` 一律返回 `E_NOT_SUPPORTED`（退出码 4），而不是静默忽略。这正是本项目自己的契约所要求的：**不可用的能力必须是显式错误，绝不能是空成功**；一个传了 `--stdin` 却没被喂入任何输入、却收到成功信封的调用方，是被误导了。
* **若干已声明的错误码确实不可达。** 在两侧实现中全文检索后确认，**零次出现**的有 `E_ENCODING_INVALID`（`file.encode`）、`E_IS_A_DIR`（`file.delete`）与 `E_ABORTED`。与此相对，`E_CHARSET_MISMATCH`（3 处）、`E_BINARY_CONTENT`、`E_TRUNCATED` 都有真实抛出点——因此这张表并非普遍不可信，但上述三个应视为尚未实现的意图，而不是可依赖的返回码。
* **此处曾记载"`E_TIMEOUT` 从未被任何一侧抛出"——该记载已过时且错误。** 它在 `execute.ps1`（`execute command` 超时）与 `window.ps1`（`wait window` 超时）中都会被抛出。实测：
  `execute command cmd.exe /c ping -n 10 127.0.0.1 --timeout 300 --allow` 返回 `{"ok":false,...,"code":"E_TIMEOUT",...,"hint":"captured so far: stdout=86 bytes, stderr=0 bytes"}`，退出码 **6**。POSIX 侧同样有 `E_TIMEOUT`（`json.sh` 映射到退出码 6）。
* **`src/client/` 是未改动的 Vite 脚手架。** 它没有与宿主接线，`index.html` 引用 `./src/main.ts` 而实际文件在 `./src/client/main.ts`，且 `node_modules` 为空——因此 `npm run build` 与 `npm run dev` 目前没有意义。
* **`git` 不是必需依赖，但也并非每个目标环境都有**，因此没有任何验收步骤依赖它。

### 尚未证实的部分

* DSH loader 会组合这个 bundle，并让 `dsh_os` 出现在活动会话中。
* 两个平台之间的动词完全对等——两个方向都没有。
* 在 harness 与委托共用同一身份的机器上 A 层的强制效果——按构造那种情况会退化为 B 层。
* 关于 macOS 或非 Linux 的 POSIX，除代码审阅之外的一切：POSIX 测试套件是为 GNU 用户态写的，此处未运行。

---

## 测试

```console
npm run test:all        # 按顺序跑下面全部
```

`test:all` 依次串联 `test:conformance`、`test:encoding`、`test`（Windows 黄金）、`test:plugin`、`test:takeover`、`test:permission`、`test:workflow`、`test:bundle`（`tools/verify-bundle.mjs`）、`test:package`（`tools/verify-package.mjs`）、`test:load`（先 `tools/verify-plugin-load.mjs`，再 `tools/verify-editions.mjs`）与 `test:desktop`（`bash tests/smoke-desktop-sh.sh`）。

| 套件 | 命令 | 用例数 | 实测结果 |
|---|---|---|---|
| 两表一致性 | `powershell -File tests/conformance.ps1` | 5 | **5 通过，0 失败** |
| 编码契约 | `powershell -File tests/encoding.ps1` | 32 个构建模块 | **全部契约成立** |
| Windows 黄金 | `powershell -File tests/golden.ps1` | 50 | **50 通过，0 失败** |
| POSIX 黄金 | `bash tests/golden-sh.sh` | 116 | **116 通过，0 失败** |
| POSIX 桌面注入 | `bash tests/smoke-desktop-sh.sh` | 52 | **52 通过，0 失败** |
| 插件 | `node tests/plugin.test.mjs` | 13 | **13 通过，0 失败** |
| 接管拦截 | `node tests/takeover.test.mjs` | 41 | **41 通过，0 失败** |
| 授权委托 | `node tests/permission.test.mjs` | 18 | **18 通过，0 失败** |
| 工作流 | `node tests/workflow.test.mjs` | 30 | **30 通过，0 失败** |
| bundle 解析 | `node tools/verify-bundle.mjs` | 16 | **16 通过，0 失败** |
| 打包完整性 | `node tools/verify-package.mjs` | 20 | **20 通过，0 失败** |
| 插件装载 | `node tools/verify-plugin-load.mjs` | 30 | **30 通过，0 失败** |
| 版本选择 | `node tools/verify-editions.mjs` | 14 | **14 通过，0 失败** |
| 构建漂移 | `powershell -File tools/build.ps1 -Check` | 3 个生成物 | **无漂移** |

> [!NOTE]
> **`test:desktop` 需要 `bash`，而本机没有。** 因此在没有 Git Bash 或 WSL 的 Windows 主机上，`npm run test:all` 会以 `'bash' is not recognized` 结束。这是运行环境缺口而非断言失败：同一次调用中位于它之前的所有套件都跑过并通过。POSIX 套件在这里依旧未被验证，原因与过去相同——它们需要一台 POSIX 主机。

### 两张表的一致性

`spec/verbs.tsv` 的文件头一直声称「`tests/conformance.ps1` 会校验它与 `command.txt` 一致」，而那个文件**并不存在**——**现已补上**，声明因此成为事实。该守卫按「**最长的、能在词表中命中某个动词的词前缀**」把 `command.txt` 的每一行解析成动词（所以 `file verify charset path charset` 解析为 `file.verify.charset`，而不会误认成不存在的 `file.verify`），然后校验：两表动词集合互相包含、数量相等、R/W 类别一致、位置参数名按序一致。

**写它的过程中查出 5 处真实不一致**，除一处外都在 `command.txt`（它是权威契约）：

| 动词 | 原声明 | 按实现应有的样子 |
|---|---|---|
| `file.append` | `path content charset` | charset 是**可选**的第三个位置参数，原写法让人以为必需 |
| `file.insert` | `path content charset offset` | charset 走 `--charset`，**刻意不是**位置参数——若它是位置参数，省略它会让 `offset` 静默移位 |
| `wait.ms` | 无位置参数 | 接受 `ms` |
| `keyboard.combination` | 两行 `... down a b c d` / `... up a b c d` | 是**一个**动词，含 `phase` 位置参数；两行写法读起来像两个动词 |
| `execute.command` | tsv 写作 `command\|arguments` | 整个位置参数列表就是 argv，不存在单独的 `command` |

其中四处改在 `command.txt`，`verbs.tsv` 的 `execute.command` 行改为 `arguments...`。**运行面没有任何改变**——变的只是两份文档的说法，而这正是这种一致性守卫存在的意义。

`tests/encoding.ps1` 守卫的是让其余一切有意义的那些契约：`.ps1` 生成物带 BOM、`.sh` 生成物不带、行尾遵循 `.gitattributes`、`command.txt` 与 `.tsv` 表保持纯 ASCII + LF，以及 **stdout 永不携带 BOM**。

**此前记载的「4 项编码违规」现已消失，但这不是"放宽了守卫"。** 规则本身从未松动，改的是它的**适用范围**：原先它要求 `src/host/lib/` 下**每个** `*.ps1` 都不带 BOM 且纯 ASCII，而其中两个 `git.ps1` 是**独立工具**——不会被拼进任何生成物，且必须带 BOM 才能在 Windows PowerShell 5.1 下正确解析其中文提示字面量。对"构建从不读取的文件"套用该规则属于**误报**。现在守卫只校验 `tools/build.ps1` 实际拼接的 **32 个模块**，并**打印出它跳过了哪些文件**，使范围的收窄是可见的而不是静默的。

> [!NOTE]
> **POSIX 桌面动词的「116 通过」与「52 通过」都不是「驱动真实窗口管理器」的证据。** 两套测试从两个方向覆盖同一批动词，而本机没有 X server：
> * `tests/golden-sh.sh` 断言**缺失路径**——没有 `DISPLAY` 时，每个桌面动词都必须返回带类型的 `E_NO_DISPLAY`，而不是空成功。
> * `tests/smoke-desktop-sh.sh` 断言**注入路径**——它把会记录调用的 `tests/fake-xdotool` 放进 `PATH` 并设置 `DISPLAY`，于是动词走真实代码路径，断言落在**交给工具的确切参数向量**上：`--button right` 是否变成按键 `3`、`Enter` 是否变成 keysym `Return`、表外的 `XF86AudioMute` 是否被原样送达、`--clearmodifiers` 与 `--repeat` 是否在正确位置、以及 xdotool 失败是否报成 `E_IO` 而不是假成功。
>
> **正是这个测试台查出了 POSIX 实现里的两个真实缺陷**（见上文「实际可用范围」与「已知缺陷」）。没有任何一套证明它们真的操作了桌面。

> [!WARNING]
> **两套黄金测试必须串行运行。** 两套实现都会把失败信封暂存到一个**固定路径**的临时文件——`.temporary/dsh-os.err`，既无 PID 也无锁——因此并发调用会互相覆盖对方待取的结果。实测并行运行 `golden.ps1` 与 `golden-sh.sh` 时报出了 2 个**假**失败：退出码与信封自身的 `error.code` 相互矛盾；改为串行后二者全部消失。请把它当作缺陷而不是随机抖动：该暂存路径在构造上就是竞态的。

---

## 参与贡献

`src/host/lib/powershell5.1/*`、`src/host/lib/powershell7.6/*` 与 `src/host/lib/*.sh` 是真源。**绝不要手改 `src/host/bin/dsh-os.ps1`、`dsh-os7.ps1` 或 `.sh`**——它们是生成物。请改模块，然后：

```console
powershell -File tools/build.ps1          # 重新生成三个脚本
powershell -File tools/build.ps1 -Check   # 已提交脚本一旦漂移即失败
```

三个生成物是分开的而不是"一份脚本加运行时分支"，因为两个运行时差异无法用分支干净地抹平：.NET Framework 没有 `ProcessStartInfo.ArgumentList`，而 .NET 10 没有理由继续背负这套项目为绕开它而手写的 Windows 命令行转义。

`git.ps1` / `git.sh` **不在** `tools/build.ps1` 的模块清单内，因此它们不被拼进任何生成物；它们是各自独立、自包含的交互式工具，详见上文"独立工具"。

`.gitattributes` 是契约的一部分而不是偏好：`command.txt` 与 `.tsv` 表必须是 LF，两套实现才能解析逐字节一致的输入；`dsh-os.bat` 必须是 CRLF 且仅 ASCII，否则 `cmd.exe` 会解析错误；`dsh-os.ps1` 必须是 CRLF 且 UTF-8 **带** BOM，否则 PowerShell 5.1 会按 ANSI 码页读取其中的非 ASCII 字面量。

两条在这个仓库里踩出来的教训，值得一并继承：

* **依赖路径推导的安全边界必须 fail-closed。** 一次重构曾让仓库根多算上一层，于是没有任何受保护路径匹配。其失败形态不是报错，而是**保护静默失效**——受保护的文件真的被删掉了。
* **临时文件统一放在 `.temporary/` 下**，黄金测试夹具也在那里。

各模块文件头仍引用已不存在的 `tools/split-once.ps1`；当前的拼装器是 `tools/build.ps1`。

---

## 独立工具

`src/host/lib/git.sh`、`src/host/lib/powershell5.1/git.ps1` 与 `src/host/lib/powershell7.6/git.ps1` 是交互式 git 运行器。它们**刻意不属于动词面**：不在 `tools/build.ps1` 的 `$modulesPs1`/`$modulesSh` 清单里，因此永远不会被拼进 `bin/dsh-os.ps1`、`bin/dsh-os7.ps1` 或 `bin/dsh-os.sh`，也不输出 JSON 信封。三者各自是单个自包含文件、彼此字节独立，靠人工评审保持一致而不是靠生成器。

它们按三阶段定位 git：`GIT_EXE`/`GIT_HOME`/`PATH` → 已知安装位置（含 Git for Windows 注册表键）→ 对每个挂载点做**有深度与时限约束**的全盘遍历；全都找不到时列出搜索过的位置并以 127 退出。参数以独立 argv 元素送达 git，绝不拼接 shell 字符串。`git add` 的输入为空（直接回车）即等价于 `git add .`。三者的编码各自服从其运行时的契约——这正是 `git.sh` 纯 ASCII（英文提示）而两个 `git.ps1` 不是的原因。

---

## 许可

**MIT**，在 `package.json` 中声明（`"license": "MIT"`，作者 Eloy Kim），并以独立的 [`LICENSE`](LICENSE) 文件随仓库分发。完全开源：整个动词面、规范文档与测试套件都在仓库里。无遥测、无需账号、运行时无网络访问。

```
MIT License

Copyright (c) 2026 Eloy Kim
```

许可证文件为纯 ASCII、LF 行尾、无 BOM，与仓库其余的编码契约保持一致。需要更正一处旧描述：它**并未**列入 `package.json` 的 `files` 白名单（该白名单共 13 项，不含 `LICENSE`，也不含 `README.zh-CN.md` 与 `dsh-os7.ps1`），因此它留在检出目录里，但不会随发布的包一起分发。

动词契约与规范文档属于源码的一部分：行为变更应当同步反映到 `src/host/spec/verbs.tsv`、`src/host/command.txt` 与 `src/host/docs/os-spec.md`，而不只是改代码。

另需说明：规范文档（`src/host/docs/os-spec.md`、`src/host/docs/permission-model.md`、`src/host/command.txt`）以**中文**撰写，而本 README 与动词表为英文。
