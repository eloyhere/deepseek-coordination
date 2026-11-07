# 项目读取规则

读取项目或文件内容之前，必须先以大纲形式读取目标。

- 读取项目：先调用 `attention_manifest_protocol_workspace.list`（或对目录调用 `read`／`outline`）查看目录结构与项目大纲，再打开具体文件。
- 读取文件：先调用 `attention_manifest_protocol_workspace.outline`，或查看首次 `workspace.read` 返回的 `phase: "outline"`；确认大纲后，再用 `startLine`／`endLine` 或字节范围读取所需正文。
- 顺序固定为“项目大纲 → 文件大纲 → 正文”；宿主会在正文前返回缺失的大纲，不要跳过。
- AMP 不可用时，用语法解析器或文档标题／配置键结构生成同级大纲，并保持相同顺序。
