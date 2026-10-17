# deepseek-coordination

[English](README.md) · **简体中文** · [更新日志](CHANGELOG.md)

一个 **DeepSeek Harness 插件 bundle**。它是"双面" Cordis 插件：**Host 半边**运行在 DSH 的 Node
进程里，负责一组 HTTP 路由；**Client 半边**运行在 DSH Web GUI 里，负责一个设置页。

> **状态：脚手架。** Host 半边目前只回应存活探测与 echo，Client 半边注册的是一个占位设置页，
> 用来显示 Host 半边是否在线。两半已经端到端接通，剩下的工作是填路由实现与界面，而不是接线。

## 几个概念

| 概念 | 含义 |
|---|---|
| **插件（plugin）** | 导出 `apply(ctx)` 的模块，由某个配置层里的一行挂载 |
| **bundle** | 在 `package.json` 里声明 `dsh.bundle.patch` 的 npm 包，即它贡献的那一层配置 |
| **profile** | `$DSH_HOME/profiles/<name>` 下的可运行组合，按顺序列出要应用的 bundle |
| **Host 半边** | `lib/index.mjs`，面向 Node 的 ESM，由 `src/index.ts` 构建 |
| **Client 半边** | `lib/client.js`，面向浏览器的 CJS，由 `src/client/index.ts` 构建 |

本仓库是其中的 **bundle**。用户启动的是 profile，二者不会合为一体。

## 目录结构

```text
.
├─ src/
│  ├─ index.ts           Host 半边：Cordis 插件，注册 /deepseek-coordination/* 路由
│  └─ client/
│     └─ index.ts        Client 半边：语言字典 + settings.section 设置页
├─ lib/                  tsdown 构建产物（已 git 忽略，不要手改）
├─ cordis.patch.yml      bundle patch：把本插件那一行插入 profile 配置
├─ package.json          dsh.bundle / dsh.client 声明与双入口 exports
├─ pnpm-lock.yaml        锁定的开发工具链与 DSH client 包
├─ tsconfig.json         只做类型检查（noEmit）
├─ tsdown.config.ts      双目标构建：Host 走 ESM，Client 走 CJS 并加模块加载器包装
├─ CHANGELOG.md
└─ LICENSE
```

## 环境要求

| 项目 | 要求 |
|---|---|
| Node.js | `>= 18` |
| 包管理器 | pnpm（npm 亦可；下例用 pnpm） |
| DSH | 装有 `dsh` CLI 的 DSH 安装，以及 `web` profile |

## 构建

```console
$ pnpm install
$ pnpm typecheck        # tsc -p tsconfig.json --noEmit
$ pnpm build            # ng build elements && tsdown --config tsdown.config.ts
```

`build` 会产出清单指向的两个文件：

| 产物 | 半边 | 格式 |
|---|---|---|
| `lib/index.mjs` + `lib/index.d.mts` | Host | ESM，`platform: node` |
| `lib/client.js` | Client | CJS，`platform: browser`，外层包 `__ModuleLoader__.load()` |

不要直接改 `lib/`，也不要手写 `__ModuleLoader__` 包装——那是由 `tsdown.config.ts` 的
`banner` / `intro` / `footer` 生成的。永远改 `src/` 后重新构建。

## 安装到 profile

```console
# 从当前检出安装
$ dsh plugin --profile web add ./

# 或者先打包成 tarball
$ pnpm pack
$ dsh plugin --profile web add ./deepseek-coordination-0.2.0.tgz
```

因为本包声明了 `dsh.bundle`，`dsh plugin add` 会把它同时写进 profile 的 `package.json`
（作为依赖）和 `dsh.profile.bundles`。不启动也能校验这一层：

```console
$ dsh --profile web --dump-config     # 应出现 "# == deepseek-coordination" 层
$ dsh --profile web
```

## 两半如何通信

两个半边从不互相 import，一律走 HTTP：

| 路由（`POST`） | 请求体 | 响应 |
|---|---|---|
| `/deepseek-coordination/ping` | `{}` | `{"ok":true,"value":{"plugin":"deepseek-coordination","pong":true}}` |
| `/deepseek-coordination/echo` | 任意 JSON | `{"ok":true,"value":<原样 JSON>}` |

所有响应统一用一个信封：`{ ok: true, value }` 或 `{ ok: false, error }`。Client 半边用
`fetch()` 发送 JSON 并读取该信封，不依赖共享的模块实例。

## 插件契约要点

以下几条出错时不会报错，只会静默失效：

- **硬依赖必须写进 `inject`。** `apply()` 只在所有被注入的服务就绪后运行。`ctx.get('x')` 是
  *可选*读取，在服务就绪前返回 `undefined`，不能当作 `inject` 的替代。
- **注册会被自动清理。** `ctx.on`、`ctx.tools.register`、`ctx.slots.inject` 等由插件的 fiber
  持有。其他资源用 `ctx.effect(() => cleanup)` 返回清理函数——路由表面的注销就是这么做的。
- **`inject` 与 `dsh.client.inject` 是两种声明。** 前者列 Client *服务*（`slots`、`locale`），
  后者列模块表中的*包*（`react`、`@deepseek-ai/dsh-client-*`）。两者都需要。
- **只有 `react` 与 `@deepseek-ai/dsh-client-*` 来自模块表。** Client 半边的其余依赖必须打进
  产物——`tsdown.config.ts` 用 `neverBundle` / `alwaysBundle` 表达这一点，模块表缺行会在加载时抛错。
- **`__ModuleLoader__` 的 `id` 必须等于包名。** 它就是解析用的键。
- **使用主题变量。** 颜色一律取自 `var(--dsw-alias-*)`，写死颜色会在两套主题中的一套里失效。
- **`files` 是白名单。** 只有列出的文件会随包发布；若清单指向 tarball 里不存在的路径，插件能装
  上，却加载失败。

## 发布

- **npm registry 或 tarball** —— 发布前先构建 `lib/`（`pnpm publish` / `pnpm pack`），这样用户拿到
  的是编译产物，也不需要任何安装期构建授权。
- **直接从 git 安装** —— `dsh plugin add github:you/deepseek-coordination` 取的是*源码*而不是产物，
  只有在包声明了自洽的 `prepare` 脚本时才可行，且用户要先在 profile 的 `pnpm-workspace.yaml`
  里放行（`allowBuilds`）。本仓库没有 `prepare` 脚本，因此应发布编译后的产物。

## 仓库历史

- `0.1.0`–`0.1.9` —— 本仓库承载的是 **dsh-os**：跨平台原子级操作系统交互面（PowerShell 5.1 /
  7.6 与 POSIX 动词实现、插件行、50 个 golden 用例）。最后提交 `3ba4a45`，带标签 `v0.1.5` … `v0.1.9`。
- `87ddab9` —— 上述代码被替换为一个独立的 Vite 单页脚手架。
- `0.2.0` —— 当前这套插件 bundle 结构，取代以上两者。

内容没有丢：之前每个状态都能从 git 历史取回。

```console
# 不动当前工作区，另开一份 dsh-os 的检出
$ git worktree add ../dsh-os v0.1.9

# 或者只把部分目录恢复到当前工作区
$ git checkout 3ba4a45 -- src/host src/plugin src/permission tests tools
```

## 参考

- DSH 插件教程：<https://github.com/deepseek-ai/deepseek-harness/tree/master/docs/user/develop>
- [打包与安装插件](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)
- [插件与生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/framework/index.md)

## 许可证

MIT © 2026 Eloy Kim，详见 [LICENSE](LICENSE)。
