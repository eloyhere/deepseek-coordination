/**
 * SQLite persistence for AMP artifacts.
 *
 * One table per artifact kind, all write-once:
 *  - `amp_object` is the hash chain (`seq`, `kind`, `digest`, `prev`, `body`, `at`);
 *  - `amp_key` is this installation's Ed25519 identity;
 *  - `amp_manifest` keeps every issued manifest;
 *  - `amp_checkpoint` keeps the signed chain of ledger tips.
 *
 * The protocol requires the chain to be verifiable *after the fact*, so `body`
 * stores canonical JSON text and `digest` is recomputed from the parsed value on
 * every read. A rewritten row therefore fails verification even if its stored
 * digest was edited too, because the link to the next `prev` no longer matches.
 *
 * Nothing here stores prompt text, file content or credentials: an AMP entry is
 * a pointer plus metadata (`Ref` is "a pointer, not a copy").
 */
import type { ChainEntry, EntryKind, LedgerSnapshot, LogEntry, SnapshotVerdict } from '../protocol/index.js'
import { GENESIS, canonical, digestOf, verifySnapshot } from '../protocol/index.js'
import type { CoordinationDatabase } from './database.js'

interface ObjectRow {
  seq: number
  kind: string
  digest: string
  prev: string
  body: string
  at: string
}

interface KeyRow {
  kid: string
  alg: string
  public_key: string
  private_key: string
  created: number
}

interface ManifestRow {
  digest: string
  kid: string
  issued: string
  expires: string
  body: string
}

interface CheckpointRow {
  seq: number
  tenant: string
  agent: string
  count: number
  tip: string
  prev: string | null
  issued: string
  kid: string
  sig: string
  body: string
}

export interface StoredKey {
  kid: string
  alg: string
  publicKey: string
  privateKey: string
  created: number
}

export interface StoredManifest {
  digest: string
  kid: string
  issued: string
  expires: string
  body: string
}

/**
 * The append-only AMP chain over the coordination database.
 *
 * `append` is synchronous and runs inside one SQLite transaction, so two
 * concurrent async callers cannot interleave a read of the tip with another
 * append: the sequence numbers stay contiguous without an in-process mutex.
 */
export class AmpStore {
  constructor(private readonly db: CoordinationDatabase) {}

