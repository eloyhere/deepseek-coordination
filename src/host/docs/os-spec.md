# dsh-os 原子操作层 · 落地规范

> 状态：**已确认规范，待批准实现**（本文件不含任何脚本代码）。
> 上游契约：`command.txt`（24 行，已按评审结论修订）＋ `notice.txt`（作业约定）。
> 设计依据：Playwright Mouse/Keyboard API、xdotool(1)、W3C WebDriver Actions、Windows `SendInput`/UIA、DSH 内部 seam 约定（`docs` 之外的事实来自对 `app.asar` 的只读勘察）。

---

## 0. 环境事实（本机实测，决定实现细节）

| 事实 | 值 | 影响 |
|---|---|---|
| PowerShell | **5.1.19041.3031**（.NET Framework） | 禁用 PS7 专有语法：`??`、`? :`、`-Encoding utf8NoBOM`、`Get-Encoding` |
| `System.Text.Encoding.CodePages` 程序集 | **不存在** | 不得使用 `CodePagesEncodingProvider`（那是 .NET Core API） |
| `GetEncoding()` 内建编码 | 65001 / 936 / **54936** / 950 / 932 / 1200 / 1201 / 28591 / 1252 全部可用 | charset 映射表可直接用 .NET；GB18030 有原生支持 |
| `UTF8Encoding($false).GetPreamble()` | 长度 0 | 写「无 BOM UTF-8」的唯一正确写法 |
| 系统工具 | `git` 不在 PATH | 验收不依赖 git；测试驱动只用 PowerShell + bash |

---

## 1. 目录布局（计划创建的文件）

```
deepseek-coordination/
├─ command.txt                       # 上游契约（人工维护，不改）
├─ docs/
│  └─ os-spec.md                     # 本文件
├─ spec/
│  ├─ verbs.tsv                      # 机器可读动词表：verb/arity/参数/权限/退出码（单一真源）
│  └─ charsets.tsv                   # IANA 名 → PS/.NET 编码名 → iconv 名 → 探测特征
├─ bin/
│  ├─ dsh-os.bat                     # Windows 入口：ASCII-only 薄壳，chcp 65001 → 转发 %* 到 .ps1
│  ├─ dsh-os.ps1                     # Windows 实现（UTF-8 **with BOM** 保存）
│  └─ dsh-os.sh                      # Linux/Unix/macOS 实现（LF，chmod +x）
└─ tests/
   ├─ golden.ps1                     # Windows 驱动的黄金用例（调 dsh-os.bat）
   ├─ golden.sh                      # Unix 驱动的同一批用例（调 dsh-os.sh）
   └─ conformance.ps1                # 校验 spec/verbs.tsv 与 command.txt 一致（防止规范漂移）
```

**为什么只有一个动词表文件**：`verbs.tsv` 是"参数签名 + 权限 + 退出码"的单一真源。`.ps1` 与 `.sh` 各自在启动时解析它做自查（`dsh-os selfcheck`），避免三套实现各自漂移——这正是本项目的立项动机。

---

## 2. 调用契约

### 2.1 调用面

```bat
dsh-os.bat <verb> [subverb] <positional...> [--flag [value]...]
```
```sh
./dsh-os.sh <verb> [subverb] <positional...> [--flag [value]...]
```

* 动词两段式：`file` / `mouse` / `keyboard` / `execute` / `window` / `wait` / `text` / `structure` / `clipboard` / `selfcheck`。
* **参数值永远作为独立 argv 元素传入，调用方不得做 shell 展开**。harness 侧必须用 argv 数组（`execFile` 语义 / DSH 的 `ctx.subprocess`），**绝不拼接命令字符串**——这是"Windows 空格问题"的根因所在。
* 值内含空格时：命令行用户用引号（`"C:\Program Files\x.txt"`）；`cmd.exe` 用户同样用引号，`.bat` 的 `%*` 会原样转发引号。

### 2.2 输出信封（stdout，UTF-8 无 BOM，默认单行 JSON）

```json
{ "ok": true,  "verb": "file.charset", "result": { }, "meta": { "durationMs": 3 } }
{ "ok": false, "verb": "file.charset", "error": { "code": "E_NOT_A_FILE", "message": "…", "hint": "…" },
  "meta": { "durationMs": 2 } }
```

* `--pretty` 输出缩进 JSON，供人类阅读。**stderr 只放人类可读的补充诊断，绝不参与解析。**
* `--quiet` 只输出 `result` 字段（便于 shell 管道）。
* 所有 JSON 由脚本显式生成**单行**（`ConvertTo-Json -Compress` / `jq -c` 或手工转义），不得依赖控制台默认换行。

### 2.3 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 用法错误（未知动词、缺参、参数互斥） |
| 2 | 类型/取值错误（偏移越界、非字符边界、坐标非法） |
| 3 | 权限未授予（需要 `--allow`，或系统权限不足） |
| 4 | 平台不支持（Wayland 无 XTest、缺 UIA、缺辅助功能授权） |
| 5 | 目标/编码/IO 错误（不存在、非文件、编码不符、写失败） |
| 6 | 超时（`wait` 系列） |
| 7 | 内部错误 |

