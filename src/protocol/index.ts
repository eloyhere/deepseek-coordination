/**
 * AMP v0.1 protocol layer.
 *
 * A faithful, host-side port of `attention-manifest-protocol`, restricted to the
 * artifacts this plugin emits and verifies: primitives, canonical JSON, ids,
 * errors, the sealed A-surface envelope, the signed Manifest, the Frame
 * boundary, Receipts/Events, the Warrant derivation rules and the append-only
 * ledger with signed checkpoints.
 *
 * Rules for consumers inside this repository:
 *  - import from `../protocol/index.js`, never from a deep path;
 *  - never re-declare a protocol field locally (a second spelling of `tier` is
 *    how two subsystems silently disagree);
 *  - never author a `confidence` on a claim — call `deriveConfidence`;
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
