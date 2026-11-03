/**
 * AMP v0.1 protocol layer.
 *
 * Host-specific compatibility artifacts retained beside the runtime dependency
 * `attention-manifest-protocol`: DSH takeover projections, local key serialization,
 * receipt/event builders and legacy test fixtures. Production protocol primitives
 * are imported directly from the npm package at their ownership boundaries.
 *
 * Rules for compatibility-layer consumers:
 *  - keep DSH-specific artifact builders here until the npm package exposes them;
 *  - production normative protocol operations must import from the npm package;
 *  - never author a `confidence` on a claim — derive it with AMP's warrant API;
 *  - never mutate a stored artifact — append a new one that cites the old.
 *
 * The layer is host-only: `sha256.ts` uses `node:crypto`, so importing this
 * barrel from `src/client` would break the browser bundle.
 */
export * from './types.js'
export * from './canonical.js'
export * from './ids.js'
export * from './errors.js'
export * from './envelope.js'
export * from './manifest.js'
export * from './frame.js'
export * from './receipt.js'
export * from './warrant.js'
export * from './social.js'
export * from './plan.js'
export * from './ledger.js'
