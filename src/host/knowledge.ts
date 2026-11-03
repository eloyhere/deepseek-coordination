/**
 * Knowledge files: explicit, user- or agent-declared "this file is knowledge".
 *
 * A workspace is mostly *source*; a few files are *knowledge* — a specification,
 * a design note, a runbook. Indexing alone cannot tell them apart, so this
 * module records that intent explicitly instead of inferring it from a path or
 * an extension.
 *
 * Rules:
 *
 *  - **Explicit only**: an entry exists because a user action or an agent tool
 *    wrote it. Nothing is marked automatically.
 *  - **Workspace-relative**: the path is the same normalised path the graph
 *    uses, so a knowledge entry joins the outline and preview without a second
 *    path grammar.
 *  - **Scoped**: `session` marks stay inside one session; `workspace` marks are
 *    visible to every session working in that workspace.
 *  - **Metadata only**: a title, a note and tags. The file body is never copied
 *    here — it stays in the file and reaches the model through the normal read
 *    path.
 *  - **One write path**: marking also publishes a `knowledge` registry record
 *    (see `control.ts`) so the AMP control surface and the panel cannot
 *    disagree.
 */
import type { ControlService } from "./control.js";
import type { CoordinationDatabase } from "./database.js";
import { encode } from "./database.js";
import type { Clock } from "./handle.js";
import type { ControlScope } from "../shared/control.js";
import { InvalidArgumentError, NotFoundError } from "../shared/error.js";

/** Maximum entries echoed by one listing. */
export const MAX_KNOWLEDGE_ENTRIES = 500;
/** Maximum tags stored on one entry. */
export const MAX_KNOWLEDGE_TAGS = 16;
/** Maximum characters of one tag. */
export const MAX_KNOWLEDGE_TAG_CHARS = 64;
/** Maximum characters of a title. */
export const MAX_KNOWLEDGE_TITLE_CHARS = 200;
/** Maximum characters of a note. */
export const MAX_KNOWLEDGE_NOTE_CHARS = 2_000;

/** One knowledge file as the routes, tools and panel see it. */
export interface KnowledgeEntry {
  path: string;
  title: string;
  note: string;
  tags: string[];
  scope: ControlScope;
  created: number;
  updated: number;
}

/** Identity a knowledge call acts for. */
export interface KnowledgeIdentity {
  workspace?: string;
  session?: string;
}

interface KnowledgeRow {
  scope: string;
  scope_id: string;
  path: string;
  title: string;
  note: string;
  tags: string;
  created: number;
  updated: number;
}

/** Normalise one tag list: trimmed, bounded, de-duplicated, order preserved. */
function normaliseTags(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const tags: string[] = []
  for (const value of raw) {
    if (typeof value !== "string") return undefined;
    const tag = value.trim().slice(0, MAX_KNOWLEDGE_TAG_CHARS)
    if (tag.length === 0 || tags.includes(tag)) continue
    if (tags.length >= MAX_KNOWLEDGE_TAGS) break
    tags.push(tag)
  }
  return tags
}

/** Read one optional bounded text field. */
function optionalText(raw: unknown, limit: number, name: string): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== "string") throw new InvalidArgumentError(`${name} must be a string`)
  return raw.trim().slice(0, limit)
}

/** Resolve the scope id a knowledge write targets. */
function scopeIdOf(scope: ControlScope, identity: KnowledgeIdentity): string {
  if (scope === "workspace") {
    const workspace = identity.workspace?.trim() ?? ""
    if (workspace.length === 0) {
      throw new InvalidArgumentError("workspace knowledge entries require a resolved workspace identity")
    }
    return workspace
  }
  if (scope === "session") {
    const session = identity.session?.trim() ?? ""
    if (session.length === 0) {
      throw new InvalidArgumentError("session knowledge entries require a session identity")
    }
    return session
  }
  return ""
}

/**
 * The knowledge-file store.
 *
 * `control` is optional: a profile that only wants the file registry can omit
 * it, and the AMP-facing projection is then simply absent.
 */
export class KnowledgeService {
  constructor(
    private readonly db: CoordinationDatabase,
    private readonly clock: Clock,
    private readonly control?: ControlService,
  ) {}

  /**
   * List knowledge entries visible to `identity`.
   *
   * Session entries are listed after workspace entries, so a session note wins
   * in the caller's `Map` when both address the same path.
   */
  list(identity: KnowledgeIdentity, limit = MAX_KNOWLEDGE_ENTRIES): KnowledgeEntry[] {
    const rows = this.db.all<KnowledgeRow>(
      `SELECT * FROM knowledge_file
       WHERE (scope = 'workspace' AND scope_id = ?) OR (scope = 'session' AND scope_id = ?)
       ORDER BY updated DESC, path`,
      identity.workspace?.trim() ?? "",
      identity.session?.trim() ?? "",
    )
    const byPath = new Map<string, KnowledgeEntry>()
    for (const row of rows) byPath.set(row.path, this.view(row))
    return [...byPath.values()].slice(0, Math.max(0, limit))
  }

