# PowerShell 5.1 → 7.6 API 变化与版本说明

本文梳理 **Windows PowerShell 5.1**（2016-08）到 **PowerShell 7.6**（2026-03，当前 LTS）之间的 API 变化与版本说明，覆盖三层含义的 "API"：

1. **.NET 公开 API**——`System.Management.Automation` 等程序集中的公开类型与成员，二进制模块作者直接依赖；
2. **面向脚本的 API**——cmdlet、参数、`$PSVersionTable` 键、自动变量、偏好变量、实验性特性开关；
3. **语言语法**——运算符、语句、AST/解析器可见的语法结构。

文中标注 `⚠️` 的条目为**破坏性变更**。每条关键结论都附官方来源；文末列出[参考来源](#8-参考来源)与[版本归属的说明](#9-版本归属的说明与已知不确定项)。

---

## 1. 版本速查矩阵

| 版本 | 发布日期 | 结束支持 | 支持级别 | .NET 基线 | 平台 |
| --- | :---: | :---: | :---: | --- | --- |
| Windows PowerShell 5.1 | 2016-08 | 随 Windows 生命周期 | Windows 组件 | .NET Framework 4.5+ | 仅 Windows |
| PowerShell 6.0 | 2018-01-20 | 2019-02-13 | 已退役 | .NET Core 2.0 | Win / macOS / Linux |
| PowerShell 6.1 | 2018-09-13 | 2019-09-28 | 已退役 | .NET Core 2.1 | 同上 |
| PowerShell 6.2 | 2019-03-29 | 2020-09-04 | 已退役 | .NET Core 2.1 | 同上 |
| PowerShell 7.0 | 2020-03-04 | 2022-12-03 | LTS（已退役） | .NET Core 3.1 | 同上 |
| PowerShell 7.1 | 2020-11-11 | 2022-05-08 | 已退役 | .NET 5.0 | 同上 |
| PowerShell 7.2 | 2021-11-08 | 2024-11-08 | LTS（已退役） | .NET 6.0 | 同上（含 ARM64） |
| PowerShell 7.3 | 2022-11-09 | 2024-05-08 | 已退役 | .NET 7.0 | 同上（**不再支持 Windows 7**） |
| PowerShell 7.4 | 2023-11-16 | 2026-11-10 | LTS | .NET 8.0 | 同上 |
| PowerShell 7.5 | 2025-01-23 | 2026-11-10 | Stable | .NET 9.0 | 同上 |
| **PowerShell 7.6** | **2026-03-18** | **2028-11-14** | **LTS（当前）** | **.NET 10.0** | 同上 |
| PowerShell 7.7 | 预览中（7.7-preview.3） | — | Preview | .NET 11.0 | 同上 |

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
| 编译目标 | `Microsoft.PowerShell.5.1.ReferenceAssemblies`（仅面向 5.1） | **`PowerShellStandard.Library`**（跨 5.1 与 7.x） |
| 版本判别 | `$PSVersionTable.PSEdition` = `Desktop` | `PSEdition` = `Core` |
| 程序集加载顺序 | 先 GAC 后模块基路径 | **先模块基路径后 GAC** |
| 运行空间 API | `RunspaceConfiguration` 或 `InitialSessionState` | **仅 `InitialSessionState`** |

**两个引用程序集包的分工**（容易混淆，务必区分）：

| 包 | 版本 | 目标框架 | 用途 | 来源 |
| --- | --- | --- | --- | --- |
| **`PowerShellStandard.Library`** | **5.1.1**（2019-03-07） | `netstandard2.0` + `net452` | PowerShell Standard 5 的引用程序集；代表 **5.1 与 Core/7.x 的公共 API 交集**，用于"同时面向 5.1 与 7.x"的编译期兼容校验 | [NuGet](https://www.nuget.org/packages/PowerShellStandard.Library) |
| `Microsoft.PowerShell.5.1.ReferenceAssemblies` | 1.0.0（2018-12-03） | `net461` | Windows PowerShell 5.1 程序集的引用程序集，**含 5.1 程序集的 XML 文档**；只能用于编译"仅 5.1"的模块 | [NuGet](https://www.nuget.org/packages/Microsoft.PowerShell.5.1.ReferenceAssemblies) |

> 早期版本：`PowerShellStandard.Library` 还有 `5.1.0`（2018-11-30）以及 `3.0.0-preview-*`。

**关键推论**：PowerShell Standard 是**交集**，因此

- 只有 5.1 具备的能力（WMI v1、snap-in、workflow 相关类型）**不在其中**；
- 只有 7.x 新增的 API（例如 7.2 的 `PSStyle` / `StringDecorated`、7.3 的 `clean` 块相关 AST）**也不在其中**。

若必须使用 7.x 专有 API，只能改为引用 7.x 的 `System.Management.Automation` 引用程序集，并放弃 5.1 兼容。此外，**编译期校验无法发现跨版本的"行为"差异**，官方要求用 Pester 在目标版本上实测。

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

- **`Import-Module -UseWindowsPowerShell`**：在 7.x 中创建代理模块，隐式调用本地 Windows PowerShell 进程（后台 5.1 进程中的 `WinPSCompatSession`）运行该模块的 cmdlet。这是**隐式远程**通道，因此参数与返回值会被**序列化**、只使用**单一 runspace**，且仅限**本地 Windows**、要求已安装 5.1。
  - 相关配置：`WindowsPowerShellCompatibilityModuleDenyList`（默认含 `PSScheduledJob`、`BestPractices`、`UpdateServices`）与 `DisableImplicitWinCompat`。
  - 注意：**该参数并未被弃用或移除**（截至 7.6 的官方文档与各版本 What's New 中都没有弃用说明）。
- **`Import-Module -SkipEditionCheck`**：允许列出/导入 `CompatiblePSEdition` 未声明 `Core` 的模块。
- PowerShell 启动时把 `$windir\System32` 加入 `PSModulePath`，但**只暴露 `CompatiblePSEdition` 含 `Core` 的模块**；`Get-Module` 输出新增 `PSEdition` 属性。
- **`CompatiblePSEditions` 的强制执行范围有区别**：对**随 Windows 提供**的模块（位于 `%windir%\system32\WindowsPowerShell\v1.0\Modules`），6.1+ 会强制检查——未声明 `Core` 时 `Import-Module` 与 `Get-Module -ListAvailable` 会拒绝，需 `-SkipEditionCheck`（官方警告此后仍可能在运行期失败）；对**从 Gallery 安装的自定义模块**，该字段**仅作信息展示**，不强制。省略该字段等同 `Desktop`。
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

跨平台化起点，破坏面最大的一次迁移。PowerShell Core 使用 **.NET Core 2.0** 作为运行时，并**暴露 .NET Core 2.0 所提供的 API 集合**；与 .NET Framework 的交集由 **.NET Standard 2.0** 定义，这是二进制兼容性的基础。

> **发布日期说明**：`CHANGELOG/6.0.md` 的标题写作 `2018-01-10`，但 Learn 生命周期表与 [Microsoft Lifecycle](https://learn.microsoft.com/en-us/lifecycle/products/powershell) 均记为 **2018-01-20**。本文以生命周期表为准。

**宿主与命令行**

- `powershell.exe` → `pwsh`；首个位置参数 `-Command` → `-File`（[#4019](https://github.com/PowerShell/PowerShell/pull/4019)）；新增 `-i` / `-Interactive`（[#3558](https://github.com/PowerShell/PowerShell/pull/3558)）；移除 `-importsystemmodules` 与 `-psconsoleFile`（[#4995](https://github.com/PowerShell/PowerShell/pull/4995)）（详见 2.2）。
- **移除自定义管理单元（snap-in）**支持（这直接破坏了 Windows 上的 `ActiveDirectory` 与 `DnsClient` 模块）。
- **移除 `RunspaceConfiguration` 支持**：编程创建运行空间只能用 `InitialSessionState`（[#4942](https://github.com/PowerShell/PowerShell/pull/4942)）。
- 新增 `$PSHome/powershell.config.json` 配置文件，用于存放启动前所需的设置（如 `ExecutionPolicy`）。

**引擎与 API**

- `Add-Type`：**移除 `AddTypeCommandBase` 类**（[#5407](https://github.com/PowerShell/PowerShell/pull/5407)）；移除 `-ShowWindow` 相关 WPF 依赖；新增 `CSharpVersion7` 支持（[#3933](https://github.com/PowerShell/PowerShell/pull/3933)）。
  - ⚠️ **版本冲突**：该移除在官方 What's New 6.0 页面的 "API changes" 中列为 6.0，而 `CHANGELOG/6.1.md` 把它放在 6.1.0-preview.1。两处证据矛盾，以 6.0 的 What's New 页面为准但需知悉此分歧。
- **`ScriptBlock` 转换为委托时不再把返回值包装为 `PSObject`**（官方差异文档列为 6.0 的 "API changes"；7.1 的 changelog 也以 [#10619](https://github.com/PowerShell/PowerShell/pull/10619) 记录了同一变更，本文按差异文档归入 6.0，并在此标注两处证据的差异）。
- **`$PSVersionTable` 新增 4 个属性**（[#3877](https://github.com/PowerShell/PowerShell/pull/3877)）：
  - `PSEdition`（Core 上为 `Core`，Windows PowerShell 上为 `Desktop`）
  - `GitCommitId`（构建所用的 Git 提交 ID）
  - `OS`（来自 `[System.Runtime.InteropServices.RuntimeInformation]::OSDescription`）
  - `Platform`（来自 `[System.Environment]::OSVersion.Platform`；Windows 为 `Win32NT`，macOS 与 Linux 为 `Unix`）
- **移除 `BuildVersion`**（[#3877](https://github.com/PowerShell/PowerShell/pull/3877)/[#1415](https://github.com/PowerShell/PowerShell/pull/1415)）与 **`ClrVersion`**（[#4027](https://github.com/PowerShell/PowerShell/pull/4027)）。
- `CommandInvocationIntrinsics.InvokeScript`：参数绑定到 **`$input`** 而非 `$args`（[#4923](https://github.com/PowerShell/PowerShell/pull/4923)）。
- 新增自动变量 **`$IsWindows`、`$IsMacOS`、`$IsLinux`**；`$IsOSX` 更名为 `$IsMacOS`（[#4700](https://github.com/PowerShell/PowerShell/pull/4700)）。
- **语义化版本 API**：新增 `semver` 类型加速器（对应 `System.Management.Automation.SemanticVersion`，[#4142](https://github.com/PowerShell/PowerShell/pull/4142)）；`SemanticVersion` 兼容 **SemVer 2.0**（[#5037](https://github.com/PowerShell/PowerShell/pull/5037)）；支持 `SemanticVersion` 与仅含 `Major.Minor` 的 `Version` 比较；`New-ModuleManifest` 默认 `ModuleVersion` 改为 `0.0.1`。
- **属性/验证 API 增补**：`ValidateDriveAttribute.ValidRootDrives`（[#3510](https://github.com/PowerShell/PowerShell/pull/3510)）；通过自定义 `ValidateSetValueGenerator` 生成动态 `ValidateSet` 值（[#3784](https://github.com/PowerShell/PowerShell/pull/3784)）；`ValidatePatternAttribute` / `ValidateSetAttribute` / `ValidateScriptAttribute` 支持自定义错误消息（[#2728](https://github.com/PowerShell/PowerShell/pull/2728)）；新增 **`ArgumentCompletionsAttribute`**（[#4835](https://github.com/PowerShell/PowerShell/pull/4835)）。
- **类型数据（ETS）变化**：为 `System.Diagnostics.Process` 新增 **`CodeProperty "Parent"`**（暴露父进程，[#2850](https://github.com/PowerShell/PowerShell/pull/2850)）；`Get-Service` 返回的 `ServiceController` 新增 `UserName`、`Description`、`DelayedAutoStart`、`BinaryPathName`、`StartupType`（[#4907](https://github.com/PowerShell/PowerShell/pull/4907)）；**移除 `System.Array` 的 `AliasProperty "Count"`**（[#3231](https://github.com/PowerShell/PowerShell/pull/3231)）。
- 工作流堆栈整体移除：`Remove Workflow code`（[#4777](https://github.com/PowerShell/PowerShell/pull/4777)）、`Remove remainder of Utility.Activities`（[#4880](https://github.com/PowerShell/PowerShell/pull/4880)）、移除 `Microsoft.PowerShell.CoreCLR.AssemblyLoadContext.dll`（[#4868](https://github.com/PowerShell/PowerShell/pull/4868)）。
  - 同一批清理还包括 `WorkflowInfo` 公开构造函数改 internal、移除 `System.Management.Automation.DebugSource` 类型、移除 `Debugger` / `RemotingJobDebugger` 中仅用于工作流调试的 `SetParent` 重载。
- 二进制模块程序集加载顺序：**先模块基路径，后 GAC**。
- 实现 **Unicode 转义解析**：`` `u#### `` / `` `u{####} ``（[#3958](https://github.com/PowerShell/PowerShell/pull/3958)）；输出字面 `` `u `` 需写 `` ``u ``。
- 引入 `-SkipEditionCheck` 与 `PSEdition` 模块属性支持的基础机制。

**语言与语义**

- **`&`（行尾后台作业运算符）**（[#3360](https://github.com/PowerShell/PowerShell/pull/3360)）：官方 6.0 What's New 明确 **"Support backgrounding of pipelines with ampersand (`&`)"**。管道作为 PowerShell 作业运行并返回 job 对象；变量（进程相关变量除外）自动复制；作业在当前目录而非用户主目录运行。
- 新增 **ESC 转义 `` `e ``**。
- **枚举到字符串的转换**（[#4318](https://github.com/PowerShell/PowerShell/pull/4318)）。
- **范围运算符 `..` 新增字符范围重载**：`'a'..'z'`（[#5026](https://github.com/PowerShell/PowerShell/pull/5026)）。
- `-split` 支持 `'Singleline, Multiline'` 选项（[#4721](https://github.com/PowerShell/PowerShell/pull/4721)）。
- 修正单元素数组到泛型集合的强制转换（[#3170](https://github.com/PowerShell/PowerShell/pull/3170)）；修正变量赋值不再覆盖只读变量。
- **`ValueFromRemainingArguments` 现在返回数组**（[#2035](https://github.com/PowerShell/PowerShell/pull/2035)）。
- `$?` 语义修正（ParenExpression / SubExpression / ArrayExpression）。
- `Group-Object` 输出排序；`Measure-Object` 新增 `StandardDeviation`（这两项亦列于 6.0 的差异文档）。
- `$PSCulture` 一致反映会话内的区域性变更。

**新 cmdlet**：`Get-Uptime`、`Remove-Alias`（[#5143](https://github.com/PowerShell/PowerShell/pull/5143)）、`Remove-Service`（[#4858](https://github.com/PowerShell/PowerShell/pull/4858)）。

**新增参数（择要）**：`ConvertFrom-Json -AsHashtable`（[#5043](https://github.com/PowerShell/PowerShell/pull/5043)）；`Sort-Object -Top` / `-Bottom`；`Split-Path -Extension` / `-LeafBase`（[#2721](https://github.com/PowerShell/PowerShell/pull/2721)）；`Out-String -NoNewLine`（[#5056](https://github.com/PowerShell/PowerShell/pull/5056)）；`Get-Credential -Title`；`Test-Connection -TimeOut`（[#2492](https://github.com/PowerShell/PowerShell/pull/2492)）；`ConvertTo-Html -Meta` / `-Charset` / `-Transitional`（[#4184](https://github.com/PowerShell/PowerShell/pull/4184)）；`Get-Verb -Group`；`Start-Process -WhatIf`（[#4735](https://github.com/PowerShell/PowerShell/pull/4735)）；`Get-ChildItem -FollowSymlink`（[#4020](https://github.com/PowerShell/PowerShell/pull/4020)）。

**Web cmdlet**：底层改写为 `HttpClient`（详见 3.9）；新增 `-CustomMethod`、`-SslProtocol`、`-NoProxy`、`-Authentication`（Basic/OAuth/Bearer）、`-Token`、`-AllowUnencryptedAuthentication`、`-ResponseHeadersVariable`、`-SkipHeaderValidation`、`-FollowRelLink` / `-MaximumFollowRelLink`、多 Link 头支持、证书认证；UserAgent 由 `WindowsPowerShell` 改为 `PowerShell`。

**输出、编码与文件行为变化**

- `Get-Content -Delimiter` 不再把分隔符包含在返回行中（[#3706](https://github.com/PowerShell/PowerShell/pull/3706)）。
- `Format-Hex` 用 C# 重写，**`-Raw` 变为无操作**（[#3320](https://github.com/PowerShell/PowerShell/pull/3320)）。
- **`Export-Csv` / `ConvertTo-Csv` 默认 `-NoTypeInformation`**（[#5164](https://github.com/PowerShell/PowerShell/pull/5164)）；`Import-Csv` 支持 W3C Extended Log File Format（[#2482](https://github.com/PowerShell/PowerShell/pull/2482)）并支持 `PSTypeName`（[#5389](https://github.com/PowerShell/PowerShell/pull/5389)）。
- **所有使用 `-Encoding` 的内置 cmdlet 默认改为 `UTF8NoBOM`**，且 `-Encoding` 统一接受 `System.Text.Encoding`（[#5080](https://github.com/PowerShell/PowerShell/pull/5080)）：`Add-Content`、`Export-Clixml`、`Export-Csv`、`Export-PSSession`、`Format-Hex`、`Get-Content`、`Import-Csv`、`Out-File`、`Select-String`、`Send-MailMessage`、`Set-Content`。
- **`$OutputEncoding` 默认由 ASCII 改为 `UTF-8 NoBOM`**（[#5369](https://github.com/PowerShell/PowerShell/pull/5369)）。
- `New-ModuleManifest` 在**非 Windows** 平台生成 UTF-8 无 BOM 的 `.psd1`（Windows 上仍为 UTF-16 带 BOM，[#3940](https://github.com/PowerShell/PowerShell/pull/3940)）。
- `Get-Item -LiteralPath a*b` 不存在时报错（[#5197](https://github.com/PowerShell/PowerShell/pull/5197)）。
- `Get-ChildItem` 递归时返回符号链接但**不进入**其目标（向 `ls -R` / `dir /S` 靠拢，[#3780](https://github.com/PowerShell/PowerShell/pull/3780)），并新增 `-FollowSymlink`（[#4020](https://github.com/PowerShell/PowerShell/pull/4020)）。
- **移除大多数默认别名的 `AllScope`**（[#5268](https://github.com/PowerShell/PowerShell/pull/5268)）。
- `-Verbose` / `-Debug` 不再覆盖 `$ErrorActionPreference`（[#5113](https://github.com/PowerShell/PowerShell/pull/5113)）。
- 退出码对齐 Unix 约定（[#4573](https://github.com/PowerShell/PowerShell/pull/4573)）。
- `Get-ComputerInfo` 的 `BiosSeralNumber` 更正为 `BiosSerialNumber`（[#3167](https://github.com/PowerShell/PowerShell/pull/3167)）。
- `Get-ComputerInfo` 新增 `WindowsUBR` / `WindowsVersion`；`Get-Process` 内存列由 KB 改为 MB。
- 非 Windows 上**忽略 `-ExecutionPolicy`**（脚本签名当时不受支持，[#3481](https://github.com/PowerShell/PowerShell/pull/3481)）。
- **对以下 cmdlet 传 `$null` 现在报错**（[#2672](https://github.com/PowerShell/PowerShell/pull/2672)）：`Get-Credential -UserName`、`Get-Event -SourceIdentifier`、`Get-EventSubscriber -SourceIdentifier`、`Get-Help -Name`、`Get-PSBreakpoint -Script`、`Get-PSProvider -PSProvider`、`Get-PSSessionConfiguration -Name`、`Get-PSSnapin -Name`、`Get-Runspace -Name`、`Get-RunspaceDebug -RunspaceName`、`Get-Service -Name`、`Get-TraceSource -Name`、`Get-Variable -Name`（以及当时尚存的 `Get-WmiObject -Class` / `-Property`）。
- 哈希算法 `MACTripleDES`、`RIPEMD160` 被 .NET 移除，影响 `Get-FileHash`（[#3024](https://github.com/PowerShell/PowerShell/pull/3024)）。
- `cd` 无参数等价于 `cd ~`；路径支持超过 260 字符（[#3960](https://github.com/PowerShell/PowerShell/pull/3960)）；`Remove-Item` 支持注册表路径中的 `*`（[#4866](https://github.com/PowerShell/PowerShell/pull/4866)）。
- **遥测**：新增控制台遥测（上报 OS 平台与 `GitCommitId`，[#3620](https://github.com/PowerShell/PowerShell/pull/3620)）；通过环境变量 `POWERSHELL_TELEMETRY_OPTOUT`（`true` / `1` / `yes`）退出。
- 自动变量 `$IsOSX` 更名为 **`$IsMacOS`**，以符合 Apple 的 macOS 命名（[#4700](https://github.com/PowerShell/PowerShell/pull/4700)）。

**⚠️ 6.0 未提供（后续版本陆续恢复）**：

- 因使用不受支持的 API 而移除：`Get-Clipboard` / `Set-Clipboard`、`Get-HotFix`、`Clear-RecycleBin`、`Update-List`、`Out-Printer`、`ConvertFrom-String` / `Convert-String`、`*-Counter`（`Get-Counter`）、`Microsoft.PowerShell.LocalAccounts`、`*-EventLog` 等。
  - 其中 `Get-Counter`、`Out-Printer`、`Get-HotFix`、`Clear-RecycleBin`、`Update-List`、跨平台 `Get-Clipboard` / `Set-Clipboard` 都在 **7.0 回归**。
- **非 Windows 平台上的安全类 cmdlet 不可用**：`Get-Acl`、`Set-Acl`、`Get-AuthenticodeSignature`、`Set-AuthenticodeSignature`、`Get-CmsMessage`、`Protect-CmsMessage`、`Unprotect-CmsMessage`、`New-FileCatalog`、`Test-FileCatalog`。
- **WPF 相关**（`Show-Command`、`Out-GridView`、`Get-Help -ShowWindow`）不可用，已在 7.0 恢复。
- 类型加速器 `[adsi]`、`[adsisearcher]`、`[wmi]`、`[wmiclass]`、`[wmisearcher]` 在 6.0 中**不存在**，6.1 在 Windows 上恢复（[#7085](https://github.com/PowerShell/PowerShell/pull/7085)）。

### 4.2 PowerShell 6.1（2018-09-13，.NET Core 2.1）

迁移到 **.NET Core 2.1**，并引入 **Windows Compatibility Pack 2.0.0**（[#6958](https://github.com/PowerShell/PowerShell/pull/6958)）——这正是"让 Windows 模块能在 PowerShell Core 里跑"的关键一步。

**引擎与 API**

- **Windows Compatibility Pack 带来的可用性跃升**：官方 What's New 明确"为随 Windows 10 October 2018 Update 与 Windows Server 2019 提供的**超过 1900 个 cmdlet** 提供支持"。
- `$windir\System32` 自动加入 `PSModulePath`，并按 `CompatiblePSEditions` 过滤；新增 `Get-Module -SkipEditionCheck` 与 `Get-Module` 输出的 `PSEdition` 列（[#7183](https://github.com/PowerShell/PowerShell/pull/7183)、[#7083](https://github.com/PowerShell/PowerShell/pull/7083)、RFC0025）。
- **引入实验性特性框架**（RFC0029）：`Add support to experimental features`（[#7242](https://github.com/PowerShell/PowerShell/pull/7242)）。官方 6.1 What's New 明确写出用 `Get-ExperimentalFeature` 列出特性，并用 `Enable-ExperimentalFeature` / `Disable-ExperimentalFeature` 启停。
  - 公开 API 层面为 **`Experimental` 特性**（`[Experimental(Name, ExperimentAction)]`）与 **`ExperimentalFeature.IsEnabled()`**。
  - ⚠️ **版本细节**：6.2 的 changelog 把 `Enable-ExperimentalFeature` / `Disable-ExperimentalFeature` 的加入记为 `#8318`（6.2）。两处证据略有出入，可理解为 6.1 引入框架与 `Get-ExperimentalFeature`、6.2 补齐启停 cmdlet；引用时建议以"6.1 引入实验性特性机制、6.2 完善"表述。
- **`PSCustomObject` 新增 `Count` 与 `Length` 属性**（[#5745](https://github.com/PowerShell/PowerShell/pull/5745)），以及 **`ForEach` 与 `Where` 方法**（[#5756](https://github.com/PowerShell/PowerShell/pull/5756)）——即常说的"PSCustomObject 也有 Count/Length 和 ForEach/Where 了"。
- 支持把 **`PSMethod` 转换为委托**（[#5287](https://github.com/PowerShell/PowerShell/pull/5287)，后续 [#6570](https://github.com/PowerShell/PowerShell/pull/6570)、[#6851](https://github.com/PowerShell/PowerShell/pull/6851) 改进）。
- 新增 `LanguagePrimitives.TryCompare`（[#7438](https://github.com/PowerShell/PowerShell/pull/7438)）；`LanguagePrimitives.GetEnumerable` 把 `DataTable` 视为可枚举（[#6511](https://github.com/PowerShell/PowerShell/pull/6511)）。
- `HistoryInfo.Duration` 属性（[#5208](https://github.com/PowerShell/PowerShell/pull/5208)）。
- **`Microsoft.PowerShell.Commands.SetDateCommand.SystemTime` 由 class 改为 struct**（[#6006](https://github.com/PowerShell/PowerShell/pull/6006)）。
- 序列化互操作：从序列化代码的 `knowntypes` 列表**移除 `SemanticVersion`**，以改善 Windows PowerShell 与 PowerShell Core 之间的互操作（[#7016](https://github.com/PowerShell/PowerShell/pull/7016)）。
- `Group-Object -AsHashTable` 以 `PSObject` 的基对象作为键（[#7123](https://github.com/PowerShell/PowerShell/pull/7123)）。
- **`Add-Type`：移除 Visual Basic 语言支持**（[#7284](https://github.com/PowerShell/PowerShell/pull/7284)）；`Add-Type` 整体重构（[#6141](https://github.com/PowerShell/PowerShell/pull/6141)），并移除部分错误字符串与全限定错误 ID；枚举 `Language` 中不受支持的成员被移除（[#5829](https://github.com/PowerShell/PowerShell/pull/5829)）。
- 清理 `CommandTypes.Workflow` 与 `WorkflowInfo` 的使用（[#6708](https://github.com/PowerShell/PowerShell/pull/6708)）。
- **在 Windows 上恢复类型加速器** `[adsi]`、`[adsisearcher]`、`[wmi]`、`[wmiclass]`、`[wmisearcher]`（[#7085](https://github.com/PowerShell/PowerShell/pull/7085)）——它们在 6.0 中不存在。
- 类（class）引擎增强：可从 PowerShell 类中非虚调用基类的 "family or assembly" 方法（[#7624](https://github.com/PowerShell/PowerShell/pull/7624)）；支持 `System.Tuple` / `System.ValueTuple` 的索引操作（[#7633](https://github.com/PowerShell/PowerShell/pull/7633)）；优雅处理 `ByRef-like` 类型（[#7533](https://github.com/PowerShell/PowerShell/pull/7533)）；返回类型为 `[object]` 的方法在空结果时返回 `null`（[#7138](https://github.com/PowerShell/PowerShell/pull/7138)）。
- **`Enable-PSRemoting` 创建 `PowerShell.6` 与具体版本两类会话配置**（[#6519](https://github.com/PowerShell/PowerShell/pull/6519)、[#7202](https://github.com/PowerShell/PowerShell/pull/7202)）。
- 新增 `ThreadJob` 模块（[#7169](https://github.com/PowerShell/PowerShell/pull/7169)）。
- 把 `Microsoft.PowerShell.MarkdownRender` 加入受信任程序集列表（[#7280](https://github.com/PowerShell/PowerShell/pull/7280)）；移植 AppLocker / Device Guard UMCI 允许列表（[#6133](https://github.com/PowerShell/PowerShell/pull/6133)）；把 `System.Windows.Forms` 加入阻止列表以防崩溃（[#6822](https://github.com/PowerShell/PowerShell/pull/6822)）。

**新增 cmdlet**

- Markdown 系列：`ConvertFrom-Markdown`、`Get-MarkdownOption`、`Set-MarkdownOption`、`Show-Markdown`（[#6926](https://github.com/PowerShell/PowerShell/pull/6926)）。
- **`Test-Json`**（基于 NJsonSchema，[#5229](https://github.com/PowerShell/PowerShell/pull/5229)）。
- 新增参数与行为：`Where-Object -Not`（[#6464](https://github.com/PowerShell/PowerShell/pull/6464)）；**`Measure-Object` 新增标准差**（[#6238](https://github.com/PowerShell/PowerShell/pull/6238)）与 `-AllStats`（[#7220](https://github.com/PowerShell/PowerShell/pull/7220)）；**`Get-PfxCertificate -Password`**（[#6113](https://github.com/PowerShell/PowerShell/pull/6113)）；`Select-Object -SkipIndex`（[#7483](https://github.com/PowerShell/PowerShell/pull/7483)）；**`-lp` 成为所有 `-LiteralPath` 的别名**（[#6770](https://github.com/PowerShell/PowerShell/pull/6770)）；`ConvertTo-Json -AsArray`（[#6438](https://github.com/PowerShell/PowerShell/pull/6438)）；**`Update-Help` 默认保存到用户范围目录**（[#6352](https://github.com/PowerShell/PowerShell/pull/6352)）；**`cd -` 返回上一目录**（[#5051](https://github.com/PowerShell/PowerShell/pull/5051)）；**移除 `more` 函数**（[#6059](https://github.com/PowerShell/PowerShell/pull/6059)）。

**语言**

- **`-replace` 运算符接受脚本块（scriptblock）**（[#6029](https://github.com/PowerShell/PowerShell/pull/6029)）。
  - ⚠️ **版本歧义**：`about_Comparison_Operators` 写的是 "In PowerShell 6 and later"，而 changelog 把它放在 6.1.0-preview.1。6.0 还是 6.1 由这些来源无法定论，引用时需注明。
- 除上述外，6.1 **没有**新增其他运算符或关键字。

**破坏性变更**

- MSI 安装路径变为 `$env:ProgramFiles\PowerShell\6\`（稳定版）与 `…\6-preview\`（预览版）（RFC0026）。
- **遥测只能通过环境变量 `POWERSHELL_TELEMETRY_OPTOUT` 关闭**；删除 `DELETE_ME_TO_DISABLE_CONSOLEHOST_TELEMETRY` 文件的方式不再有效。
- Unix 上的远程处理禁止通过 HTTP 使用 Basic 认证（[#6787](https://github.com/PowerShell/PowerShell/pull/6787)）。
- 对随 Windows 提供的 `System32` 模块强制执行 `CompatiblePSEditions`（[#7183](https://github.com/PowerShell/PowerShell/pull/7183)）。
- `Group-Object` 输出排序（[#7409](https://github.com/PowerShell/PowerShell/pull/7409)）。
- `New-TemporaryFile` 抛出**终止性**错误（[#6182](https://github.com/PowerShell/PowerShell/pull/6182)）。
- `Add-Type` 移除全限定错误 ID。


### 4.3 PowerShell 6.2（2019-03-29，.NET Core 2.1）

官方把这一版定位为"性能改进、缺陷修复，以及较小的 cmdlet 与语言增强"。

> `CHANGELOG/6.2.md` 标题写作 `2019-03-28`，生命周期表记为 **29-Mar-2019**。

**引擎与 .NET API（本版本是 6.x 中 API 面变化最大的一版）**

- **`PSVersionInfo.PSVersion` 与 `PSVersionInfo.PSEdition` 公开**（[#8054](https://github.com/PowerShell/PowerShell/pull/8054)）。
- **`System.Management.Automation.PowerShell` 新增 5 个 `InvokeAsync` 重载与 `StopAsync`**（[#8056](https://github.com/PowerShell/PowerShell/pull/8056)）；新增接受 `Runspace` 的 **`PowerShell.Create` 重载**（[#8057](https://github.com/PowerShell/PowerShell/pull/8057)）；**`PowerShell.GetSteppablePipeline` 公开**（[#8055](https://github.com/PowerShell/PowerShell/pull/8055)）；基于任务的异步 API"直接返回 `Task` 对象"（[#9079](https://github.com/PowerShell/PowerShell/pull/9079)）。
- **`ConvertTo-Json` 重构，把 `JsonObject.ConvertToJson` 暴露为公开 API**（[#8682](https://github.com/PowerShell/PowerShell/pull/8682)）；`ConvertToJson` 中 `StoppingException` 由 `OperationCancellationException` 取代（[#8920](https://github.com/PowerShell/PowerShell/pull/8920)）。
- **移除类型**：不再使用的 `RunspaceConfigurationEntry` 系列类型（[#8424](https://github.com/PowerShell/PowerShell/pull/8424)）；`PSSnapInInfo()` 的旧 `customPSSnapInType` 参数（[#8333](https://github.com/PowerShell/PowerShell/pull/8333)）；若干未使用的缓存类型（[#9015](https://github.com/PowerShell/PowerShell/pull/9015)）。
- **PowerShell 开始自带引用程序集（reference assemblies）**：为 `Microsoft.PowerShell.Commands.Utility.dll` 生成并部署引用程序集（[#8716](https://github.com/PowerShell/PowerShell/pull/8716)），引用程序集构建目标改为 `netcoreapp2.1`（[#8729](https://github.com/PowerShell/PowerShell/pull/8729)）——这正是 `Add-Type` 与模块作者后来消费的机制。
- **类型系统**：枚举支持用户指定基础类型（[#8329](https://github.com/PowerShell/PowerShell/pull/8329)）；新增 `ushort` / `uint` / `ulong` / `short` 的 C# 风格类型加速器与字面量后缀（[#7813](https://github.com/PowerShell/PowerShell/pull/7813)）；字节字面量（[#7901](https://github.com/PowerShell/PowerShell/pull/7901)）；支持调用带 `ByRef-like` 类型参数的方法（[#7721](https://github.com/PowerShell/PowerShell/pull/7721)、[#7788](https://github.com/PowerShell/PowerShell/pull/7788)）；`.exe` 可作为 IL 二进制模块（[#7281](https://github.com/PowerShell/PowerShell/pull/7281)）。
- 类型推断（供补全使用）覆盖 `Select-Object`、`Group-Object`、`PSObject`、`Hashtable`（[#7231](https://github.com/PowerShell/PowerShell/pull/7231)）；`catch{}` 中的 `$_` / `$PSItem`（[#8020](https://github.com/PowerShell/PowerShell/pull/8020)）。
- **程序集加载顺序改为"先模块基路径，后 GAC"**（[#8073](https://github.com/PowerShell/PowerShell/pull/8073)）。
- 序列化/远程：修正 `CustomSerializer.WriteMemberInfoCollection()` 的 XML 嵌套缺陷（[#8476](https://github.com/PowerShell/PowerShell/pull/8476)）；修正 `FormatTable` 的远程反序列化回归（[#9116](https://github.com/PowerShell/PowerShell/pull/9116)）。
- 宿主相关行为：非 Windows 上 `SecureString` cmdlet 通过存储明文来启用（[#9199](https://github.com/PowerShell/PowerShell/pull/9199)）；**在 PowerShell 被宿主（hosting）时 `Start-Job` 抛终止性错误**（[#9128](https://github.com/PowerShell/PowerShell/pull/9128)）；`Add-Type` 可在宿主 PowerShell 的应用中使用（[#10587](https://github.com/PowerShell/PowerShell/pull/10587)，列在 6.2.4）。
- 引入 **dotnet 全局工具（global tool）** 形式的 PowerShell（[#8984](https://github.com/PowerShell/PowerShell/pull/8984)、[#9163](https://github.com/PowerShell/PowerShell/pull/9163)）。

**cmdlet 变化**

- 新增 **`Join-String`**（[#7660](https://github.com/PowerShell/PowerShell/pull/7660)）。
- `ConvertFrom-Json` 新增 **`-Depth`**（默认 1024，[#8199](https://github.com/PowerShell/PowerShell/pull/8199)）；`ConvertTo-Json -EscapeHandling`（[#7775](https://github.com/PowerShell/PowerShell/pull/7775)）。
- `Format-Hex -Offset` / `-Count`（[#7877](https://github.com/PowerShell/PowerShell/pull/7877)），并移除其 `ShouldProcess`（[#8178](https://github.com/PowerShell/PowerShell/pull/8178)）。
- `Get-Culture -Name` / `-NoUserOverrides` / `-ListAvailable`（[#7702](https://github.com/PowerShell/PowerShell/pull/7702)）；`Start-Transcript -UseMinimalHeader`（[#8402](https://github.com/PowerShell/PowerShell/pull/8402)）；`Send-MailMessage -ReplyTo`（[#8727](https://github.com/PowerShell/PowerShell/pull/8727)）并被标记为过时（[#9178](https://github.com/PowerShell/PowerShell/pull/9178)）。
- `pwsh` 与 `Enter-PSHostProcess` 新增 `-CustomPipeName`（[#8889](https://github.com/PowerShell/PowerShell/pull/8889)）；`Get-PSHostProcessInfo` / `Enter-PSHostProcess` 支持 Unix（[#8232](https://github.com/PowerShell/PowerShell/pull/8232)）。
- 非 Windows 上移除 `New-PSDrive -Persist`（[#8291](https://github.com/PowerShell/PowerShell/pull/8291)）。
- **`-Encoding` 支持数字代码页 ID 或代码页名称**（见官方 `Select-String` 文档："Beginning with PowerShell 6.2, the **Encoding** parameter also allows numeric IDs of registered code pages"）。

**实验性特性**

- **新增 `Enable-ExperimentalFeature` 与 `Disable-ExperimentalFeature` cmdlet**（[#8318](https://github.com/PowerShell/PowerShell/pull/8318)）——至此实验性特性机制才完整；同时 **`Get-ExperimentalFeature` 失去 `-ListAvailable`**（破坏性）。
- 简化新实验性特性的声明方式（[#8726](https://github.com/PowerShell/PowerShell/pull/8726)）。
- 本版本新增的实验性特性：`PSCommandNotFoundSuggestion`（[#8458](https://github.com/PowerShell/PowerShell/pull/8458)）、`PSImplicitRemotingBatching`（[#8038](https://github.com/PowerShell/PowerShell/pull/8038)）、**`PSTempDrive`**（[#8696](https://github.com/PowerShell/PowerShell/pull/8696)）、`PSUseAbbreviationExpansion`（[#8109](https://github.com/PowerShell/PowerShell/pull/8109)）。

**语言**

- **没有新增运算符或关键字**；本版本的语法层面增补是字面量与类型层面的（枚举基础类型、数字字面量后缀与字节字面量，见上）。

**破坏性变更**

- `Write-Output -NoEnumerate` 行为一致性（[#9069](https://github.com/PowerShell/PowerShell/pull/9069)）。
- `Join-String -InputObject 1,2,3` 等价于 `1,2,3 | Join-String`（[#8611](https://github.com/PowerShell/PowerShell/pull/8611)）。
- 新增 `Sort-Object -Stable`，改变排序语义（[#7862](https://github.com/PowerShell/PowerShell/pull/7862)）。
- `Start-Sleep` 接受小数秒（[#8537](https://github.com/PowerShell/PowerShell/pull/8537)）。
- **哈希表比较改为所有区域性下的 `OrdinalIgnoreCase`**（[#8566](https://github.com/PowerShell/PowerShell/pull/8566)）。
- `Import-Csv -LiteralPath` 绑定 `Get-ChildItem` 输出（[#8277](https://github.com/PowerShell/PowerShell/pull/8277)）。
- **`-Debug` 把 `$DebugPreference` 设为 `Continue`（原为 `Inquire`）**（[#8195](https://github.com/PowerShell/PowerShell/pull/8195)）。
- `-OutputFormat` 在重定向/编码的非交互式 `pwsh` 中生效（[#8115](https://github.com/PowerShell/PowerShell/pull/8115)）。
- `-WorkingDirectory` 在 profile 之前处理（[#8079](https://github.com/PowerShell/PowerShell/pull/8079)）；Unix 上不再追加 `PATHEXT`（[#7697](https://github.com/PowerShell/PowerShell/pull/7697)）。
- 锁定模式（lockdown）下禁用调试器（6.2.1/6.2.2），并在 6.2.2 中禁用 `Enter-PSHostProcess`。
- Linux 预览包的包名移除波浪号（[#8244](https://github.com/PowerShell/PowerShell/pull/8244)）。


**Web cmdlet**：JSON 响应默认使用 UTF-8（RFC 8259）；新增 **`-Form`**（简化 `multipart/form-data`，见官方 `Invoke-WebRequest` 文档标注 "This feature was added in PowerShell 6.1.0"）与 `-Resume`。

### 4.4 PowerShell 7.0（2020-03-04，.NET Core 3.1，LTS）

迁移到 **.NET Core 3.1**，官方表述为"显著提升了对既有 Windows PowerShell 模块的向后兼容性"。这是第一个 **LTS** 版本，安装在 `%ProgramFiles%\PowerShell\7`，并对 6.x 做**原地升级**。

**语言与运算符**——这一批是 5.1 用户感知最直接的变化

| 语法 | 说明 | 引入时的状态 |
| --- | --- | --- |
| `??` | null 合并；左侧非 null 时不计算右侧 | 7.0 preview.5 实验性 → GA 正式（[#10636](https://github.com/PowerShell/PowerShell/pull/10636)） |
| `??=` | null 合并赋值 | 同上 |
| `? :` | 三元运算符（实验性特性名 `PSTernaryOperator`） | 7.0 GA 正式 |
| `&&` / `\|\|` | 管道链运算符，依据左侧管道成败条件执行右侧 | 7.0 preview.5 实验性 → GA 正式（[#9849](https://github.com/PowerShell/PowerShell/pull/9849)） |
| `?.` / `?[]` | null 条件访问 | **7.0 全程实验性**（`PSNullConditionalOperators`，[#10960](https://github.com/PowerShell/PowerShell/pull/10960)）→ **7.1 转正式** |
| `&`（行尾） | 后台作业运算符 | **6.0 起已有**，不是 7.0 新增 |

> 官方在 7.0.0-rc.1 通过 `Make approved features non-experimental`（[#11303](https://github.com/PowerShell/PowerShell/pull/11303)）把一批特性转正，三元、`??`、`??=`、`&&`、`||`、ConciseView、`Get-Error` 都在其中；**`?.` / `?[]` 不在其列**。

其他语言/解析器增补：管道位于**行首**时的续行支持（[#8938](https://github.com/PowerShell/PowerShell/pull/8938)）；`-split` 支持负数（[#8960](https://github.com/PowerShell/PowerShell/pull/8960)）；补全 `TokenKind.QuestionMark` 的 token 文本（[#10706](https://github.com/PowerShell/PowerShell/pull/10706)）；`$?` 在 ParenExpression / SubExpression / ArrayExpression 中的保留（[#11040](https://github.com/PowerShell/PowerShell/pull/11040)）。

**引擎与 API**

- `ForEach-Object` 新增 **`-Parallel`** 与 **`-ThrottleLimit`**（[#10454](https://github.com/PowerShell/PowerShell/pull/10454)、[#10455](https://github.com/PowerShell/PowerShell/pull/10455)）。
- 默认错误视图 **ConciseView**（[#10641](https://github.com/PowerShell/PowerShell/pull/10641)、[#10724](https://github.com/PowerShell/PowerShell/pull/10724)）；新增 **`Get-Error`** cmdlet（7.0 期间为实验性，RC.2 移除其清单声明 [#11369](https://github.com/PowerShell/PowerShell/pull/11369)）；`Get-Error` 增加 `OutputType`、保留原始 `TypeNames`（[#10856](https://github.com/PowerShell/PowerShell/pull/10856)）与异常 `Type` 成员（[#11076](https://github.com/PowerShell/PowerShell/pull/11076)）；`$Host.PrivateData` 新增 `ErrorAccentColor`。
- **恢复 WPF 相关功能**：新增 **`Microsoft.PowerShell.GraphicalHost` 程序集**以启用 `Out-GridView`、`Show-Command`、`Get-Help -ShowWindow`（[#10899](https://github.com/PowerShell/PowerShell/pull/10899)）。
- **引入 `Import-Module -UseWindowsPowerShell`（WinCompat）**代理模块机制（实验性起点 [#10973](https://github.com/PowerShell/PowerShell/pull/10973)）；`WindowsPS` 版本检查（[#11148](https://github.com/PowerShell/PowerShell/pull/11148)）；新增禁用隐式 WinPS 模块加载的设置（[#11332](https://github.com/PowerShell/PowerShell/pull/11332)）。
- **断点与运行空间 API**：为运行空间新增断点管理 API，并支持不使用 `BreakAll` 附加到进程（[#10338](https://github.com/PowerShell/PowerShell/pull/10338)）；新增 `New-PSBreakpoint` cmdlet 与 `Debug-Runspace -Breakpoint`（[#8923](https://github.com/PowerShell/PowerShell/pull/8923)）；远程场景断点 API 改进（[#11312](https://github.com/PowerShell/PowerShell/pull/11312)）；修正 PowerShell 类定义泄漏到其他运行空间（[#11273](https://github.com/PowerShell/PowerShell/pull/11273)）。
- **枚举/偏好 API**：新增 `ActionPreference.Break`（[#8205](https://github.com/PowerShell/PowerShell/pull/8205)）；`ActionPreference.Suspend` 变为保留/不支持状态，并解除偏好变量中使用 `ActionPreference.Ignore` 的限制（[#10317](https://github.com/PowerShell/PowerShell/pull/10317)）。
- **运行空间/宿主**：**`InitialSessionState.ImportPSSnapIn` 标记为过时（Obsolete）**（[#11399](https://github.com/PowerShell/PowerShell/pull/11399)）；`ConsoleShell.Start` 可接受 `InitialSessionState`（[#9802](https://github.com/PowerShell/PowerShell/pull/9802)）。
- 补全/格式化/反射公开 API：`TabExpansion2` 不再要求 `-CursorColumn`（[#10849](https://github.com/PowerShell/PowerShell/pull/10849)）；`CompletionCompleters` 公开方法的空引用修正（[#11274](https://github.com/PowerShell/PowerShell/pull/11274)）；`PSObject` 格式化基元优化（[#8785](https://github.com/PowerShell/PowerShell/pull/8785)）；`ParameterMetadata.GetProxyAttributeData` 支持 `ValidateRangeKind`（[#9059](https://github.com/PowerShell/PowerShell/pull/9059)）。
- 绑定器/序列化：`LanguagePrimitives.IsNullLike()` 求值顺序修正（[#10781](https://github.com/PowerShell/PowerShell/pull/10781)）；`ConvertFrom-Json` 默认展开集合（[#10861](https://github.com/PowerShell/PowerShell/pull/10861)）；移除引发格式化问题的 `SourceLength` 远程属性（[#10765](https://github.com/PowerShell/PowerShell/pull/10765)）。
- API 恢复/移除：恢复 `SetBreakpoints` API（[#11622](https://github.com/PowerShell/PowerShell/pull/11622)）；以 `ObsoleteAttribute` 恢复 `PowerShellStreamType` 枚举（[#11836](https://github.com/PowerShell/PowerShell/pull/11836)）；恢复 #10338 中丢失的调试 API（[#10808](https://github.com/PowerShell/PowerShell/pull/10808)）；移除 `CommaDelimitedStringCollection` 的未使用类型转换器（[#11000](https://github.com/PowerShell/PowerShell/pull/11000)）；移除 `WorkflowJobSourceAdapter` 引用（[#10326](https://github.com/PowerShell/PowerShell/pull/10326)）；内部 `HelpCategory.Workflow` 枚举标记过时（[#10319](https://github.com/PowerShell/PowerShell/pull/10319)）。
- 引用程序集目标框架改为 `netcoreapp3.0`（[#9747](https://github.com/PowerShell/PowerShell/pull/9747)）；新增 ConsoleHost 引用程序集（[#11545](https://github.com/PowerShell/PowerShell/pull/11545)）；NuGet 打包开始包含 `cimcmdlets.dll` 与多数内置模块（[#11832](https://github.com/PowerShell/PowerShell/pull/11832)）。

**cmdlet 变化**

- `-lp` 统一为所有 `-LiteralPath` 的别名（6.1 已开始）。
- `Start-Job` 使用当前目录作为工作目录（[#10920](https://github.com/PowerShell/PowerShell/pull/10920)），并新增 `-WorkingDirectory`（[#10324](https://github.com/PowerShell/PowerShell/pull/10324)）。
- 从 `Rename-Computer` / `Restart-Computer` / `Stop-Computer` 移除 `-Protocol`（**DCOM 不再支持**，[#5277](https://github.com/PowerShell/PowerShell/pull/5277)）。
- 从 `*-Service` cmdlet 移除 `-ComputerName`（[#5094](https://github.com/PowerShell/PowerShell/pull/5094)）。
- **回归的 Windows cmdlet**：`Get-Counter`（[#10933](https://github.com/PowerShell/PowerShell/pull/10933)）、`Out-Printer`（[#10906](https://github.com/PowerShell/PowerShell/pull/10906)）、`Get-HotFix`（[#10740](https://github.com/PowerShell/PowerShell/pull/10740)）、`Clear-RecycleBin`（[#10909](https://github.com/PowerShell/PowerShell/pull/10909)）、`Update-List`（[#10922](https://github.com/PowerShell/PowerShell/pull/10922)）；**跨平台 `Get-Clipboard` / `Set-Clipboard`**（[#10340](https://github.com/PowerShell/PowerShell/pull/10340)）。
- `ConvertFrom-SecureString -AsPlainText`（[#11142](https://github.com/PowerShell/PowerShell/pull/11142)）；`ConvertFrom-StringData -Delimiter`（[#10665](https://github.com/PowerShell/PowerShell/pull/10665)）；`Select-String -Culture`（[#10943](https://github.com/PowerShell/PowerShell/pull/10943)）与 `-NoEmphasis`（[#8963](https://github.com/PowerShell/PowerShell/pull/8963)）；`New-Service -SecurityDescriptorSDDL`（[#10483](https://github.com/PowerShell/PowerShell/pull/10483)）。
- `Get-Item -LiteralPath a*b` 不存在时报错（[#5197](https://github.com/PowerShell/PowerShell/pull/5197)）。
- `Get-ChildItem` 递归时返回符号链接但**不进入**其目标（向 `ls -R` / `dir /S` 靠拢，[#3780](https://github.com/PowerShell/PowerShell/pull/3780)）。
- **对以下 cmdlet 传 `$null` 现在报错**（[#2672](https://github.com/PowerShell/PowerShell/pull/2672)）：`Get-Credential -UserName`、`Get-Event -SourceIdentifier`、`Get-EventSubscriber -SourceIdentifier`、`Get-Help -Name`、`Get-PSBreakpoint -Script`、`Get-PSProvider -PSProvider`、`Get-PSSessionConfiguration -Name`、`Get-PSSnapin -Name`、`Get-Runspace -Name`、`Get-RunspaceDebug -RunspaceName`、`Get-Service -Name`、`Get-TraceSource -Name`、`Get-Variable -Name`（以及当时尚存的 `Get-WmiObject -Class` / `-Property`）。
- 哈希算法 `MACTripleDES`、`RIPEMD160` 被 .NET 移除，影响 `Get-FileHash`（[#3024](https://github.com/PowerShell/PowerShell/pull/3024)）。
- `Select-String` 开始使用 ANSI 序列高亮匹配（见 `about_ANSI_Terminals`）。
- `Test-Path` 对空白字符串返回 `$false`。
- `$env:__SuppressAnsiEscapeSequences`（[#10814](https://github.com/PowerShell/PowerShell/pull/10814)）。
- 新增更新通知开关 **`$Env:POWERSHELL_UPDATECHECK`**（`Default` / `Off` / `LTS`，[#11132](https://github.com/PowerShell/PowerShell/pull/11132)，属破坏性变更）。
- `Add-Type` 在存在同名类型时抛错（[#9609](https://github.com/PowerShell/PowerShell/pull/9609)）。


### 4.5 PowerShell 7.1（2020-11-11，.NET 5.0）

构建于 **.NET 5.0**（GA 构建 `5.0.100-rtm.20526.5`）。随附 **PSReadLine 2.1.0**（Predictive IntelliSense），并提供 Microsoft Store 包。

**语言**

- **null 条件运算符 `?.` / `?[]` 由实验性转为正式**（`Move PSNullConditionalOperators feature out of experimental`，[#13529](https://github.com/PowerShell/PowerShell/pull/13529)）。这是 `?.` / `?[]` 的版本边界：**7.0 全程实验性 → 7.1 正式**。
- `??` 语义收紧：确保左侧只求值一次（[#12667](https://github.com/PowerShell/PowerShell/pull/12667)）。
- `-replace` 的文化处理：使用固定区域性（invariant culture）做字符串转换（[#10954](https://github.com/PowerShell/PowerShell/pull/10954)）——7.1 中作为破坏性变更列出，同时受实验性特性 `PSCultureInvariantReplaceOperator` 控制；到 **7.2 才成为默认行为**（`about_Comparison_Operators` 记载为 "Beginning in PowerShell 7.2"）。
- 解析器：`default` 的 switch 条件子句标记为关键字（[#10487](https://github.com/PowerShell/PowerShell/pull/10487)）。

**引擎与 API**

- **子系统插件模型（subsystem plugin model）起步**：`Initial work of the subsystem plugin model (for minimal powershell)`（[#13186](https://github.com/PowerShell/PowerShell/pull/13186)），新增 **`Get-PSSubsystem`**（RC.2 由 `Get-Subsystem` 更名，[#13765](https://github.com/PowerShell/PowerShell/pull/13765)）。该特性的目标是把 `System.Management.Automation.dll` 的部分内容拆分为独立程序集（实验性特性 `PSSubsystemPluginModel`）。
- 解析器 API：补齐 `PSToken` token 表项以修复 `PSParser` API（[#13779](https://github.com/PowerShell/PowerShell/pull/13779)）。
- AST 访问器 API：访问器接口与类新增 **`DefaultVisit`** 方法（[#13258](https://github.com/PowerShell/PowerShell/pull/13258)）。
- **`ScriptBlock` 转换为委托时不再把返回值包装为 `PSObject`**（[#10619](https://github.com/PowerShell/PowerShell/pull/10619)，破坏性；官方差异文档把它列在 API changes 中）。
- COM 互操作（.NET 5）：重新启用并刷新 `ComInterop` 代码（[#13304](https://github.com/PowerShell/PowerShell/pull/13304)、[#13533](https://github.com/PowerShell/PowerShell/pull/13533)）；**移除 `ComEnumerator`**，因为 .NET 5.0 已支持使用 `IEnumerator` 的 COM 对象（[#13259](https://github.com/PowerShell/PowerShell/pull/13259)）。
- 公开 API 调整：`ConsoleHost` 公开 API 的 `args` 参数改为非空（[#13429](https://github.com/PowerShell/PowerShell/pull/13429)）；`Command.Clone()` 复制 `CommandInfo`（[#12301](https://github.com/PowerShell/PowerShell/pull/12301)）；恢复 `PSHostProcessInfo.MainWindowTitle`（[#11885](https://github.com/PowerShell/PowerShell/pull/11885)）。
- 参数绑定/引擎：**显式命名参数覆盖 splatting 中的同名参数**（[#13162](https://github.com/PowerShell/PowerShell/pull/13162)，破坏性，会改变 `$args` 顺序）；`BigInteger` 数字字面量的字符串参数绑定修正（[#11634](https://github.com/PowerShell/PowerShell/pull/11634)，破坏性）；模块清单 `FileList` 中列出的程序集不再被加载（[#12968](https://github.com/PowerShell/PowerShell/pull/12968)）；发现由 `Assembly.Load(byte[])` / `Assembly.LoadFile` 加载的程序集（[#12203](https://github.com/PowerShell/PowerShell/pull/12203)）。
- `using module` 的相对路径**允许使用 `/`**（[#7424](https://github.com/PowerShell/PowerShell/pull/7424)/[#12492](https://github.com/PowerShell/PowerShell/pull/12492)）。
- 并发：**`ForEach-Object -Parallel` 复用运行空间**（[#12122](https://github.com/PowerShell/PowerShell/pull/12122)）；修复可能泄漏 PowerShell 对象释放的竞态（[#12227](https://github.com/PowerShell/PowerShell/pull/12227)）；进程外作业使用专用线程读取重定向的输出与错误流（[#11713](https://github.com/PowerShell/PowerShell/pull/11713)）。
- Web/IO：`Invoke-RestMethod` 使用异步流（[#11095](https://github.com/PowerShell/PowerShell/pull/11095)）；Web cmdlet 支持 **TLS 1.3**（[#13409](https://github.com/PowerShell/PowerShell/pull/13409)）；**`-OutFile` 改为类似 `-LiteralPath`，不处理通配符**（[#11701](https://github.com/PowerShell/PowerShell/pull/11701)，破坏性）；忽略值为 null 的头（[#11424](https://github.com/PowerShell/PowerShell/pull/11424)）。
- `Add-Type -OutputType` 不再支持 `ConsoleApplication` 与 `WindowsApplication`（[#13440](https://github.com/PowerShell/PowerShell/pull/13440)）。

**cmdlet 变化**

- `Get-Date` 新增 `-AsUTC`（[#11611](https://github.com/PowerShell/PowerShell/pull/11611)）；`-FromUnixTime`（[#12179](https://github.com/PowerShell/PowerShell/pull/12179)）在 preview.6 更名为 **`-UnixTimeSeconds`**（[#13084](https://github.com/PowerShell/PowerShell/pull/13084)）。
- `Test-Json -SchemaFile`（[#11934](https://github.com/PowerShell/PowerShell/pull/11934)）。
- `Read-Host -MaskInput`（[#10908](https://github.com/PowerShell/PowerShell/pull/10908)），后续改为返回纯文本（[#13256](https://github.com/PowerShell/PowerShell/pull/13256)）。
- `Get-Random -Shuffle`（[#11093](https://github.com/PowerShell/PowerShell/pull/11093)）。
- `Process` 新增 **`CommandLine`** 属性（[#12288](https://github.com/PowerShell/PowerShell/pull/12288)）。
- 恢复 Certificate provider 的参数（[#10622](https://github.com/PowerShell/PowerShell/pull/10622)）。
- `Stop-Computer` 支持 Linux/macOS（[#11151](https://github.com/PowerShell/PowerShell/pull/11151)）；`Restart-Computer` 为 Unix/macOS 重构（[#11319](https://github.com/PowerShell/PowerShell/pull/11319)）。
- `ConvertTo-Json` 超出 `-Depth` 时发出警告（[#13692](https://github.com/PowerShell/PowerShell/pull/13692)）。
- 指定 `utf7` 编码时发出警告。
- `Select-Object` 对 `Keys` 等哈希表成员的修正（[#11097](https://github.com/PowerShell/PowerShell/pull/11097)）。

**实验性特性**

- 新增：`Microsoft.PowerShell.Utility.PSManageBreakpointsInRunspace`（`*-PSBreakpoint` 全部新增 `-Runspace` 参数，[#10492](https://github.com/PowerShell/PowerShell/pull/10492)）、`PSNativePSPathResolution`（[#12386](https://github.com/PowerShell/PowerShell/pull/12386)；preview.7 曾转正式 [#13522](https://github.com/PowerShell/PowerShell/pull/13522)，RC.2 又回退为实验性 [#13734](https://github.com/PowerShell/PowerShell/pull/13734)）、`PSCultureInvariantReplaceOperator`、`PSSubsystemPluginModel`。
- 转正式：`PSNullConditionalOperators`、`PSUnixFileStat`。

**破坏性变更** ⚠️

- **字符串比较行为变化**：.NET 5 起，固定区域性（culture-invariant）字符串比较**忽略不可打印控制字符**。例如 `'Food' -eq "Foo`ad"` 返回 `True`（`` `a `` 为 Ctrl-G / `[char]7`）。
- **原生命令只写 `stderr` 不再使 `$?` 为 `$false`**（[#13395](https://github.com/PowerShell/PowerShell/pull/13395)）。
- **`$ErrorActionPreference` 不再作用于原生命令的 `stderr`**（[#13361](https://github.com/PowerShell/PowerShell/pull/13361)）。
- `-FromUnixTime` 更名为 `-UnixTimeSeconds`（[#13084](https://github.com/PowerShell/PowerShell/pull/13084)）。
- 显式命名参数覆盖 splatting 中的同名参数（[#13162](https://github.com/PowerShell/PowerShell/pull/13162)）。
- `Split-Path -Qualifier` 不再是位置参数（[#12960](https://github.com/PowerShell/PowerShell/pull/12960)）。
- `Start-Process` 未指定的工作目录按字面路径解析（[#11946](https://github.com/PowerShell/PowerShell/pull/11946)）；Windows 上的环境行为与 `-UseNewEnvironment`（[#10830](https://github.com/PowerShell/PowerShell/pull/10830)）。
- Web cmdlet `-OutFile` 按字面路径处理（[#11701](https://github.com/PowerShell/PowerShell/pull/11701)）。
- `pwsh -inputformat` 的简写由 `-in` 改为 **`-inp`**，以避免与 `-interactive` 冲突（[#13205](https://github.com/PowerShell/PowerShell/pull/13205)）。

### 4.6 PowerShell 7.2（2021-11-08，.NET 6.0，LTS）

**破坏性变更** ⚠️

- **`PSDesiredStateConfiguration` 移出 PowerShell 7 安装包**，改发布到 PowerShell Gallery，产品与 DSC 解耦；跨平台 DSC 代码改为引擎子系统（[#15536](https://github.com/PowerShell/PowerShell/pull/15536)、[#15127](https://github.com/PowerShell/PowerShell/pull/15127)）。安装时**必须限制主版本**，例如 `Install-Module PSDesiredStateConfiguration -Repository PSGallery -MaximumVersion 2.99`（否则会装到差异很大的 v3+）。
- **`FileSystemInfo.Target` 由 CodeProperty 改为**指向 `FileSystemInfo.LinkTarget` 的 **AliasProperty**（[#16165](https://github.com/PowerShell/PowerShell/pull/16165)）。
- **公共 API 破坏性整理**：为满足 CA1052，把"只含静态方法的公共类"改为 `static`——**对二进制模块可见**（[#15775](https://github.com/PowerShell/PowerShell/pull/15775)）。
- `ConvertTo-Json` 超出 `-Depth` 时**发出警告**（[#13692](https://github.com/PowerShell/PowerShell/pull/13692)）；`-Depth` 最小值改为 **0**（[#14830](https://github.com/PowerShell/PowerShell/pull/14830)）；**`DateTime` / `string` 的 ETS 属性不再序列化进 JSON**（[#15665](https://github.com/PowerShell/PowerShell/pull/15665)，重要行为变更）。
- `ConvertTo-Csv` / `Export-Csv` 支持 `IDictionary`（[#11029](https://github.com/PowerShell/PowerShell/pull/11029)）；`-UseQuotes AsNeeded` 时对含引号/换行的字段加引号（[#15765](https://github.com/PowerShell/PowerShell/pull/15765)）。
- 移除 `-Directory` 的别名 `D`（[#15171](https://github.com/PowerShell/PowerShell/pull/15171)）。
- **命令行参数禁止混用 `-` 与 `/` 前缀**（[#15142](https://github.com/PowerShell/PowerShell/pull/15142)）。
- **Windows 上 `pwsh.exe -File` 只接受 `.ps1` 文件**（[#15859](https://github.com/PowerShell/PowerShell/pull/15859)）。
- `Get-Date -UFormat` 的 `%G` / `%g`（[#14555](https://github.com/PowerShell/PowerShell/pull/14555)）与 `%u`（[#14549](https://github.com/PowerShell/PowerShell/pull/14549)）按 ISO 8601 修正。
- 安全 / 锁定语义收紧：AppLocker Deny 先于 Execution Policy Bypass 生效（[#15035](https://github.com/PowerShell/PowerShell/pull/15035)）；**NoLanguage** 模式下限制 `New-Object`（[#14140](https://github.com/PowerShell/PowerShell/pull/14140)）、锁定机器上禁用 `Add-Type`（[#16245](https://github.com/PowerShell/PowerShell/pull/16245)）；AppLocker 锁定时禁用全部 COM（[#16268](https://github.com/PowerShell/PowerShell/pull/16268)）；脚本签名校验逻辑对齐 `Get-AuthenticodeSignature`（[#14849](https://github.com/PowerShell/PowerShell/pull/14849)）。
- 改进可变值类型（mutable value type）检测（[#12495](https://github.com/PowerShell/PowerShell/pull/12495)）。
- `-PipelineVariable` 保证对脚本 cmdlet 的所有输出生效（[#12766](https://github.com/PowerShell/PowerShell/pull/12766)）。
- 允许从**原生代码加载程序集**的实验性特性 `PSLoadAssemblyFromNativeCode`；引擎新增 `LoadAssemblyFromNativeMemory`，使原生 PowerShell 宿主可从内存加载程序集（[#14652](https://github.com/PowerShell/PowerShell/pull/14652)）。
- **`$ErrorView` 新增 `DetailedView`**（[#15609](https://github.com/PowerShell/PowerShell/pull/15609)）。
- **`PSHostUserInterface.GetOutputString()` 与 `GetFormatStyleString()` 上移为公共 API**（[#16075](https://github.com/PowerShell/PowerShell/pull/16075)、[#14397](https://github.com/PowerShell/PowerShell/pull/14397)）——影响自定义 host 及继承 `PSHostUserInterface` 的实现。
- **新增 `IArgumentCompleterFactory`**，用于需要构造参数的 ArgumentCompleter（[#12605](https://github.com/PowerShell/PowerShell/pull/12605)）。

**新增/转正**

- 实验性特性转正式：`PSAnsiRendering`、`PSAnsiProgress`、`PSCultureInvariantReplaceOperator`、`PSNotApplyErrorActionToStderr`、`PSUnixFileStat`、`Microsoft.PowerShell.Utility.PSImportPSDataFileSkipLimitCheck`、`Microsoft.PowerShell.Utility.PSManageBreakpointsInRunspace`。
- 新增实验性特性：**`PSNativeCommandArgumentPassing`**（改用 `StartProcessInfo.ArgumentList` 而非重建字符串，并新增自动变量 `$PSNativeCommandArgumentPassing`）、**`PSAnsiRenderingFileInfo`**、`PSLoadAssemblyFromNativeCode`。
- **引入自动变量 `$PSStyle`** 与 ANSI 渲染引擎改动：格式化系统遵循 `$PSStyle.OutputRendering`；新增 `StringDecorated` 类型处理含 ANSI 转义的字符串（`IsDecorated` 属性、`Length` 返回不含转义序列的文本长度、`Substring(int contentLength)`、`ToString(bool Ansi)`、`FormatHyperlink(string text, uri link)`）。
  - `$PSStyle.OutputRendering` 取值：`ANSI` / `PlainText` / `Host`；原有的 `Automatic` 在 7.2 preview.9 被**移除**（[#15882](https://github.com/PowerShell/PowerShell/pull/15882)）。
  - **关于默认值的版本细节**（容易记错）：7.2 preview.9 一度设为 `Host`，**7.2 服务版（7.2.1 起）为 `Ansi`**（即重定向输出会带 ANSI 转义序列），**7.3 起才是 `Host`**。
- **`PSStyle` 同时是公开 .NET API**：`System.Management.Automation.PSStyle` 提供单例 `PSStyle.Instance` 供 C# 宿主使用。

**其他新增参数（择要）**

- `Import-PowerShellDataFile -SkipLimitCheck`（[#13672](https://github.com/PowerShell/PowerShell/pull/13672)）。
- `Set-Clipboard -PassThru`（[#13713](https://github.com/PowerShell/PowerShell/pull/13713)）。
- `Tee-Object -Encoding`（[#12135](https://github.com/PowerShell/PowerShell/pull/12135)）。
- `Write-Error -Exception` / `-ErrorRecord` 改为位置 0（[#13813](https://github.com/PowerShell/PowerShell/pull/13813)）。
- **`New-PSSession -ConnectingTimeout`**（文档明确标注 "This parameter was introduced in PowerShell 7.2"）。
- `Start-Transcript` 默认编码改为 UTF-8 无 BOM（[#13732](https://github.com/PowerShell/PowerShell/pull/13732)）。
- `$PSStyle.Progress.UseOSCIndicator`（[#14927](https://github.com/PowerShell/PowerShell/pull/14927)）；Unix 下 DECCKM 处理（[#14943](https://github.com/PowerShell/PowerShell/pull/14943)）。
- `Start-Process` 移除环境块 32767 字符限制（[#14111](https://github.com/PowerShell/PowerShell/pull/14111)）。

**语言**：**7.2 没有新增任何语言语法特性**（`??` / `??=` / `?.` / `? :` 等来自 7.0 / 7.1）。
- 支持 **Microsoft Update**（MSI 参数 `USE_MU`、`ENABLE_MU`）。
- **Linux 通用安装包**：把原先 8 个发行版包合并为一个，自动安装所需依赖。
- 支持 Windows / macOS 的 **ARM64**，以及 Debian / Ubuntu 的 **ARM32 与 ARM64**。
- PSReadLine 2.1 引入 **Predictive IntelliSense**（`CommandPrediction` API 框架）；默认关闭，用 `Set-PSReadLineOption -PredictionSource History` 启用。

### 4.7 PowerShell 7.3（2022-11-09，.NET 7.0）

**破坏性变更** ⚠️

- **不再支持 Windows 7**（合规相关的 Windows API 更新/移除）；PowerShell Direct for Hyper-V 仅支持 Windows 10 1809 及以上。
- **`$PSStyle.OutputRendering` 默认值改为 `Host`**（7.2 服务版为 `Ansi`，见 4.6）。
- `Out-String` / `Out-File` 对纯字符串输入**保持原样**（不再重排换行，[#17455](https://github.com/PowerShell/PowerShell/pull/17455)；相较 7.2 为破坏性）。
- **`System.Security.AccessControl.ObjectSecurity` 的类型数据（type data）移入 `Microsoft.PowerShell.Security` 模块**：使用其代码属性/代码方法前**必须显式导入该模块**（[#16355](https://github.com/PowerShell/PowerShell/pull/16355)、[#17771](https://github.com/PowerShell/PowerShell/pull/17771)）。
- `Test-Connection` 因 .NET 7 的有意破坏性变更而失效（跟踪于 [#17018](https://github.com/PowerShell/PowerShell/issues/17018)）。

**语言**：script block 新增 **`clean` 块**，与 `begin` / `process` / `end` 并列（[#15177](https://github.com/PowerShell/PowerShell/pull/15177)）。

> 官方 `about_Language_Keywords` 明确：`clean` 关键字在 PowerShell 7.3 加入；它在 `begin` / `process` / `end` 之后**保证执行**——与 `end` 不同，**即使其他块发生终止性错误也总会执行**。这正是它作为资源清理机制的价值所在。

**引擎与 API**

- **PSRP 序列化移除 `BinaryFormatter`**（安全驱动，[#17133](https://github.com/PowerShell/PowerShell/pull/17133)）。
- **新增自定义远程连接（Custom Remote Connections）功能**，提供连接类型的可扩展点（[#17011](https://github.com/PowerShell/PowerShell/pull/17011)）。
- **支持带泛型类型实参调用 .NET 方法**（[#12412](https://github.com/PowerShell/PowerShell/pull/12412)、[#16822](https://github.com/PowerShell/PowerShell/pull/16822)，解析修正 [#16937](https://github.com/PowerShell/PowerShell/pull/16937)）。
- 文件系统项新增 **`.ResolvedTarget`**，把符号链接目标解析为 `FileSystemInfo`（[#16490](https://github.com/PowerShell/PowerShell/pull/16490)）。
- **`Set-AuthenticodeSignature` 默认哈希算法改为 SHA256**（[#17560](https://github.com/PowerShell/PowerShell/pull/17560)）。
- 错误格式化改用 `$PSStyle.Formatting` 中的颜色（[#17987](https://github.com/PowerShell/PowerShell/pull/17987)）；`AnsiRegex` 支持 Hyperlink 序列（[#17442](https://github.com/PowerShell/PowerShell/pull/17442)）。
- `Add-Type -PassThru` 过滤编译器生成的类型（[#18095](https://github.com/PowerShell/PowerShell/pull/18095)）。
- `Measure-Object` 默认忽略缺失属性（除非 strict mode，[#16589](https://github.com/PowerShell/PowerShell/pull/16589)）；`Sort-Object -Stable -Unique` 真正稳定排序（[#17189](https://github.com/PowerShell/PowerShell/pull/17189)）。
- 7.3.8 安全修复：**受限远程会话禁止从网络位置获取帮助**（后续 7.5 正式列入破坏性变更）。

**远程处理**

- PSRP over SSH 新增 **`-Options`**，可直传 OpenSSH 选项（[#12802](https://github.com/PowerShell/PowerShell/pull/12802)）。
- `pwsh` 新增 **`-ConfigurationFile`**，可用 `.pssc` 文件定义会话配置启动新进程（[#17447](https://github.com/PowerShell/PowerShell/pull/17447)）。
- `New-PSSessionConfigurationFile` 支持非 Windows 平台（[#17447](https://github.com/PowerShell/PowerShell/pull/17447)）。
- 隐式远程生成的模块保持对 5.1 的向后兼容（[#17227](https://github.com/PowerShell/PowerShell/pull/17227)）。

**cmdlet 变化**

- **新增 `Switch-Process`**（别名 `exec`），提供非 Windows 上的 `exec` 兼容（[#16462](https://github.com/PowerShell/PowerShell/pull/16462)）；7.3.1 把 `exec` 从别名改为包装函数，并把 `sqlcmd.exe` 加入 legacy 传参名单。
- Web cmdlet 新增 `-HttpVersion`（[#15853](https://github.com/PowerShell/PowerShell/pull/15853)）。
- `ConvertTo-Json -Depth` 上限修正为 **100**（[#16197](https://github.com/PowerShell/PowerShell/pull/16197)）。
- `Invoke-Command` 新增 `-StrictMode`（[#16545](https://github.com/PowerShell/PowerShell/pull/16545)）；改进 `$using:` 变量处理（[#16113](https://github.com/PowerShell/PowerShell/pull/16113)）。
- **`ConvertFrom-Json -AsHashtable` 改为返回 `OrderedHashtable`**（[#17405](https://github.com/PowerShell/PowerShell/pull/17405)）——该参数本身自 6.0 起存在，此前返回普通 `Hashtable`。
- `Get-CimClass` 新增 `-Amended`（[#17477](https://github.com/PowerShell/PowerShell/pull/17477)）。
- `New-TimeSpan` 新增 `-Milliseconds`（[#17621](https://github.com/PowerShell/PowerShell/pull/17621)）；**`Start-Sleep` 新增 `-Duration`（`TimeSpan`）**（[#16185](https://github.com/PowerShell/PowerShell/pull/16185)）。
- `Set-AuthenticodeSignature -TimeStampServer` 支持 HTTPS（[#16134](https://github.com/PowerShell/PowerShell/pull/16134)）。
- 新增类型加速器 **`ordered`**（`OrderedDictionary`，[#17804](https://github.com/PowerShell/PowerShell/pull/17804)）。
- `pwsh` 新增 `-NoProfileLoadTime`（[#17535](https://github.com/PowerShell/PowerShell/pull/17535)）。
- `find.exe` 加入 Windows 上的 legacy 传参名单（[#17715](https://github.com/PowerShell/PowerShell/pull/17715)）；`Test-Json` 支持根为非对象类型（[#17741](https://github.com/PowerShell/PowerShell/pull/17741)）。
- 显示方法定义/重载时展示可选参数。
- 移除 `Out-GridView` 收到的字符串中的 ANSI 转义序列。
- 表格中的十进制数字按当前区域性渲染。
- 即使当前工作目录已不存在，命令仍可执行（[#17579](https://github.com/PowerShell/PowerShell/pull/17579)）。

**实验性特性**

- 转正式：`PSAnsiRenderingFileInfo`、`PSCleanBlock`、`PSAMSIMethodInvocationLogging`、**`PSNativeCommandArgumentPassing`**、`PSExec`、`PSRemotingSSHTransportErrorHandling`。
- 新增：`PSNativeCommandErrorActionPreference`（引入 `$PSNativeCommandUseErrorActionPreference`）。
- **移除**：`PSNativePSPathResolution`（[#17670](https://github.com/PowerShell/PowerShell/pull/17670)）、`PSStrictModeAssignment`（[#18040](https://github.com/PowerShell/PowerShell/pull/18040)）。

> **`PSNativeCommandArgumentPassing` 转正式的连锁影响**：该特性默认对所有用户启用新的原生命令传参机制（改用 `StartProcessInfo.ArgumentList` 而非重建字符串），仅 `find.exe`、`sqlcmd.exe` 等保留 legacy 行为。这是 7.3 中最容易影响既有脚本的变更之一。

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

| 语法 | 引入版本 | 引入时的状态 / 备注 |
| --- | --- | --- |
| `using namespace` / `using assembly` / `using module` | 5.0 | 5.1 基线已具备；7.1 起 `using module` 的相对路径允许 `/` |
| 类（`class`）、枚举（`enum`） | 5.0 | 5.1 基线已具备 |
| **`&`（行尾后台作业运算符）** | **6.0** | 正式（[#3360](https://github.com/PowerShell/PowerShell/pull/3360)）；同时是语句终止符 |
| ESC 转义 `` `e `` | 6.0 | 正式 |
| Unicode 转义 `` `u{...} `` / `` `u#### `` | 6.0 | 正式（[#3958](https://github.com/PowerShell/PowerShell/pull/3958)） |
| 枚举到字符串的转换 | 6.0 | 正式（[#4318](https://github.com/PowerShell/PowerShell/pull/4318)） |
| 字符范围 `'a'..'z'` | 6.0 | 正式（[#5026](https://github.com/PowerShell/PowerShell/pull/5026)）；数字范围更早已有 |
| `-split` 支持 `'Singleline, Multiline'` | 6.0 | 正式（[#4721](https://github.com/PowerShell/PowerShell/pull/4721)） |
| `-replace` 接受脚本块 | 6.1（存疑） | changelog 记为 6.1（[#6029](https://github.com/PowerShell/PowerShell/pull/6029)），官方 `about_Comparison_Operators` 写 "PowerShell 6 and later"，两者不一致 |
| 数字字面量后缀 `short`/`ushort`/`uint`/`ulong`、字节字面量、枚举自定义基础类型 | 6.2 | 正式（[#7813](https://github.com/PowerShell/PowerShell/pull/7813)、[#7901](https://github.com/PowerShell/PowerShell/pull/7901)、[#8329](https://github.com/PowerShell/PowerShell/pull/8329)） |
| `??`、`??=` | **7.0** | preview.5 实验性 → GA 正式（[#10636](https://github.com/PowerShell/PowerShell/pull/10636)） |
| `&&`、`\|\|`（管道链） | **7.0** | preview.5 实验性 → GA 正式（[#9849](https://github.com/PowerShell/PowerShell/pull/9849)） |
| `? :`（三元运算符） | **7.0** | 实验性特性名 `PSTernaryOperator`；GA 正式 |
| **`?.` / `?[]`（null 条件访问）** | **7.0 实验性 → 7.1 正式** | 7.0 全程实验性（[#10960](https://github.com/PowerShell/PowerShell/pull/10960)），7.1 转正（[#13529](https://github.com/PowerShell/PowerShell/pull/13529)）；需写 `${var}` 形式 |
| 管道位于行首时的续行 | 7.0 | 正式（[#8938](https://github.com/PowerShell/PowerShell/pull/8938)） |
| `-replace` 使用固定区域性转换 | 7.1 实验性 → **7.2 默认** | `PSCultureInvariantReplaceOperator` |
| `ForEach-Object -Parallel` / `-ThrottleLimit` | 7.0 | 5.1 无并行管道 |
| **`clean` 块** | **7.3** | 与 `begin`/`process`/`end` 并列；**即使其他块发生终止性错误也总会执行**（[#15177](https://github.com/PowerShell/PowerShell/pull/15177)） |

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

**WinRM 端点的复用**：在已启用 WinRM 的机器上，**PowerShell 7 默认复用 5.1 的 `Microsoft.PowerShell` endpoint**；只有运行 `Enable-PSRemoting` 后才会生成 7 自己的 endpoint。这解释了"7 装好了但 `Enter-PSSession` 连过去还是 5.1"的现象。

**PSRP 协议版本**：官方示例显示 `PSRemotingProtocolVersion = 2.3`、`SerializationVersion = 1.1.0.1`、`WSManStackVersion = 3.0`（见 `about_PowerShell_Editions` 的 7.3.9 示例）。7.2 / 7.3 的 CHANGELOG 中没有协议版本升级条目，故 2.3 在这些版本间保持一致。

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

实验性特性机制自 **6.1 引入**（RFC0029，[#7242](https://github.com/PowerShell/PowerShell/pull/7242)），并在 **6.2 补齐启停 cmdlet**（[#8318](https://github.com/PowerShell/PowerShell/pull/8318)），是理解 7.x API 演进的关键：新功能先以实验性特性交付，获得反馈后再转正式。**实验性特性可能在后续版本被改名、转正甚至移除**（例如 7.3 移除了 `PSNativePSPathResolution` 与 `PSStrictModeAssignment`），因此不应在生产环境依赖。

```powershell
Get-ExperimentalFeature                              # 列出全部
Enable-ExperimentalFeature  -Name PSRedirectToVariable
Disable-ExperimentalFeature -Name PSRedirectToVariable
$EnabledExperimentalFeatures                         # 已启用的特性名列表
```

公开 API 层面：`Experimental` 特性（`[Experimental(Name, ExperimentAction)]`）与 `ExperimentalFeature.IsEnabled()`。

| 版本 | 新增实验性特性 | 转为正式 |
| --- | --- | --- |
| 6.1 | 机制本身 + `Get-ExperimentalFeature` | — |
| 6.2 | `Enable-`/`Disable-ExperimentalFeature` cmdlet；`PSCommandNotFoundSuggestion`、`PSImplicitRemotingBatching`、`PSTempDrive`、`PSUseAbbreviationExpansion` | — |
| 7.0 | `?.`/`?[]`（`PSNullConditionalOperators`）、`PSTernaryOperator` 等 | `??`、`??=`、`&&`、`\|\|`、`? :`、ConciseView、`Get-Error`（`Make approved features non-experimental`，[#11303](https://github.com/PowerShell/PowerShell/pull/11303)） |
| 7.1 | `PSManageBreakpointsInRunspace`、`PSNativePSPathResolution`、`PSCultureInvariantReplaceOperator`、`PSSubsystemPluginModel` | `PSNullConditionalOperators`、`PSUnixFileStat` |
| 7.2 | `PSNativeCommandArgumentPassing`、`PSAnsiRenderingFileInfo`、`PSLoadAssemblyFromNativeCode` | `PSAnsiRendering`、`PSAnsiProgress`、`PSCultureInvariantReplaceOperator`、`PSNotApplyErrorActionToStderr`、`PSUnixFileStat`、`PSImportPSDataFileSkipLimitCheck`、`PSManageBreakpointsInRunspace`；**移除** `PSImplicitRemotingBatching` |
| 7.3 | `PSNativeCommandErrorActionPreference` | `PSAnsiRenderingFileInfo`、`PSCleanBlock`、`PSAMSIMethodInvocationLogging`、`PSNativeCommandArgumentPassing`、`PSExec`、`PSRemotingSSHTransportErrorHandling`；**移除** `PSNativePSPathResolution`、`PSStrictModeAssignment` |
| 7.4 | `PSFeedbackProvider`、`PSModuleAutoLoadSkipOfflineFiles`、`PSCommandWithArgs` | `PSConstrainedAuditLogging`、`PSCustomTableHeaderLabelDecoration`、`PSNativeCommandErrorActionPreference`、`PSNativeCommandPreserveBytePipe`、`PSWindowsNativeCommandArgPassing` |
| 7.5 | `PSRedirectToVariable`、`PSNativeWindowsTildeExpansion`、`PSSerializeJSONLongEnumAsNumber` | `PSCommandNotFoundSuggestion`、`PSCommandWithArgs`、`PSModuleAutoLoadSkipOfflineFiles` |
| 7.6 | `PSSerializeJSONLongEnumAsNumber`、`PSProfileDSCResource` | `PSFeedbackProvider`、`PSNativeWindowsTildeExpansion`、`PSRedirectToVariable`、`PSSubsystemPluginModel` |

> ⚠️ 7.5 / 7.6 之间关于 `ConvertTo-Json` 大枚举按数字（`PSSerializeJSONLongEnumAsNumber`）的正式化节点，官方两处表述重叠，见[第 9 节](#9-版本归属的说明与已知不确定项)。

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
| 6.0 | 跨平台化：`pwsh`、.NET Core 2.0，移除 snap-in / 工作流 / WMI v1 / `RunspaceConfiguration`；新增 `&` 后台运算符、字符范围、`$PSVersionTable` 4 个新键 |
| 6.1 | Windows Compatibility Pack（1900+ cmdlet 可用）、**实验性特性机制**、`PSCustomObject.Count/Length/ForEach/Where`、Markdown cmdlet、`Test-Json`、SSH `user@host:port`、Web cmdlet `-Form` |
| 6.2 | **`Enable-`/`Disable-ExperimentalFeature`**、`Join-String`、`ConvertFrom-Json -Depth`、`PowerShell.InvokeAsync`/`StopAsync` 公开、哈希表改 `OrdinalIgnoreCase`、`-Debug` 改 `Continue` |
| 7.0 | **`??` / `??=` / `? :` / `&&` / `\|\|`**、`ForEach-Object -Parallel`、ConciseView、`Get-Error`、WPF 恢复、`Import-Module -UseWindowsPowerShell`、`POWERSHELL_UPDATECHECK` |
| 7.1 | **`?.` / `?[]` 转正式**、.NET 5 字符串比较语义变化、`ScriptBlock`→委托不再包 `PSObject`、splatting 覆盖规则、Web `-OutFile` 字面化、`Get-PSSubsystem` |
| 7.2 | **`$PSStyle`**、DSC 移出产品、原生参数传递实验性特性、Microsoft Update、`PSHostUserInterface` 新公开方法、`IArgumentCompleterFactory` |
| 7.3 | **`clean` 块**、`$PSStyle.OutputRendering` 默认 `Host`、`ObjectSecurity` 类型数据迁移、`ConvertFrom-Json -AsHashtable` 有序化、`ConvertTo-Json -Depth` 上限 100、PSRP 弃用 `BinaryFormatter`、`Set-AuthenticodeSignature` 默认 SHA256 |
| 7.4 | **通用参数 `ProgressAction`**、`Test-Json` 换引擎（弃 Draft 4）、`ValidateNotNullOrWhiteSpace`、`NoRunspaceAffinity`、`-ConnectionTimeoutSeconds`、`Get-SecureRandom`、字节流保留转正 |
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
- [What's New in PowerShell Core 6.2](https://learn.microsoft.com/en-us/previous-versions/powershell/scripting/whats-new/what-s-new-in-powershell-core-62)
- [What's New in PowerShell Core 6.1](https://learn.microsoft.com/en-us/previous-versions/powershell/scripting/whats-new/what-s-new-in-powershell-core-61)
- [What's New in PowerShell Core 6.0](https://learn.microsoft.com/en-us/previous-versions/powershell/scripting/whats-new/what-s-new-in-powershell-core-60)
- [Differences between Windows PowerShell 5.1 and PowerShell 7.x](https://learn.microsoft.com/en-us/powershell/scripting/whats-new/differences-from-windows-powershell)
- [PowerShell Support Lifecycle](https://learn.microsoft.com/en-us/powershell/scripting/install/powershell-support-lifecycle)
- [Microsoft Lifecycle — PowerShell（含 PT 时区的精确支持日期）](https://learn.microsoft.com/en-us/lifecycle/products/powershell)
- [Choosing the right PowerShell NuGet package for your .NET project](https://learn.microsoft.com/en-us/powershell/scripting/dev-cross-plat/choosing-the-right-nuget-package)
- [about_Automatic_Variables](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_automatic_variables)
- [about_Operators](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_operators)
- [about_PowerShell_Editions](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_editions)
- [about_Language_Keywords](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_language_keywords)
- [about_ANSI_Terminals（`$PSStyle`）](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_ansi_terminals)
- [about_Experimental_Features](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_experimental_features)
- [Using Experimental Features](https://learn.microsoft.com/en-us/powershell/scripting/learn/experimental-features)
- [about_Windows_PowerShell_Compatibility](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_windows_powershell_compatibility)
- [Migrating from Windows PowerShell 5.1 to PowerShell 7](https://learn.microsoft.com/en-us/powershell/scripting/whats-new/migrating-from-windows-powershell-51-to-powershell-7)
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
- [7.3 Changelog](https://github.com/PowerShell/PowerShell/blob/master/CHANGELOG/7.3.md)
- [7.2 Changelog](https://github.com/PowerShell/PowerShell/blob/master/CHANGELOG/7.2.md)
- [PowerShell Releases](https://github.com/PowerShell/PowerShell/releases)
- [NuGet: PowerShellStandard.Library](https://www.nuget.org/packages/PowerShellStandard.Library)
- [NuGet: Microsoft.PowerShell.5.1.ReferenceAssemblies](https://www.nuget.org/packages/Microsoft.PowerShell.5.1.ReferenceAssemblies)
- [.NET 支持策略](https://dotnet.microsoft.com/platform/support/policy/dotnet-core)

---

## 9. 版本归属的说明与已知不确定项

本文的写法遵循"**能在官方文档中逐条核对才下断言**"的原则。以下条目需要读者注意其证据强度：

1. **7.6 的补丁版本日期**：官方 `CHANGELOG/7.6.md` 未逐条标注日期，本文只给出 7.6 GA 日期（2026-03-18，来自 Support Lifecycle 表格）。7.6.1–7.6.6 的具体发布日期未列出。
2. **`$PSVersionTable` 的完整键集合**：7.x 的官方键清单取自 `about_Automatic_Variables`（列出 9 个键）。5.1 的 `BuildVersion` / `CLRVersion` 存在性与移除依据的是官方 "Differences from Windows PowerShell" 文档的明确表述；但该文档未给出 5.1 的完整键清单，且这两项的具体值随 OS / 补丁变化，官方没有对照表。若需精确对比，建议在真实 5.1 会话中执行 `$PSVersionTable` 实测。
3. **`$PSStyle.OutputRendering` 默认值的变迁细节**：官方 What's New 7.3 写"默认改为 `Host`"，但 7.3 的 CHANGELOG 只有 preview.1 的"改为 `Ansi`"一条，**缺少最终改为 `Host` 的那条 PR 记录**。本文的表述（7.2 preview.9 曾为 `Host` → 7.2 服务版 `Ansi` → 7.3 起 `Host`）综合了 What's New、CHANGELOG 与现行 `about_ANSI_Terminals` 三处，请以目标版本实测为准。
4. **7.2 / 7.3 的 .NET 补丁号**：官方文档只写 ".NET 6.0" / ".NET 7.0"。7.2 的 GA SDK 为 `6.0.100-rtm.21527.11`，据此推断运行时为 .NET 6.0.0；7.3 使用内部 .NET 7 GA 构建。补丁号未在文档中明写。
5. **7.5 与 7.6 之间关于"大枚举按数字"的正式化节点**：7.5 changelog 将其列为该版本的破坏性变更（预览阶段），而 7.6 的 What's New 把 `PSSerializeJSONLongEnumAsNumber` 列为**7.6 新增实验性特性**、同时把 `ConvertTo-Json` 大枚举按数字列入 7.6 破坏性变更。两处表述存在重叠，实际行为请以目标版本实测为准。
6. **`clean` 块相关的 AST 类型名**：`CleanBlockAst` 来自引擎实现。Microsoft Learn 的 .NET API 浏览器**不收录 `System.Management.Automation` 命名空间**（`PSStyle` 同样查不到），因此引擎内部的公开类型名无法从官方 API 文档逐一核实。
7. **PowerShell Standard 5.1 的成员级 API 面**：本文只确认了两个引用程序集包的定位与目标框架，**未逐成员枚举** PowerShell Standard 5.1 的 API 集合。如需精确判断某个成员是否可用，请直接引包编译验证。
8. **`Select-Object -SkipIndex` / `-Wait` 的版本标注**：官方文档分别写作 "introduced in Windows PowerShell 6.0" 与 "introduced in Windows PowerShell 3.0"，用词不统一（"Windows PowerShell 6.0" 实际指 PowerShell 6.0），本文照原文引用。
9. **`Export-Clixml` / `Import-Clixml`**：7.2 与 7.3 的 CHANGELOG 中**未发现**变更条目——这属于"未发现"，不等于"确认未变"。
10. **6.0 / 6.2 的 GA 日期冲突**：`CHANGELOG/6.0.md` 标题写 `2018-01-10`，`CHANGELOG/6.2.md` 标题写 `2019-03-28`；而 Learn 生命周期表与 Microsoft Lifecycle 分别为 `2018-01-20` 与 `2019-03-29`。本文统一采用生命周期表的日期。此外，**结束支持日期在两个官方页面间会差一天**，原因是 Microsoft Lifecycle 以太平洋时间（PT）呈现。
11. **`AddTypeCommandBase` 的移除版本冲突**：官方 What's New **6.0** 页面把它列在 "API changes"，而 `CHANGELOG/6.1.md` 把它列在 6.1.0-preview.1。
12. **`Enable-ExperimentalFeature` / `Disable-ExperimentalFeature` 的引入版本**：6.1 的 What's New 正文提到了这两个 cmdlet，而 6.2 的 changelog 把它们的加入记为 `#8318`。本文表述为"6.1 引入机制、6.2 完善"。
13. **`-replace` 接受脚本块的版本**：changelog 记为 6.1（`#6029`），官方 `about_Comparison_Operators` 写 "In PowerShell 6 and later"。
14. **`DebugSource` 类型的移除**：该类型是真实存在的公开类型（`Script`、`ScriptFile`、`XamlDefinition`），但 Learn 的 .NET API 浏览器**只为 `Microsoft.PowerShell.5.1.ReferenceAssemblies` 提供该页面**（查询 7.x SDK 视图会回退到 5.1 页面），且 **6.0–7.1 的 changelog 中没有任何条目点名 `DebugSource`**。因此"它随工作流堆栈在 6.0 一并移除"是**推断**，不是官方明文。
15. **`Cmdlet` / `PSCmdlet` 基类成员集的变化**：在 6.0–7.1 的官方文档与 changelog 中**未发现**任何关于基类成员集变化的记录（`Cmdlet.PipelineStopToken` 是 7.6 的新增）。若需要断言"未变化"，本节的准确表述是"这些版本中没有记录此类变化"。
16. **PSRP 协议版本**：官方示例确认 `PSRemotingProtocolVersion = 2.3`、`SerializationVersion = 1.1.0.1`、`WSManStackVersion = 3.0`（7.3.9 示例）；**未找到 5.1 的官方对照页面**，因此"5.1 也是 2.3"属业界通说而非官方明文。
17. **逐 PR 级别的完整 API 差异清单**：本文按"官方 What's New + 5.1→7.x 差异文档 + 关键 cmdlet/API 页面"汇总，未穷举每个 PR。若需要逐条精度，建议比对 GitHub CHANGELOG 与 `System.Management.Automation` 的公开 API 差异报告（APIScan）。

---

*本文档位于 `src/host/lib/powershell.md`，供本仓库内部参考。所有版本归属以标注的官方来源为准；与官方文档冲突时，以官方文档与目标版本实测为准。*
