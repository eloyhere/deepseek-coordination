/**
 * Scoped control: the AMP 0.5.0 scoped-control surface over this plugin's data.
 *
 * AMP 0.5.0 adds eight canonical control tools that adjust registry metadata,
 * defaults, interaction settings and scenario settings across three scopes
 * (`global → workspace → session`), with host-bound identities, CAS versions,
 * `dryRun` and atomic batches. This module implements the same contract against
 * the coordination database so the plugin exposes one control surface to both
 * the agent and the panel, without pulling in AMP's own SQLite database or its
 * Elasticsearch dependency.
 *
 * Rules kept exactly as the reference implementation states them:
 *
 *  - **Inheritance**: an effective value comes from the most specific scope that
 *    has one; `reset` clears the local row and restores inheritance.
 *  - **CAS**: a write may carry `expectedVersion`; a mismatch is a typed
 *    `INVALID_STATE` conflict, never a silent overwrite. A first local write
 *    starts at version `0`.
 *  - **Deletion markers**: removing an entry inherited from a wider scope writes
 *    a tombstone in the narrower scope instead of resurrecting the wider value.
 *  - **Dry run**: `dryRun` validates and returns the version it would produce
 *    without writing.
 *  - **Metadata only**: registry values are JSON objects. Nothing executable,
 *    no tool schema, no policy is stored here.
 *
 * Every mutation runs inside one SQLite transaction, so a multi-row batch
 * (global settings applied to default plus existing sessions) rolls back whole.
 */
import type { CoordinationDatabase } from "./database.js";
import { encode, parseJson } from "./database.js";
import type { Clock } from "./handle.js";
import {
  CONTROL_MUTATING_ACTIONS,
  CONTROL_SCOPE_ORDER,
  normaliseControlMix,
  type ControlApplyTo,
  type ControlDefaultView,
  type ControlDomain,
  type ControlMutationResult,
  type ControlRecordView,
  type ControlRegistry,
  type ControlRegistryAction,
  type ControlScope,
  type ControlSettingAction,
  type ControlSettingView,
} from "../shared/control.js";
import { InvalidArgumentError, InvalidStateError, NotFoundError } from "../shared/error.js";

/** Scope identity for one control call: which workspace/session it acts for. */
export interface ControlIdentity {
  /** Workspace key (absolute root or host workspace id); empty disables the scope. */
  workspace?: string;
  /** Session key; empty disables the session scope. */
  session?: string;
}

/** Argument bag of one registry call. */
export interface ControlRegistryRequest {
  scope: ControlScope;
  registry: ControlRegistry;
  action: ControlRegistryAction;
  id?: string;
  key?: string;
  value?: unknown;
  targetId?: string;
  relation?: string;
  expectedVersion?: number;
  dryRun?: boolean;
}

/** Argument bag of one settings call. */
export interface ControlSettingRequest {
  scope: ControlScope;
  domain: ControlDomain;
  action: ControlSettingAction;
  /** Single selector (`mode` for interaction, `scenario` for scenario). */
  selector?: string;
  /** Weighted mix; mutually exclusive with `selector`. */
  mix?: unknown;
  /** Where a global/workspace write lands. */
  applyTo?: ControlApplyTo;
  expectedVersion?: number;
  dryRun?: boolean;
}

interface RecordRow {
  scope: string;
  scope_id: string;
  registry: string;
  id: string;
  value: string;
  version: number;
  deleted: number;
  created: number;
  updated: number;
}

interface DefaultRow {
  scope: string;
  scope_id: string;
  key: string;
  value: string;
  version: number;
  created: number;
  updated: number;
}

interface SettingRow {
  scope: string;
  scope_id: string;
  domain: string;
  value: string;
  version: number;
  created: number;
  updated: number;
}

/** The stored shape of one setting row (`value` column JSON). */
interface StoredSetting {
  selector?: string | null;
  mix?: Record<string, number> | null;
}

/** Order scopes from least to most specific. */
const SCOPES: readonly ControlScope[] = CONTROL_SCOPE_ORDER;

/** The scope id a call writes under; `global` has no identity. */
function scopeIdOf(scope: ControlScope, identity: ControlIdentity): string {
  if (scope === "global") return "";
  if (scope === "workspace") {
    const workspace = identity.workspace?.trim() ?? "";
    if (workspace.length === 0) {
      throw new InvalidArgumentError("workspace scope requires a resolved workspace identity");
    }
    return workspace;
  }
  const session = identity.session?.trim() ?? "";
  if (session.length === 0) {
    throw new InvalidArgumentError("session scope requires a session identity");
  }
  return session;
}