**退出码是粗分类，`error.code` 才是权威**；调用方按 code 分支，**绝不解析 message 文本**（沿用 DSH `FsError` 的既有约定）。

---

## 3. 完整命令表

权限列：`R` = 只读/查询，不要对话框；`W` = 变更，需要用户已接受的授权。

### 3.1 file

| 命令 | 权限 | 参数与语义 |
|---|---|---|
| `file create path content charset` | W | 目标已存在则 `E_EXISTS`（不覆盖）。父目录自动创建。缺省 `charset=utf-8`（无 BOM） |
| `file charset path` | R | 返回 `{charset, bom, eol, confidence}`。非普通文件 → `E_NOT_A_FILE` |
| `file encode path charset [--backup] [--bom keep\|strip\|add]` | W | 原地换编码，内容语义不变，行尾不动；缺省保留原 BOM 状态；`--backup` 先写 `path.bak` |
| `file length path [--no-recursive]` | R | 文件→字节数；目录→递归总字节（`--no-recursive` 改为自身条目大小） |
| `file information path` | R | `{type,size,charset,bom,eol,lines,mode,atime,mtime,ctime,realpath}` |
| `file list path` | R | 列**一层**目录：`[{name,type,size,mtime}]`（不递归、不支持 glob） |
| `file delete path [--permanent]` | W | 缺省移入回收站；`--permanent` 才真删。**调用前必须核对解析后的绝对路径**（`notice.txt` 要求） |
| `file move source destination` | W | 同卷 rename；跨卷则复制+删除。目标已存在 → `E_EXISTS` |
| `file copy source destination` | W | 目标已存在 → `E_EXISTS` |
| `file mkdir path [--parents]` | W | `--parents` 等价 `mkdir -p`；缺省父目录不存在则 `E_NO_PARENT` |
| `file append path content charset` | W | 追加到文件尾（保留原 BOM 与行尾） |
| `file insert path content charset offset` | W | 在**字节偏移** `offset` 处插入；`offset` 必须落在**字符边界**，否则 `E_BOUNDARY`（多字节字符不可切碎） |
| `file view path [charset] [start] [end]` | R | `start`/`end` 为**字节偏移、半开区间 `[start,end)`**，缺省全文。`charset` 给出时是**断言**（不符即 `E_CHARSET_MISMATCH`），缺省自动探测。返回带行号文本 + `truncated` 标记 |

**编码铁律（治 BOM 问题的核心）**

1. `file charset` 必须把 `utf-8`（无 BOM）与 `utf-8-bom`（有 BOM）**区分报告**。
2. `file create` 若目标已存在则报错而非覆盖，因此不存在"覆盖时如何处理原 BOM"的歧义。
3. `file append` / `file insert` / `file encode` 必须**保留原文件的 BOM 与行尾状态**。
4. 读取时剥离 BOM、把 `\r\n` 归一为 `\n` 用于输出，但**任何写回操作都必须还原原文件的 BOM 与行尾**。
   > 这是对 DSH 现有不一致的修正：`dsh-fs-local` 的 `editText` 会复原 CRLF、`writeText` **不会**，且两者都不保留 BOM。

### 3.2 execute

| 命令 | 权限 | 参数与语义 |
|---|---|---|
| `execute command arguments` | W | `arguments` 为**数组**，逐元素作为独立 argv 直传，**不经 shell**。需要管道/重定向时显式 `--shell`，并在描述里警告调用方自行负责引用 |
| `execute query pid` | R | 进程是否存在、退出码、CPU/内存峰值（平台能力不足时字段为 `null`） |
| `execute kill pid [--force]` | W | 缺省温和终止（WM_CLOSE/SIGTERM），`--force` 强杀 |

通用标志：`--workdir d`、`--env K=V`（可重复）、`--stdin file`、`--timeout ms`、`--encoding c`、`--background`。

**编码**：子进程 stdout/stderr 以**字节**收集后按显式 `--encoding`（缺省 utf-8，含 BOM 时剥离）解码；Windows 侧先钉死 `[Console]::OutputEncoding`/`$OutputEncoding` 为无 BOM UTF-8 再 spawn。

### 3.3 mouse

坐标缺省为**虚拟桌面逻辑像素**（全部显示器并集的左上为原点）；`--space physical` 切换为物理像素。
Windows 上进程**必须先声明 DPI 感知**（`SetProcessDpiAwarenessContext` / 清单），否则 125%/150% 缩放下点击整体偏移。

| 命令 | 权限 | 参数与语义 |
|---|---|---|
| `mouse click x y [--button left\|right\|middle] [--count n] [--clearmodifiers]` | W | 等价 down+up 的原子语义；`--count 2` 为双击 |
| `mouse context x y [--clearmodifiers]` | W | 等价 `mouse click --button right`（保留独立动词以贴合 `command.txt`） |
| `mouse over x y [--hold]` | W | 移动光标；`--hold` 表示"按住左键移动"（拖动必需，避免 down/up 之间被中断） |
| `mouse wheel x y` | W | `x`/`y` 为**相对位移**（像素），模拟滚轮 |
| `mouse down x y [--button ...]` | W | 按下并保持 |
| `mouse up [--button ...]` | W | 释放 |
| `mouse cursor` | R | 读回 `{x,y,screen,space}`，用于点击后校验 |