  /** One entry visible to `identity`, or `undefined`. */
  get(path: string, identity: KnowledgeIdentity): KnowledgeEntry | undefined {
    return this.list(identity).find((entry) => entry.path === path)
  }

  /** Is this path a knowledge file for `identity`? */
  has(path: string, identity: KnowledgeIdentity): boolean {
    return this.get(path, identity) !== undefined
  }

  /**
   * Mark a file as knowledge, or update an existing mark.
   *
   * The write is idempotent per `(scope, path)`: marking twice updates instead of
   * duplicating. `control` receives the matching `knowledge` registry record in
   * the same transaction so both surfaces change together.
   */
  mark(
    path: string,
    patch: { title?: unknown; note?: unknown; tags?: unknown },
    identity: KnowledgeIdentity,
    scope: ControlScope = "workspace",
  ): KnowledgeEntry {
    const target = path.trim()
    if (target.length === 0) throw new InvalidArgumentError("path must be a non-empty workspace-relative path")
    const scopeId = scopeIdOf(scope, identity)
    const title = optionalText(patch.title, MAX_KNOWLEDGE_TITLE_CHARS, "title")
    const note = optionalText(patch.note, MAX_KNOWLEDGE_NOTE_CHARS, "note")
    const tags = normaliseTags(patch.tags)
    if (tags === undefined && patch.tags !== undefined) {
      throw new InvalidArgumentError("tags must be an array of strings")
    }
    const now = this.clock.now()
    return this.db.transaction(() => {
      const existing = this.db.get<KnowledgeRow>(
        "SELECT * FROM knowledge_file WHERE scope = ? AND scope_id = ? AND path = ?",
        scope,
        scopeId,
        target,
      )
      const next: KnowledgeEntry = {
        path: target,
        title: title ?? existing?.title ?? target,
        note: note ?? existing?.note ?? "",
        tags: tags ?? (existing === undefined ? [] : parseTags(existing.tags)),
        scope,
        created: existing?.created ?? now,
        updated: now,
      }
      if (existing === undefined) {
        this.db.run(
          "INSERT INTO knowledge_file (scope, scope_id, path, title, note, tags, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          scope,
          scopeId,
          target,
          next.title,
          next.note,
          encode(next.tags),
          next.created,
          now,
        )
      } else {
        this.db.run(
          "UPDATE knowledge_file SET title = ?, note = ?, tags = ?, updated = ? WHERE scope = ? AND scope_id = ? AND path = ?",
          next.title,
          next.note,
          encode(next.tags),
          now,
          scope,
          scopeId,
          target,
        )
      }
      this.publish(next, identity, scope)
      return next
    })
  }

  /** Remove a mark. Returns the removed entry, or throws `NOT_FOUND`. */
  unmark(path: string, identity: KnowledgeIdentity, scope: ControlScope = "workspace"): KnowledgeEntry {
    const scopeId = scopeIdOf(scope, identity)
    const current = this.db.get<KnowledgeRow>(
      "SELECT * FROM knowledge_file WHERE scope = ? AND scope_id = ? AND path = ?",
      scope,
      scopeId,
      path.trim(),
    )
    if (current === undefined) throw new NotFoundError("knowledge file", path)
    this.db.transaction(() => {
      this.db.run(
        "DELETE FROM knowledge_file WHERE scope = ? AND scope_id = ? AND path = ?",
        scope,
        scopeId,
        path.trim(),
      )
      // Drop the mirrored registry record; a wider-scope mark would otherwise
      // stay visible after the file was explicitly unmarked here.
      try {
        this.control?.registry(
          { scope, registry: "knowledge", action: "remove", id: path.trim() },
          { workspace: identity.workspace, session: identity.session },
        )
      } catch {
        // The file row is already gone; a missing projection is not a failure.
      }
    })
    return this.view(current)
  }

  /** Bounded digest for prompt context: path + title only, never a body. */
  brief(identity: KnowledgeIdentity, limit = 20): string[] {
    return this.list(identity, limit).map((entry) =>
      entry.title === entry.path ? entry.path : `${entry.path} — ${entry.title}`,
    )
  }

  private publish(entry: KnowledgeEntry, identity: KnowledgeIdentity, scope: ControlScope): void {
    if (this.control === undefined) return
    const value = {
      kind: "file",
      title: entry.title,
      note: entry.note,
      tags: entry.tags,
    }
    try {
      const existing = this.control.getRecord("knowledge", entry.path, scope, {
        workspace: identity.workspace,
        session: identity.session,
      })
      this.control.registry(
        existing === undefined
          ? { scope, registry: "knowledge", action: "register", id: entry.path, value }
          : { scope, registry: "knowledge", action: "update", id: entry.path, value },
        { workspace: identity.workspace, session: identity.session },
      )
    } catch {
      // The projection is derived data; a failed mirror never undoes the mark.
    }
  }

  private view(row: KnowledgeRow): KnowledgeEntry {
    return {
      path: row.path,
      title: row.title,
      note: row.note,
      tags: parseTags(row.tags),
      scope: row.scope === "session" ? "session" : "workspace",
      created: row.created,
      updated: row.updated,
    }
  }
}

/** Decode the stored tag list defensively. */
function parseTags(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}