  /** Number of chain entries. */
  count(): number {
    return Number(this.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM amp_object')?.count ?? 0)
  }

  /** Hash of the last entry, or genesis for an empty chain. */
  tip(): string {
    const row = this.db.get<{ digest: string }>(
      'SELECT digest FROM amp_object ORDER BY seq DESC LIMIT 1',
    )
    return row?.digest ?? GENESIS
  }

  /**
   * Appends one artifact and returns its chain entry.
   *
   * The payload is canonicalised before storage, and the digest covers
   * `{seq, kind, payload, prev}` exactly as the reference implementation does.
   */
  append(kind: EntryKind, payload: unknown, at = new Date().toISOString()): LogEntry {
    const body = canonical(payload)
    return this.db.transaction(() => {
      const seq = Number(
        this.db.get<{ next: number }>('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM amp_object')?.next ?? 0,
      )
      const prev = this.tip()
      const hash = digestOf({ seq, kind, payload, prev })
      this.db.run(
        'INSERT INTO amp_object (seq, kind, digest, prev, body, at) VALUES (?, ?, ?, ?, ?, ?)',
        seq,
        kind,
        hash,
        prev,
        body,
        at,
      )
      return { seq, kind, payload, prev, hash, at }
    })
  }

  /** Decoded chain entries in sequence order, oldest first. */
  entries(options: { limit?: number; kind?: EntryKind } = {}): ChainEntry[] {
    const limit = Math.max(0, Math.trunc(options.limit ?? 0))
    const rows =
      options.kind === undefined
        ? this.db.all<ObjectRow>('SELECT * FROM amp_object ORDER BY seq ASC')
        : this.db.all<ObjectRow>('SELECT * FROM amp_object WHERE kind = ? ORDER BY seq ASC', options.kind)
    const selected = limit > 0 ? rows.slice(Math.max(0, rows.length - limit)) : rows
    return selected.map((row) => ({
      seq: Number(row.seq),
      kind: row.kind as EntryKind,
      payload: JSON.parse(row.body) as unknown,
      prev: row.prev,
      hash: row.digest,
    }))
  }

  /** Artifacts of one kind, newest first, decoded. */
  recent(kind: EntryKind, limit = 50): unknown[] {
    const rows = this.db.all<ObjectRow>(
      'SELECT * FROM amp_object WHERE kind = ? ORDER BY seq DESC LIMIT ?',
      kind,
      Math.max(1, Math.trunc(limit)),
    )
    return rows.map((row) => JSON.parse(row.body) as unknown)
  }

  /** The full chain as a `LedgerSnapshot` the protocol verifier accepts. */
  snapshot(agent: string): LedgerSnapshot {
    const entries = this.entries()
    return {
      amp: '0.1',
      kind: 'ledger-snapshot',
      agent,
      tip: entries.at(-1)?.hash ?? GENESIS,
      count: entries.length,
      entries,
    }
  }

  /**
   * Recomputes the chain from storage.
   *
   * Each row is re-hashed from its parsed body, so a tampered `body`, a rewritten
   * `digest`, a deleted row (gap in `prev`) and a reordered row all fail here.
   */
  verify(): SnapshotVerdict {
    return verifySnapshot(this.snapshot('verification'))
  }

  /* ---- identity ---------------------------------------------------------- */

  key(): StoredKey | undefined {
    const row = this.db.get<KeyRow>('SELECT * FROM amp_key ORDER BY created ASC LIMIT 1')
    if (row === undefined) return undefined
    return {
      kid: row.kid,
      alg: row.alg,
      publicKey: row.public_key,
      privateKey: row.private_key,
      created: Number(row.created),
    }
  }

  saveKey(key: StoredKey): void {
    this.db.run(
      'INSERT INTO amp_key (kid, alg, public_key, private_key, created) VALUES (?, ?, ?, ?, ?)',
      key.kid,
      key.alg,
      key.publicKey,
      key.privateKey,
      key.created,
    )
  }

  /* ---- manifests --------------------------------------------------------- */

  latestManifest(): StoredManifest | undefined {
    const row = this.db.get<ManifestRow>('SELECT * FROM amp_manifest ORDER BY seq DESC LIMIT 1')
    if (row === undefined) return undefined
    return {
      digest: row.digest,
      kid: row.kid,
      issued: row.issued,
      expires: row.expires,
      body: row.body,
    }
  }

  saveManifest(manifest: { digest: string; issued: string; expires: string; signatures: readonly { kid: string }[] }, body: string): void {
    this.db.run(
      'INSERT INTO amp_manifest (digest, kid, issued, expires, body) VALUES (?, ?, ?, ?, ?)',
      manifest.digest,
      manifest.signatures[0]?.kid ?? '',
      manifest.issued,
      manifest.expires,
      body,
    )
  }

  /* ---- checkpoints ------------------------------------------------------- */

  latestCheckpoint(): CheckpointRow | undefined {
    const row = this.db.get<CheckpointRow>('SELECT * FROM amp_checkpoint ORDER BY seq DESC LIMIT 1')
    return row === undefined ? undefined : { ...row, seq: Number(row.seq), count: Number(row.count) }
  }

  saveCheckpoint(checkpoint: {
    amp: string
    kind: string
    tenant: string
    agent: string
    seq: number
    count: number
    tip: string
    prev?: string
    issued: string
    kid: string
    sig: string
  }): void {
    this.db.run(
      'INSERT INTO amp_checkpoint (seq, tenant, agent, count, tip, prev, issued, kid, sig, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      checkpoint.seq,
      checkpoint.tenant,
      checkpoint.agent,
      checkpoint.count,
      checkpoint.tip,
      checkpoint.prev ?? null,
      checkpoint.issued,
      checkpoint.kid,
      checkpoint.sig,
      canonical(checkpoint),
    )
  }
}
