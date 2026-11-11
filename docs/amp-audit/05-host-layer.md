# host 层 8 个模块的实际使用情况

判定依据（可复现）：

1. `SURFACE_MODULES` 中 tier=host 的 8 个模块：`capability`、`manifest`、`provenance`、`receipt`、`verification`、`retrieval`、`model`、`runtime`。
2. 在 `node_modules/attention-manifest-protocol/lib` 中检索 `ports.<module>`：
   - `ports.receipt`：命中（kernel.js 多处，`createInvocation` / `createReceiptCore` / `verifyReceiptIntegrity`）。
   - `ports.verification`：命中（kernel.js `verifyBusinessSemantics`）。
   - `ports.policy`：命中（kernel.js `authorize`）。
   - `ports.provenance`、`ports.retrieval`、`ports.model`、`ports.runtime`、`ports.capability`、`ports.manifest`：**0 命中**。
3. 插件侧直接 import：仅 `profession`（hidden）与 `kernel`，其余通过 kernel flow。

## 结论

| 模块 | 插件中的使用 | 判定 |
|---|---|---|
| receipt | kernel flow `settleAction`/`recordReceipt` 内部调用 | 实际使用（间接） |
| verification | kernel flow `verifyBusiness` 内部调用 | 实际使用（间接） |
| capability | 未调用 | 未使用 |
| manifest | 未调用 | 未使用 |
| provenance | 未调用（证据审计事件走 `EvidenceLedger.auditEvents`） | 未使用 |
| retrieval | 未调用（`execution.read_handle` 用插件自己的 handle 分页） | 未使用 |
| model | 未调用（模型由 DSH harness 拥有） | N/A |
| runtime | 未调用（执行由 kernel `settleAction` + DSH 工具层拥有） | N/A |

`model` 与 `runtime` 是 AMP 提供的“替代模型端口 / 替代执行协调器”；在本插件里模型与执行的所有权属于 DSH，强行接入只会制造第二套真相，因此标为 N/A 而非待办。

`capability` / `manifest` / `provenance` / `retrieval` 四个是可接入的：

- `retrieval`：把 `execution.read_handle` 的分页改为 AMP retrieval handle；影响面中等。
- `provenance`：`evidence.get` 增加可选的 provenance 链（数据来自 `EvidenceLedger.auditEvents()`）。
- `capability`：网关用 AMP capability registry 复核 authority，替代当前的字符串比较。
- `manifest`：为编译后的上下文块生成 AMP manifest；需要先确认 manifest 的签名/载荷契约。

## 建议

若“每个模块都有实际应用”按字面执行，需要至少接入上述四个；`model`/`runtime` 建议按 N/A 处理并在验收口径中排除。若接受“可构造 + 有明确所有权归属”作为标准，则当前状态已可验收。