`--clearmodifiers`：注入前查询并释放所有活动修饰键（含 CapsLock/鼠标键），注入后恢复。**这是防"按键卡住"和"Shift 污染"的必需项**（PowerToys 有专门修复此类故障的 PR；xdotool 亦提供同名标志）。

### 3.4 keyboard / clipboard

| 命令 | 权限 | 参数与语义 |
|---|---|---|
| `keyboard code action [--clearmodifiers]` | W | `action ∈ {down, up, press}`；`press` = 单次按下+释放的**原子**语义（缺它则"按一次键"要两条命令，中途中断会留下卡住的键） |
| `keyboard chord keys [--clearmodifiers]` | W | `keys` 为**数组**（`["alt","tab"]`），语义为**同时按下、逆序释放**。取代原 `combination` 的变长位置参数（DSH 的 schema DSL 中 `array` 只允许 `items`，变长位置参数无法表达） |
| `keyboard type text [--method auto\|keys\|paste]` | W | 任意文本输入。**非 ASCII 缺省走剪贴板粘贴**（`SendInput` 的 `KEYEVENTF_UNICODE` 在 IME/中文场景不可靠） |
| `clipboard read` | R | 读剪贴板文本 |
| `clipboard write text` | W | 写剪贴板文本 |
| `clipboard paste` | W | 写剪贴板后按 Ctrl+V（`keyboard type --method paste` 的显式形式） |

**键码方言**（`code` 参数，带前缀）：`dom:KeyA` / `vk:0x53`（Windows 虚拟键）/ `keycode:0`（macOS CGKeyCode）/ `keysym:a`（X11）。无前缀按平台默认；同时提供 `keyboard codes` 子命令列出可用键名，避免模型猜键名。

### 3.5 window

| 命令 | 权限 | 参数与语义 |
|---|---|---|
| `window find name [--regex] [--pid n] [--visible]` | R | 返回**全部**匹配窗口，含 `handle/title/class/pid/rect/z` |
| `window list [--z-order]` | R | 枚举顶层窗口 |
| `window active` | R | 当前前台窗口（避免必须按名字再找一次） |
| `window close name` | W | 请求关闭（非强杀） |
| `window top name` | W | 置前（改 **z-order**） |
| `window bottom name` | W | 置底（改 z-order） |
| `window move name x y` | W | 移动窗口 |
| `window resize name width height` | W | 改变窗口尺寸 |

**已删除 `window next` / `window previous`**：Alt+Tab 的"下一个窗口"由窗口管理器决定，脚本无法确定，只能**合成 `Alt+Tab` 按键**——即等价于 `keyboard chord ["alt","tab"]`，且原 `name` 参数在语义上无意义（无法"只在同名窗口间循环"）。按原子化原则删去，保留组合键原语。xdotool 亦警告窗口栈顺序"may not be consistent across invocations"。

### 3.6 wait（新增：UI 时序必需）

| 命令 | 权限 | 参数与语义 |
|---|---|---|
| `wait window name [--timeout ms] [--interval ms] [--absent]` | R | 等待窗口出现（`--absent` 等待消失）；超时退出码 6 |
| `wait ms` | R | 显式等待。**这是"未知时长"场景唯一的确定性手段**，模型不应靠反复轮询 `window find` 猜测 |

### 3.7 观察面

| 命令 | 权限 | 参数与语义 |
|---|---|---|
| `mouse screenshot [x y width height] [--screen n] [--out file]` | R | 缺省全屏（当前显示器）。**参数序采用 `x y width height`**，与 `BitBlt`/xdotool/`CGWindowListCreateImage` 取值习惯一致；原 `top right bottom left` 既缺 `left` 又与任何平台 API 顺序不符，已废止 |
| `structure x y` | R | 取该点**视图结构**：控件类型/名称/包围盒/父子链/是否可点击聚焦 |
| `text x y` | R | 取该点**完整文本** |

**`text` / `structure` 的实现层次（关键设计决定）**：这两者是本层**唯一不确定**的原语，必须"无障碍树优先、OCR 兜底"：

| | Windows | macOS | Linux |
|---|---|---|---|
| `structure` | UI Automation `ElementFromPoint` → `CurrentControlType`/`CurrentName`/`CurrentBoundingRectangle` + `TreeWalker` 父链 | AXAPI `AXUIElementCopyElementAtPosition` → `AXRole`/`AXTitle`/`AXPosition`/`AXSize` | AT-SPI2 `getAccessibleAtPoint` → `getRoleName`/`getName`/`getExtents` |
| `text` | UIA `TextPattern`/`ValuePattern` 优先；OCR 用 `Windows.Media.Ocr` 或捆绑 Tesseract | AXAPI `AXValue`/`AXSelectedText`；OCR 用 Vision `VNRecognizeTextRequest` | AT-SPI `Text` 接口；OCR 用 Tesseract |

返回**必须**包含 `source: "uia" | "ax" | "atspi" | "ocr"` 与 `confidence`。失败必须区分报错，**不得以空文本表示"无文本"**：