/** Read a required non-empty string argument. */
function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidArgumentError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

/** Read an optional non-negative integer CAS version. */
function optionalVersion(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new InvalidArgumentError("expectedVersion must be a non-negative integer");
  }
  return value;
}

/** Reject an unsupported scope/detail before any write happens. */
function assertScopeAvailable(scope: ControlScope, identity: ControlIdentity): string {
  return scopeIdOf(scope, identity);
}

/**
 * Scoped control store and service.
 *
 * One instance per coordination service; it borrows the long-lived database and
 * never closes it.
 */
export class ControlService {
  constructor(
    private readonly db: CoordinationDatabase,
    private readonly clock: Clock,
  ) {}

  /* ----------------------------------------------------------------------- *
   * Registry
   * ----------------------------------------------------------------------- */

  /**
   * Every effective record of one registry in one scope.
   *
   * Inheritance walks `global → workspace → session`; a tombstone in a narrower
   * scope removes the entry entirely, which is how a narrow scope deletes a
   * wider value without the wider row being touched.
   */
  listRegistry(
    registry: ControlRegistry,
    scope: ControlScope,
    identity: ControlIdentity,
  ): ControlRecordView[] {
    const chain = this.chain(scope, identity);
    const effective = new Map<string, ControlRecordView>();
    for (const entry of chain) {
      const rows = this.db.all<RecordRow>(
        "SELECT * FROM control_record WHERE scope = ? AND scope_id = ? AND registry = ? ORDER BY id",
        entry.scope,
        entry.id,
        registry,
      );
      for (const row of rows) {
        if (row.deleted === 1) {
          effective.delete(row.id);
          continue;
        }
        effective.set(row.id, this.recordView(row, registry, entry.scope));
      }
    }
    return [...effective.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  /** One effective record, or `undefined` when absent (or deleted). */
  getRecord(
    registry: ControlRegistry,
    id: string,
    scope: ControlScope,
    identity: ControlIdentity,
  ): ControlRecordView | undefined {
    return this.listRegistry(registry, scope, identity).find((record) => record.id === id);
  }

  /** Read every local row of one scope (used by the panel's scope editor). */
  localRegistry(
    registry: ControlRegistry,
    scope: ControlScope,
    identity: ControlIdentity,
  ): ControlRecordView[] {
    const id = assertScopeAvailable(scope, identity);
    return this.db
      .all<RecordRow>(
        "SELECT * FROM control_record WHERE scope = ? AND scope_id = ? AND registry = ? AND deleted = 0 ORDER BY id",
        scope,
        id,
        registry,
      )
      .map((row) => this.recordView(row, registry, scope));
  }

  /**
   * Execute one registry action.
   *
   * Mutating actions validate the CAS version and honour `dryRun`; a rejected
   * version is `INVALID_STATE` so the caller can retry with the value `get`
   * reported in `effectiveVersion`.
   */
  registry(
    request: ControlRegistryRequest,
    identity: ControlIdentity,
  ): ControlMutationResult | ControlRecordView[] | ControlRecordView | ControlDefaultView {
    const scopeId = assertScopeAvailable(request.scope, identity);
    const registry = request.registry;
    const action = request.action;

    if (action === "list") return this.listRegistry(registry, request.scope, identity);

    if (action === "get") {
      const id = requireText(request.id, "id");
      const record = this.getRecord(registry, id, request.scope, identity);
      if (record === undefined) throw new NotFoundError("control record", `${registry}:${id}`);
      return record;
    }

    if (action === "default_get") {
      const key = requireText(request.key, "key");
      const view = this.getDefault(key, request.scope, identity);
      if (view === undefined) throw new NotFoundError("control default", key);
      return view;
    }

    if (!CONTROL_MUTATING_ACTIONS.has(action)) {
      throw new InvalidArgumentError(`unsupported registry action: ${String(action)}`);
    }

    return this.db.transaction(() => {
      const now = this.clock.now();
      const expected = optionalVersion(request.expectedVersion);
      const dryRun = request.dryRun === true;

      if (action === "default_set") {
        const key = requireText(request.key, "key");
        if (request.value === undefined) throw new InvalidArgumentError("default_set requires value");
        const current = this.localDefault(key, request.scope, scopeId);
        this.assertVersion(expected, current?.version ?? 0, `default ${key}`);
        const version = (current?.version ?? 0) + 1;
        if (!dryRun) {
          this.writeDefault(request.scope, scopeId, key, request.value, version, now, current === undefined);
        }
        return this.mutation(action, request, version, dryRun, 0, request.value);
      }

      if (action === "default_reset") {
        const key = requireText(request.key, "key");
        const current = this.localDefault(key, request.scope, scopeId);
        if (current === undefined) throw new NotFoundError("control default", key);
        this.assertVersion(expected, current.version, `default ${key}`);
        if (!dryRun) this.db.run("DELETE FROM control_default WHERE scope = ? AND scope_id = ? AND key = ?", request.scope, scopeId, key);
        return this.mutation(action, request, 0, dryRun, 1);
      }

      const id = requireText(request.id, "id");

      // enable/disable are metadata toggles on an existing entry: the row stays,
      // so a disabled capability can be re-enabled without losing its value.
      if (action === "enable" || action === "disable") {
        const current = this.localRecord(registry, id, request.scope, scopeId);
        const effective = this.getRecord(registry, id, request.scope, identity);
        if (current === undefined && effective === undefined) {
          throw new NotFoundError("control record", `${registry}:${id}`);
        }
        const baseVersion = current?.version ?? effective?.effectiveVersion ?? 0;
        this.assertVersion(expected, baseVersion, `${registry}:${id}`);
        const version = baseVersion + 1;
        const base = effective?.value ?? (current === undefined ? {} : parseJson<Record<string, unknown>>(current.value, {}));
        const value = { ...base, enabled: action === "enable" };
        if (!dryRun) {
          this.writeRecord(registry, id, value, request.scope, scopeId, version, now, current === undefined);
        }
        return this.mutation(action, request, version, dryRun, 1, value);
      }

      if (action === "register" || action === "update") {
        if (typeof request.value !== "object" || request.value === null || Array.isArray(request.value)) {
          throw new InvalidArgumentError(`${action} requires a JSON object value`);
        }
        const current = this.localRecord(registry, id, request.scope, scopeId);
        const effective = this.getRecord(registry, id, request.scope, identity);
        const baseVersion = current?.version ?? effective?.effectiveVersion ?? 0;
        this.assertVersion(expected, baseVersion, `${registry}:${id}`);
        if (action === "update" && current === undefined && effective === undefined) {
          throw new NotFoundError("control record", `${registry}:${id}`);
        }
        const version = baseVersion + 1;
        if (!dryRun) {
          this.writeRecord(registry, id, request.value as Record<string, unknown>, request.scope, scopeId, version, now, current === undefined);
        }
        return this.mutation(action, request, version, dryRun, 0, request.value);
      }

      if (action === "remove") {
        const current = this.localRecord(registry, id, request.scope, scopeId);
        const effective = this.getRecord(registry, id, request.scope, identity);
        if (current === undefined && effective === undefined) {
          throw new NotFoundError("control record", `${registry}:${id}`);
        }
        this.assertVersion(expected, current?.version ?? effective?.effectiveVersion ?? 0, `${registry}:${id}`);
        const version = (current?.version ?? 0) + 1;
        if (!dryRun) {
          if (request.scope === "global") {
            this.db.run("DELETE FROM control_record WHERE scope = ? AND scope_id = ? AND registry = ? AND id = ?", request.scope, scopeId, registry, id);
          } else {
            // Tombstone: a wider scope must not resurrect the entry.
            this.writeRecord(registry, id, {}, request.scope, scopeId, version, now, current === undefined, true);
          }
        }
        return this.mutation(action, request, version, dryRun, 1);
      }

      // link / unlink: target belongs to the same registry.
      const targetId = requireText(request.targetId, "targetId");
      const relation = requireText(request.relation, "relation");
      const source = this.getRecord(registry, id, request.scope, identity);
      const target = this.getRecord(registry, targetId, request.scope, identity);
      if (source === undefined) throw new NotFoundError("control record", `${registry}:${id}`);
      if (target === undefined) throw new NotFoundError("control record", `${registry}:${targetId}`);
      this.assertVersion(expected, source.effectiveVersion, `${registry}:${id}`);
      const version = source.effectiveVersion + 1;
      if (!dryRun) {
        if (action === "link") {
          this.db.run(
            "INSERT OR REPLACE INTO control_link (scope, scope_id, registry, id, target_id, relation, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
            request.scope,
            scopeId,
            registry,
            id,
            targetId,
            relation,
            now,
          );
        } else {
          this.db.run(
            "DELETE FROM control_link WHERE scope = ? AND scope_id = ? AND registry = ? AND id = ? AND target_id = ? AND relation = ?",
            request.scope,
            scopeId,
            registry,
            id,
            targetId,
            relation,
          );
        }
      }
      return this.mutation(action, request, version, dryRun, 1);
    });
  }

  /** Links recorded for one record, narrow scope included. */
  links(registry: ControlRegistry, id: string, scope: ControlScope, identity: ControlIdentity): Array<{ targetId: string; relation: string; scope: ControlScope }> {
    const chain = this.chain(scope, identity);
    const seen = new Map<string, { targetId: string; relation: string; scope: ControlScope }>();
    for (const entry of chain) {
      const rows = this.db.all<{ target_id: string; relation: string }>(
        "SELECT target_id, relation FROM control_link WHERE scope = ? AND scope_id = ? AND registry = ? AND id = ? ORDER BY target_id",
        entry.scope,
        entry.id,
        registry,
        id,
      );
      for (const row of rows) {
        seen.set(`${row.relation}\u0000${row.target_id}`, { targetId: row.target_id, relation: row.relation, scope: entry.scope });
      }
    }
    return [...seen.values()];
  }

  /* ----------------------------------------------------------------------- *
   * Settings
   * ----------------------------------------------------------------------- */

  /** The effective interaction/scenario setting of one scope. */
  getSetting(
    domain: ControlDomain,
    scope: ControlScope,
    identity: ControlIdentity,
  ): ControlSettingView {
    const chain = this.chain(scope, identity);
    const plan: ControlSettingView["plan"] = [];
    let source: ControlScope | undefined;
    let selector: string | null = null;
    let mix: Record<string, number> | null = null;
    let version = 0;
    let effectiveVersion = 0;
    let updated = 0;
    const mixLayers: Array<Record<string, number> | null> = [];
    for (const entry of chain) {
      const row = this.db.get<SettingRow>(
        "SELECT * FROM control_setting WHERE scope = ? AND scope_id = ? AND domain = ?",
        entry.scope,
        entry.id,
        domain,
      );
      if (row === undefined) continue;
      const stored = parseJson<StoredSetting>(row.value, {});
      const rowSelector = typeof stored.selector === "string" ? stored.selector : null;
      const rowMix = stored.mix ?? null;
      plan.push({ scope: entry.scope, value: rowSelector, mix: rowMix, version: row.version });
      source = entry.scope;
      version = row.version;
      effectiveVersion = row.version;
      updated = row.updated;
      if (rowSelector !== null) selector = rowSelector;
      if (rowMix !== null) mix = rowMix;
      mixLayers.push(rowMix);
    }
    void mixLayers;
    return {
      scope,
      domain,
      value: selector,
      mix,
      effectiveMix: mix,
      source: source ?? "global",
      version,
      effectiveVersion,
      plan,
      updated,
    };
  }

  /** Set one setting; a selector and a mix are mutually exclusive. */
  setSetting(
    request: ControlSettingRequest,
    identity: ControlIdentity,
  ): ControlMutationResult {
    const scopeId = assertScopeAvailable(request.scope, identity);
    if (request.selector !== undefined && request.mix !== undefined) {
      throw new InvalidArgumentError("set accepts either a selector or a mix, not both");
    }
    if (request.selector === undefined && request.mix === undefined) {
      throw new InvalidArgumentError("set requires a selector or a mix");
    }
    const mix = request.mix === undefined ? null : normaliseControlMix(request.domain, request.mix);
    if (request.mix !== undefined && mix === undefined) {
      throw new InvalidArgumentError(
        `mix must be an object of ${request.domain} keys with finite non-negative weights and at least one positive weight`,
      );
    }
    const selector = request.selector ?? null;
    const expected = optionalVersion(request.expectedVersion);
    const dryRun = request.dryRun === true;
    const applyTo = request.applyTo ?? "defaults";
    if (request.scope === "session" && request.applyTo !== undefined) {
      throw new InvalidArgumentError("session settings do not accept applyTo");
    }
    const targets = request.scope === "session" ? ["session"] as const : applyingScopes(request.scope, applyTo, identity);

    return this.db.transaction(() => {
      const now = this.clock.now();
      let changed = 0;
      let version = 0;
      for (const target of targets) {
        const targetId = scopeIdOf(target, identity);
        const current = this.db.get<SettingRow>(
          "SELECT * FROM control_setting WHERE scope = ? AND scope_id = ? AND domain = ?",
          target,
          targetId,
          request.domain,
        );
        if (expected !== undefined && current !== undefined && current.version !== expected) {
          throw new InvalidStateError(
            `${request.domain} setting is at version ${current.version}, not ${expected}`,
            { domain: request.domain, scope: target, version: current.version, expected },
          );
        }
        version = (current?.version ?? 0) + 1;
        if (dryRun) continue;
        const body: StoredSetting = { selector, mix };
        if (current === undefined) {
          this.db.run(
            "INSERT INTO control_setting (scope, scope_id, domain, value, version, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
            target,
            targetId,
            request.domain,
            encode(body),
            version,
            now,
            now,
          );
        } else {
          this.db.run(
            "UPDATE control_setting SET value = ?, version = ?, updated = ? WHERE scope = ? AND scope_id = ? AND domain = ?",
            encode(body),
            version,
            now,
            target,
            targetId,
            request.domain,
          );
        }
        changed += 1;
      }
      return {
        ok: true as const,
        action: "set" as const,
        scope: request.scope,
        domain: request.domain,
        version,
        dryRun,
        changed,
        value: selector ?? mix,
      };
    });
  }

  /** Clear the local setting and restore inheritance. */
  resetSetting(
    request: ControlSettingRequest,
    identity: ControlIdentity,
  ): ControlMutationResult {
    const scopeId = assertScopeAvailable(request.scope, identity);
    const expected = optionalVersion(request.expectedVersion);
    const dryRun = request.dryRun === true;
    const applyTo = request.applyTo ?? "defaults";
    const targets = request.scope === "session" ? ["session"] as const : applyingScopes(request.scope, applyTo, identity);
    return this.db.transaction(() => {
      let changed = 0;
      for (const target of targets) {
        const targetId = scopeIdOf(target, identity);
        const current = this.db.get<SettingRow>(
          "SELECT * FROM control_setting WHERE scope = ? AND scope_id = ? AND domain = ?",
          target,
          targetId,
          request.domain,
        );
        if (current === undefined) continue;
        if (expected !== undefined && current.version !== expected) {
          throw new InvalidStateError(
            `${request.domain} setting is at version ${current.version}, not ${expected}`,
            { domain: request.domain, scope: target, version: current.version, expected },
          );
        }
        if (!dryRun) {
          this.db.run(
            "DELETE FROM control_setting WHERE scope = ? AND scope_id = ? AND domain = ?",
            target,
            targetId,
            request.domain,
          );
        }
        changed += 1;
      }
      return {
        ok: true as const,
        action: "reset" as const,
        scope: request.scope,
        domain: request.domain,
        version: 0,
        dryRun,
        changed,
      };
    });
  }

  /* ----------------------------------------------------------------------- *
   * Internals
   * ----------------------------------------------------------------------- */

  /** Scope rows from least to most specific, skipping scopes without identity. */
  private chain(scope: ControlScope, identity: ControlIdentity): Array<{ scope: ControlScope; id: string }> {
    const limit = SCOPES.indexOf(scope);
    const chain: Array<{ scope: ControlScope; id: string }> = [{ scope: "global", id: "" }];
    for (let index = 1; index <= (limit < 0 ? SCOPES.length - 1 : limit); index += 1) {
      const entry = SCOPES[index]!;
      const id = entry === "workspace" ? identity.workspace?.trim() ?? "" : identity.session?.trim() ?? "";
      if (id.length > 0) chain.push({ scope: entry, id });
    }
    return chain;
  }

  private recordView(row: RecordRow, registry: ControlRegistry, source: ControlScope): ControlRecordView {
    const value = parseJson<Record<string, unknown>>(row.value, {});
    return {
      scope: row.scope as ControlScope,
      registry,
      id: row.id,
      value,
      enabled: value.enabled !== false,
      version: row.version,
      effectiveVersion: row.version,
      source,
      ...(row.deleted === 1 ? { deleted: true } : {}),
      created: row.created,
      updated: row.updated,
    };
  }

  private localRecord(
    registry: ControlRegistry,
    id: string,
    scope: ControlScope,
    scopeId: string,
  ): RecordRow | undefined {
    return this.db.get<RecordRow>(
      "SELECT * FROM control_record WHERE scope = ? AND scope_id = ? AND registry = ? AND id = ?",
      scope,
      scopeId,
      registry,
      id,
    );
  }

  private writeRecord(
    registry: ControlRegistry,
    id: string,
    value: Record<string, unknown>,
    scope: ControlScope,
    scopeId: string,
    version: number,
    now: number,
    insert: boolean,
    deleted = false,
  ): void {
    if (insert) {
      this.db.run(
        "INSERT INTO control_record (scope, scope_id, registry, id, value, version, deleted, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        scope,
        scopeId,
        registry,
        id,
        encode(value),
        version,
        deleted ? 1 : 0,
        now,
        now,
      );
      return;
    }
    this.db.run(
      "UPDATE control_record SET value = ?, version = ?, deleted = ?, updated = ? WHERE scope = ? AND scope_id = ? AND registry = ? AND id = ?",
      encode(value),
      version,
      deleted ? 1 : 0,
      now,
      scope,
      scopeId,
      registry,
      id,
    );
  }

  private getDefault(
    key: string,
    scope: ControlScope,
    identity: ControlIdentity,
  ): ControlDefaultView | undefined {
    let found: ControlDefaultView | undefined;
    for (const entry of this.chain(scope, identity)) {
      const row = this.db.get<DefaultRow>(
        "SELECT * FROM control_default WHERE scope = ? AND scope_id = ? AND key = ?",
        entry.scope,
        entry.id,
        key,
      );
      if (row === undefined) continue;
      found = {
        scope,
        key,
        value: parseJson<unknown>(row.value, null),
        version: row.version,
        effectiveVersion: row.version,
        source: entry.scope,
        updated: row.updated,
      };
    }
    return found;
  }

  private localDefault(key: string, scope: ControlScope, scopeId: string): DefaultRow | undefined {
    return this.db.get<DefaultRow>(
      "SELECT * FROM control_default WHERE scope = ? AND scope_id = ? AND key = ?",
      scope,
      scopeId,
      key,
    );
  }

  private writeDefault(
    scope: ControlScope,
    scopeId: string,
    key: string,
    value: unknown,
    version: number,
    now: number,
    insert: boolean,
  ): void {
    if (insert) {
      this.db.run(
        "INSERT INTO control_default (scope, scope_id, key, value, version, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
        scope,
        scopeId,
        key,
        encode(value),
        version,
        now,
        now,
      );
      return;
    }
    this.db.run(
      "UPDATE control_default SET value = ?, version = ?, updated = ? WHERE scope = ? AND scope_id = ? AND key = ?",
      encode(value),
      version,
      now,
      scope,
      scopeId,
      key,
    );
  }

  private assertVersion(expected: number | undefined, actual: number, label: string): void {
    if (expected === undefined || expected === actual) return;
    throw new InvalidStateError(`${label} is at version ${actual}, not ${expected}`, {
      label,
      version: actual,
      expected,
    });
  }

  private mutation(
    action: ControlRegistryAction,
    request: ControlRegistryRequest,
    version: number,
    dryRun: boolean,
    changed: number,
    value?: unknown,
  ): ControlMutationResult {
    return {
      ok: true,
      action,
      scope: request.scope,
      registry: request.registry,
      ...(request.id === undefined ? {} : { id: request.id }),
      ...(request.key === undefined ? {} : { key: request.key }),
      version,
      dryRun,
      changed,
      ...(value === undefined ? {} : { value }),
    };
  }
}

/**
 * Which scope rows a global/workspace settings write touches.
 *
 * `defaults` writes only the addressed scope, `existing` writes the sessions the
 * host can see under it, and `all` does both in one transaction.
 */
function applyingScopes(
  scope: ControlScope,
  applyTo: ControlApplyTo,
  identity: ControlIdentity,
): readonly ControlScope[] {
  if (applyTo === "defaults") return [scope];
  if (scope === "session") return ["session"];
  // `existing`/`all`: the addressed scope plus the concrete sessions this host
  // knows about. A session row is addressed by its own identity, so without one
  // the batch is the addressed scope alone rather than an invented session.
  const sessions = identity.session?.trim() ?? "";
  if (sessions.length === 0) return [scope];
  return applyTo === "all" ? [scope, "session"] : ["session"];
}
