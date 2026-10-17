# deepseek-coordination

[English](README.md) · **简体中文** · [更新日志](CHANGELOG.md)

**deepseek-coordination** 的浏览器前端：一个用 [Vite](https://vite.dev) 与 TypeScript 构建的单页应用。

> **状态：初始脚手架。** 仓库已于 2026-10-17 在提交 `87ddab9` 中重新搭建。`src/main.ts`
> 目前仍是 Vite 模板页，产品界面尚未实现。重置前仓库里是什么、如何取回，见
> [仓库历史](#仓库历史)。

## 环境要求

| 项目 | 要求 |
|---|---|
| Node.js | `>= 18`（已在 24.21.0 上验证） |
| 包管理器 | npm（随 Node 安装） |
| 浏览器 | 任意当前主流浏览器 |

Vite 与 TypeScript 都是本地 `devDependencies`，无需全局安装任何工具；项目没有运行时依赖，
`dist/` 可独立部署。

## 快速开始

```console
$ npm install
$ npm run dev
```

Vite 会打印本地地址（默认 <http://localhost:5173>）。修改 `src/` 下的文件会通过热模块替换
直接生效，无需刷新浏览器。

构建静态产物：

```console
$ npm run build
$ npm run preview
```

`build` 会先执行 `tsc`，因此类型错误会在打包前就让构建失败。产物输出到 `dist/`，该目录已被
git 忽略。

## npm 脚本

| 脚本 | 实际执行 | 作用 |
|---|---|---|
| `npm run dev` | `vite` | 启动带 HMR 的开发服务器 |
| `npm run build` | `tsc && vite build` | 先做类型检查（不产出），再打包到 `dist/` |
| `npm run preview` | `vite preview` | 本地预览生产构建 |

`package.json` 里还保留着 18 个旧脚本（`os`、`test`、`test:*`、`measure:cache`、`test:all`、
`selfcheck`）。它们属于上一个项目，目前执行会失败——详见[已知问题](#已知问题)。

## 目录结构

```text
.
├─ index.html          HTML 入口，也是唯一页面
├─ package.json        ESM 包，Vite + TypeScript 开发依赖与 npm 脚本
├─ package-lock.json   锁定本地工具链版本
├─ tsconfig.json       仅做类型检查（noEmit）
├─ public/             原样复制到站点根目录
│  ├─ favicon.svg
│  └─ icons.svg
├─ src/
│  ├─ main.ts          应用入口：挂载并渲染到 #app
│  ├─ counter.ts       计数器按钮的行为实现
│  ├─ style.css        由 main.ts 导入，Vite 负责注入
│  └─ assets/          以模块方式导入、参与 URL 解析与哈希的图片
│     ├─ hero.png
│     ├─ typescript.svg
│     └─ vite.svg
├─ README.md
├─ README.zh-CN.md
├─ CHANGELOG.md
└─ LICENSE
```

`public/` 中的文件以站点根路径提供，必须用 `/favicon.svg` 这样的绝对路径引用；`src/` 中的文件
按模块导入，构建后会得到带内容哈希的文件名。

## 页面是怎么组装出来的

1. `index.html` 提供 `<div id="app">`，并以模块方式加载 `/src/main.ts`。
2. `src/main.ts` 导入 `./style.css`（由 Vite 注入文档）、以 URL 字符串形式导入三张图片，并从
   `./counter.ts` 导入 `setupCounter`。
3. 脚本向 `#app` 写入 `<section id="center">`：包含三张图片的 hero 区、标题 *Get started*、
   HMR 提示，以及一个 `<button id="counter">`。
4. 按钮交给 `setupCounter`，它渲染 `Count is N` 并在点击时自增。
5. `vite build` 会把入口改写为 `dist/index.html`，并在 `dist/assets/` 下产出带内容哈希的资源。

相对导入刻意保留 `.ts` 后缀：`allowImportingTsExtensions` 与 `moduleResolution: "bundler"`
允许这样做，Vite 也能解析省略后缀的写法。

## 约定

- **只使用 ESM。** 包声明 `"type": "module"`，`src/` 中不使用 CommonJS。
- **`tsc` 不产出文件。** 开启 `noEmit`，TypeScript 只负责类型检查、Vite 负责打包，两者不会争抢
  输出目录。
- **编译选项有意偏严。** `target: ES2023`、`lib: [ES2023, DOM]`、`types: ["vite/client"]`，并开启
  `noUnusedLocals`、`noUnusedParameters`、`noFallthroughCasesInSwitch`、`erasableSyntaxOnly`、
  `verbatimModuleSyntax`。
- **资源只有一处归属。** 需要保持文件名的放到 `public/`；经由模块图导入的放到 `src/assets/`。
- **忽略规则。** `.gitignore` 沿用 Vite 模板：`logs`、`*.log`、`node_modules`、`dist`、
  `dist-ssr`、`*.local` 以及编辑器目录。

## 已知问题

重新搭建时删掉了旧源码，却没有清理引用它们的元数据，因此这个包目前自相矛盾。以下问题都不影响
`dev`、`build`、`preview`。

| `package.json` 中的位置 | 声明内容 | `87ddab9` 之后的状态 |
|---|---|---|
| `main` | `src/plugin/index.js` | 已删除 |
| `exports`（5 个子路径） | `src/plugin/*.js`、`client.js`、`src/permission/index.js` | 已删除 |
| `bin.dsh-os` | `src/host/bin/dsh-os.bat` | 已删除 |
| `dsh.bundle.patch` | `./cordis.patch.yml` | 已删除 |
| `files` | 20 条路径 | 19 条已删除，`README.md` 已重新生成 |

其他遗留项：

- `index.html` 的标题仍是脚手架占位符 `replace`（重置前是 `deepseek-coordination`）。
- `.gitattributes` 已被删除，换行现在由 `core.autocrlf` 决定，不再遵循仓库原先的显式规则。
- `npm pack` 能成功执行，但打出的包其入口文件并不存在。

## 仓库历史

在提交 `3ba4a45`（标签 `v0.1.9`）之前，本仓库承载的是 **dsh-os**：面向 DeepSeek Harness 的
跨平台原子级操作系统交互面。它用一套参数稳定的动词覆盖 file、environment、task、service、
system、permission、execute、window、screenshot、clipboard、wait、mouse、keyboard、text 与
structure，在 Windows（PowerShell 5.1 与 7.6）和 POSIX 上原生实现，每个动词返回单个 JSON
信封，并对字符集、BOM 与换行做字节级精确处理。

这棵树——`src/host`、`src/plugin`、`src/permission`、`tests`、`tools`、`client.js`、
`cordis.patch.yml`——在 `87ddab9` 中从分支顶端删除，但在 git 历史中完整可达，并且仍带有
`v0.1.5` … `v0.1.9` 标签：

```console
# 不动当前工作区，另开一份旧项目的检出
$ git worktree add ../dsh-os v0.1.9

# 或者只把部分目录恢复到当前工作区
$ git checkout 3ba4a45 -- src/host src/plugin src/permission tests tools
```

两个阶段的逐版本变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

MIT © 2026 Eloy Kim，详见 [LICENSE](LICENSE)。
