# dsh-os 授权模型（permission model）

> 状态：**B 层与写入委托已落地**；A 层（ACL）待落地。上游决策见本文件 §7。
> 关联：`command.txt`（权威动词契约）、`spec/verbs.tsv`（动词表）、`docs/os-spec.md`（总规范）、根目录 `permission.json`（授权数据，当前 0 字节）。
>
> **已落地**：读侧规则匹配（`permission query/list/audit`，动词层只读）、写入委托插件
> `src/permission/index.js`（`dsh-os-permission`），以及 §6 中除 ACL 强度上报外的全部用例，
> 见 `tests/permission.test.mjs`（18 条）。

---

## 1. 四种决定的语义

用户明确要求的四种弹窗决定，映射为 `permission.json` 中的记录：

| 用户选择 | `decision` 值 | 生效范围 | 写入 `permission.json` |
|---|---|---|---|
| 同意 | `allow-once` | 仅本次调用 | **否**（一次性，不落盘） |
| 拒绝 | `deny-once` | 仅本次调用 | **否** |
| 永久同意 | `allow-always` | 该 `(verb, target-scope)` 组合，直到撤销 | 是 |
| 永久拒绝 | `deny-always` | 同上 | 是 |

**映射到 DSH 审批 seam 的硬约束**（已实测）：`ApprovalService.request()` 的四种结局是 `allowed-once | rejected | cancelled | unavailable`，且源码注释写明 *`'allowed-once'` is the only grant*。因此：

* `allow-once` / `deny-once` **可以**走 DSH 审批通道（用户在自己的 GUI 里点一次）。
* `allow-always` / `deny-always` **不能**由审批通道表达——该 seam 刻意不提供持久授权。持久决定必须由**同意写入委托（consent delegate）**写入 `permission.json`。
* 当 session 策略为 `never` 时（本会话即如此），`request()` 直接返回 `rejected`，**不会向用户询问**。此时任何需要授权的操作都以 `E_PERMISSION` 失败，且提示用户切换审批策略——**绝不静默降级为允许**。

---

## 2. `permission.json` 模式

```jsonc
{
  "version": 1,
  "updatedAt": "2026-10-12T17:10:10.000Z",
  "updatedBy": "consent-delegate",          // 只有委托进程可以写这个值
  "defaults": {
    "readOnly": "allow",                    // R 类动词永不询问，也不落盘
    "mutating": "ask"                       // W 类的默认动作
  },
  "rules": [
    {
      "id": "r-0001",
      "verb": "file.delete",                // 支持末尾通配：file.* / window.*
      "target": { "kind": "path", "value": "R:\\project\\**" },
      "scope": { "kind": "user" },          // user | machine | process | session | any
      "decision": "allow-always",           // allow-always | deny-always
      "grantedBy": "consent-delegate",
      "grantedAt": "2026-10-12T17:10:10.000Z",
      "expiresAt": null,
      "note": "optional human note"
    }
  ],
  "audit": [
    {
      "at": "2026-10-12T17:10:10.000Z",
      "verb": "file.delete",
      "target": { "kind": "path", "value": "R:\\project\\x.txt" },
      "decision": "allow-once",
      "decidedBy": "dsh-approval",          // dsh-approval | consent-delegate
      "actor": { "sessionId": "...", "agentId": "..." }
    }
  ]
}
```

**规则设计的三个要点**

1. **先匹配先赢，无规则即 `defaults`。** 规则按数组顺序求值，第一条命中即生效——不引入优先级字段，避免"为什么这条没生效"的隐式排序问题。
2. **`deny-*` 优先于 `allow-*` 在语义上不可跨越**：若同一 `(verb, target)` 同时存在 allow 与 deny 规则，`deny` 命中即拒绝（安全默认），并在返回中说明命中了哪条规则（`ruleId`）。
3. **审计是追加式、有界**：`audit` 只保留最近 N 条（默认 200），超出时由委托进程裁剪；**审计条目不可由动词修改**。
4. **`target-scope` 必须显式**：路径类目标用绝对路径前缀或通配；进程类用 pid 或可执行名；环境变量用变量名。**不允许"所有目标"的永久同意**——`target.value` 为 `"*"` 时，委托必须要求用户二次确认，并在返回里标注 `broad: true`。

---

## 3. 强制模型（已确认：A + B 组合）

### 3.1 B —— 结构强制（跨平台，始终生效）

* **`permission.json` 的写入不是任何 dsh-os 动词。** `spec/verbs.tsv` 里不存在 `permission write/set/delete` 这类动词；动词层只能 `permission query`（R 类，只读）。
* **保护路径硬拒绝。** 所有 `file.*` / `execute.*` / `environment.*` 命令在路径解析后检查保护清单，命中即以 **`E_PERMISSION_PROTECTED_PATH`（退出码 3）** 拒绝，且**不产生任何副作用**。保护清单至少包含：
  * `permission.json` 本身及其 `.bak` / 临时文件
  * `bin/dsh-os.ps1`、`bin/dsh-os.sh`、`bin/dsh-os.bat`（防止脚本自我改写绕过检查）
  * `spec/*.tsv`、`command.txt`（防止篡改动词表）
