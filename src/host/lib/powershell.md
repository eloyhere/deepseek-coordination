# PowerShell 5.1 → 7.6 API 变化与版本说明

本文梳理 **Windows PowerShell 5.1**（2016-08）到 **PowerShell 7.6**（2026-03，当前 LTS）之间的 API 变化与版本说明，覆盖三层含义的 "API"：

1. **.NET 公开 API**——`System.Management.Automation` 等程序集中的公开类型与成员，二进制模块作者直接依赖；
2. **面向脚本的 API**——cmdlet、参数、`$PSVersionTable` 键、自动变量、偏好变量、实验性特性开关；
3. **语言语法**——运算符、语句、AST/解析器可见的语法结构。

文中标注 `⚠️` 的条目为**破坏性变更**。每条关键结论都附官方来源；文末列出[参考来源](#10-参考来源)与[版本归属的说明](#9-版本归属的说明与已知不确定项)。

---

## 1. 版本速查矩阵

| 版本 | 发布日期 | 结束支持 | 支持级别 | .NET 基线 |
| --- | :---: | :---: | :---: | --- |
| Windows PowerShell 5.1 | 2016-08 | 随 Windows 生命周期 | Windows 组件 | .NET Framework 4.5+ |
| PowerShell 6.0 | 2018-01-20 | 2019-02-13 | 已退役 | .NET Core 2.0 |
| PowerShell 6.1 | 2018-09-13 | 2019-09-28 | 已退役 | .NET Core 2.1 |
| PowerShell 6.2 | 2019-03-29 | 2020-09-04 | 已退役 | .NET Core 2.1 |
| PowerShell 7.0 | 2020-03-04 | 2022-12-03 | LTS（已退役） | .NET Core 3.1 |
| PowerShell 7.1 | 2020-11-11 | 2022-05-08 | 已退役 | .NET 5.0 |
| PowerShell 7.2 | 2021-11-08 | 2024-11-08 | LTS（已退役） | .NET 6.0 |
| PowerShell 7.3 | 2022-11-09 | 2024-05-08 | 已退役 | .NET 7.0 |
| PowerShell 7.4 | 2023-11-16 | 2026-11-10 | LTS | .NET 8.0 |
| PowerShell 7.5 | 2025-01-23 | 2026-11-10 | Stable | .NET 9.0 |
| **PowerShell 7.6** | **2026-03-18** | **2028-11-14** | **LTS（当前）** | **.NET 10.0** |
| PowerShell 7.7 | 预览中（7.7-preview.3） | — | Preview | .NET 11.0 |

来源：[PowerShell Support Lifecycle](https://learn.microsoft.com/en-us/powershell/scripting/install/powershell-support-lifecycle)、[Differences between Windows PowerShell 5.1 and PowerShell 7.x](https://learn.microsoft.com/en-us/powershell/scripting/whats-new/differences-from-windows-powershell)。

**支持的实务含义**

- **LTS 版本**（7.0 / 7.2 / 7.4 / 7.6）与 .NET 的 LTS 对齐，只接收安全更新与最小化影响的修复。
- **Stable（非 LTS）版本**（7.1 / 7.3 / 7.5）会包含新功能与创新，支持期约为"下一个 LTS 发布后 6 个月"。
- 因此从 API 稳定性角度，**7.4 与 7.6 是长期基线**，7.1 / 7.3 / 7.5 属于过渡版本。截至撰写时，7.5.11 为当前 Stable，7.6.6 为当前 LTS。
- PowerShell 仅支持某个版本的**最新补丁版本**。

---

## 2. 5.1 基线：后续版本"打破"的到底是什么

要把 API 变化讲清楚，必须先固定 5.1 的基线特征。**5.1 与 7.x 的差异主要不是 PowerShell 语言差异，而是 .NET Framework → .NET Core/.NET 迁移带来的差异**，以及由此导致的功能取舍。

### 2.1 基线对照表

| 维度 | Windows PowerShell 5.1 | PowerShell 7.x |
| --- | --- | --- |
| 可执行文件 | `powershell.exe` | `pwsh` / `pwsh.exe` |
| 首个位置参数 | `-Command` | `-File`（故 `pwsh foo.ps1` 直接可用） |
| 运行时 | .NET Framework 4.5+ | .NET Core 3.1 → .NET 10 |
| 平台 | 仅 Windows | Windows / macOS / Linux |
| 扩展机制 | 模块 **+ 管理单元（snap-in）** | **仅模块** |
| 远程处理 | WinRM (WSMan)、DCOM | WSMan（仅 Windows 服务端）+ **SSH（全平台）** |
| WMI | WMI v1（`Get-WmiObject` 等） | **仅 CIM/WMI v2** |
| 工作流 | PowerShell Workflow（基于 WF） | **已移除** |
| ISE | `powershell_ise.exe` | **已移除** |
| DSC | `PSDesiredStateConfiguration` 内置 | 7.2 起**移出产品**，改由 Gallery 分发 |
| `$PSVersionTable` | 含 `CLRVersion`、`BuildVersion` | 二者**已移除**，改用 `GitCommitId` |

### 2.2 命令行与宿主契约的变化

`pwsh` 相对 `powershell.exe` 的契约差异（对封装方、CI 调用方都是实打实的 API 变化）：

- **首个位置参数由 `-Command` 改为 `-File`**。这修复了非 Windows 平台上 `#!`（shebang）的用法，使 `pwsh foo.ps1` / `pwsh fooScript` 可直接执行；代价是执行命令时必须显式写 `-c` 或 `-Command`。
- 新增 `-i` / `-Interactive`，以符合 Unix shell 约定。
- **移除** `-ImportSystemModules` 与 `-PSConsoleFile`。
- **`-File` 支持把 `$true` / `$false` 解析为参数值**（5.1 无此能力）；switch 参数同样支持。
- `pwsh -Version` 与内置帮助对齐其他原生工具。
- `-File` / `-Command` 的非法参数错误信息与退出码对齐 Unix 约定。
- Windows 上新增 `-WindowStyle`；非 Windows 上基于包的安装改为原地更新。
- **`-i` 语义变更**：Unix 上 `-i` 原本可作为 `-InputFormat` 的简写，现在必须写 `-in`。

### 2.3 已从产品中移除的模块

`ISE`、`Microsoft.PowerShell.LocalAccounts`、`Microsoft.PowerShell.ODataUtils`、`Microsoft.PowerShell.Operation.Validation`、`PSScheduledJob`、`PSWorkflow`、`PSWorkflowUtility`。

### 2.4 已移除的 cmdlet

| 模块 | 已移除的 cmdlet |
| --- | --- |
| CimCmdlets | `Export-BinaryMiLog` |
| Microsoft.PowerShell.Core | `Add-PSSnapin`、`Export-Console`、`Get-PSSnapin`、`Remove-PSSnapin`、`Resume-Job`、`Suspend-Job` |
| Microsoft.PowerShell.Diagnostics | `Export-Counter`、`Import-Counter` |
| Microsoft.PowerShell.Management | `Add-Computer`、`Checkpoint-Computer`、`Clear-EventLog`、`Complete-Transaction`、`Disable-ComputerRestore`、`Enable-ComputerRestore`、`Get-ComputerRestorePoint`、`Get-ControlPanelItem`、`Get-EventLog`、`Get-Transaction`、`Get-WmiObject`、`Invoke-WmiMethod`、`Limit-EventLog`、`New-EventLog`、`New-WebServiceProxy`、`Register-WmiEvent`、`Remove-Computer`、`Remove-EventLog`、`Remove-WmiObject`、`Reset-ComputerMachinePassword`、`Restore-Computer`、`Set-WmiInstance`、`Show-ControlPanelItem`、`Show-EventLog`、`Start-Transaction`、`Test-ComputerSecureChannel`、`Undo-Transaction`、`Use-Transaction`、`Write-EventLog` |
| Microsoft.PowerShell.Utility | `Convert-String`、`ConvertFrom-String` |
| PSDesiredStateConfiguration | `Disable-DscDebug`、`Enable-DscDebug`、`Get-DscConfiguration`、`Get-DscConfigurationStatus`、`Get-DscLocalConfigurationManager`、`Publish-DscConfiguration`、`Remove-DscConfigurationDocument`、`Restore-DscConfiguration`、`Set-DscLocalConfigurationManager`、`Start-DscConfiguration`、`Stop-DscConfiguration`、`Test-DscConfiguration`、`Update-DscConfiguration` |

**移除原因归类**（理解原因比记住清单更有用）：

| 原因 | 涉及项 | 替代方案 |
| --- | --- | --- |
| WMI v1 API 不受支持 | `Get-WmiObject`、`Invoke-WmiMethod`、`Set-WmiInstance`、`Remove-WmiObject`、`Register-WmiEvent` | CimCmdlets（WMI v2），语法重新设计 |
| WCF/SOAP 不受支持 | `New-WebServiceProxy` | `Invoke-RestMethod` / `Invoke-WebRequest` |
| 使用率极低 | `*-Transaction`、`Resume-Job`、`Suspend-Job`、`Export-Counter` / `Import-Counter` | 无 |
| 依赖不受支持的 API | `*-EventLog` | `Get-WinEvent` / `New-WinEvent` |
| 扩展模型被淘汰 | `*-PSSnapin`、`Export-Console` | 模块（`Import-Module`） |
| WPF 依赖（**已在 7.0 恢复**） | `Show-Command`、`Out-GridView`、`Get-Help -ShowWindow` | .NET Core 3.1 起支持 WPF，故回归 |

### 2.5 二进制模块作者的基线差异

| 项 | 5.1 | 7.x |
| --- | --- | --- |
| 引擎程序集 | `System.Management.Automation.dll`（.NET Framework / GAC） | `$PSHOME` 下的 `System.Management.Automation.dll`（.NET） |
| 编译目标 | .NET Framework 的 SMA 引用程序集，或 `Microsoft.PowerShell.5.1.ReferenceAssemblies` | **`PowerShellStandard.Library`**（当前版本 **5.1.1**，目标框架 `netstandard2.0` 与 `net452`） |
| 版本判别 | `$PSVersionTable.PSEdition` = `Desktop` | `PSEdition` = `Core` |
| 程序集加载顺序 | 先 GAC 后模块基路径 | **先模块基路径后 GAC** |
| 运行空间 API | `RunspaceConfiguration` 或 `InitialSessionState` | **仅 `InitialSessionState`** |

`PowerShellStandard.Library` 版本历史：`5.1.0`（2018-11-30）、**`5.1.1`（2019-03-07，当前最新）**；更早还有 `3.0.0-preview-*`。包说明为 "Contains the reference assemblies for PowerShell Standard 5"。来源：[NuGet: PowerShellStandard.Library](https://www.nuget.org/packages/PowerShellStandard.Library)。

---

## 3. 引擎与 API 语义变化（跨版本主题汇总）

这一节按**变化主题**而非版本次序组织，便于定位问题。

### 3.1 .NET 运行时迁移导致的方法重载变化 ⚠️

PowerShell 直接暴露底层 .NET 类型，因此 .NET 的重载变化会直接影响脚本。典型例子是 `String.Split`：

```powershell
# 5.1：可把 char[] 当 string 传入；7.x：该重载绑定结果不同
'1111p2222q3333'.Split('pq')          # 7.x 返回整串原样
'1111p2222q3333'.Split([char[]]'pq')  # 7.x 需显式转型才能得到预期拆分
```

`New-Object` 与 `[type]::new()` 也会因新增构造函数重载而改变绑定结果。**结论：任何直接调用 .NET 方法的脚本在跨大版本升级时都必须重新验证绑定结果。**

来源：[Be aware of .NET method changes](https://learn.microsoft.com/en-us/powershell/scripting/whats-new/differences-from-windows-powershell)。

### 3.2 错误语义与 `$?`

| 变化 | 说明 |
| --- | --- |
| `$?` 不再自动为 `true` | `(...)`、`$(...)`、`@()` 的编译方式改变；**PowerShell 7 起** `$?` 始终反映其中最后一条命令的真实成败 |
| 原生命令写 `stderr` 不再使 `$?` 为 `$false` | 仅当 `$LASTEXITCODE` 非零时 `$?` 才为 `$false` |
| `$ErrorActionPreference` 不再影响原生命令的 `stderr` | `stderr` 仍被捕获为 `ErrorRecord`，但不再套用偏好变量 |
| `-Verbose` / `-Debug` 不再覆盖 `$ErrorActionPreference` | `-Debug` 把 `$DebugPreference` 设为 **Continue**（原为 **Inquire**） |
| 默认错误视图 | 7.0 起默认 **ConciseView**（5.1 为 **NormalView**），可用 `$ErrorView` 切换 |
| `ErrorAccentColor` | 7.0 起 `$Host.PrivateData` 新增该属性 |
| `Get-Error` | 7.0 新增，输出含内部异常的完整错误详情，支持 `-Newest` 与管道输入 `$Error` |
| `RecommendedAction` | 7.5 起 ConciseView 展示 `RecommendedAction`（[#20826](https://github.com/PowerShell/PowerShell/pull/20826)） |
| `ErrorRecord` 字符串化 | 7.6 起空异常消息的 `ErrorRecord` 字符串化为空字符串（[#24949](https://github.com/PowerShell/PowerShell/pull/24949)） |

### 3.3 编码

| 变化 | 版本 |
| --- | --- |
| `$OutputEncoding` 默认由 **ASCII** 改为 **UTF-8 NoBOM** | 6.0 |
| 文件系统 Provider 的 `-Encoding` 统一为 `System.Text.Encoding`；**移除 `Byte` 取值**，改用 **`-AsByteStream`** | 6.0 |
| `New-ModuleManifest` 在非 Windows 平台改为 **UTF8NoBOM**（原 UTF-16 带 BOM） | 6.0 |
| `-Encoding` 接受**数字代码页 ID 或代码页名称** | 6.2 |
| 指定 `utf7` 时发出警告 | 7.1 |
| `-Encoding` 接受 **`ANSI`** | 7.4 |

（`Select-String -Encoding` 的说明见 [官方文档](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/select-string?view=powershell-7.6)。）

### 3.4 参数绑定

- **显式命名参数可覆盖 splatting 中的同名参数**：splatting 参数被移到参数列表**末尾**，因而在所有显式命名参数之后绑定。这也改变了 `$args` 中参数的出现顺序。
- `ValueFromRemainingArguments` 现在返回**数组**，而非"本身是数组的单个值"。
- `Mandatory` / `ValidateNotNull` / `ValidateNotNullOrEmpty` 对**值类型元素**的集合跳过 null 元素检查。
- 所有内置 `-LiteralPath` 参数统一新增别名 **`-lp`**。
- `Mandatory` 属性使 `Get-Help` 可能把带 `ValueFromRemainingArguments` 的参数报告为可管道输入（7.5 修正，[#23871](https://github.com/PowerShell/PowerShell/pull/23871)）。

### 3.5 输出与格式化

| 变化 | 版本 |
| --- | --- |
| `Format-Hex -Raw` 变为无操作（默认行为已等同于原 `-Raw`） | 6.0 |
| `Group-Object` 输出**有序**（性能优化结果，不应依赖顺序） | 6.0 |
| `Measure-Object` 新增 **`StandardDeviation`** 属性 | 6.0 |
| `Export-Csv` **默认 `-NoTypeInformation`** | 6.0 |
| `Import-Csv` 支持 W3C Extended Log File Format；存在类型信息时应用到 `pstypenames` | 6.0 |
| `Get-Content -Delimiter` 返回值**不再包含分隔符** | 6.0 |
| `Get-ComputerInfo` 属性名 `BiosSeralNumber` 修正为 `BiosSerialNumber` | 6.0 |
| `$PSStyle` 引入（ANSI 渲染） | 7.2 |
| `Out-String` / `Out-File` 对**纯字符串**输入保持不变；需应用格式视图时才按 `OutputRendering` 增删转义序列（相对 7.2 是破坏性变更） | 7.2.6 |
| `$PSStyle.OutputRendering` 默认值改为 **`Host`** | 7.3 |
| `Out-String` / `Out-File` 对字符串输入**保持原样** | 7.3 |
| `$PSStyle.Dim` / `DimOff`；`PSStyle` 三个 ConsoleColor → ANSI 静态映射方法 | 7.4 |
| 计算字段的表头默认使用斜体 | 7.4 |
| `Write-Host` 遵循 `OutputRendering = PlainText` | 7.6（[#21188](https://github.com/PowerShell/PowerShell/pull/21188)） |

### 3.6 Provider、路径与文件系统

- `Get-Item -LiteralPath a*b`：通配符按**字面**处理，不存在则**报错**（旧行为静默返回）。
- `cd DriveName:` 返回该驱动器的**上次工作目录**，而非驱动器默认位置。
- `cd -` 返回上一个目录；`cd` / `cd --` 切换到 `$HOME`；7.4 新增函数 `cd~`。
- **`Test-Path` 对空白字符串返回 `$false`**（5.1 行为不同，属 7.0 起的变更）；空字符串返回错误；`$null`、`$null` 数组或空数组返回**非终止性错误**（`NullPathNotPermitted`）。
- **`Test-Path -IsValid` 的字符校验回归**：.NET Core 2.1 起 Path API 不再对非法字符抛异常，导致 `-IsValid` 不再检查非法字符；该回归已在 **7.5 修复**（[#21358](https://github.com/PowerShell/PowerShell/pull/21358)）。
- `FileSystemInfo.Target` 由 **CodeProperty** 改为指向 `FileSystemInfo.LinkTarget` 的 **AliasProperty**（7.2 破坏性变更）。
- `Resolve-Path -RelativeBasePath` 对相对路径的处理改变（7.4，[#19755](https://github.com/PowerShell/PowerShell/pull/19755)）。

### 3.7 作业与并发

| 能力 | 5.1 | 7.0+ |
| --- | --- | --- |
| 后台作业运算符 `&`（行尾） | ❌ | ✅ 等价 `Start-Job`，返回 `Job` 对象；变量自动复制；作业在当前目录运行；同时是语句终止符 |
| `ForEach-Object -Parallel` / `-ThrottleLimit` | ❌ | ✅ 默认 `ThrottleLimit` = 5；用 `Using:` 传变量引用 |
| `Start-ThreadJob` | ❌ | ✅ 线程作业（模块随产品分发，见 4.10 的改名） |
| `Start-Job` 工作目录 | 用户主目录 | **当前目录** |

### 3.8 与 Windows PowerShell 的互操作

- **`Import-Module -UseWindowsPowerShell`**：在 7.x 中创建代理模块，隐式调用本地 Windows PowerShell 进程运行该模块的 cmdlet（Windows 专用兼容层）。
- **`Import-Module -SkipEditionCheck`**：允许列出/导入 `CompatiblePSEdition` 未声明 `Core` 的模块。
- PowerShell 启动时把 `$windir\System32` 加入 `PSModulePath`，但**只暴露 `CompatiblePSEdition` 含 `Core` 的模块**；`Get-Module` 输出新增 `PSEdition` 属性。
- 隐式远程代理 cmdlet 现在正确作用于通用参数（7.5 修正，[#20367](https://github.com/PowerShell/PowerShell/pull/20367)）。

### 3.9 Web cmdlet 底层改写（6.0）⚠️

底层由 `System.Net.WebRequest` 换成 **`System.Net.Http.HttpClient`**，这是 5.1 → 7.x 中影响最大的 API 面变化之一。5.1 用户升级时必须核对：

| 项 | 5.1 | 7.x |
| --- | --- | --- |
| `Invoke-WebRequest` 返回类型 | 含完整 DOM 的对象 | **始终** `BasicHtmlWebResponseObject`（仅基础 HTML 解析） |
| `ParsedHtml`、`Forms` 属性 | ✅ | **已移除** |
| `BasicHtmlWebResponseObject.Headers` 值类型 | `String` | **`String[]`** |
| `BasicHtmlWebResponseObject.BaseResponse` | — | `System.Net.Http.HttpResponseMessage` |
| Web cmdlet 异常的 `Response` 属性 | — | `System.Net.Http.HttpResponseMessage` |
| `-Headers` / `-UserAgent` 解析 | 宽松 | **严格 RFC**，可用 `-SkipHeaderValidation` 绕过 |
| `file://`、`ftp://` | ✅ | **不支持** |
| `System.Net.ServicePointManager` 设置 | 遵循 | **不遵循** |
| 对 `http://` 使用 `-Credential` | 允许 | **报错**，需 `https://` 或 `-AllowUnencryptedAuthentication` |
| `-MaximumRedirection` 超限 | 返回最后一次重定向结果 | **终止性错误** |

---

## 4. 逐版本变化

### 4.1 PowerShell 6.0（2018-01-20，.NET Core 2.0）

跨平台化起点，破坏面最大的一次迁移。

**宿主与命令行**

- `powershell.exe` → `pwsh`；首个位置参数 `-Command` → `-File`；新增 `-i`；移除 `-ImportSystemModules` / `-PSConsoleFile`（详见 2.2）。
- **移除自定义管理单元（snap-in）**支持。
- **移除 `RunspaceConfiguration` 支持**：编程创建运行空间只能用 `InitialSessionState`。

**引擎与 API**

- `Add-Type`：移除 `AddTypeCommandBase` 类；**移除 Visual Basic 语言支持**。
- **`$PSVersionTable` 移除 `ClrVersion` 与 `BuildVersion`**，改用 `GitCommitId`。
- `CommandInvocationIntrinsics.InvokeScript`：参数绑定到 **`$input`** 而非 `$args`（原为参数位置错误导致的行为）。
- 清理工作流相关 API：`WorkflowInfo` 公开构造函数改 internal；移除 `System.Management.Automation.DebugSource` 类型；移除 `Debugger` / `RemotingJobDebugger` 中仅用于工作流调试的 `SetParent` 重载。
- `ScriptBlock` 转换为委托时**不再把结果包装为 `PSObject`**。
- 二进制模块程序集加载顺序：**先模块基路径，后 GAC**。
- 实现 **Unicode 转义解析**：`` `u#### `` / `` `u{####} ``；输出字面 `` `u `` 需写 `` ``u ``。
- 新增自动变量 `$IsCoreCLR`、`$IsWindows`、`$IsLinux`、`$IsMacOS`。
- 引入 `-SkipEditionCheck` 与 `PSEdition` 模块属性支持。

**语言与语义**

- PSCustomObject 新增 **`Count` / `Length` 属性**以及 **`ForEach` / `Where` 方法**。
- 支持把 **`PSMethod` 转换为委托**（可把静态方法作为委托传给 .NET API）。
- 范围运算符 `..` **新增字符范围**支持（`'a'..'f'`）。
- `$?` 语义修正（ParenExpression / SubExpression / ArrayExpression）。
- `Group-Object` 输出排序；`Measure-Object` 新增 `StandardDeviation`。
- `$PSCulture` 一致反映会话内的区域性变更（修正 5.1 的缓存行为）。

**新 cmdlet**：`Get-Uptime`、`Remove-Alias`、`Remove-Service`。

**Web cmdlet**：底层改写为 `HttpClient`（详见 3.9）；新增 `-AllowUnencryptedAuthentication`、`-Authentication`、`-CustomMethod`、`-NoProxy`。

### 4.2 PowerShell 6.1（2018-09-13，.NET Core 2.1）

- 新增 Markdown 系列：`ConvertFrom-Markdown`、`Get-MarkdownOption`、`Set-MarkdownOption`、`Show-Markdown`。
- 新增 **`Test-Json`**（可选用 JSON Schema 校验）。
- 新增 `Import-Csv` 的 W3C 扩展日志格式支持等。
- **`Enable-PSRemoting` 为预览版本创建独立会话配置**（如 `PowerShell.6.2-preview.1`、`PowerShell.6-preview`）。
- SSH 远程处理支持 `user@host:port` 连接串。
- Web cmdlet 新增 **`-Form`**（简化 `multipart/form-data`）。

### 4.3 PowerShell 6.2（2019-03-29，.NET Core 2.1）

- **引入实验性特性（Experimental Features）框架**，新增 `Get-ExperimentalFeature`、`Enable-ExperimentalFeature`、`Disable-ExperimentalFeature`。这是后续所有新 API 的"孵化通道"，也是理解 7.x 演进的关键。
- 新增 **`Join-String`**。
- `Select-Object` 新增 `-SkipIndex`（文档写作"Windows PowerShell 6.0"）。
- `ConvertFrom-Json` 新增 **`-Depth`**（默认 1024）。
- `-Encoding` 支持数字代码页 ID 或代码页名称。
- Web cmdlet：JSON 响应默认 UTF-8（RFC 8259）；新增 `-SkipHeaderValidation`、`-Resume`。

### 4.4 PowerShell 7.0（2020-03-04，.NET Core 3.1，LTS）

**语言与运算符**——这一批是 5.1 用户感知最直接的变化

| 语法 | 说明 | 5.1 |
| --- | --- | --- |
| `??` | null 合并；左侧非 null 时不计算右侧 | ❌ |
| `??=` | null 合并赋值 | ❌ |
| `? :` | 三元运算符 | ❌ |
| `&&` / `||` | 管道链运算符，依据左侧管道成败条件执行右侧 | ❌ |
| `&`（行尾） | 后台作业运算符 | ❌ |
| `?.` / `?[]` | null 条件访问（**7.0 实验性 → 7.1 转正式**，见 4.5） | ❌ |

**引擎与 API**

- `ForEach-Object` 新增 **`-Parallel`** 与 **`-ThrottleLimit`**。
- 默认错误视图 **ConciseView**；`$Host.PrivateData` 新增 `ErrorAccentColor`。
- 新增 **`Get-Error`** cmdlet。
- **恢复 WPF 相关功能**：`Show-Command`、`Out-GridView`、`Get-Help -ShowWindow`。
- **`Invoke-DscResource` 以实验性特性形式回归**。
- 引入 **`Import-Module -UseWindowsPowerShell`** 兼容层。

**cmdlet 变化**

- `-lp` 统一为所有 `-LiteralPath` 的别名。
- `Start-Job` 使用当前目录作为工作目录。
- 从 `Rename-Computer` / `Restart-Computer` / `Stop-Computer` 移除 `-Protocol`（**DCOM 不再支持**）。
- 从 `*-Service` cmdlet 移除 `-ComputerName`（改用 `Invoke-Command`）。
- `Get-Content -Delimiter` 不再返回分隔符；`Format-Hex -Raw` 变为无操作。
- `Export-Csv` 默认 `-NoTypeInformation`；`Import-Csv` 支持 W3C 格式并应用 `pstypenames`。
- `Update-Help` 不再需要管理员权限，默认保存到用户范围目录。
- `Where-Object` 新增 `-Not`。
- `Get-PfxCertificate` 新增 `-Password`（`SecureString`），使其可非交互使用。
- 移除 `more` 函数；`help` 改用 `more.com`（Windows）或 `$Env:PAGER`（非 Windows）。
- **对以下 cmdlet 传 `$null` 现在报错**（原为返回所有对象）：`Get-Credential -UserName`、`Get-Event -SourceIdentifier`、`Get-EventSubscriber -SourceIdentifier`、`Get-Help -Name`、`Get-PSBreakpoint -Script`、`Get-PSProvider -PSProvider`、`Get-PSSessionConfiguration -Name`、`Get-Runspace -Name`、`Get-RunspaceDebug -RunspaceName`、`Get-Service -Name`、`Get-TraceSource -Name`、`Get-Variable -Name`。
- 哈希算法 `MACTripleDES`、`RIPEMD160` 被 .NET 移除，影响 `Get-FileHash`。
- `Select-String` 开始使用 ANSI 序列高亮匹配（见 `about_ANSI_Terminals`）。
- `Test-Path` 对空白字符串返回 `$false`。

### 4.5 PowerShell 7.1（2020-11-11，.NET 5.0）

- **null 条件运算符 `?.` / `?[]` 由实验性转为正式**。
- **字符串比较行为变化** ⚠️：.NET 5 起，固定区域性（culture-invariant）字符串比较**忽略不可打印控制字符**。例如 `'Food' -eq "Foo`ad"` 返回 `True`（`` `a `` 为 Ctrl-G / `[char]7`）。
- 指定 `utf7` 编码时发出警告。
- Web cmdlet 的 **`-OutFile` 改为类似 `-LiteralPath`**，**不处理通配符**。

### 4.6 PowerShell 7.2（2021-11-08，.NET 6.0，LTS）

**破坏性变更** ⚠️

- **`PSDesiredStateConfiguration` 移出 PowerShell 7 安装包**，改发布到 PowerShell Gallery，产品与 DSC 解耦。安装时**必须限制主版本**，例如 `Install-Module PSDesiredStateConfiguration -Repository PSGallery -MaximumVersion 2.99`（否则会装到差异很大的 v3+）。
- `FileSystemInfo.Target` 由 **CodeProperty** 改为指向 `FileSystemInfo.LinkTarget` 的 **AliasProperty**。
- `ConvertTo-Json` 超出 `-Depth` 时**发出警告**。
- 移除 `-Directory` 的别名 `D`。
- 在 **NoLanguage** 模式下锁定环境中限制 `New-Object`。
- 改进可变值类型（mutable value type）检测。
- 在 Execution Policy Bypass 之前先强制执行 AppLocker Deny 配置。
- `-PipelineVariable` 保证对脚本 cmdlet 的所有输出生效（[#12766](https://github.com/PowerShell/PowerShell/pull/12766)）。
- 允许从**原生代码加载程序集**的实验性特性 `PSLoadAssemblyFromNativeCode`；引擎新增 `LoadAssemblyFromNativeMemory`，使原生 PowerShell 宿主可从内存加载程序集（[#14652](https://github.com/PowerShell/PowerShell/pull/14652)）。

**新增/转正**

- 实验性特性转正式：`PSAnsiRendering`、`PSAnsiProgress`、`PSCultureInvariantReplaceOperator`、`PSNotApplyErrorActionToStderr`、`PSUnixFileStat`、`Microsoft.PowerShell.Utility.PSImportPSDataFileSkipLimitCheck`、`Microsoft.PowerShell.Utility.PSManageBreakpointsInRunspace`。
- 新增实验性特性：**`PSNativeCommandArgumentPassing`**（改用 `StartProcessInfo.ArgumentList` 而非重建字符串，并新增自动变量 `$PSNativeCommandArgumentPassing`）、**`PSAnsiRenderingFileInfo`**、`PSLoadAssemblyFromNativeCode`。
- **引入自动变量 `$PSStyle`** 与 ANSI 渲染引擎改动：格式化系统遵循 `$PSStyle.OutputRendering`；新增 `StringDecorated` 类型处理含 ANSI 转义的字符串（`IsDecorated` 属性、`Length` 返回不含转义序列的文本长度、`Substring(int contentLength)`、`ToString(bool Ansi)`、`FormatHyperlink(string text, uri link)`）。
  - `$PSStyle.OutputRendering` 取值：`ANSI` / `PlainText` / `Host`（默认）。
- 支持 **Microsoft Update**（MSI 参数 `USE_MU`、`ENABLE_MU`）。
- **Linux 通用安装包**：把原先 8 个发行版包合并为一个，自动安装所需依赖。
- 支持 Windows / macOS 的 **ARM64**，以及 Debian / Ubuntu 的 **ARM32 与 ARM64**。
- PSReadLine 2.1 引入 **Predictive IntelliSense**（`CommandPrediction` API 框架）；默认关闭，用 `Set-PSReadLineOption -PredictionSource History` 启用。

### 4.7 PowerShell 7.3（2022-11-09，.NET 7.0）

**破坏性变更** ⚠️

- **不再支持 Windows 7**（合规相关的 Windows API 更新/移除）。
- PowerShell Direct for Hyper-V 仅支持 Windows 10 1804 及以上。
- **`$PSStyle.OutputRendering` 默认值改为 `Host`**。
- `Out-String` / `Out-File` 对字符串输入**保持原样**（不再重排换行）。
- **`System.Security.AccessControl.ObjectSecurity` 的类型数据（type data）移入 `Microsoft.PowerShell.Security` 模块**：使用其代码属性/代码方法前**必须显式导入该模块**（[#16355](https://github.com/PowerShell/PowerShell/pull/16355)）。
- `Test-Connection` 因 .NET 7 的有意破坏性变更而失效（跟踪于 [#17018](https://github.com/PowerShell/PowerShell/issues/17018)）。

**语言**：script block 新增 **`clean` 块**，与 `begin` / `process` / `end` 并列，用于资源清理（[#15177](https://github.com/PowerShell/PowerShell/pull/15177)）。

**远程处理**

- PSRP over SSH 新增 **`-Options`**，可直传 OpenSSH 选项（[#12802](https://github.com/PowerShell/PowerShell/pull/12802)）。
- `pwsh` 新增 **`-ConfigurationFile`**，可用 `.pssc` 文件定义会话配置启动新进程（[#17447](https://github.com/PowerShell/PowerShell/pull/17447)）。
- `New-PSSessionConfigurationFile` 支持非 Windows 平台。

**cmdlet 变化**

- Web cmdlet 新增 `-HttpVersion`。
- `ConvertTo-Json -Depth` 上限放宽到 **100**（[#16197](https://github.com/PowerShell/PowerShell/pull/16197)）。
- `Invoke-Command` 新增 `-StrictMode`；改进 `$using:` 变量处理。
- **`ConvertFrom-Json -AsHashtable` 改为返回有序哈希表 `OrderedHashtable`**（[#17405](https://github.com/PowerShell/PowerShell/pull/17405)）——该参数本身自 6.0 起存在，此前返回普通 `Hashtable`。
- `Get-CimClass` 新增 `-Amended`。
- `New-TimeSpan` 新增 `-Milliseconds`。
- `Set-AuthenticodeSignature -TimeStampServer` 支持 HTTPS。
- 新增类型加速器 **`ordered`**（`OrderedDictionary`）。
- `pwsh` 新增 `-NoProfileLoadTime`。
- 显示方法定义/重载时展示可选参数。
- 移除 `Out-GridView` 收到的字符串中的 ANSI 转义序列。
- 表格中的十进制数字按当前区域性渲染。
- 即使当前工作目录已不存在，命令仍可执行（[#17579](https://github.com/PowerShell/PowerShell/pull/17579)）。

**实验性特性**

- 转正式：`PSAnsiRenderingFileInfo`、`PSCleanBlock`、`PSAMSIMethodInvocationLogging`、**`PSNativeCommandArgumentPassing`**、`PSExec`（新增 `Switch-Process` cmdlet，别名 `exec`）。
- 新增：`PSNativeCommandErrorActionPreference`。
- **移除**：`PSNativePSPathResolution`、`PSStrictModeAssignment`。

### 4.8 PowerShell 7.4（2023-11-16，.NET 8.0，LTS）

**破坏性变更** ⚠️

| 变更 | 说明 | PR |
| --- | --- | --- |
| **通用参数新增 `ProgressAction`** | 影响所有 cmdlet 的通用参数集合 | — |
| **空字符串参数改抛 `ArgumentException`** | 部分 PowerShell API 原先抛 `ArgumentNullException` | [#19215](https://github.com/PowerShell/PowerShell/pull/19215) |
| **移除 `#Requires -PSSnapin`** | 相关代码被删除 | [#19320](https://github.com/PowerShell/PowerShell/pull/19320) |
| **`Test-Json` 改用 JsonSchema.NET** | 见下方说明 | [#18141](https://github.com/PowerShell/PowerShell/pull/18141) |
| **移除 PSv2 遗留代码，删除 `TabExpansion` 函数** | 依赖该函数的自定义补全需迁移 | [#18337](https://github.com/PowerShell/PowerShell/pull/18337) |
| `Resolve-Path -RelativeBasePath` 相对路径处理改变 | | [#19755](https://github.com/PowerShell/PowerShell/pull/19755) |
| 实验性特性 **`PSNativeCommandPreserveBytePipe` 转正式** | 原生命令 stdout 重定向到文件、或把字节流管道送入 stdin 时**保留字节流** | — |
| `Test-Connection` | 输出包含更详细的 TCP 连接测试信息；因 .NET 变更，Linux 上自定义缓冲区大小需 `sudo` | [#20369](https://github.com/PowerShell/PowerShell/pull/20369) |
| Nano Server Docker 镜像不再提供 | | — |

**`Test-Json` 的重要变化**（官方 `Test-Json` 文档明确）：

> Beginning in PowerShell 7.4, `Test-Json` uses `System.Text.Json` for JSON parsing and `JsonSchema.NET` for schema validation. With these changes, `Test-Json`:
> - No longer supports Draft 4 schemas
> - Only supports strictly conformant JSON

注意：**`ConvertFrom-Json` 仍使用 Newtonsoft.Json**，因此仍可转换带注释的 JSON。

**新增 API / cmdlet**

| 新增项 | 说明 | PR |
| --- | --- | --- |
| **`ValidateNotNullOrWhiteSpace`** | 新的参数验证特性 | [#17191](https://github.com/PowerShell/PowerShell/pull/17191) |
| **`NoRunspaceAffinity`** | 使 PowerShell 类不与运行空间关联 | [#18138](https://github.com/PowerShell/PowerShell/pull/18138) |
| **`Get-SecureRandom`** | 新 cmdlet | [#19587](https://github.com/PowerShell/PowerShell/pull/19587) |
| **`PSStyle` 三个静态方法** | `MapForegroundColorToEscapeSequence`、`MapBackgroundColorToEscapeSequence`、`MapColorPairToEscapeSequence`（把 `ConsoleColor` 映射为 ANSI 转义序列） | [#17938](https://github.com/PowerShell/PowerShell/pull/17938) |
| `$PSStyle.Dim` / `DimOff` | | [#18653](https://github.com/PowerShell/PowerShell/pull/18653) |
| `Set-Clipboard -AsOSC52` | 便于远程场景 | [#18222](https://github.com/PowerShell/PowerShell/pull/18222) |
| `ConvertTo-Csv` / `Export-Csv` `-NoHeader` | | [#19108](https://github.com/PowerShell/PowerShell/pull/19108) |
| `Stop-Transcript` `-Confirm` / `-WhatIf` | | [#18731](https://github.com/PowerShell/PowerShell/pull/18731) |
| `Get-Command -FuzzyMinimumDistance` | | [#18261](https://github.com/PowerShell/PowerShell/pull/18261) |
| `Test-Json -Path` / `-LiteralPath` | | [#19042](https://github.com/PowerShell/PowerShell/pull/19042) |
| `Select-Object` / `Get-Unique` `-CaseInsensitive` | | [#19683](https://github.com/PowerShell/PowerShell/pull/19683) |
| `Select-Object` 允许 `-Skip` 与 `-SkipLast` 组合 | | [#18849](https://github.com/PowerShell/PowerShell/pull/18849) |
| `Copy-Item` / `Remove-Item` 进度条 | | [#18735](https://github.com/PowerShell/PowerShell/pull/18735)、[#20778](https://github.com/PowerShell/PowerShell/pull/20778) |
| 获取 `PSModulePath` 各元素位置的公共 API | | [#19422](https://github.com/PowerShell/PowerShell/pull/19422) |
| `ProgressRecord` 不再强制要求 Activity | | [#18474](https://github.com/PowerShell/PowerShell/pull/18474) |
| `Get-Content` 的 `-Head` / `-Tail` 禁止负值 | | [#19715](https://github.com/PowerShell/PowerShell/pull/19715) |
| `#Requires -PSSnapin` 移除后补全也相应调整 | | — |

**Web cmdlet 变化**（重点 API 面）

| 项 | 版本 | 说明 |
| --- | --- | --- |
| **`-TimeoutSec` → `-ConnectionTimeoutSeconds`** | 7.4 | 文档明确：**"This parameter replaced the `TimeoutSec` parameter in PowerShell 7.4. You can use `TimeoutSec` as an alias for `ConnectionTimeoutSeconds`."** 即旧名称仍可用（作为**别名**） |
| 新增 **`-OperationTimeoutSeconds`** | 7.4 | [#19558](https://github.com/PowerShell/PowerShell/pull/19558) |
| 新增 `-AllowInsecureRedirect` | 7.4 | 文档明确 "added in PowerShell 7.4"；默认 **https → http 重定向报错** |
| 新增 `-PreserveHttpMethodOnRedirect` | 7.4 | [#18894](https://github.com/PowerShell/PowerShell/pull/18894) |
| 请求字符编码默认 **UTF-8**（原 ASCII） | 7.4 | 需其他编码时在 `Content-Type` 中设 `charset` |
| `ContentType` 参数**优先于** `Headers` 中的 `Content-Type` | 7.4 | — |
| 解压缩支持 **Brotli** | 7.4 | [#17955](https://github.com/PowerShell/PowerShell/pull/17955) |
| 重定向码加入 **308** | 7.4 | [#18536](https://github.com/PowerShell/PowerShell/pull/18536) |
| 429 时从 `Retry-After` 响应头获取间隔 | 7.4 | [#18717](https://github.com/PowerShell/PowerShell/pull/18717)、修正 [#19622](https://github.com/PowerShell/PowerShell/pull/19622) |
| `HttpResponseException` 新增 **`StatusCode`** | 7.4 | [#18842](https://github.com/PowerShell/PowerShell/pull/18842) |
| 支持 **HTTP 持久连接** | 7.4 | [#19249](https://github.com/PowerShell/PowerShell/pull/19249) |
| 支持 **Unix domain socket**（`-UnixSocket`） | 7.4 | [#19343](https://github.com/PowerShell/PowerShell/pull/19343) |
| `MultipartFileContent` 新增 `FileNameStar` | 7.4 | [#19467](https://github.com/PowerShell/PowerShell/pull/19467) |
| **`WebResponseObject` 新增 `OutFile` 属性** | 7.5 | [#24047](https://github.com/PowerShell/PowerShell/pull/24047) |
| `-PassThru` 与 `-OutFile` 可同时使用 | 7.5 | [#24086](https://github.com/PowerShell/PowerShell/pull/24086) |

**实验性特性生命周期**

- 转正式：`PSConstrainedAuditLogging`、`PSCustomTableHeaderLabelDecoration`、`PSNativeCommandErrorActionPreference`、`PSNativeCommandPreserveBytePipe`、`PSWindowsNativeCommandArgPassing`。
- 新增：**`PSFeedbackProvider`**（用可扩展的 feedback provider 取代硬编码建议框架；同时为 `$PSStyle.Formatting` 新增 **`FeedbackName` / `FeedbackText` / `FeedbackAction`** 属性）、**`PSModuleAutoLoadSkipOfflineFiles`**、**`PSCommandWithArgs`**（支持把参数作为单个字符串传递）。
- 变更：`PSCommandNotFoundSuggestion` 改用可扩展的 feedback provider（[#18726](https://github.com/PowerShell/PowerShell/pull/18726)）。

### 4.9 PowerShell 7.5（2025-01-23，.NET 9.0，Stable）

构建于 **.NET 9.0**（7.5.11 对应 .NET 9.0.20）。随附 PSResourceGet v1.1.1、PSReadLine v2.3.6。

**破坏性变更** ⚠️

| 变更 | 说明 | PR |
| --- | --- | --- |
| **`Test-Path -OlderThan` / `-NewerThan` 行为修正** | 7.5 起可与任意 `PathType` 组合、可**同时使用构成日期范围**、可测试目录年龄。此前这三类用法都被静默忽略 | [#20942](https://github.com/PowerShell/PowerShell/pull/20942) |
| **`New-FileCatalog -CatalogVersion` 默认值改为 2** | | [#20428](https://github.com/PowerShell/PowerShell/pull/20428) |
| **受限远程会话中禁止从网络位置获取帮助** | | [#20593](https://github.com/PowerShell/PowerShell/pull/20593) |
| **`ConvertTo-Json` 把 `BigInteger` 序列化为数字** | | [#21000](https://github.com/PowerShell/PowerShell/pull/21000) |
| 大枚举值在 `ConvertTo-Json` 中按数字处理 | 实验性特性 `PSSerializeJSONLongEnumAsNumber` | [#20999](https://github.com/PowerShell/PowerShell/pull/20999) |
| Windows 安装程序记住上次安装选项作为下次默认值 | | [#20420](https://github.com/PowerShell/PowerShell/pull/20420) |

**⚠️ 类型变更（对强类型代码有影响）**

> **`MatchInfo.LineNumber` 的类型由 `Int32` 改为 `UInt64`。**

.NET API 文档中 `MatchInfo.LineNumber` 同时列出两个版本：`Microsoft.PowerShell.Commands.Utility v7.4.15` → `public int LineNumber`；`v7.5.6`、`v7.6.1` → `public ulong LineNumber`。即 **7.5 起为 `ulong`**，对应 PR [#24075](https://github.com/PowerShell/PowerShell/pull/24075)。

**新 cmdlet 与参数**

| 新增项 | 版本/说明 | PR |
| --- | --- | --- |
| **`ConvertTo-CliXml`** | 文档明确 "introduced in PowerShell 7.5-preview.4"。把对象转换为 CliXml **字符串**，与 `Export-Clixml` 类似但**不写文件**；参数 `-InputObject`（位置 0，必填）、`-Depth`（默认 2） | [#21063](https://github.com/PowerShell/PowerShell/pull/21063) |
| **`ConvertFrom-CliXml`** | 与上者配对，从 CliXml 字符串还原对象（还原后类型带 `Deserialized.` 前缀） | [#21063](https://github.com/PowerShell/PowerShell/pull/21063) |
| `Test-Json -Options` | 文档明确 "added in PowerShell 7.5.0-preview.4"；取值 `IgnoreComments`、`AllowTrailingCommas` | [#23817](https://github.com/PowerShell/PowerShell/pull/23817) |
| `ConvertFrom-Json -DateKind` | 文档明确 "introduced in PowerShell 7.5"；取值 `Default`/`Local`/`Utc`/`Offset`/`String`，类型为 `JsonDateKind` | [#20925](https://github.com/PowerShell/PowerShell/pull/20925) |
| `Resolve-Path` / `Convert-Path` `-Force` | 支持通配符隐藏文件 | [#20981](https://github.com/PowerShell/PowerShell/pull/20981) |
| `New-Guid -Empty` / `-InputObject` | | [#20014](https://github.com/PowerShell/PowerShell/pull/20014) |
| `Get-ChildItem -Recurse` 别名 **`r`** | | [#20100](https://github.com/PowerShell/PowerShell/pull/20100) |
| `Register-PSSessionConfiguration -NoRestart` | | [#23891](https://github.com/PowerShell/PowerShell/pull/23891) |

**其他 API 与行为变化**

- `Get-Process -IncludeUserName` **取消管理员要求**（[#21302](https://github.com/PowerShell/PowerShell/pull/21302)）。
- **`Test-Path -IsValid` 恢复非法路径/文件名字符检查**（修复 .NET Core 2.1 引入的回归，[#21358](https://github.com/PowerShell/PowerShell/pull/21358)）。
- `Set-Acl` 对无法转换的 SID 不再失败（[#21096](https://github.com/PowerShell/PowerShell/pull/21096)）。
- `Move-Item` 移动到自身时抛错（[#24004](https://github.com/PowerShell/PowerShell/pull/24004)）。
- `Remove-Item` 新增进度条（[#20778](https://github.com/PowerShell/PowerShell/pull/20778)）。
- `Get-Error` 修正数组值序列化（[#21085](https://github.com/PowerShell/PowerShell/pull/21085)）。
- `Out-GridView` 用自定义实现替换已废弃的 `BinaryFormatter`（[#25559](https://github.com/PowerShell/PowerShell/pull/25559)）。
- `pwsh` 传入非法 `-ExecutionPolicy` 时报错（[#20460](https://github.com/PowerShell/PowerShell/pull/20460)）。
- `Start-Transcript` 允许用 `$Transcript`（`PSObject` 包装的字符串）指定路径（[#24963](https://github.com/PowerShell/PowerShell/pull/24963)）。
- `Start-Process -Wait` 轮询效率改进（[#24711](https://github.com/PowerShell/PowerShell/pull/24711)）。
- 引擎：**.NET 泛型方法的重载定义改进**（[#21326](https://github.com/PowerShell/PowerShell/pull/21326)）；**对象数组 `+=` 操作大幅优化**（[#23901](https://github.com/PowerShell/PowerShell/pull/23901)）。
- `Import-Module` 中处理器架构校验方式修正（[#24265](https://github.com/PowerShell/PowerShell/pull/24265)）。

**性能**：官方 What's New 给出的对照数据显示，10240 元素场景下 `+=` 从 **约 1668 ms** 降到 **约 105 ms**，且快于 `List<T>.Add(T)`。

**实验性特性**

- 转正式：`PSCommandNotFoundSuggestion`、`PSCommandWithArgs`、`PSModuleAutoLoadSkipOfflineFiles`。
- 新增：**`PSRedirectToVariable`**（重定向到变量，[#20381](https://github.com/PowerShell/PowerShell/pull/20381)）、**`PSNativeWindowsTildeExpansion`**（为 Windows 原生可执行文件做 `~` 展开，[#20402](https://github.com/PowerShell/PowerShell/pull/20402)）、`PSSerializeJSONLongEnumAsNumber`（[#20999](https://github.com/PowerShell/PowerShell/pull/20999)）。

### 4.10 PowerShell 7.6（2026-03-18，.NET 10.0，LTS，当前版本）

构建于 **.NET 10.0（LTS）**；当前补丁版本为 **7.6.6**（.NET 10.0.12）。随附 **Microsoft.PowerShell.PSResourceGet v1.2.0**、**PSReadLine v2.4.5**、**Microsoft.PowerShell.ThreadJob v2.2.0**。

**破坏性变更** ⚠️

| 变更 | 说明 | PR |
| --- | --- | --- |
| **`ThreadJob` 模块改名为 `Microsoft.PowerShell.ThreadJob`** | `Start-ThreadJob` 本身不变；**受影响的是使用模块限定名的脚本**，需改为 `Microsoft.PowerShell.ThreadJob\Start-ThreadJob` | — |
| **`Join-Path -ChildPath` 类型由 `string` 改为 `string[]`** | 官方文档：**"Beginning in PowerShell 7.6, this parameter accepts an array of strings."** 可替代 `-AdditionalChildPath`（后者自 6.0 起存在） | [#24677](https://github.com/PowerShell/PowerShell/pull/24677) |
| **`WildcardPattern.Escape` 修正** | 正确处理**孤立反引号**（lone backtick）的转义 | [#25211](https://github.com/PowerShell/PowerShell/pull/25211) |
| **事件源名称去掉尾随空格** | 影响依赖事件源名称精确匹配的代码 | [#24192](https://github.com/PowerShell/PowerShell/pull/24192) |
| `ConvertTo-Json` 大枚举按数字处理 | 原实验性特性转正式 | [#20999](https://github.com/PowerShell/PowerShell/pull/20999) |

**新增 API**

| 新增项 | 说明 | PR |
| --- | --- | --- |
| **`Cmdlet.PipelineStopToken`** | 类型为 **`System.Threading.CancellationToken`** 的只读属性，管道停止时发出信号（.NET API 文档：`public System.Threading.CancellationToken PipelineStopToken { get; }`，程序集 `System.Management.Automation.dll`）。使自定义 cmdlet 能正确响应取消 | [#24620](https://github.com/PowerShell/PowerShell/pull/24620) |
| **`SystemPolicy` 公开 API 在 Unix 上可见但无操作** | 目的是使其能被纳入 **`PowerShellStandard.Library`**——对跨平台二进制模块作者是重要变化 | [#25051](https://github.com/PowerShell/PowerShell/pull/25051) |
| **`PSForEach` / `PSWhere`** | 作为 `ForEach` / `Where` 内建方法的别名 | [#25511](https://github.com/PowerShell/PowerShell/pull/25511) |
| `Register-ArgumentCompleter -NativeFallback` | 为原生命令注册**兜底**补全器 | [#25230](https://github.com/PowerShell/PowerShell/pull/25230) |
| `Get-Clipboard -Delimiter` | | [#26572](https://github.com/PowerShell/PowerShell/pull/26572) |
| `Get-Command -ExcludeModule` | | [#18955](https://github.com/PowerShell/PowerShell/pull/18955) |
| `Import-LocalizedData` 隐式本地化回退 | | [#19896](https://github.com/PowerShell/PowerShell/pull/19896) |
| `[bigint]` 转换支持千位分隔符 | | [#25396](https://github.com/PowerShell/PowerShell/pull/25396) |
| 原生命令退出码支持十六进制显示 | | [#21067](https://github.com/PowerShell/PowerShell/pull/21067) |
| `PSDiagnostics` 模块在 PowerShell 7 中管理 `PowerShellCore` provider | | [#25590](https://github.com/PowerShell/PowerShell/pull/25590) |
| PowerShell 类作用域可访问继承的 `protected internal` 实例成员 | | [#25245](https://github.com/PowerShell/PowerShell/pull/25245) |
| `TypeName.GetReflectionType()` 支持泛型类型定义（位于 `GenericTypeName` 中） | | [#24985](https://github.com/PowerShell/PowerShell/pull/24985) |
| `Get-Item` 列出备用数据流（ADS）时返回正确的 `FileName` | | [#18019](https://github.com/PowerShell/PowerShell/pull/18019) |
| `FileSystemProvider.CreateDirectory` 使用绝对路径 | | [#24615](https://github.com/PowerShell/PowerShell/pull/24615) |
| `Get-Help` 参数展示新增 `Aliases`；`Get-Command -Noun`、`Get-Module -PSEdition`、`New-ItemProperty -PropertyType` 等新增参数补全 | | — |

**其他行为修正**

- `ConvertFrom-Json` 忽略**数组字面量内**的注释（[#26050](https://github.com/PowerShell/PowerShell/pull/26050)）。
- `-Debug` 不再触发 `ShouldProcess` 提示（[#26081](https://github.com/PowerShell/PowerShell/pull/26081)）。
- `Write-Host` 遵循 `OutputRendering = PlainText`（[#21188](https://github.com/PowerShell/PowerShell/pull/21188)）。
- 高级函数的通用参数 `-ProgressAction` 修正（[#24591](https://github.com/PowerShell/PowerShell/pull/24591)）。
- 多线程向控制台写进度记录时的 `NullReferenceException` 修正（[#25440](https://github.com/PowerShell/PowerShell/pull/25440)）。
- `New-Item -Force` 传入非法目录名时报错（[#24936](https://github.com/PowerShell/PowerShell/pull/24936)）。
- `New-Item` 把 `-Target` 视为字面量（[#25186](https://github.com/PowerShell/PowerShell/pull/25186)）。
- `Get-Service` 获取非关键属性时忽略常见错误（[#24245](https://github.com/PowerShell/PowerShell/pull/24245)）。
- `Get-ItemProperty` 对强制转换异常报告非终止性错误（[#21115](https://github.com/PowerShell/PowerShell/pull/21115)）。
- `Test-ModuleManifest` 支持 UNC 路径（[#24115](https://github.com/PowerShell/PowerShell/pull/24115)）。
- `Get-TypeData` / `Get-FormatData` 立即写入管道而非先收集（[#24236](https://github.com/PowerShell/PowerShell/pull/24236)）。
- 符号链接目标相对于符号链接本身解析，而非工作目录（[#20943](https://github.com/PowerShell/PowerShell/pull/20943)）。
- `Get-Process` / `Start-Process -NoNewWindow` 标准句柄处理改进（[#25061](https://github.com/PowerShell/PowerShell/pull/25061)）。
- 内部接口 `IDeepCloneable` 改为 internal（[#25552](https://github.com/PowerShell/PowerShell/pull/25552)）。

**引擎与安全**

| 变更 | 说明 | PR |
| --- | --- | --- |
| **支持在 AppContainer 中使用** | | [#27423](https://github.com/PowerShell/PowerShell/pull/27423) |
| **PSRP 协议弃用会话密钥交换** | 在**新客户端与新服务端之间**弃用；跨版本远程场景需注意 | [#25774](https://github.com/PowerShell/PowerShell/pull/25774) |
| 新增 WLDP 设置 `EnableFileOnlyEntry` 支持 | | [#27922](https://github.com/PowerShell/PowerShell/pull/27922) |
| `WldpCanExecuteFile` 之后回退到 AppLocker 检查 | | [#24912](https://github.com/PowerShell/PowerShell/pull/24912) |
| 可通过环境变量 `POWERSHELL_DIAGNOSTICS_OPTOUT` 关闭命名管道监听器 | | [#26086](https://github.com/PowerShell/PowerShell/pull/26086) |
| `stderr` 输出遵循 `NO_COLOR` | | [#24391](https://github.com/PowerShell/PowerShell/pull/24391) |
| `pwsh -file` 对高级函数脚本的点源（dot-sourcing）行为修正 | | [#27762](https://github.com/PowerShell/PowerShell/pull/27762) |
| `ConsoleHost` 移除 `IsScreenReaderActive()` 检查 | | [#26118](https://github.com/PowerShell/PowerShell/pull/26118) |
| feedback provider 默认超时由 300 ms 改为 **1000 ms** | | [#25910](https://github.com/PowerShell/PowerShell/pull/25910) |
| `MethodInvocation` trace 支持重载跟踪 | | [#21320](https://github.com/PowerShell/PowerShell/pull/21320) |
| 关闭子 ssh 进程后关闭管道客户端句柄 | | [#26564](https://github.com/PowerShell/PowerShell/pull/26564) |
| 遥测遵循 Windows 上的诊断与反馈设置 | | [#27438](https://github.com/PowerShell/PowerShell/pull/27438) |
| 更新通知延迟一周，确保所有包可用 | | [#27220](https://github.com/PowerShell/PowerShell/pull/27220) |
| 修复 `CompletionCompleters.CompleteFilename()` 的空引用异常回归 | | [#26487](https://github.com/PowerShell/PowerShell/pull/26487) |

**本地化 / 打包**

- macOS PKG 包已由 Microsoft **公证并签名**。
- 使用原生 `rpmbuild` / `pkgbuild` 取代 `fpm` 生成 RPM 与 macOS 包（[#26441](https://github.com/PowerShell/PowerShell/pull/26441)、[#26501](https://github.com/PowerShell/PowerShell/pull/26501)）。
- 为 LTS 发布创建独立的 Linux / macOS 包（`#27162`、`#27163`）。

**DSC**：DSC v3 的 PowerShell Profile 资源（[#26447](https://github.com/PowerShell/PowerShell/pull/26447)）。

**实验性特性**

- **转正式**：**`PSFeedbackProvider`**、**`PSNativeWindowsTildeExpansion`**、**`PSRedirectToVariable`**、**`PSSubsystemPluginModel`**。
- **新增**：**`PSSerializeJSONLongEnumAsNumber`**（`ConvertTo-Json` 大枚举按数字）、**`PSProfileDSCResource`**（为 PowerShell Profile 提供 DSC v3 资源）。

来源：[What's New in PowerShell 7.6](https://learn.microsoft.com/en-us/powershell/scripting/whats-new/what-s-new-in-powershell-76)、[7.6 Changelog](https://github.com/PowerShell/PowerShell/blob/master/CHANGELOG/7.6.md)。

---

## 5. 专题：按关注点索引 API 变化

### 5.1 `System.Management.Automation` 公开 API 变化

| 变化 | 版本 | 影响面 |
| --- | --- | --- |
| **移除 `RunspaceConfiguration` 支持**，仅支持 `InitialSessionState` | 6.0 | 运行空间宿主程序 |
| 移除 `DebugSource` 类型；`WorkflowInfo` 构造函数改 internal；移除工作流相关 `SetParent` 重载 | 6.0 | 工作流 / 调试器集成 |
| `Add-Type` 移除 `AddTypeCommandBase` 类 | 6.0 | 仅影响 `Add-Type` 内部 |
| `CommandInvocationIntrinsics.InvokeScript` 参数绑定到 `$input` 而非 `$args` | 6.0 | 宿主 / 反射调用 |
| `ScriptBlock` → 委托转换不再包装 `PSObject` | 6.0 | 从 C# 调用 PowerShell 委托 |
| 移除 `Add-Type` 的 Visual Basic 语言支持 | 6.0 | 使用 VB 编译的脚本 |
| 移除自定义管理单元（snap-in）支持 | 6.0 | 旧扩展 |
| `$PSStyle` 类与 `StringDecorated` 类型 | 7.2 | ANSI 渲染、C# 互操作 |
| `LoadAssemblyFromNativeMemory`（原生宿主从内存加载程序集） | 7.2 | 原生宿主 |
| `ObjectSecurity` 类型数据移入 `Microsoft.PowerShell.Security` | 7.3 | **需显式导入模块** |
| `NoRunspaceAffinity` 特性 | 7.4 | PowerShell 类 |
| `ValidateNotNullOrWhiteSpace` 特性 | 7.4 | 参数验证 |
| 空字符串参数改抛 `ArgumentException` | 7.4 | 调用方异常处理 |
| `ProgressRecord` 完成记录不再要求 Activity | 7.4 | 提供程序 / 自定义 cmdlet |
| `PSStyle` 三个 `ConsoleColor` → ANSI 静态映射方法 | 7.4 | 主机 / UI |
| 获取 `PSModulePath` 元素位置的公共 API | 7.4 | 模块发现 |
| `PSMethodInvocationConstraints.GetHashCode` 修正 | 7.5 | 相等性判断 |
| **`Cmdlet.PipelineStopToken`**（`CancellationToken`） | **7.6** | **自定义 cmdlet 取消支持** |
| **`SystemPolicy` 公开 API 在 Unix 可见但无操作（为纳入 `PowerShellStandard.Library`）** | **7.6** | **跨平台二进制模块** |
| `TypeName.GetReflectionType()` 支持泛型类型定义 | 7.6 | 类型系统反射 |
| `IDeepCloneable` 改为 internal | 7.6 | 内部实现收敛 |

### 5.2 语言语法引入版本

| 语法 | 引入版本 | 备注 |
| --- | --- | --- |
| `using namespace` / `using assembly` / `using module` | 5.0 | 5.1 基线已具备 |
| 类（`class`）、枚举（`enum`） | 5.0 | 5.1 基线已具备 |
| `??`、`??=`、`&&`、`\|\|`、`? :` | **7.0** | 5.1 完全没有 |
| `?.` / `?[]`（null 条件访问） | **7.0 实验性 → 7.1 正式** | 需写 `${var}` 形式 |
| `&`（行尾后台作业运算符） | 7.0 | 同时是语句终止符 |
| 字符范围 `'a'..'f'` | 6.0 | 数字范围更早已有 |
| Unicode 转义 `` `u{...} `` | 6.0 | — |
| `ForEach-Object -Parallel` / `-ThrottleLimit` | 7.0 | 5.1 无并行管道 |
| **`clean` 块** | **7.3** | 与 `begin`/`process`/`end` 并列（[#15177](https://github.com/PowerShell/PowerShell/pull/15177)） |

### 5.3 远程处理与 PSRP

| 能力 | 5.1 | 7.x |
| --- | :---: | :---: |
| WinRM (WSMan) | ✅ | ✅（**仅 Windows 可作服务端**） |
| DCOM | ✅（受限） | ❌（`-Protocol` 已移除） |
| **SSH 远程** | ❌ | ✅ 全平台（`-HostName` / `-UserName` / `-SSHTransport`） |
| `user@host:port` 连接串 | ❌ | ✅（6.1 起） |
| SSH `-Options` 透传 | ❌ | ✅（7.3，[#12802](https://github.com/PowerShell/PowerShell/pull/12802)） |
| `pwsh -ConfigurationFile` | ❌ | ✅（7.3，[#17447](https://github.com/PowerShell/PowerShell/pull/17447)） |
| `New-PSSessionConfigurationFile` 非 Windows | ❌ | ✅（7.3） |
| 多版本会话配置（主版本 + 具体版本 + 预览版） | ❌ | ✅（6.1 起） |
| 隐式远程代理 cmdlet 对通用参数生效 | — | 7.5 修正（[#20367](https://github.com/PowerShell/PowerShell/pull/20367)） |
| PSRP 会话密钥交换 | 使用 | **7.6 起在新客户端/新服务端之间弃用**（[#25774](https://github.com/PowerShell/PowerShell/pull/25774)） |

**兼容性提示**：PowerShell 7 的 `Enable-PSRemoting` 为**主版本**（如 `PowerShell.7`）、**具体版本**（如 `PowerShell.7.6.0`）以及**预览版本**分别创建会话配置。跨大版本远程连接时要明确指定目标配置名。

### 5.4 序列化与 JSON

| 能力 | 版本 | 说明 |
| --- | --- | --- |
| `ConvertFrom-Json` 支持 JSON 注释 | 6.0 | 5.1 遇到注释**报错** |
| `ConvertFrom-Json -AsHashtable` | 6.0 | 7.3 起返回 **`OrderedHashtable`**（此前为 `Hashtable`） |
| `ConvertFrom-Json -Depth`（默认 1024） | 6.2 | — |
| `ConvertTo-Json -Depth` 上限 **100** | 7.3 | 7.2 起超限发出警告 |
| `Test-Json` 改用 `System.Text.Json` + `JsonSchema.NET`，**不再支持 Draft 4** | 7.4 | 且仅支持严格合规的 JSON |
| `Test-Json -Path` / `-LiteralPath` | 7.4 | — |
| `Test-Json -Options`（`IgnoreComments`、`AllowTrailingCommas`） | 7.5 | 弥补 7.4 切换后的兼容性回归 |
| `ConvertFrom-Json -DateKind` | 7.5 | `JsonDateKind` 枚举 |
| **`ConvertTo-CliXml` / `ConvertFrom-CliXml`** | **7.5** | 字符串级 CLIXML 转换（`ConvertTo-CliXml` 的 `-Depth` 默认 **2**） |
| `ConvertTo-Json` 大 `BigInteger` 按数字 | 7.5 | — |
| `ConvertTo-Json` 大枚举按数字 | 7.5 实验性 / **7.6 正式** | — |
| `Out-GridView` 弃用 `BinaryFormatter` | 7.5 / 7.6 | 改为自定义序列化实现 |
| `ConvertFrom-Json` 忽略数组字面量内注释 | 7.6 | [#26050](https://github.com/PowerShell/PowerShell/pull/26050) |

### 5.5 自动变量差异

| 变量 | 5.1 | 7.x |
| --- | :---: | :---: |
| `$IsCoreCLR`、`$IsWindows`、`$IsLinux`、`$IsMacOS` | ❌ | ✅（6.0 起） |
| `$PSEdition` | ❌ | ✅ |
| `$PSStyle` | ❌ | ✅（7.2 起） |
| `$EnabledExperimentalFeatures` | ❌ | ✅（6.2 起） |
| `$PSNativeCommandArgumentPassing` | ❌ | ✅（7.2 实验性 / 7.3 正式） |
| `$PSNativeCommandUseErrorActionPreference` | ❌ | ✅（7.3 实验性 / 7.4 正式） |
| `$PSNativeCommandPreserveBytePipe` | ❌ | ✅（7.4 正式） |
| `$PSItem`、`$foreach`、`$switch`、`$Matches`、`$LASTEXITCODE`、`$PSSenderInfo` 等 | ✅ | ✅ |
| `$ConsoleFileName` | ✅ | 保留（但 `-PSConsoleFile` / `Export-Console` 已移除） |

### 5.6 `$PSVersionTable` 键差异

| 键 | 5.1 | 6.x | 7.x |
| --- | :---: | :---: | :---: |
| `PSVersion` | ✅ | ✅ | ✅ |
| `PSEdition` | ❌ | ✅ | ✅ |
| `PSCompatibleVersions` | ✅ | ✅ | ✅ |
| **`BuildVersion`** | ✅ | ❌ | ❌ |
| **`CLRVersion`** | ✅ | ❌ | ❌ |
| `GitCommitId` | ❌ | ✅ | ✅ |
| `OS` | ❌ | ✅ | ✅ |
| `Platform` | ❌ | ✅ | ✅ |
| `PSRemotingProtocolVersion` | ✅ | ✅ | ✅ |
| `SerializationVersion` | ✅ | ✅ | ✅ |
| `WSManStackVersion` | ✅ | ✅ | ✅ |

> `PSEdition` 的取值：**`Desktop`** 适用于 PowerShell 4 及更低版本，以及完整 Windows 版本上的 PowerShell 5.1；**`Core`** 适用于 PowerShell 6 及以上，以及 Windows Nano Server / Windows IoT 等精简版本上的 Windows PowerShell 5.1。
> `Platform` 在 Linux 与 macOS 上的值为 **`Unix`**。

判别运行时环境的推荐做法：

```powershell
$PSVersionTable.PSEdition            # 'Desktop' 或 'Core'
$PSVersionTable.PSVersion            # [semver]
$PSVersionTable.GitCommitId          # 精确构建版本（5.1 无此键）

# 查询实际的 .NET 运行时（官方推荐）
[System.Runtime.InteropServices.RuntimeInformation]::FrameworkDescription
```

### 5.7 实验性特性总览

实验性特性机制自 **6.2** 引入，是理解 7.x API 演进的关键：新功能先以实验性特性交付，获得反馈后再转正式。**实验性特性可能在后续版本被改名、转正甚至移除**（例如 7.3 移除了 `PSNativePSPathResolution` 与 `PSStrictModeAssignment`），因此不应在生产环境依赖。

```powershell
Get-ExperimentalFeature                              # 列出全部
Enable-ExperimentalFeature  -Name PSRedirectToVariable
Disable-ExperimentalFeature -Name PSRedirectToVariable
$EnabledExperimentalFeatures                         # 已启用的特性名列表
```

| 版本 | 新增实验性特性 | 转为正式 |
| --- | --- | --- |
| 6.2 | 机制本身 | — |
| 7.2 | `PSNativeCommandArgumentPassing`、`PSAnsiRenderingFileInfo`、`PSLoadAssemblyFromNativeCode` | `PSAnsiRendering`、`PSAnsiProgress`、`PSCultureInvariantReplaceOperator`、`PSNotApplyErrorActionToStderr`、`PSUnixFileStat`、`PSImportPSDataFileSkipLimitCheck`、`PSManageBreakpointsInRunspace` |
| 7.3 | `PSNativeCommandErrorActionPreference` | `PSAnsiRenderingFileInfo`、`PSCleanBlock`、`PSAMSIMethodInvocationLogging`、`PSNativeCommandArgumentPassing`、`PSExec` |
| 7.4 | `PSFeedbackProvider`、`PSModuleAutoLoadSkipOfflineFiles`、`PSCommandWithArgs` | `PSConstrainedAuditLogging`、`PSCustomTableHeaderLabelDecoration`、`PSNativeCommandErrorActionPreference`、`PSNativeCommandPreserveBytePipe`、`PSWindowsNativeCommandArgPassing` |
| 7.5 | `PSRedirectToVariable`、`PSNativeWindowsTildeExpansion`、`PSSerializeJSONLongEnumAsNumber` | `PSCommandNotFoundSuggestion`、`PSCommandWithArgs`、`PSModuleAutoLoadSkipOfflineFiles` |
| 7.6 | `PSSerializeJSONLongEnumAsNumber`、`PSProfileDSCResource` | `PSFeedbackProvider`、`PSNativeWindowsTildeExpansion`、`PSRedirectToVariable`、`PSSubsystemPluginModel` |

---

## 6. 迁移与兼容实践

### 6.1 从 5.1 迁移到 7.x 的检查清单

1. **WMI**：`Get-WmiObject` / `Invoke-WmiMethod` / `Set-WmiInstance` → `Get-CimInstance` / `Invoke-CimMethod` / `Set-CimInstance`。
2. **管理单元**：`Add-PSSnapin` 已移除 → `Import-Module`。
3. **工作流**：`workflow` 语句不可用 → 改用 `ForEach-Object -Parallel`、`Start-ThreadJob`，或计划任务 + 自行持久化状态（官方推荐后者用于恢复场景）。
4. **事件日志**：`Get-EventLog` / `Write-EventLog` → `Get-WinEvent` / `New-WinEvent`。
5. **WPF 相关**：`Out-GridView` / `Show-Command` 自 7.0 恢复，但**仅限 Windows**。
6. **编码**：核对 `$OutputEncoding` 与 `-Encoding Byte`（→ `-AsByteStream`）的依赖。
7. **`-ComputerName`**：`*-Service` 已移除该参数 → `Invoke-Command`。
8. **DCOM**：`-Protocol` 已从 `*-Computer` cmdlet 移除。
9. **错误处理**：核对 `$?`、`$ErrorActionPreference` 与原生命令 `stderr` 的新语义。
10. **Web cmdlet**：`ParsedHtml` / `Forms` 已移除；`-Headers` 严格解析；`file://`、`ftp://` 不再支持；`-TimeoutSec` 在 7.4 起被 `-ConnectionTimeoutSeconds` 取代（旧名保留为别名）。
11. **DSC**：7.2 起需从 Gallery 安装 `PSDesiredStateConfiguration`，并**务必限制主版本**。
12. **`ObjectSecurity` 类型数据**：7.3 起需显式 `Import-Module Microsoft.PowerShell.Security`。
13. **`Test-Json`**：7.4 起不支持 Draft 4；含注释的 JSON 需在 7.5+ 用 `-Options IgnoreComments`。
14. **类型敏感的强类型代码**：
    - 7.5 起 `MatchInfo.LineNumber` 为 **`ulong`**；
    - 7.6 起 `Join-Path -ChildPath` 为 **`string[]`**。
15. **模块限定名**：7.6 起 `ThreadJob` 应写为 `Microsoft.PowerShell.ThreadJob`。
16. **直接调用 .NET 方法**：逐个复核重载绑定（见 3.1）。

### 6.2 编写跨 5.1 / 7.x 模块

```powershell
# 模块清单：声明同时支持 Desktop 与 Core
@{
    CompatiblePSEditions = @('Desktop', 'Core')   # 5.1 = Desktop, 7.x = Core
    PowerShellVersion    = '5.1'
    # ...
}
```

```powershell
# 运行时按版本分派
if ($PSVersionTable.PSEdition -eq 'Desktop') {
    # 5.1 分支：可使用 Windows-only API
}
else {
    # 7.x 分支：可使用 ??、? :、-Parallel、clean 块等
}
```

**模块自动加载**：PowerShell 启动时把 `$windir\System32` 加入 `PSModulePath`，但**只暴露 `CompatiblePSEdition` 含 `Core` 的模块**；用 `Get-Module -SkipEditionCheck` 可查看全部。需要运行仅支持完整框架的模块时，用 `Import-Module -UseWindowsPowerShell`（Windows 专用）。

**二进制模块**：针对 **`PowerShellStandard.Library` 5.1.1**（`netstandard2.0` / `net452`）编译可同时覆盖 5.1 与 7.x。7.6 把 `SystemPolicy` 的公开 API 在 Unix 上改为"可见但无操作"，正是为了让这类跨平台程序集能统一编译。

### 6.3 生产环境建议

- **优先选择 LTS**（当前 **7.6**；7.4 支持到 2026-11-10）。
- **不要依赖实验性特性**：它们可能在下一版本改名或移除。
- **Stable 版本升级要读 What's New 的 Breaking Changes 段落**：7.3 / 7.5 都有影响面较广的行为修正。
- **关注 `$PSStyle.OutputRendering`**：7.3 起默认 `Host`，会把管道/重定向输出中的 ANSI 序列剥离；需要原样传下游时必须显式设为 `ANSI`。

---

## 7. 快速参考：各版本的"关键一句"

| 版本 | 关键变化 |
| --- | --- |
| 5.1 | 基线：Windows-only、.NET Framework、管理单元、WMI v1、工作流、`powershell.exe` |
| 6.0 | 跨平台化：`pwsh`、.NET Core 2.0，移除 snap-in / 工作流 / WMI v1 / `RunspaceConfiguration` |
| 6.1 | Markdown cmdlet、`Test-Json`、SSH `user@host:port`、Web cmdlet `-Form` |
| 6.2 | **实验性特性框架**、`Join-String`、`ConvertFrom-Json -Depth` |
| 7.0 | **`??` / `??=` / `? :` / `&&` / `\|\|` / `&`**、`ForEach-Object -Parallel`、ConciseView、`Get-Error`、WPF 恢复、DSC 实验性回归 |
| 7.1 | `?.` / `?[]` 转正式、.NET 5 字符串比较语义变化、Web `-OutFile` 字面化 |
| 7.2 | **`$PSStyle`**、DSC 移出产品、原生参数传递实验性特性、Microsoft Update |
| 7.3 | **`clean` 块**、`$PSStyle.OutputRendering` 默认 `Host`、`ObjectSecurity` 类型数据迁移、`ConvertFrom-Json -AsHashtable` 有序化、`ConvertTo-Json -Depth` 上限 100 |
| 7.4 | **通用参数 `ProgressAction`**、`Test-Json` 换引擎（弃 Draft 4）、`ValidateNotNullOrWhiteSpace`、`-ConnectionTimeoutSeconds`、`Get-SecureRandom`、字节流保留转正 |
| 7.5 | **`ConvertTo-CliXml` / `ConvertFrom-CliXml`**、`MatchInfo.LineNumber` → `ulong`、`Test-Path` 日期范围修正、`ConvertFrom-Json -DateKind`、`+=` 性能大幅提升 |
| **7.6** | **`Cmdlet.PipelineStopToken`**、**`Join-Path -ChildPath` → `string[]`**、**`ThreadJob` 改名**、`SystemPolicy` 跨平台可见、AppContainer 支持、PSRP 弃用会话密钥交换 |

---

## 8. 参考来源

**官方文档（Microsoft Learn）**

- [What's New in PowerShell 7.6](https://learn.microsoft.com/en-us/powershell/scripting/whats-new/what-s-new-in-powershell-76)
- [What's New in PowerShell 7.5](https://learn.microsoft.com/en-us/powershell/scripting/whats-new/what-s-new-in-powershell-75)
- [What's New in PowerShell 7.4](https://learn.microsoft.com/en-us/powershell/scripting/whats-new/what-s-new-in-powershell-74)
- [What's New in PowerShell 7.3](https://learn.microsoft.com/en-us/powershell/scripting/whats-new/what-s-new-in-powershell-73)
- [What's New in PowerShell 7.2](https://learn.microsoft.com/en-us/powershell/scripting/whats-new/what-s-new-in-powershell-72)
- [What's New in PowerShell 7.0](https://learn.microsoft.com/en-us/powershell/scripting/whats-new/what-s-new-in-powershell-70)
- [Differences between Windows PowerShell 5.1 and PowerShell 7.x](https://learn.microsoft.com/en-us/powershell/scripting/whats-new/differences-from-windows-powershell)
- [PowerShell Support Lifecycle](https://learn.microsoft.com/en-us/powershell/scripting/install/powershell-support-lifecycle)
- [about_Automatic_Variables](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_automatic_variables)
- [about_Operators](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_operators)
- [about_ANSI_Terminals（`$PSStyle`）](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_ansi_terminals)
- [about_Experimental_Features](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_experimental_features)
- [Using Experimental Features](https://learn.microsoft.com/en-us/powershell/scripting/learn/experimental-features)
- [about_Windows_PowerShell_Compatibility](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_windows_powershell_compatibility)
- [PowerShell 7 module compatibility](https://aka.ms/PSModuleCompat)
- [Breaking changes for migration from .NET Framework to .NET Core](https://learn.microsoft.com/en-us/dotnet/core/compatibility/fx-core)
- [Behavior changes when comparing strings on .NET 5+](https://learn.microsoft.com/en-us/dotnet/standard/base-types/string-comparison-net-5-plus)

**cmdlet / .NET API 参考（用于逐条核对参数与类型）**

- [`Cmdlet.PipelineStopToken`](https://learn.microsoft.com/en-us/dotnet/api/system.management.automation.cmdlet.pipelinestoptoken)
- [`MatchInfo.LineNumber`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.powershell.commands.matchinfo.linenumber)
- [`Join-Path`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/join-path)
- [`Select-String`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/select-string)
- [`Select-Object`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/select-object)
- [`Test-Path`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/test-path)
- [`Test-Json`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/test-json)
- [`ConvertFrom-Json`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/convertfrom-json)
- [`ConvertTo-CliXml`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/convertto-clixml)
- [`Invoke-WebRequest`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/invoke-webrequest)
- [`Microsoft.PowerShell.ThreadJob` 模块](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.threadjob/)

**版本历史与变更日志**

- [PowerShell/PowerShell CHANGELOG 目录](https://github.com/PowerShell/PowerShell/blob/master/CHANGELOG/)
- [7.6 Changelog](https://github.com/PowerShell/PowerShell/blob/master/CHANGELOG/7.6.md)
- [7.5 Changelog](https://github.com/PowerShell/PowerShell/blob/master/CHANGELOG/7.5.md)
- [PowerShell Releases](https://github.com/PowerShell/PowerShell/releases)
- [NuGet: PowerShellStandard.Library](https://www.nuget.org/packages/PowerShellStandard.Library)
- [.NET 支持策略](https://dotnet.microsoft.com/platform/support/policy/dotnet-core)

---

## 9. 版本归属的说明与已知不确定项

本文的写法遵循"**能在官方文档中逐条核对才下断言**"的原则。以下条目需要读者注意其证据强度：

1. **7.6 的补丁版本日期**：官方 `CHANGELOG/7.6.md` 未逐条标注日期，本文只给出 7.6 GA 日期（2026-03-18，来自 Support Lifecycle 表格）。7.6.1–7.6.6 的具体发布日期未列出。
2. **`$PSVersionTable` 的完整键集合**：7.x 的官方键清单取自 `about_Automatic_Variables`（列出 9 个键）。5.1 的 `BuildVersion` / `CLRVersion` 存在性与移除依据的是官方 "Differences from Windows PowerShell" 文档的明确表述；但该文档未给出 5.1 的完整键清单，若需精确对比建议在真实 5.1 会话中执行 `$PSVersionTable` 实测。
3. **`Microsoft.PowerShell.5.1.ReferenceAssemblies`**：该 NuGet 包确实存在（在 `MatchInfo.LineNumber` 的 .NET API 文档中被列为程序集来源之一，版本 `v1.0.0`），但本文未逐一核对其内容与目标框架。
4. **7.5 与 7.6 之间关于"大枚举按数字"的正式化节点**：7.5 changelog 将其列为该版本的破坏性变更（预览阶段），而 7.6 的 What's New 把 `PSSerializeJSONLongEnumAsNumber` 列为**7.6 新增实验性特性**、同时把 `ConvertTo-Json` 大枚举按数字列入 7.6 破坏性变更。两处表述存在重叠，实际行为请以目标版本实测为准。
5. **`Select-Object -SkipIndex` / `-Wait` 的版本标注**：官方文档分别写作 "introduced in Windows PowerShell 6.0" 与 "introduced in Windows PowerShell 3.0"，用词不统一（"Windows PowerShell 6.0" 实际指 PowerShell 6.0），本文照抄原文并加注。
6. **逐 PR 级别的完整 API 差异清单**：本文按"官方 What's New + 5.1→7.x 差异文档 + 关键 cmdlet/API 页面"汇总，未穷举每个 PR。若需要逐条精度，建议比对 GitHub CHANGELOG 与 `System.Management.Automation` 的公开 API 差异报告（APIScan）。

---

*本文档位于 `src/host/lib/powershell.md`，供本仓库内部参考。所有版本归属以标注的官方来源为准；与官方文档冲突时，以官方文档与目标版本实测为准。*