* `E_ACCESSIBILITY_DENIED`（macOS 未授予辅助功能权限）
* `E_ELEVATION_REQUIRED`（Windows 提权窗口不可读/不可注入）
* `E_ACCESSIBILITY_UNAVAILABLE`（Wayland 下 AT-SPI 不可用）

### 3.8 自检

| 命令 | 权限 | 参数与语义 |
|---|---|---|
| `selfcheck [--json]` | R | 校验 `spec/verbs.tsv` 与实现一致、报告平台能力矩阵（DPI 感知可用性、UIA/AT-SPI 可用性、会话类型、可用键码方言），并逐项列出**不支持**的原语及原因 |

---

## 4. 错误码表（权威，调用方按此分支）

| code | 退出码 | 触发条件 |
|---|---|---|
| `E_USAGE` | 1 | 未知动词、缺参、参数互斥 |
| `E_TYPE` | 2 | 参数类型/取值非法 |
| `E_NOT_SUPPORTED` | 4 | 本平台无此能力（含 Wayland 无 XTest） |
| `E_PERMISSION` | 3 | 需要 `--allow` 而用户未授权 |
| `E_ACCESSIBILITY_DENIED` | 4 | 系统级辅助功能权限未授予（macOS） |
| `E_ACCESSIBILITY_UNAVAILABLE` | 4 | 无障碍树不可用（Wayland / 服务未运行 / 提权窗口） |
| `E_ELEVATION_REQUIRED` | 3 | UIPI 阻止向高完整性窗口注入或读取 |
| `E_NOT_FOUND` | 5 | 路径不存在 |
| `E_NOT_A_FILE` | 5 | 路径存在但不是普通文件（`file charset`/`encode` 的主要失败） |
| `E_NOT_A_DIR` | 5 | 期望目录 |
| `E_IS_A_DIR` | 5 | 期望文件 |
| `E_EXISTS` | 5 | 目标已存在（create/move/copy） |
| `E_NO_PARENT` | 5 | 父目录不存在且未给 `--parents` |
| `E_CHARSET_UNKNOWN` | 2 | charset 不在支持表内 |
| `E_CHARSET_MISMATCH` | 5 | `file view` 的 charset 断言不符 |
| `E_ENCODING_INVALID` | 5 | 字节序列在指定编码下非法 |
| `E_BOM_INVALID` | 5 | BOM 与声明编码矛盾 |
| `E_BINARY_CONTENT` | 5 | 内容判定为二进制 |
| `E_BOUNDARY` | 2 | 字节偏移落在多字节字符中间 |
| `E_RANGE` | 2 | 偏移/区间越界 |
| `E_TRUNCATED` | 5 | 内容超过上限被截断（结果内含 `truncated:true`） |
| `E_PARTIAL_WRITE` | 5 | 写入未完成（原子写失败后的状态） |
| `E_NO_DISPLAY` | 4 | 无图形会话（纯终端/无头环境） |
| `E_WINDOW_NOT_FOUND` | 5 | 未匹配到窗口 |
| `E_WINDOW_AMBIGUOUS` | 2 | 匹配到多个窗口而需要唯一目标 |
| `E_WINDOW_CLOSED` | 5 | 操作过程中窗口已消失 |
| `E_TIMEOUT` | 6 | `wait` 超时 |
| `E_ABORTED` | 7 | 调用方中止（`AbortSignal`） |
| `E_IO` | 5 | 其他 IO 失败 |
| `E_INTERNAL` | 7 | 内部错误 |

---

## 5. 各脚本的实现约束（写代码时的硬要求）

### 5.1 `bin/dsh-os.bat`（薄壳）
* **只允许 ASCII 字节**（否则 `cmd.exe` 的 OEM 代码页会破坏 `%*`）。
* CRLF 行尾；首行 `@echo off`；随后 `chcp 65001 >nul`。
* **只做一件事**：把 `%*` 原样转发给 `dsh-os.ps1`，并透传退出码（`exit /b %ERRORLEVEL%`）。
* 用 `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File`；**不加 `-NoLogo` 之外的多余开关**。
* 逻辑一律不在 `.bat` 里实现（`.bat` 的引号处理不可靠，是故障源）。

### 5.2 `bin/dsh-os.ps1`（Windows 实现）
* 文件自身保存为 **UTF-8 with BOM**；若保存为无 BOM，PowerShell 5.1 会按 ANSI 解析脚本内的非 ASCII 字面量——这正是 BOM 问题的反噬。
* 顶部固定：
  * `$ErrorActionPreference = 'Stop'`；`Set-StrictMode -Version Latest`
  * `[Console]::InputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)`
  * `$OutputEncoding = New-Object System.Text.UTF8Encoding($false)`