* 该检查是**路径规范化之后**的字符串比较（大小写按平台折叠、解析 `..` 与符号链接），不是正则匹配——正则会被 `..\` 或短路径 8.3 形式绕过。
* **`execute` 的例外必须显式**：`execute` 能启动任意程序，因此 `execute` 本身**不是**绕过路径检查的通道；动词层无法静态判定子进程会写什么，所以这属于**已知残余风险**（见 §5），只能靠 ACL（A 层）兜底。

### 3.2 A —— ACL 内核强制（可行平台上，推荐开启）

| 平台 | 做法 | 说明 |
|---|---|---|
| Windows | 用 `SetNamedSecurityInfoW` 在 `permission.json` 上**显式拒绝**自动化上下文的 WRITE（含 `DELETE` / `WRITE_DAC`），只授予交互用户与委托进程 | 由内核强制，无法由用户态绕开。**前提：两侧身份必须不同**（例如 harness 以受限账户/低完整性运行，委托以交互用户运行），否则 A 退化为 B |
| Linux | 文件属主为交互用户，目录对自动化上下文不可写；或 `chattr +a`（只可追加） | 等价物较弱；容器内可能不可用 |
| macOS | ACL + `chflags uchg` | 同上 |

**初始化**：`permission acl init` 是**幂等的显式动作**（在动词层属于 W 类），它只设置保护属性、不写授权内容；失败不阻断 B 层。`selfcheck` 必须报告 A 层是否生效（`aclEnforced: true|false`），让调用方知道当前处于哪一档强度。

### 3.3 写入委托：`permission-consent`（唯一写入方）

```
用户选择  ──►  dsh-os 动词 (R/W)
                    │  需要授权？
                    ▼
            ┌───────────────────────┐
            │ 1. 查 permission.json  │  命中 allow-always → 放行
            │                       │  命中 deny-always  → 拒绝（E_PERMISSION_DENIED_BY_RULE）
            └──────────┬────────────┘
                       │ 无规则 → defaults
                       ▼
            ┌───────────────────────┐
            │ 2. 走 DSH 审批通道      │  approval/request waterfall
            │    allow-once/deny-once│  → 不落盘
            └──────────┬────────────┘
                       │ 用户选择"永久"
                       ▼
            ┌───────────────────────┐
            │ 3. permission-consent  │  唯一持有 permission.json 写权的进程/插件
            │    追加规则 + 审计      │  以交互用户身份运行（配合 A 层 ACL）
            └───────────────────────┘
