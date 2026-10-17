# deepseek-coordination

**English** · [简体中文](README.zh-CN.md) · [Changelog](CHANGELOG.md)

A **DeepSeek Harness plugin bundle**. It is a *dual-face* Cordis plugin: a **host half** that
runs in the DSH Node process and owns an HTTP route surface, and a **client half** that runs in
the DSH Web GUI and mounts UI into two host slots.

> **Status: first real UI.** The plugin's UI is a `协调` settings page holding the
> permission-takeover switch, and three coordination selectors injected into the composer tool
> row. Built from Material UI (MUI) React components.

## What the pieces mean

| Term | What it is |
|---|---|
| **Plugin** | A module exporting `apply(ctx)`, mounted by a row in a config layer |
| **Bundle** | An npm package whose `package.json` declares `dsh.bundle.patch` — the layer of rows it contributes |
| **Profile** | A runnable composition under `$DSH_HOME/profiles/<name>` listing the bundles to apply, in order |
| **Host half** | `lib/index.mjs`, ESM for Node, built from `src/index.ts` |
| **Client half** | `lib/client.js`, CJS for the browser, built from `src/client/index.ts` |

This repository is the **bundle**. A profile is what a user boots; nothing here is both.

## Project structure

```text
.
├─ src/
│  ├─ index.ts            Host half: liveness and echo routes
│  └─ client/
│     └─ index.ts         Client half: `协调` settings page, composer mount, takeover rule
├─ lib/                   Build output (git-ignored, never edited by hand)
│  ├─ index.mjs           Host half
│  └─ client.js           Client half
├─ cordis.patch.yml       Bundle patch: inserts this plugin's row into a profile roster
├─ package.json           dsh.bundle + dsh.client declarations, dual exports map
├─ pnpm-lock.yaml         Pinned dev toolchain and DSH client packages
├─ pnpm-workspace.yaml    pnpm settings (build-script allowlist)
├─ tsconfig.json          Type checking only (`noEmit`)
├─ tsdown.config.ts       Dual-target build: host ESM + client CJS with the module-loader wrapper
├─ CHANGELOG.md
└─ LICENSE
```

## What the plugin mounts

| Where | Slot | Content |
|---|---|---|
| Settings | `settings.section` | A `协调` page with the permission-takeover switch and nothing else |
| Composer tool row | `conversation.input.left` | Three selectors in the free space right of the access-mode control |

The selectors run left to right — **职能** (决策 / 成果 / 资源 / 人员 / 任职 / 执行), **交互**
(感情 / 思维 / 启发 / 收束), **情景** (对话 / 写作 / 办公 / 研究 / 工程 / 迭代).

**Permission takeover.** The host's access-mode control is resident chrome, not a slot, so the
plugin cannot replace it by registration. With the switch on, an injected rule hides it —

```css
button[aria-label^="访问模式"], button[aria-label^="Access mode"] { display: none !important; }
```

— and `conversation.input.left` renders a replacement dropdown at the left edge of the same row.
The selector targets the control's accessible name (its CSS-module class names are hashed), so a
host release that renames that label breaks the rule. The switch position persists in
`localStorage`.

## Requirements

| | |
|---|---|
| Node.js | `>= 18` |
| Package manager | pnpm (npm works; the examples below use pnpm) |
| DSH | an installation that ships the `dsh` CLI, plus a profile with `@deepseek-ai/dsh-web-app` |

## Build

```console
$ pnpm install
$ pnpm typecheck        # tsc -p tsconfig.json --noEmit
$ pnpm build            # tsdown --config tsdown.config.ts
```

| Output | Face | Format |
|---|---|---|
| `lib/index.mjs` + `lib/index.d.mts` | Host | ESM, `platform: node` |
| `lib/client.js` | Client | CJS, `platform: browser`, wrapped in `__ModuleLoader__.load()` |

The widgets are Material UI components. `react` arrives through the module table and is never
bundled; `@mui/material` and emotion are not in that table, so `alwaysBundle` inlines them into
`lib/client.js`. That is why the client half is now ~749 kB (~156 kB gzip).

## Install into a profile

```console
# from this checkout
$ dsh plugin --profile web add ./

# or from a packed tarball
$ pnpm pack
$ dsh plugin --profile web add ./deepseek-coordination-0.4.0.tgz
```

`dsh plugin add` writes the package into the profile's `package.json` (as a dependency *and* into
`dsh.profile.bundles`) because this package declares `dsh.bundle`. Verify the layer without booting:

```console
$ dsh --profile web --dump-config     # expect a "# == deepseek-coordination" layer
$ dsh --profile web
```

To run a throwaway instance for development, boot a separate profile on its own port:
`dsh --profile debug --port 3081 --no-open`.

## Plugin contract rules

These are the ones that fail silently rather than loudly:

- **Hard dependencies belong in `inject`.** `apply()` runs only after every injected service is
  ready. `ctx.get('x')` is an *optional* read and returns `undefined` before the service exists.
- **Registrations are disposed automatically.** `ctx.on`, `ctx.tools.register`, `ctx.slots.inject`
  and friends are owned by the plugin's fiber. For anything else, return a disposer from
  `ctx.effect(() => cleanup)` — that is how the route surface, the injected `<style>` unregister on unload.
- **`inject` and `dsh.client.inject` are different declarations.** The first lists client
  *services* (`slots`); the second lists module-table *packages* (`react`,
  `@deepseek-ai/dsh-client-*`). Both are required.
- **Only `react` and `@deepseek-ai/dsh-client-*` come from the module table.** Everything else —
  everything else — must be bundled; a missing table row throws at load time.
- **`__ModuleLoader__`'s `id` must equal the package name.** It is the resolution key.
- **`files` is a whitelist.** Only what it lists ships; if the manifest points at a path the
  tarball lacks, the plugin installs cleanly and then fails to load.

## Known issues

- The replacement dropdown's preset list is a fallback (`完全权限`) until the host's real preset
  inventory is wired through.
- The takeover selector keys off the host control's accessible name; renaming it breaks the hide
  rule.
- The selectors are presentation only: a chosen 职能 / 交互 / 情景 is **not** sent to the model or
  the session yet.
- Verified in a running `dsh web` debug profile (settings page, composer mount, takeover hide
  rule); the widget styling was confirmed from screenshots, not from an automated visual test.

## Repository history

- `0.1.0`–`0.1.9` — the repository hosted **dsh-os**, a cross-platform atomic OS-interaction
  surface (PowerShell 5.1 / 7.6 and POSIX verbs, 50 golden cases). Last commit `3ba4a45`, tagged
  `v0.1.5` … `v0.1.9`.
- `87ddab9` — replaced by a standalone Vite single-page scaffold.
- `0.2.0` — reshaped into this plugin bundle layout.
- `0.3.0` — first UI, built as an Angular custom element.
- `0.4.0` — the Angular element replaced by MDUI 2 web components.
- `0.5.0` — MDUI removed; the widgets are plain React components owned by this plugin.
- `0.6.0` — those components replaced by Material UI (`@mui/material` + emotion).

Nothing is lost: every earlier state is reachable from git history.

```console
# Inspect the dsh-os project without touching this checkout
$ git worktree add ../dsh-os v0.1.9
```

## References

- DSH plugin tutorials: <https://github.com/deepseek-ai/deepseek-harness/tree/master/docs/user/develop>
- [Package and install a plugin](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)
- [Plugins and lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/framework/index.md)

## License

MIT © 2026 Eloy Kim. See [LICENSE](LICENSE).
