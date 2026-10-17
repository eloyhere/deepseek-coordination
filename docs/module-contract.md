# Module contract (v24 implementation)

This file is the working agreement for every coordination module. The design
document `docs/deepseek-coordination-v24.md` is authoritative for *behaviour*;
this file is authoritative for *boundaries*.

## Layering

```
src/shared/*      pure types, enums, copy, errors. No Node, no DSH, no React.
src/host/*        Node-side modules and the Cordis service. `node:sqlite` only.
src/client/*      React/MUI browser half. No Node APIs.
src/index.ts      Host plugin entry: composes ports, service, routes, hooks.
```

A module:

- imports `ModuleHost` from `./module.js`, entity/enum/error types from `../shared/`;
- never imports `@deepseek-ai/dsh-*` or `node:http`;
- never reaches into another module's private map — it calls the exported class;
- uses the synchronous database API inside `host.db.transaction(() => { ... })`
  when a change spans more than one row;
- writes every 职能 lock / rebuild / abandon / dispatch / submit / verify /
  recover / synthesize through `host.trace.append(...)`;
- throws the typed errors in `src/shared/error.ts`, never `Error` for domain
  failures;
- never invents a field name: use the entity field names exactly, all lower
  camel case without underscores (v23 §0).

The service layer (`src/host/coordination.ts`) is the only place that converts a
module's synchronous result to `Promise<T>` for `shared/service.ts`.

## Naming (v23 §0)

- Database tables/columns, entity fields, functions, variables: full English
  words, lower case (camel case in TypeScript), singular, no underscores.
- Classes, interfaces, global constants: PascalCase. No `MAX_THREADS`.
- Chinese copy lives only in `src/shared/enum.ts` (labels/hints) and
  `docs/`; modules and the UI never hard-code a second copy.

## Module host

`src/host/module.ts` defines `ModuleHost`:

```
db          CoordinationDatabase
config      resolved CoordinationConfig
handles     HandleGenerator
clock       Clock
events      CoordinationEventBus
trace       TraceWriter
llm?        LlmReadPort          (read-only DSH provider view)
goals?      GoalPort
compaction? CompactionPort
web?        WebSearchPort
agents?     AgentPort
sessions?   SessionPort
approval?   ApprovalPort
permissionPresets? PermissionPresetPort
sandboxPolicy?     SandboxPolicyPort
logger?     LoggerPort
```

A module must tolerate every optional port being absent (tests omit them) and
raise `NotImplementedError` or fall back to a deterministic local behaviour —
never silently fake a DSH capability.

## Tests

Every module ships `test/<module>.test.mjs` runnable with `node --test` and Node
24 (`node:sqlite` is built in). Build a test host with:

```js
import { openDatabase } from '../lib-test/host/database.js'
```

The project compiles with `node_modules/typescript/bin/tsc`; tests import the
TypeScript source through `tsx`? No — this repository has no runtime TS loader.
The build (`npm run build`) emits only two bundles. For tests, either:

1. test the compiled host bundle through a small dynamic import (preferred for
   integration tests), or
2. write `test/<module>.test.mjs` as a pure-JS fixture that exercises the same
   SQL/schema contract, and leave unit coverage to typecheck.

Do not add a new test framework. Do not modify `package.json` scripts unless the
task says so.

## Selection wiring (the current milestone)

The five composer dropdowns write one `Selection` row per DSH session
(`selection` table, keyed by the DSH session id string). The host exposes:

```
GET  /deepseek-coordination/selection?session=<id>  -> SelectionState
POST /deepseek-coordination/selection                -> SelectionState
     body { session, patch: SelectionPatch }
GET  /deepseek-coordination/presets                  -> PermissionPresetView[]
POST /deepseek-coordination/permission               -> { preset }
     body { session, preset }
```

`SelectionState` and `SelectionPatch` are defined in `src/shared/selection.ts`.
When the session has an active turn, `SelectionState.locked` is true and a
profession change is refused with `ProfessionLockedError`.

On each DSH step the host hook records one coordination `Turn` for the current
DSH turn, with `profession` locked and the selected interaction/scene/validation.
A terminal DSH turn closes the coordination turn and unlocks the profession
dropdown for the next turn.