* **禁止**用 `Get-Content`/`Set-Content` 处理文件内容——它们在 5.1 下编码行为不一致；一律走 `[System.IO.File]::ReadAllBytes` / `WriteAllBytes` + 显式 `Encoding` 对象，以便精确控制 BOM 与行尾。
* **原子写**：同目录临时文件 → `[System.IO.File]::Replace`（同卷）或 `MoveFileEx`；保证 `file create/append/insert/encode` 不产生半写状态。
* 原生调用用 `koffi`（本机安装体已带 `@koromix/koffi-win32-x64`；`user32.dll` 已被 DSH 内 3 处加载，写法可参照 `dsh-host-directory-picker-native/lib/worker.cjs:93` 的 `keybd_event`）。
* **惰性 `await import('koffi')`**：只在真正需要注入时加载，且仅在 Windows 分支触达（DSH 内既有同模式）。
* 中文路径：调用方除非显式要求，一律走 `\\?\` 长路径前缀内部规范化，**不得把前缀回显给模型**。

### 5.3 `bin/dsh-os.sh`（Linux/Unix/macOS 实现）
* LF 行尾；`#!/usr/bin/env bash`；`set -euo pipefail`；`chmod +x`。
* 首部 `export LC_ALL=C.UTF-8`（回退 `en_US.UTF-8`），并校验当前 locale 确实是 UTF-8——**这是 Unix 侧空格/中文路径问题的根因所在**。若 locale 非 UTF-8，必须报 `E_NOT_SUPPORTED` 而不是静默乱码。
* `IFS=$'\n'` 级别的谨慎处理：所有参数用数组 `"$@"` 传递，**禁止 `eval`、禁止未加引号的变量展开**。
* 编码探测/转换用 `iconv`（映射表见 `spec/charsets.tsv`）；`iconv` 缺失时报 `E_NOT_SUPPORTED`。
* Linux 输入注入：X11 用 XTest（`xdotool` 存在则优先复用）；**Wayland 检测到即 `E_NOT_SUPPORTED`**（`XTest` 在 Wayland 无效，uinput 需 root）。macOS 用 `CGEvent`（`osascript`/`cliclick` 兜底），缺辅助功能权限报 `E_ACCESSIBILITY_DENIED`。

### 5.4 授权模型（`--allow`）
* 首行权限组：`execute / delete / create / edit / window / keyboard / clipboard / text / structure`。
* **判定在 harness 侧**（DSH 已有 `ctx.tools.guard()` 与 `tools/pre-execute` 的 allow/deny/ask 门禁）；脚本侧只检查 `--allow` 是否存在，缺失即以 `E_PERMISSION`（退出码 3）拒绝。**避免两套互不知情的权限系统。**
* `R` 类命令（charset/length/information/list/view/find/list-active/wait/cursor/clipboard read/selfcheck）永不要求 `--allow`。

---

## 6. 黄金测试矩阵（三平台同一批用例，逐字比对）

| # | 用例 | 断言要点 |
|---|---|---|
| 1 | 路径含空格：`...\a b\c.txt` | create→charset→view→delete 全链路成功；**空格不被拆分** |
| 2 | 路径含全角字符：`...\中文 目录\文件.txt` | 同上；输出 JSON 为合法 UTF-8 |
| 3 | UTF-8 **带 BOM** 文件 | `charset` 报 `utf-8-bom`；`append`/`insert` 后 **BOM 仍在**；`view` 首行**不含** `\uFEFF` |
| 4 | UTF-8 无 BOM 文件 | `charset` 报 `utf-8`；**不得**擅自加 BOM |
| 5 | CRLF 文件 | `information.eol == "crlf"`；`append` 后仍 CRLF；`view` 输出行尾归一为 `\n` |
| 6 | GBK 文件 | `charset` 报 `gbk`；`encode` 转 `utf-8` 后内容语义不变；转回再比对字节级一致 |
| 7 | UTF-16LE/带 BOM | `charset` 报 `utf-16le`；`view` 正确解码 |
| 8 | 偏移落在多字节字符中间 | `file view` 多字节文件时给中间偏移 → `E_BOUNDARY`（退出码 2） |
| 9 | 二进制文件 | `file charset` → `E_BINARY_CONTENT`；`file view` 同 |
| 10 | 目录当文件用 | `file charset <dir>` → `E_NOT_A_FILE` |
| 11 | `file create` 目标已存在 | `E_EXISTS`，且**文件内容未被改动** |
| 12 | `file delete` 缺省 | 进入回收站/垃圾桶而非真删；`--permanent` 才消失 |
| 13 | 非 ASCII 参数：`execute printf` 传中文参数 | argv 直传，**不经 shell**，参数边界与内容完全一致 |
| 14 | 非 ASCII 输出：子进程打印中文 | 正确解码，无乱码、无 BOM 泄漏到结果 |
| 15 | 输出 JSON 合法性 | 每个成功/失败结果都能被解析器解析（含路径带引号、换行、制表符的转义） |
| 16 | 缺少 `--allow` 的 W 类命令 | `E_PERMISSION`（退出码 3），且**未产生任何副作用** |
| 17 | 未知动词/缺参 | `E_USAGE`（退出码 1），stdout 仍是合法 JSON |
| 18 | `selfcheck` | 三平台都能输出能力矩阵；不支持项以 code 列出而非静默省略 |
| 19 | 规范一致性 | `tests/conformance.ps1` 校验 `spec/verbs.tsv` 与 `command.txt` 动词集完全一致（防止规范漂移） |
| 20 | 幂等/可重复 | 连续两次 `file charset`、`file information` 结果一致（无隐藏状态污染） |

