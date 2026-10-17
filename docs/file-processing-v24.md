# 文件处理与解析增强（v24 追加规格）

> 优先级确认：**1（JavaScript/TypeScript）+ 3（CSS/HTML/Markdown）+ 4（通用接口，其他语言插件化）**。
> 本文只规定解析与文件处理层的边界、数据结构和复杂度；不改变现有 Turn/Plan/职能锁定语义。

## 1. 目标

为 Coordination 插件增加可复用的文本解析、依赖解析与导入解析能力，支撑：

- 读取工作区文件后提取 import/require/动态 import/export-from；
- 提取 CSS `@import`/`url()`、HTML `script/link/img`、Markdown 链接与图片；
- 构建文件依赖图，检测环、计算拓扑层级、找出孤立节点；
- 为 Plan/Organization 提供“影响面/依赖顺序”证据，而不是把整个文件塞进上下文。

## 2. 分层

```
src/host/text/
  token.ts        通用 Token/TokenKind/SourceSpan（或复用 shared/ast.ts 的 Token 类型）
  tokenizer.ts    字符级扫描，O(n)，无正则回溯；产出 TokenStream
  parser.ts       Parser 接口 + ParserRegistry（按扩展名/语言插件化）
  javascript.ts   JS/TS/JSX 的 import/export/require/import() 解析（容错，不构建完整 AST）
  markup.ts       CSS/HTML/Markdown 的引用/链接解析
  dependency.ts   DirectedGraph 构建、路径解析、拓扑排序、环检测、层级
  cache.ts        有界 LRU（path+mtime+size 指纹），默认 256 项
  index.ts        对外 API：parseFile / parseText / buildDependencyGraph
```

- 所有解析器实现 `Parser` 接口，注册到 `ParserRegistry`；未知扩展名返回 `undefined`，不猜。
- 解析失败不是异常：返回 `ParseResult { ast?, references, diagnostics, truncated }`；诊断带 `SourceSpan`。
- 不引入第三方解析库；手写容错扫描器，优先正确提取引用而不是完整语法树。

## 3. 数据结构映射

| 需求 | 结构 | 理由 |
|---|---|---|
| 有序符号表/按路径排序 | `RedBlackTree` / `RedBlackSet` | O(log n) 插入/范围/前后驱 |
| 依赖调度、最短路径 | `BinaryHeap` / `IndexedHeap` | O(log n) 取最小、改键 |
| 解析器显式栈、回溯 | `Stack` / `Deque` | 避免递归爆栈，O(1) |
| AST 节点/遍历 | `AstNode` / `AstTree` / `AstIndex` / `TokenStream` | 迭代 visitor，span/parent 一致 |
| 依赖图 | `DirectedGraph` | O(V+E) 拓扑/环/层级 |
| import 路径前缀、关键字 | `Trie` | O(k) 匹配与补全 |
| 解析缓存 | `OrderedLruSet` / `LruList` | 有界，避免重复 IO/解析 |
| 插入序映射 | `OrderedMap` | 诊断按出现顺序稳定 |
| 去重 | `OrderedSet` / 哈希集合 | O(1) 均摊 |

## 4. 复杂度与资源上限（强制）

| 项 | 上限/复杂度 |
|---|---|
| 单文件读取 | 1 MiB；超过则截断并标记 `truncated` |
| tokenizer | O(n) 时间、O(tokens) 空间；无正则回溯 |
| 单文件 token 数 | 200,000；超过停止并标记 |
| AST 深度 | 256；超过停止并标记 |
| 解析超时 | 2s（可配置），超时返回已收集引用 + `truncated` |
| 依赖图 | O(V+E)；V ≤ 20,000，E ≤ 100,000，超出 fail-closed |
| 缓存 | LRU 256 项，内存 O(256 × 文件大小上限) 受控 |
| 拓扑排序 | Kahn O(V+E)；有环返回 `null` 并附环路径 |
| 解析器注册表 | `Map<string, Parser>`，O(1) 查找 |

## 5. 引用模型

```ts
type ReferenceKind = 'import' | 'require' | 'dynamic-import' | 'export-from'
  | 'css-import' | 'css-url' | 'html-script' | 'html-link' | 'html-image'
  | 'markdown-link' | 'markdown-image'

interface FileReference {
  kind: ReferenceKind
  specifier: string        // 原始文本
  resolved?: string        // 相对路径解析后的绝对/相对工作区路径
  external: boolean        // 裸模块、http(s)、data:
  span: SourceSpan
  typeOnly?: boolean       // TS `import type`
}
```

- 解析相对路径时只做词法归一（`.`/`..`/分隔符），不访问文件系统；文件存在性由文件层另行检查。
- 裸模块（`react`）、URL、`data:` 标记 `external: true`，不进入本地依赖图的边。
- 循环依赖是合法结果，必须报告而不是抛错。

## 6. 通用接口（插件化）

```ts
interface Parser {
  id: string                       // 'javascript' | 'markup' | ...
  extensions: readonly string[]    // ['.ts', '.tsx', '.js', '.jsx']
  parse(text: string, options: ParseOptions): ParseResult
}

interface ParseOptions {
  path?: string
  maxTokens?: number
  maxDepth?: number
  timeoutMs?: number
  signal?: AbortSignal
}
```

- 新语言只需新增 `Parser` 并注册，不修改 `parser.ts`。
- 语言识别顺序：显式 `path` 扩展名 → 调用方 `parserId` → `undefined`（不猜）。
- 解析器之间不得相互 import；共享逻辑放 `tokenizer.ts`。

## 7. 与工作流的接入（后续）

- `coordination_parse` 工具（新增）：参数 `path` 或 `text`，返回引用列表 + 诊断 + 截断标记；不把文件全文返回给模型。
- Organization 在“工程/办公”情景下，可先解析入口文件的 import 图，把拓扑层级作为 Plan 的约束/步骤顺序证据。
- 解析结果只作为 `evidence` 片段进入上下文，按 `value-per-token` 选择，受 TokenGovernor 预算约束。
- 缓存键：`path + mtime + size + parserId`；文件变化自动失效。

## 8. 验收

- TS/JS：静态 import、`import type`、re-export、`require`、`import()`、多行/注释/字符串干扰。
- CSS/HTML/Markdown：`@import`、`url()`、`src/href`、Markdown 行内/引用式链接与图片。
- 依赖图：相对路径归一、external 过滤、环检测、拓扑层级、孤立节点。
- 资源上限：1 MiB、200k token、深度 256、2s 超时、20k 节点全部有测试。
- 复杂度：tokenize/parse O(n)、图 O(V+E)、缓存 O(1)；10k 引用解析 <2s（宽松上限）。
