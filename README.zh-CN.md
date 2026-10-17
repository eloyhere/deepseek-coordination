# deepseek-coordination

[English](README.md) · **简体中文** · [更新日志](CHANGELOG.md)

一个 **DeepSeek Harness 插件 bundle**。它是"双面" Cordis 插件：**Host 半边**运行在 DSH 的 Node
进程里，负责一组 HTTP 路由；**Client 半边**运行在 DSH Web GUI 里，把 UI 挂载到宿主的两个插槽上。

> **状态：已有第一版真实 UI。** 插件提供设置页里的 `协调` 分组（只含权限接管开关），以及在输入框
> 工具栏中注入的三个协调选择器。界面由 Material UI（MUI）的 React 组件构建。

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
│  ├─ index.ts            Host 半边：存活探测与 echo 路由
│  └─ client/
│     └─ index.ts         Client 半边：`协调` 设置页、输入框挂载、接管样式规则
├─ lib/                   构建产物（已 git 忽略，不要手改）
│  ├─ index.mjs           Host 半边
│  └─ client.js           Client 半边
├─ cordis.patch.yml       bundle patch：把本插件那一行插入 profile 配置
├─ package.json           dsh.bundle / dsh.client 声明与双入口 exports
├─ pnpm-lock.yaml         锁定的开发工具链与 DSH client 包
├─ pnpm-workspace.yaml    pnpm 设置（构建脚本白名单）
├─ tsconfig.json          只做类型检查（noEmit）
├─ tsdown.config.ts       双目标构建：Host 走 ESM，Client 走 CJS 并加模块加载器包装
├─ CHANGELOG.md
└─ LICENSE
```

## 插件挂了什么

| 位置 | 插槽 | 内容 |
|---|---|---|
| 设置页 | `settings.section` | `协调` 分组，只有一个权限接管开关 |
| 输入框工具栏 | `conversation.input.left` | 权限控件右侧空白处的三个选择器 |

三个选择器从左到右：**职能**（决策 / 成果 / 资源 / 人员 / 任职 / 执行）、**交互**（感情 / 思维 /
启发 / 收束）、**情景**（对话 / 写作 / 办公 / 研究 / 工程 / 迭代）。

**权限接管。** 宿主的权限控件是常驻 chrome、不是插槽，注册替换不了它。开关打开时注入一条规则把它
隐藏：

```css
button[aria-label^="访问模式"], button[aria-label^="Access mode"] { display: none !important; }
```

然后由 `conversation.input.left` 在同一行最左侧渲染替换用的下拉框。选择器基于控件的可访问名称
（它的 CSS-module 类名是哈希的），所以宿主改名会让规则失效。开关状态存在 `localStorage`。

## 环境要求

| 项目 | 要求 |
|---|---|
| Node.js | `>= 18` |
| 包管理器 | pnpm（npm 亦可；下例用 pnpm） |
| DSH | 装有 `dsh` CLI 的安装，且 profile 里含 `@deepseek-ai/dsh-web-app` |

## 构建

```console
$ pnpm install
$ pnpm typecheck        # tsc -p tsconfig.json --noEmit
$ pnpm build            # tsdown --config tsdown.config.ts
```

| 产物 | 半边 | 格式 |
|---|---|---|
| `lib/index.mjs` + `lib/index.d.mts` | Host | ESM，`platform: node` |
| `lib/client.js` | Client | CJS，`platform: browser`，外层包 `__ModuleLoader__.load()` |

控件用的是 Material UI 组件。`react` 由模块表提供、永远不打进产物；`@mui/material` 与 emotion 不在
该表里，因此由 `alwaysBundle` 内联进 `lib/client.js`——这也是 client 半边现在约 749 kB（gzip 约
156 kB）的原因。

## 安装到 profile

```console
# 从当前检出安装
$ dsh plugin --profile web add ./

# 或者先打包成 tarball
$ pnpm pack
$ dsh plugin --profile web add ./deepseek-coordination-0.4.0.tgz
```

因为本包声明了 `dsh.bundle`，`dsh plugin add` 会把它同时写进 profile 的 `package.json`（作为依赖）
和 `dsh.profile.bundles`。不启动也能校验这一层：

```console
$ dsh --profile web --dump-config     # 应出现 "# == deepseek-coordination" 层
$ dsh --profile web
```

调试时可以另起一个独立 profile 与端口：`dsh --profile debug --port 3081 --no-open`。

## 插件契约要点

以下几条出错时不会报错，只会静默失效：

- **硬依赖必须写进 `inject`。** `apply()` 只在所有被注入的服务就绪后运行。`ctx.get('x')` 是
  *可选*读取，在服务就绪前返回 `undefined`。
- **注册会被自动清理。** `ctx.on`、`ctx.tools.register`、`ctx.slots.inject` 等由插件的 fiber 持有。
  其他资源用 `ctx.effect(() => cleanup)` 返回清理函数——路由表面、接管 `<style>` 
  都是这样在卸载时移除的。
- **`inject` 与 `dsh.client.inject` 是两种声明。** 前者列 Client *服务*（`slots`），后者列模块表中的
  *包*（`react`、`@deepseek-ai/dsh-client-*`）。两者都需要。
- **只有 `react` 与 `@deepseek-ai/dsh-client-*` 来自模块表。** 其余（包括第三方库）必须打进产物；
  模块表缺行会在加载时抛错。
- **`__ModuleLoader__` 的 `id` 必须等于包名。** 它就是解析用的键。
- **`files` 是白名单。** 只有列出的文件会随包发布；清单指向 tarball 里不存在的路径时，插件能装上，
  却加载失败。

## 已知问题

- 替换下拉的文案已与宿主对齐（仅可查看 / 工作区内修改 / 完全权限），但选中后**尚未**派发
  `/permission` 命令：命令入口挂在输入栏插槽上，本插件所在的插槽拿不到。
- 接管选择器依赖宿主控件的可访问名称，宿主改名会让隐藏规则失效。
- 三个选择器目前只是界面：选中的职能 / 交互 / 情景**尚未**发送给模型或会话。
- 已在运行中的 `dsh web` 调试 profile 里验证（设置页、输入框挂载、接管隐藏规则）；控件样式是看
  截图确认的，没有自动化视觉测试。

## 仓库历史

- `0.1.0`–`0.1.9` —— 本仓库承载 **dsh-os**：跨平台原子级操作系统交互面（PowerShell 5.1 / 7.6 与
  POSIX 动词、50 个 golden 用例）。最后提交 `3ba4a45`，带标签 `v0.1.5` … `v0.1.9`。
- `87ddab9` —— 被替换为独立的 Vite 单页脚手架。
- `0.2.0` —— 重塑为当前这套插件 bundle 结构。
- `0.3.0` —— 第一版 UI，以 Angular 自定义元素实现。
- `0.4.0` —— 用 MDUI 2 web components 替换 Angular 元素。
- `0.5.0` —— 移除 MDUI，控件改由本插件自己的纯 React 组件绘制。
- `0.6.0` —— 改用 Material UI（`@mui/material` + emotion）。

内容没有丢：之前每个状态都能从 git 历史取回。

```console
# 不动当前工作区，另开一份 dsh-os 的检出
$ git worktree add ../dsh-os v0.1.9
```

## 参考

- DSH 插件教程：<https://github.com/deepseek-ai/deepseek-harness/tree/master/docs/user/develop>
- [打包与安装插件](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)
- [插件与生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/framework/index.md)

## 许可证

MIT © 2026 Eloy Kim，详见 [LICENSE](LICENSE)。