**平台专属（各自跑，标记为 `platform-only`）**：`click`/`keyboard` 的注入效果（需真实图形会话）、`window` 五连、`wait window`、`screenshot`、`text`/`structure`（需 UIA/AT-SPI 可用）。这些**不进 CI 的强制门槛**，但必须提供"能力不可用时返回正确错误码"的断言——CI 里可强制验证的就是这一条。

---

## 7. 验收标准

1. `tests/conformance.ps1` 通过：脚本动词集 == `command.txt` 动词集，无多、无缺。
2. 用例 1–20 在 Windows 全绿；用例 1–10、13–20 在任何 POSIX（含非 UTF-8 locale 的降级行为）上全绿。
3. 用户环境相关用例（11–17 类）在**变更失败时不留下半写文件**（原子写验证）。
4. 三平台 `selfcheck` 输出的能力矩阵互相可比对（同名字段、同语义），差异只体现在受支持项上。
5. 不引入除 `koffi`（Windows 注入）与系统工具（`iconv`、`xdotool`、`osascript`）之外的任何依赖。

---

## 8. 尚未闭合的技术风险（实现时需先行验证）

| 风险 | 说明 | 处置 |
|---|---|---|
| koffi 版本与 Electron ABI | 安装体内 koffi 服务于 Electron 主进程；脚本由 `pwsh` 加载的是 Node 侧 koffi，版本可能不同 | 首步先跑一个最小 `SendInput` 冒烟测试，确认加载与注入均可用；不可用则降级为 `keybd_event`/`mouse_event`（同样经 koffi），或 `WScript.Shell.SendKeys`（仅 ASCII） |
| DPI 感知 | 未声明 DPI 感知时坐标整体偏移 | 在 `.ps1` 启动即声明；`selfcheck` 报告当前 DPI 与缩放因子 |
| UIPI | 提权窗口既不可注入也不可读 | 明确 `E_ELEVATION_REQUIRED`；不静默失败 |
| UIA 在部分应用不可用 | 空格/自绘控件无 UIA 树 | `text`/`structure` 必须能回退 OCR，并在返回中标注 `source` |
| Wayland | XTest 无效 | 检测会话类型，明确 `E_NOT_SUPPORTED`；不尝试 uinput（需 root） |
| 回收站 API | Windows 侧 `SHFileOperation` 需经 shell；Unix 侧无标准回收站 | Windows 走 `SHFileOperation`/`IFileOperation`；Unix 缺 `trash-cli` 时**降级为报错**而非静默真删，或经 `--permanent` 显式确认 |
| `.bat` 的 `%*` 边界 | 极端引号组合可能被 `cmd.exe` 改写 | 文档明确"harness 必须用 argv 数组直调 `.ps1`/`.sh`"；`.bat` 仅服务人类手敲 |

---

## 9. 落地进度与实现偏差

### 9.1 已完成（第 1 轮，Windows `file` 族 + 公共设施）

| 文件 | 状态 | 说明 |
|---|---|---|
| `command.txt` | 已按批准结论修订 | 保留用户全部命名；仅做加法修正（见 9.2） |
| `docs/command-original.txt` | 原始草稿备份 | 修订前的 26 行版本 |
| `spec/verbs.tsv` | 完成 | 46 条动词的参数/标志/权限/错误码单一真源 |
| `spec/charsets.tsv` | 完成 | 15 种编码的 IANA 名 → .NET 码页 → iconv 名 → BOM 字节 |
| `bin/dsh-os.ps1` | 完成 `file.*` + `selfcheck` | 1450 行；其余动词以 `E_NOT_SUPPORTED` 明确拒绝，绝不静默 |
| `bin/dsh-os.bat` | 完成 | ASCII-only、CRLF、`chcp 65001`、`%*` 原样转发、透传退出码 |
| `tests/golden.ps1` | 完成 | 23 条黄金用例，全部通过 |
| `tests/encoding.ps1` | 完成 | 编码契约守卫（BOM/ASCII/行尾/stdout 无 BOM） |

**验证证据**：`tests/golden.ps1` → `passed: 23 failed: 0`；`tests/encoding.ps1` → `all encoding contracts hold`。

### 9.2 对 `command.txt` 的加法修正（用户命名全部保留）

| 项 | 处理 | 理由 |
|---|---|---|
| `keyboard press code` | **新增** | 原设计只有 `down`/`up` 两半，"按一次键"必须两条命令，中途中断会留下卡住的按键 |
| `keyboard type text` | **新增** | 只有键码无法输入中文等任意文本；非 ASCII 走剪贴板粘贴 |
| `mouse down/up/cursor`、`clipboard` 三条、`wait` 两条、`window list/active/move/resize`、`execute query/kill`、`file list/move/copy/mkdir`、`selfcheck` | **新增** | 见评审结论；均为填补缺口而非扩张范围 |
| `screenshot` 注释拼写 | **修正** | 原文 `rectange` → `rectangle`；参数序确定为 `x y width height`（原文 `top right bottom left` 缺 `left` 且与任何平台 API 顺序不符） |
| `mose over` / `mose wheel` | **修正** | 拼写 → `mouse over` / `mouse wheel` |
| `keyboard` / `clipboard` 加入权限组 | **修正** | 原首行权限组遗漏这两族；键鼠注入的风险不低于改文件 |
| `window next/previous` | **删除** | Alt+Tab 的"下一个"由窗口管理器决定，脚本只能合成 `Alt+Tab` = `keyboard combination alt tab press`，原 `name` 参数无法实现 |

