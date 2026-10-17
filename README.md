# deepseek-coordination

**English** · [简体中文](README.zh-CN.md) · [Changelog](CHANGELOG.md)

The browser front end for **deepseek-coordination**: a single-page application built with
[Vite](https://vite.dev) and TypeScript.

> **Status: early scaffold.** This repository was re-scaffolded on 2026-10-17 in commit
> `87ddab9`. `src/main.ts` still renders the Vite starter screen, so there is no product UI
> yet. What the repository contained before the reset, and how to get it back, is documented
> under [Repository history](#repository-history).

## Requirements

| | |
|---|---|
| Node.js | `>= 18` (verified on 24.21.0) |
| Package manager | npm (ships with Node) |
| Browser | any current evergreen browser |

Vite and TypeScript are local `devDependencies`; nothing needs to be installed globally.
There are no runtime dependencies, so `dist/` is self-contained.

## Quick start

```console
$ npm install
$ npm run dev
```

Vite prints the local URL (default <http://localhost:5173>). Saving a file under `src/`
re-executes the page through hot module replacement; no browser reload is needed.

To produce a static build:

```console
$ npm run build
$ npm run preview
```

`build` runs `tsc` first, so a type error fails the build before anything is bundled.
Output lands in `dist/`, which is ignored by git.

## Scripts

| Script | Runs | What it does |
|---|---|---|
| `npm run dev` | `vite` | Dev server with HMR |
| `npm run build` | `tsc && vite build` | Type-check (no emit), then bundle to `dist/` |
| `npm run preview` | `vite preview` | Serve the production build locally |

`package.json` also declares 18 legacy scripts (`os`, `test`, `test:*`, `measure:cache`,
`test:all`, `selfcheck`). They belong to the previous project and currently fail — see
[Known issues](#known-issues).

## Project structure

```text
.
├─ index.html          HTML entry; the only page
├─ package.json        ESM package, Vite + TypeScript devDependencies, npm scripts
├─ package-lock.json   Locked local toolchain
├─ tsconfig.json       Type checking only (`noEmit`)
├─ public/             Copied verbatim to the site root
│  ├─ favicon.svg
│  └─ icons.svg
├─ src/
│  ├─ main.ts          Application entry: mounts and renders into #app
│  ├─ counter.ts       Exported behaviour for the counter button
│  ├─ style.css        Imported by main.ts and injected by Vite
│  └─ assets/          Images imported for URL resolution and hashing
│     ├─ hero.png
│     ├─ typescript.svg
│     └─ vite.svg
├─ README.md
├─ README.zh-CN.md
├─ CHANGELOG.md
└─ LICENSE
```

Files in `public/` are served from `/` and must be referenced by absolute path, e.g.
`/favicon.svg`. Files under `src/` are imported as modules and get content-hashed names.

## How the page is assembled

1. `index.html` provides `<div id="app">` and loads `/src/main.ts` as a module.
2. `src/main.ts` imports `./style.css` (Vite injects it into the document), imports the three
   images as resolved URL strings, and imports `setupCounter` from `./counter.ts`.
3. It writes a `<section id="center">` into `#app`: a hero with the three images, the heading
   *Get started*, an HMR hint, and a `<button id="counter">`.
4. The button is handed to `setupCounter`, which renders `Count is N` and increments on click.
5. `vite build` rewrites the entry into `dist/index.html` plus content-hashed assets under
   `dist/assets/`.

Relative imports keep their `.ts` extension on purpose; `allowImportingTsExtensions` and
`moduleResolution: "bundler"` allow it, and Vite resolves the extensionless specifiers too.

## Conventions

- **ESM only.** `"type": "module"`; no CommonJS in `src/`.
- **`tsc` never emits.** `noEmit` is on — TypeScript is the type checker, Vite the bundler, so
  the two cannot fight over output.
- **Compiler settings are strict on purpose.** `target: ES2023`, `lib: [ES2023, DOM]`,
  `types: ["vite/client"]`, plus `noUnusedLocals`, `noUnusedParameters`,
  `noFallthroughCasesInSwitch`, `erasableSyntaxOnly` and `verbatimModuleSyntax`.
- **Assets have one home.** Anything that must keep its filename goes in `public/`; anything
  imported through the module graph goes in `src/assets/`.
- **Ignore file.** `.gitignore` follows the Vite template: `logs`, `*.log`, `node_modules`,
  `dist`, `dist-ssr`, `*.local`, and editor directories.

## Known issues

The re-scaffold removed the previous sources but not the metadata that referenced them, so the
package is currently inconsistent. None of this breaks `dev`, `build` or `preview`.

| Location in `package.json` | Declares | State after `87ddab9` |
|---|---|---|
| `main` | `src/plugin/index.js` | removed |
| `exports` (5 subpaths) | `src/plugin/*.js`, `client.js`, `src/permission/index.js` | removed |
| `bin.dsh-os` | `src/host/bin/dsh-os.bat` | removed |
| `dsh.bundle.patch` | `./cordis.patch.yml` | removed |
| `files` | 20 paths | 19 removed, `README.md` regenerated |

Additional loose ends:

- `index.html` still carries the scaffold placeholder title `replace` (it was
  `deepseek-coordination` before the reset).
- `.gitattributes` was deleted, so line endings now follow `core.autocrlf` instead of the
  repository's previous explicit rules.
- `npm pack` would succeed but ship a package whose entry points do not exist.

## Repository history

Until commit `3ba4a45` (tag `v0.1.9`) this repository hosted **dsh-os**, a cross-platform
atomic OS-interaction surface for the DeepSeek Harness: one argument-stable verb set over
file, environment, task, service, system, permission, execute, window, screenshot, clipboard,
wait, mouse, keyboard, text and structure, implemented natively on Windows (PowerShell 5.1
and 7.6) and POSIX, each verb returning a single JSON envelope with byte-exact charset, BOM
and line-ending handling.

That tree — `src/host`, `src/plugin`, `src/permission`, `tests`, `tools`, `client.js`,
`cordis.patch.yml` — was removed from the branch tip in `87ddab9`. It is still fully
reachable in git history and remains tagged `v0.1.5` … `v0.1.9`:

```console
# Inspect the previous project without touching this checkout
$ git worktree add ../dsh-os v0.1.9

# Or restore selected directories into this checkout
$ git checkout 3ba4a45 -- src/host src/plugin src/permission tests tools
```

Per-release details for both eras are in [CHANGELOG.md](CHANGELOG.md).

## License

MIT © 2026 Eloy Kim. See [LICENSE](LICENSE).