```

* **委托是插件，不是脚本子命令。** 理由：DSH 的审批 UI 在客户端（`dsh-client-ui-approval`），只有插件能注册 `approval/request` answerer 并触达用户 GUI。脚本侧（`.ps1`/`.sh`）**只读取** `permission.json`，永不写入。
* **插件形态**（照 DSH 惯例）：Service Definition `dsh-os-permission`（只读契约 + 查询/匹配逻辑）+ Consumer `dsh-tool-os-permission`（暴露 `permission query` / `permission grant` / `permission revoke` 工具）+ answerer 注册在 `approval/request`。
* **写入必须原子**：同目录临时文件 → `MoveFileExW(REPLACE_EXISTING)`（与 `file.*` 同机制），确保崩溃不留半写。
* **每次写入都追加审计条目**，`updatedBy` 固定为 `consent-delegate`；读侧若发现 `updatedBy` 不是该值，视为**被篡改**，按 fail-closed 处理（全部按 `defaults` 求值，并报告 `E_PERMISSION_FILE_UNTRUSTED`）。

---

## 4. 新增动词（本文件覆盖的授权相关部分）

| 动词 | 权限 | 说明 |
|---|---|---|
| `permission query [verb] [target]` | R | 返回某动作的当前判定、命中规则、生效强度（`aclEnforced`） |
| `permission list` | R | 列出全部规则 |
| `permission audit [--limit n]` | R | 读取审计尾部 |
| `permission grant verb target --decision allow-always\|deny-always` | W | **必须**经委托 + 用户弹窗；脚本直接调用返回 `E_PERMISSION_DELEGATE_ONLY` |
| `permission revoke rule-id` | W | 同上，撤销也必须经用户确认 |
| `permission acl init` | W | 幂等设置 A 层保护；不涉及授权内容 |

**新增错误码**

| code | 退出码 | 触发条件 |
|---|---|---|
| `E_PERMISSION_DENIED_BY_RULE` | 3 | 命中 `deny-always` 规则 |
| `E_PERMISSION_PROTECTED_PATH` | 3 | 试图经 `file.*`/`environment.*` 改动受保护路径 |
| `E_PERMISSION_DELEGATE_ONLY` | 3 | 非委托方试图写入/撤销授权 |
| `E_PERMISSION_FILE_UNTRUSTED` | 3 | `permission.json` 的 `updatedBy` 或完整性戳校验失败 |
| `E_PERMISSION_NO_ANSWERER` | 3 | 需要用户交互但无可用 answerer（或 session 策略为 `never`） |

---

## 5. 已知残余风险（必须记录，不可声称已解决）

1. **`execute` 是路径保护之外的通道。** 动词层无法静态判定子进程行为，因此"经 `execute` 启动的程序去改 `permission.json`"只能靠 A 层 ACL 阻止。若 A 层未启用（`aclEnforced: false`），**B 层无法阻止这种改写**——这是组合方案的真实边界。
2. **A 层要求两侧身份不同。** 若 harness 与委托以同一用户身份运行且都未被 ACL 拒绝，A 层退化，整体强度等于 B。`selfcheck` 必须如实报告，不能假称已强制。
3. **DSH 审批通道不提供持久授权。** 因此"永久同意"的可信度取决于委托进程的完整性，而非审批服务本身。
4. **`--allow` 是调用方的自我声明**，与 `permission.json` 是两套东西：`--allow` 表示"harness 已从用户处取得本次授权"，`permission.json` 表示"用户曾作过的持久决定"。两者**都必须满足**：`allow-always` 规则命中时仍需调用方传 `--allow`（防御纵深），而 `--allow` 单独存在不能抵消 `deny-always`。

---

## 6. 测试要求（随实现落地）

| 用例 | 断言 | 状态 |
|---|---|---|
| 受保护路径 | `file delete permission.json --allow` → `E_PERMISSION_PROTECTED_PATH`，且文件**字节不变** | 已实现（`tests/golden.ps1`） |
| 脚本自我改写 | `file create bin/dsh-os.ps1 ... --allow` → 同上 | 已实现（`tests/golden.ps1`） |
| 规则命中 | 存在 `deny-always` 规则时，即使传 `--allow` 也拒绝，返回 `ruleId` | 已实现（委托侧查询；动词侧匹配待接入） |
| 审计追加 | 每次授权决定后审计条数 +1，且旧条目不被改写 | 已实现（`tests/permission.test.mjs`） |
| 委托专属 | 非委托上下文调用 `permission grant` → `E_PERMISSION_DELEGATE_ONLY`，**文件未被修改** | 待实现（动词层目前根本不接受该写入） |
| 篡改检出 | 手工把 `updatedBy` 改成别的值 → 读取时 `E_PERMISSION_FILE_UNTRUSTED`，判定退回 `defaults` | 已实现（`tests/permission.test.mjs`） |
| fail-closed | 本会话审批策略为 `never` 时，需授权的操作返回 `E_PERMISSION_NO_ANSWERER`，**不产生副作用** | 部分：动词层以 `E_PERMISSION` 拒绝，`E_PERMISSION_NO_ANSWERER` 待接入 |
| A 层强度上报 | `selfcheck` 的 `aclEnforced` 与真实 ACL 状态一致（不能恒为 true） | **未实现**，`selfcheck` 目前如实报告 ACL 未启用 |


---

## 7. 已确认的设计决策（本轮由用户裁决）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 强制手段 | **A + B 组合**：ACL 内核强制 + 动词表硬拒绝 |
| 2 | 弹窗实现 | **复用 DSH 自身审批通道**（`dsh-user-approval` + `dsh-client-ui-approval`）；持久决定由 `permission-consent` 委托写入 |
| 3 | 语义 | `file verify charset` 断言声明值；`file verify encoding` 校验字节序列合法性；`file verify completion` 校验完整性（预期由调用方给出）；`task show pid` 置前该进程窗口；`task launch` 为**启动**（原文 lunch 为笔误）；`service` 指**系统服务**（SCM/systemd/launchd） |
| 4 | environment 作用域 | 默认**用户级**，支持 `--scope process\|user\|machine`；`machine` 级需提权，报 `E_ELEVATION_REQUIRED` 而非静默失败 |

---

## 8. 待落地顺序

1. `spec/verbs.tsv` 扩展：`file.verify.*`、`system.*`、`task.*`、`service.*`、`environment.*`、`window.minimize/maximize`、`permission.*`
2. `bin/dsh-os.ps1`：保护路径检查（B 层）→ 新增查询类动词（`system.*`、`task.list/query`、`environment.list`、`file.verify.*`）——这些是 **R 类，可立即实现且无授权风险**
3. `permission.json` 读写逻辑 + 规则匹配 + 审计（读侧先做，写侧留到委托插件）
4. 委托插件（Service Definition + Consumer + `approval/request` answerer）
5. A 层 ACL 初始化与 `selfcheck` 强度上报
6. 上述 §6 测试用例接入 `tests/golden.ps1`