### 9.3 实现细节与规范的偏差（已在实现中落地，需回写规范）

| 项 | 规范原写法 | 实现采用 | 理由 |
|---|---|---|---|
| `file append` 的 `charset` | 位置参数（必需） | **可选**（省略即用文件自身编码） | 追加时断言编码几无意义，且实测必需会让 `file append p content` 失败 |
| `file insert` 的 `charset` | 第三个位置参数 | **`--charset` 标志** | 它夹在 `content` 与 `offset` 之间，作为可选位置参数会**静默移位 offset**，属危险设计 |
| `file create` 的 `--encoding` | 标志 | 未实现（重复了 `charset` 位置参数） | 保留为后续清理项 |
| `file.delete` 回收站 | 规范要求"Unix 缺 `trash-cli` 时降级为报错" | Windows 用 `Microsoft.VisualBasic.FileIO.FileSystem` + `SendToRecycleBin`（实测可用） | Unix 侧待实现时按规范处理 |
| 原子替换 | 规范写 `File.Replace` | **`MoveFileExW(REPLACE_EXISTING\|WRITE_THROUGH)`** | .NET Framework 上 `File.Replace(tmp, dst, $null)` 抛"路径格式非法"，且 `File.Move` 无覆盖重载 |
| 原生调用 | 规范建议 koffi | **`Add-Type` P/Invoke，零外部依赖** | `koffi` 是 Node 侧模块，`pwsh` 脚本内不可用；P/Invoke 由 .NET Framework 内建，反而更稳 |

### 9.4 本轮踩到并修掉的 PowerShell 5.1 陷阱（教训，务必遵守）

1. **脚本文件自身必须 UTF-8 with BOM。** 本轮 `tests/golden.ps1` 含中文面量却无 BOM，被 PS 5.1 按 ANSI(936) 解码 ⇒ 测试数据在运行前就已损坏，表现为"脚本明明对、断言却离奇失败"。这正是本项目要消灭的那类 bug，反过来咬了自己一口。**结论：`.ps1` 含非 ASCII 保存为 UTF-8 with BOM；纯 ASCII 文件（`golden.ps1`）用码点构造非 ASCII 数据。**
2. **`New-Object byte[] $a + $b` 是 `$a + ($b * 4)`。** 运算符优先级导致 `byte[]` 尺寸错误。全部改为 `New-Object byte[] ($a + $b)`。
3. **函数返回空数组会被 PowerShell 展开成 `$null`。** `return @()` ⇒ 调用方 `$bom.Length` 抛"找不到 Length 属性"（GBK 等无 BOM 编码全中）。用 `return , $array` 或 `Write-Output -NoEnumerate`。
4. **PS 5.1 无法绑定 `Decoder.GetChars(bytes, 0, n)` 三参重载。** 用它做编码校验 ⇒ 每个候选编码都抛异常 ⇒ 检测静默退化到 `latin1`（GBK 文件被静默损坏）。改用 `Encoding.GetString`。
5. **`System.Text.Encoding.CodePages` 在 .NET Framework 上不存在**（那是 .NET Core API），但 936/54936/950/932/1200/1201/28591/1252/65001 都已内建。
6. **`File.Move` 在 .NET Framework 只有 2 参重载**，没有覆盖版本。
7. **PowerShell 的 `>` 重定向会解码再编码子进程输出**，用它采样 stdout 字节会**制造** U+FFFD。测字节必须用 `ProcessStartInfo` + `RedirectStandardOutput.BaseStream`。
8. **行为契约：先做参数校验，再检查权限。** 否则畸形调用返回 `E_PERMISSION`，既掩盖真实问题、又像是在为一次根本无法执行的调用索要授权。

### 9.5 第 2 轮完成（授权层 + 新增动词族）

新增 `docs/permission-model.md`：四种决定语义、`permission.json` 模式、A+B 强制模型、写入委托、残余风险。

**已实现（全部实测通过）**

| 组 | 动词 | 状态 |
|---|---|---|
| `file.verify.*` | charset / encoding / completion | 完成。`encoding` 用"解码再编码后逐字节比对"判定合法性，能区分"文件不合法"与"我要求错了" |
| `system.*` | brand / cpu / gpu / version / info | 完成。逐字段降级（无 GPU 驱动返回空列表而非整体失败） |
| `task.*` | list / query | 完成。`show` / `kill` / `launch` 待下一轮 |
| `service.*` | list / query | 完成。`start/stop/restart` 待下一轮（需提权路径） |
| `environment.*` | list / get / add / set / delete + `attr` 同名五操作 | 完成。见 §9.6 |
| `permission.*` | query / list / audit | 完成（只读） |
| **保护路径（B 层）** | — | 完成。8 个变更类动词全部接入；`permission.json`、脚本自身、`spec/*.tsv`、`command.txt` 不可被任何动词修改 |

