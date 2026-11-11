# 第三批审计结论与修复（attention / evidence / budget）

来源：受限互斥子代理审计，原始结论见 [batch-attention-evidence-budget.md](batch-attention-evidence-budget.md)。

## 结论与处理

| 模块 | 审计判定 | 问题 | 处理 |
|---|---|---|---|
| attention | partial | `context` 优先真实编译包但会回退到合成包；`get` 未按 tenant/session 过滤；`request_focus` 只写 host note 且永远 `granted:false` | 未改：`request_focus` 的驻留权本来就属宿主策略（`granted:false` 是诚实回答，不是缺口）；回退包是容错路径，保留 |
| evidence | partial | `cite` 只把 id 塞进 host Set，不校验、不写 AMP；`list` 绕过端口读原始表 | `cite` 改为逐 id 用 `ports.evidence.get(id, tenantId)` 解析：存在才计入 citations，不存在的返回 `missing`；全部缺失时 `not_found`。`list` 暂保留 store 视图（EvidenceLedger 无 list API），已在报告标注 |
| budget | partial | 只返回 `snapshot().budget` 聚合值，丢失 per-node 预算树 | `remaining` 现在返回 `{ ...budget, tree: snapshot().budgetTree }`，扁平字段不变，新增 per-node 树 |

## 额外修复

`AmpHost.bindingFor` 的 `policyVersion` 仍是 `dsh-amp-0.9.1`（升级时漏改），已改为 `dsh-amp-0.14.0`。这正是审计怀疑“0.9.1 时代接线”的直接证据之一。

## 验证

- `npm test`：**187/187**。
- 新增回归：`evidence.cite` 对不存在 id 返回 `not_found`；`budget.remaining` 必带 `tree` 数组。