**验证证据**：`tests/golden.ps1` → **passed: 30 failed: 0**（新增 7 条用例）；`tests/encoding.ps1` → **all encoding contracts hold**；动词表 82 条。

**本轮修掉的两个真实缺陷（均由测试暴露）**

1. **`file.move` / `file.copy` 只保护了目标端**，于是 `file move permission.json <外部路径>` 把授权文件搬走了 —— 移动同样会删除源文件。测试因此发现 `permission.json` 真的被移走（已从副本恢复，最终确认 0 字节、哈希 `E3B0C442…`）。现已改为**两端都检查**：移动/复制受保护文件属泄露与破坏，源与目标同等对待。
2. **`E_PERMISSION_PROTECTED_PATH` 未登记退出码**，被兜底成 7（E_INTERNAL）而非 3（授权类）。现已把 5 个授权类错误码统一登记为退出码 3。

**另修**：三级动词解析（`file verify charset`、`environment path add`）—— 原解析器只支持两级；`Get-CimSafe` 单行结果被 PowerShell 展开导致 `.Count` 抛异常；`--filter` 缺省被强转为 `''` 导致过滤掉全部结果。

### 9.6 第 3 轮：environment 重构为「变量 + 属性」两层

`path` 不再是独立命令，而是 environment 的**属性**；变量与属性各自暴露同一组五个操作。

| 层 | 动词 | 语义 |
|---|---|---|
| 变量 | `environment list` | 列出变量的名字与原始值 |
| | `environment get name` | 取变量的原始字符串 |
| | `environment add name value` | 仅创建；已存在报 `E_EXISTS` |
| | `environment set name value` | 仅覆盖；不存在报 `E_NOT_FOUND` |
| | `environment delete name` | 删除；返回被删掉的值 |
| 属性 | `environment attr list` | 发现哪些变量是列表型属性（PATH / PATHEXT / LIB / …），含分隔符与条目数 |
| | `environment attr get name [--attr A]` | 属性的**有序条目列表** |
| | `environment attr add name value` | 追加一条；重复条目报 `E_EXISTS` |
| | `environment attr set name index value` | 按索引替换；越界报 `E_RANGE` |
| | `environment attr delete name [--index n \| --value v]` | 按索引或按值删除；两者都不给报 `E_USAGE` |

**关键语义（已实测并写入测试）**

1. **`--scope process` 的改动不跨调用存活**：每次调用都是新进程，因此该作用域只能验证单次调用内的行为。**只有 `user` / `machine` 作用域能证明持久化**，黄金用例据此分工。
2. **每个写入动词都回报 `visibleToRunningProcesses`**：`user`/`machine` 写入对已运行进程不可见，这个字段让调用方不必靠猜——正是这类"set 了却没生效"的困惑要在接口层消灭。
3. **`machine` 作用域在未提权时报 `E_ELEVATION_REQUIRED`**，绝不静默失败（本机会话恰好是提权的，所以该分支由代码审查而非运行验证）。
4. **属性是通用列表，不是 PATH 特例**：分隔符按平台取（Windows `;`、POSIX `:`），`--attr` 默认 `PATH`。

**本轮修掉的三个真实缺陷**

1. **`Get-AttributeEntries` 的数组包装被调用方二次 `@()`**：函数用一元逗号返回（保证空结果仍是数组），而两处调用又套了 `@(...)`，于是数组被**嵌套成单元素数组**，`.Count` 恒为 1、范围检查误判——表现为"文件里明明是 `a;b;c`，却报 index 1 越界 (0..0)"。已统一所有调用点并写明契约。
2. **黄金用例的夹具不生效**：`$env:NAME=` 只改提供程序视图，子进程继承的是进程环境块，必须用 `[System.Environment]::SetEnvironmentVariable(..., 'Process')`。夹具失效会让所有计数断言变得**看似通过实则无意义**。
3. **`--attr` 未登记为取值标志**，会被当成布尔标志从而吞掉属性名。

**验证证据**：`tests/golden.ps1` → **passed: 32 failed: 0**；`tests/encoding.ps1` → **all encoding contracts hold**；动词表 **82 条**。

### 9.7 下一步（第 4 轮起）

1. `execute` 族（argv 直传、非 ASCII 输出解码、超时、`--background`）
2. `bin/dsh-os.sh` 对齐 `file` 族 + `tests/golden.sh`；locale 非 UTF-8 时必须 `E_NOT_SUPPORTED` 而非乱码
3. `permission-consent` 插件（Service Definition + Consumer + `approval/request` answerer）与 A 层 ACL 初始化
4. 剩余动词：`task.show/kill/launch`、`window.minimize/maximize/restore`、`service.start/stop/restart`、`environment.*` 写入侧、`mouse`/`keyboard`/`clipboard`/`wait`/`screenshot`/`text`/`structure`
5. `tests/conformance.ps1`（动词集与 `command.txt` 一致性）


