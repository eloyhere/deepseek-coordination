/**
 * The `coordination` SQLite database.
 *
 * The plugin owns this file; it never opens DSH's `harness` database. The
 * physical shape follows v23 搂17 for the tables the document spells out, and
 * extends the same conventions to the remaining v22 entities. SQLite triggers
 * are the second line of defence for the profession lock: even a caller that
 * bypasses the service cannot rewrite a locked profession.
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DatabaseError, NotFoundError } from '../shared/error.js'

export const SCHEMA_VERSION = 23

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS session (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  principal TEXT NOT NULL,
  sandbox TEXT NOT NULL,
  interaction TEXT NOT NULL,
  scene TEXT NOT NULL,
  validation TEXT NOT NULL,
  profile TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created INTEGER NOT NULL,
  ended INTEGER
);
CREATE INDEX IF NOT EXISTS idx_session_status ON session(status, created);

CREATE TABLE IF NOT EXISTS prompt (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  content TEXT NOT NULL,
  media TEXT,
  created INTEGER NOT NULL,
  FOREIGN KEY (turn) REFERENCES turn(identity)
);
CREATE INDEX IF NOT EXISTS idx_prompt_turn ON prompt(turn, created);

CREATE TABLE IF NOT EXISTS turn (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  session INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  prompt INTEGER,
  command TEXT NOT NULL DEFAULT 'none',
  comprehension INTEGER,
  organization INTEGER,
  plan INTEGER,
  goal INTEGER,
  compact INTEGER,
  interaction TEXT NOT NULL,
  scene TEXT NOT NULL,
  validation TEXT NOT NULL,
  profession TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0,
  lockedAt INTEGER,
  cognitive TEXT,
  effort TEXT NOT NULL DEFAULT 'medium',
  iteration INTEGER NOT NULL DEFAULT 1,
  rebuild INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created INTEGER NOT NULL,
  finished INTEGER,
  UNIQUE(session, ordinal),
  FOREIGN KEY (session) REFERENCES session(identity)
);
CREATE INDEX IF NOT EXISTS idx_turn_session ON turn(session, ordinal);
CREATE INDEX IF NOT EXISTS idx_turn_status ON turn(status, created);
CREATE INDEX IF NOT EXISTS idx_turn_command ON turn(command);
CREATE INDEX IF NOT EXISTS idx_turn_profession ON turn(profession, locked);

CREATE TRIGGER IF NOT EXISTS trg_turn_profession_lock
BEFORE UPDATE OF profession ON turn
FOR EACH ROW
WHEN OLD.locked = 1 AND NEW.profession != OLD.profession
BEGIN
  SELECT RAISE(ABORT, 'profession is locked; use rebuild or abandon');
END;

CREATE TRIGGER IF NOT EXISTS trg_turn_profession_unlock
BEFORE UPDATE OF locked ON turn
FOR EACH ROW
WHEN OLD.locked = 1 AND NEW.locked = 0
BEGIN
  SELECT RAISE(ABORT, 'profession lock cannot be removed');
END;

CREATE TABLE IF NOT EXISTS command (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  result TEXT,
  created INTEGER NOT NULL,
  finished INTEGER,
  FOREIGN KEY (turn) REFERENCES turn(identity)
);
CREATE INDEX IF NOT EXISTS idx_command_turn ON command(turn, created);

CREATE TABLE IF NOT EXISTS goal (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  session INTEGER NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  created INTEGER NOT NULL,
  changed INTEGER,
  FOREIGN KEY (turn) REFERENCES turn(identity),
  FOREIGN KEY (session) REFERENCES session(identity)
);
CREATE INDEX IF NOT EXISTS idx_goal_turn ON goal(turn, created);
CREATE INDEX IF NOT EXISTS idx_goal_session ON goal(session, status);

CREATE TABLE IF NOT EXISTS compact (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  session INTEGER NOT NULL,
  beforeContent TEXT NOT NULL,
  afterContent TEXT NOT NULL,
  beforeSize INTEGER NOT NULL,
  afterSize INTEGER NOT NULL,
  ratio REAL NOT NULL,
  strategy TEXT NOT NULL,
  reason TEXT,
  created INTEGER NOT NULL,
  FOREIGN KEY (turn) REFERENCES turn(identity),
  FOREIGN KEY (session) REFERENCES session(identity)
);
CREATE INDEX IF NOT EXISTS idx_compact_turn ON compact(turn, created);

CREATE TABLE IF NOT EXISTS plan (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  parent INTEGER,
  goal TEXT NOT NULL,
  approach TEXT NOT NULL,
  step TEXT NOT NULL,
  "constraint" TEXT NOT NULL,
  assumption TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  rebuild INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'auto',
  orchestration INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  finished INTEGER,
  FOREIGN KEY (turn) REFERENCES turn(identity),
  FOREIGN KEY (parent) REFERENCES plan(identity)
);
CREATE INDEX IF NOT EXISTS idx_plan_turn ON plan(turn, created);
CREATE INDEX IF NOT EXISTS idx_plan_status ON plan(status, created);

CREATE TABLE IF NOT EXISTS plan_rebuild (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  plan INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  reason TEXT NOT NULL,
  dimension TEXT NOT NULL,
  beforeScore TEXT NOT NULL,
  afterScore TEXT NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (plan) REFERENCES plan(identity)
);
CREATE INDEX IF NOT EXISTS idx_plan_rebuild_plan ON plan_rebuild(plan, attempt);

CREATE TABLE IF NOT EXISTS comprehension (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  prompt INTEGER NOT NULL,
  intent TEXT NOT NULL,
  requirement TEXT NOT NULL,
  "constraint" TEXT NOT NULL,
  assumption TEXT NOT NULL,
  ambiguity TEXT NOT NULL,
  confidence REAL NOT NULL,
  entropy REAL,
  emotion REAL,
  empathy TEXT,
  think TEXT,
  probe REAL,
  evidence TEXT,
  constraintIds TEXT,
  boundary TEXT,
  prospect TEXT,
  posterior TEXT,
  fusion TEXT,
  refusal REAL,
  route TEXT,
  failure TEXT,
  stageCount INTEGER NOT NULL DEFAULT 0,
  thinkTrace TEXT,
  model TEXT,
  created INTEGER NOT NULL,
  finished INTEGER,
  FOREIGN KEY (turn) REFERENCES turn(identity),
  FOREIGN KEY (prompt) REFERENCES prompt(identity)
);
CREATE INDEX IF NOT EXISTS idx_comprehension_turn ON comprehension(turn, created);

CREATE TABLE IF NOT EXISTS comprehension_stage (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  comprehension INTEGER NOT NULL,
  stage TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL,
  input TEXT,
  output TEXT,
  confidence REAL,
  entropyBefore REAL,
  entropyAfter REAL,
  created INTEGER NOT NULL,
  finished INTEGER,
  FOREIGN KEY (comprehension) REFERENCES comprehension(identity)
);
CREATE INDEX IF NOT EXISTS idx_stage_comprehension ON comprehension_stage(comprehension, ordinal);

CREATE TABLE IF NOT EXISTS organization (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  comprehension INTEGER NOT NULL,
  plan INTEGER NOT NULL,
  goal TEXT NOT NULL,
  approach TEXT NOT NULL,
  step TEXT NOT NULL,
  "constraint" TEXT NOT NULL,
  assumption TEXT NOT NULL,
  model TEXT,
  created INTEGER NOT NULL,
  finished INTEGER,
  FOREIGN KEY (turn) REFERENCES turn(identity),
  FOREIGN KEY (comprehension) REFERENCES comprehension(identity),
  FOREIGN KEY (plan) REFERENCES plan(identity)
);
CREATE INDEX IF NOT EXISTS idx_organization_turn ON organization(turn, created);

CREATE TABLE IF NOT EXISTS score (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL,
  target INTEGER NOT NULL,
  dimension TEXT NOT NULL,
  value REAL NOT NULL,
  reason TEXT,
  model TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_score_target ON score(category, target, created);

CREATE TABLE IF NOT EXISTS profession_record (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  subtask INTEGER,
  actor TEXT NOT NULL,
  profession TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0,
  lockedAt INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  input TEXT,
  output TEXT,
  reason TEXT,
  created INTEGER NOT NULL,
  finished INTEGER,
  FOREIGN KEY (turn) REFERENCES turn(identity),
  FOREIGN KEY (subtask) REFERENCES subtask(identity)
);
CREATE INDEX IF NOT EXISTS idx_profession_record_turn ON profession_record(turn);
CREATE INDEX IF NOT EXISTS idx_profession_record_subtask ON profession_record(subtask);
CREATE INDEX IF NOT EXISTS idx_profession_record_actor ON profession_record(actor, profession);

CREATE TRIGGER IF NOT EXISTS trg_profession_record_lock
BEFORE UPDATE OF profession ON profession_record
FOR EACH ROW
WHEN OLD.locked = 1 AND NEW.profession != OLD.profession
BEGIN
  SELECT RAISE(ABORT, 'profession is locked; use rebuild or abandon');
END;

CREATE TABLE IF NOT EXISTS subtask (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  parent INTEGER NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  task TEXT NOT NULL,
  tools TEXT,
  context TEXT,
  acceptance TEXT NOT NULL,
  groundTruth TEXT,
  profession TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0,
  lockedAt INTEGER,
  blockedBy TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  evidence TEXT,
  verdict TEXT,
  reason TEXT,
  recovery TEXT,
  rejectCount INTEGER NOT NULL DEFAULT 0,
  supersedes INTEGER,
  created INTEGER NOT NULL,
  finished INTEGER,
  FOREIGN KEY (parent) REFERENCES turn(identity),
  FOREIGN KEY (supersedes) REFERENCES subtask(identity)
);
CREATE INDEX IF NOT EXISTS idx_subtask_parent ON subtask(parent, status);
CREATE INDEX IF NOT EXISTS idx_subtask_status ON subtask(status, created);
CREATE INDEX IF NOT EXISTS idx_subtask_profession ON subtask(profession, locked);

CREATE TRIGGER IF NOT EXISTS trg_subtask_profession_lock
BEFORE UPDATE OF profession ON subtask
FOR EACH ROW
WHEN OLD.locked = 1 AND NEW.profession != OLD.profession
BEGIN
  SELECT RAISE(ABORT, 'profession is locked; use rebuild or abandon');
END;

CREATE TRIGGER IF NOT EXISTS trg_subtask_profession_unlock
BEFORE UPDATE OF locked ON subtask
FOR EACH ROW
WHEN OLD.locked = 1 AND NEW.locked = 0
BEGIN
  SELECT RAISE(ABORT, 'profession lock cannot be removed');
END;

CREATE TABLE IF NOT EXISTS orchestration_trace (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  event TEXT NOT NULL,
  subtask INTEGER,
  actor TEXT NOT NULL,
  profession TEXT,
  parentEvent INTEGER,
  detail TEXT NOT NULL,
  hash TEXT NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (turn) REFERENCES turn(identity),
  FOREIGN KEY (subtask) REFERENCES subtask(identity),
  FOREIGN KEY (parentEvent) REFERENCES orchestration_trace(identity)
);
CREATE INDEX IF NOT EXISTS idx_trace_turn ON orchestration_trace(turn, created);
CREATE INDEX IF NOT EXISTS idx_trace_subtask ON orchestration_trace(subtask, created);
CREATE INDEX IF NOT EXISTS idx_trace_event ON orchestration_trace(event, created);

CREATE TRIGGER IF NOT EXISTS trg_trace_immutable_update
BEFORE UPDATE ON orchestration_trace
BEGIN
  SELECT RAISE(ABORT, 'orchestration_trace is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_trace_immutable_delete
BEFORE DELETE ON orchestration_trace
BEGIN
  SELECT RAISE(ABORT, 'orchestration_trace is append-only');
END;

CREATE TABLE IF NOT EXISTS provider_view (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  route TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  live INTEGER NOT NULL,
  source TEXT NOT NULL,
  models TEXT NOT NULL,
  cacheStrategy TEXT,
  notes TEXT,
  observed INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cache_stat (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  session INTEGER UNIQUE NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  misses INTEGER NOT NULL DEFAULT 0,
  effortBreaks INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  changed INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS selection (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  session TEXT UNIQUE NOT NULL,
  profession TEXT NOT NULL,
  interaction TEXT NOT NULL,
  scene TEXT NOT NULL,
  validation TEXT NOT NULL,
  command TEXT NOT NULL,
  changed INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS takeover (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  session INTEGER,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created INTEGER NOT NULL,
  finished INTEGER
);
CREATE INDEX IF NOT EXISTS idx_takeover_status ON takeover(status, created);

CREATE TABLE IF NOT EXISTS permission (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  session INTEGER NOT NULL,
  subject TEXT NOT NULL,
  grant TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL,
  created INTEGER NOT NULL,
  finished INTEGER,
  FOREIGN KEY (session) REFERENCES session(identity)
);
CREATE INDEX IF NOT EXISTS idx_permission_session ON permission(session, status);

CREATE TABLE IF NOT EXISTS resource (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  session INTEGER NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  media TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  changed INTEGER NOT NULL,
  FOREIGN KEY (session) REFERENCES session(identity)
);
CREATE INDEX IF NOT EXISTS idx_resource_session ON resource(session, path);

CREATE TABLE IF NOT EXISTS version (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  resource INTEGER NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  author TEXT NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (resource) REFERENCES resource(identity)
);
CREATE INDEX IF NOT EXISTS idx_version_resource ON version(resource, version);

CREATE TABLE IF NOT EXISTS vision (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  session INTEGER NOT NULL,
  resource INTEGER NOT NULL,
  version INTEGER NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (session) REFERENCES session(identity),
  FOREIGN KEY (resource) REFERENCES resource(identity),
  FOREIGN KEY (version) REFERENCES version(identity)
);

CREATE TABLE IF NOT EXISTS lock (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  session INTEGER NOT NULL,
  subject TEXT NOT NULL,
  mode TEXT NOT NULL,
  lease INTEGER NOT NULL,
  heartbeat INTEGER NOT NULL,
  created INTEGER NOT NULL,
  ended INTEGER,
  FOREIGN KEY (session) REFERENCES session(identity)
);
CREATE INDEX IF NOT EXISTS idx_lock_subject ON lock(subject, ended);

CREATE TABLE IF NOT EXISTS request (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  session INTEGER NOT NULL,
  thread INTEGER,
  method TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  created INTEGER NOT NULL,
  finished INTEGER,
  FOREIGN KEY (session) REFERENCES session(identity)
);

CREATE TABLE IF NOT EXISTS thread (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  session INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  created INTEGER NOT NULL,
  ended INTEGER,
  FOREIGN KEY (session) REFERENCES session(identity)
);

CREATE TABLE IF NOT EXISTS result (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  request INTEGER NOT NULL,
  status TEXT NOT NULL,
  content TEXT NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (request) REFERENCES request(identity)
);

CREATE TABLE IF NOT EXISTS predict (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  plan INTEGER NOT NULL,
  step TEXT NOT NULL,
  content TEXT NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (turn) REFERENCES turn(identity),
  FOREIGN KEY (plan) REFERENCES plan(identity)
);

CREATE TABLE IF NOT EXISTS reality (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  predict INTEGER NOT NULL,
  content TEXT NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (turn) REFERENCES turn(identity),
  FOREIGN KEY (predict) REFERENCES predict(identity)
);

CREATE TABLE IF NOT EXISTS action (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  plan INTEGER NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  created INTEGER NOT NULL,
  finished INTEGER,
  FOREIGN KEY (turn) REFERENCES turn(identity),
  FOREIGN KEY (plan) REFERENCES plan(identity)
);

CREATE TABLE IF NOT EXISTS answer (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  content TEXT NOT NULL,
  validation TEXT NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (turn) REFERENCES turn(identity)
);
CREATE INDEX IF NOT EXISTS idx_answer_turn ON answer(turn, created);

CREATE TABLE IF NOT EXISTS question (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  content TEXT NOT NULL,
  answer TEXT,
  created INTEGER NOT NULL,
  finished INTEGER,
  FOREIGN KEY (turn) REFERENCES turn(identity)
);

CREATE TABLE IF NOT EXISTS choice (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  question INTEGER NOT NULL,
  option TEXT NOT NULL,
  selected INTEGER NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (turn) REFERENCES turn(identity),
  FOREIGN KEY (question) REFERENCES question(identity)
);

CREATE TABLE IF NOT EXISTS error (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  stack TEXT,
  created INTEGER NOT NULL,
  FOREIGN KEY (turn) REFERENCES turn(identity)
);

CREATE TABLE IF NOT EXISTS pattern (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,
  signature TEXT NOT NULL,
  content TEXT NOT NULL,
  weight REAL NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pattern_signature ON pattern(kind, signature);

CREATE TABLE IF NOT EXISTS calibration (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  model TEXT NOT NULL,
  dimension TEXT NOT NULL,
  predicted REAL NOT NULL,
  actual REAL NOT NULL,
  score REAL NOT NULL,
  created INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lesson (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  pattern INTEGER NOT NULL,
  content TEXT NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (pattern) REFERENCES pattern(identity)
);

CREATE TABLE IF NOT EXISTS rollback (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  error INTEGER NOT NULL,
  target TEXT NOT NULL,
  reason TEXT NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (error) REFERENCES error(identity)
);

CREATE TABLE IF NOT EXISTS emotion (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  label TEXT NOT NULL,
  intensity REAL NOT NULL,
  empathy TEXT,
  created INTEGER NOT NULL,
  FOREIGN KEY (turn) REFERENCES turn(identity)
);

CREATE TABLE IF NOT EXISTS companion (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  session INTEGER NOT NULL,
  emotion INTEGER NOT NULL,
  response TEXT NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (session) REFERENCES session(identity),
  FOREIGN KEY (emotion) REFERENCES emotion(identity)
);

CREATE TABLE IF NOT EXISTS crisis (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  severity TEXT NOT NULL,
  signal TEXT NOT NULL,
  action TEXT NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (turn) REFERENCES turn(identity)
);

CREATE TABLE IF NOT EXISTS probe (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  entropy REAL NOT NULL,
  question TEXT NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (turn) REFERENCES turn(identity)
);

CREATE TABLE IF NOT EXISTS cognition (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  stage TEXT NOT NULL,
  strategy TEXT NOT NULL,
  content TEXT NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (turn) REFERENCES turn(identity)
);

CREATE TABLE IF NOT EXISTS evidence (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  source TEXT NOT NULL,
  content TEXT NOT NULL,
  weight REAL NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (turn) REFERENCES turn(identity)
);

CREATE TABLE IF NOT EXISTS restriction (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  content TEXT NOT NULL,
  kind TEXT NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (turn) REFERENCES turn(identity)
);

CREATE TABLE IF NOT EXISTS gate (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (turn) REFERENCES turn(identity)
);

CREATE TABLE IF NOT EXISTS stopping (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  criterion TEXT NOT NULL,
  value REAL NOT NULL,
  reached INTEGER NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (turn) REFERENCES turn(identity)
);

CREATE TABLE IF NOT EXISTS prior (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  hypothesis TEXT NOT NULL,
  probability REAL NOT NULL,
  source TEXT NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (turn) REFERENCES turn(identity)
);

CREATE TABLE IF NOT EXISTS boundary (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  failureRoute INTEGER NOT NULL,
  content TEXT NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (turn) REFERENCES turn(identity),
  FOREIGN KEY (failureRoute) REFERENCES failure_route(identity)
);

CREATE TABLE IF NOT EXISTS prospect (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  route INTEGER NOT NULL,
  probability REAL NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (turn) REFERENCES turn(identity),
  FOREIGN KEY (route) REFERENCES route(identity)
);

CREATE TABLE IF NOT EXISTS posterior (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  hypothesis TEXT NOT NULL,
  probability REAL NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (turn) REFERENCES turn(identity)
);
CREATE INDEX IF NOT EXISTS idx_posterior_turn ON posterior(turn, hypothesis);

CREATE TABLE IF NOT EXISTS likelihood (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  evidence INTEGER NOT NULL,
  hypothesis TEXT NOT NULL,
  probability REAL NOT NULL,
  weight REAL NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (evidence) REFERENCES evidence(identity)
);

CREATE TABLE IF NOT EXISTS fusion (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  content TEXT NOT NULL,
  probability REAL NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (turn) REFERENCES turn(identity)
);

CREATE TABLE IF NOT EXISTS refusal (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (turn) REFERENCES turn(identity)
);

CREATE TABLE IF NOT EXISTS directive (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  created INTEGER NOT NULL,
  finished INTEGER,
  FOREIGN KEY (turn) REFERENCES turn(identity)
);

CREATE TABLE IF NOT EXISTS route (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  probability REAL NOT NULL,
  rank INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  FOREIGN KEY (turn) REFERENCES turn(identity)
);
CREATE INDEX IF NOT EXISTS idx_route_turn ON route(turn, rank);

CREATE TABLE IF NOT EXISTS failure_route (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  probability REAL NOT NULL,
  rank INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  FOREIGN KEY (turn) REFERENCES turn(identity)
);
CREATE INDEX IF NOT EXISTS idx_failure_route_turn ON failure_route(turn, rank);

CREATE TABLE IF NOT EXISTS mode_state (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  turn INTEGER NOT NULL,
  mode TEXT NOT NULL,
  content TEXT NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (turn) REFERENCES turn(identity)
);

CREATE TABLE IF NOT EXISTS history (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  session INTEGER NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (session) REFERENCES session(identity)
);
CREATE INDEX IF NOT EXISTS idx_history_session ON history(session, created);

CREATE TABLE IF NOT EXISTS global_posterior (
  identity INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT UNIQUE NOT NULL,
  hypothesis TEXT NOT NULL,
  probability REAL NOT NULL,
  scope TEXT NOT NULL,
  created INTEGER NOT NULL
);
`

export interface RunResult {
  changes: number
  lastInsertRowid: number
}

export type SqlValue = string | number | null | Uint8Array

/** Thin, typed wrapper over `node:sqlite` with JSON and Boolean coercion. */
export class CoordinationDatabase {
  readonly raw: DatabaseSync
  readonly path: string
  private depth = 0

  constructor(path: string) {
    this.path = path
    try {
      if (path !== ':memory:' && !path.startsWith('file:')) mkdirSync(dirname(path), { recursive: true })
      this.raw = new DatabaseSync(path)
      this.raw.exec('PRAGMA foreign_keys = ON;')
      this.raw.exec('PRAGMA busy_timeout = 5000;')
      if (path !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL;')
      this.raw.exec(SCHEMA_SQL)
      this.raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
    } catch (error) {
      throw new DatabaseError(`failed to open coordination database at ${path}`, error)
    }
  }

  /** Run a statement with positional parameters. */
  run(sql: string, ...params: unknown[]): RunResult {
    try {
      const result = this.raw.prepare(sql).run(...(params as SqlValue[]))
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
    } catch (error) {
      throw new DatabaseError(`SQL failed: ${firstLine(sql)}`, error)
    }
  }

  get<T>(sql: string, ...params: unknown[]): T | undefined {
    try {
      return this.raw.prepare(sql).get(...(params as SqlValue[])) as T | undefined
    } catch (error) {
      throw new DatabaseError(`SQL failed: ${firstLine(sql)}`, error)
    }
  }

  all<T>(sql: string, ...params: unknown[]): T[] {
    try {
      return this.raw.prepare(sql).all(...(params as SqlValue[])) as T[]
    } catch (error) {
      throw new DatabaseError(`SQL failed: ${firstLine(sql)}`, error)
    }
  }

  exec(sql: string): void {
    try {
      this.raw.exec(sql)
    } catch (error) {
      throw new DatabaseError(`SQL script failed: ${firstLine(sql)}`, error)
    }
  }

  /** Run `operation` inside one immediate transaction, rolling back on throw. */
  transaction<T>(operation: () => T): T {
    if (this.depth > 0) return operation()
    this.raw.exec('BEGIN IMMEDIATE;')
    this.depth += 1
    try {
      const value = operation()
      this.raw.exec('COMMIT;')
      return value
    } catch (error) {
      try {
        this.raw.exec('ROLLBACK;')
      } catch {
        // Preserve the original failure; a failed rollback would hide it.
      }
      throw error
    } finally {
      this.depth -= 1
    }
  }

  /** Insert one row and return its integer identity. */
  insert(table: string, values: Record<string, unknown>): number {
    const entries = Object.entries(values).filter(([, value]) => value !== undefined)
    if (entries.length === 0) throw new DatabaseError(`insert into ${table} has no columns`)
    const columns = entries.map(([column]) => quote(column)).join(', ')
    const placeholders = entries.map(() => '?').join(', ')
    const params = entries.map(([, value]) => encode(value))
    const result = this.run(`INSERT INTO ${quote(table)} (${columns}) VALUES (${placeholders})`, ...params)
    return result.lastInsertRowid
  }

  /** Update every supplied column of one row; returns the changed row count. */
  update(table: string, values: Record<string, unknown>, where: string, ...params: unknown[]): number {
    const entries = Object.entries(values).filter(([, value]) => value !== undefined)
    if (entries.length === 0) return 0
    const assignments = entries.map(([column]) => `${quote(column)} = ?`).join(', ')
    const encoded = entries.map(([, value]) => encode(value))
    return this.run(`UPDATE ${quote(table)} SET ${assignments} WHERE ${where}`, ...encoded, ...params).changes
  }

  /** Read one row by `identity`, or throw a domain NotFoundError. */
  require<T>(table: string, identity: number, kind = table): T {
    const row = this.get<T>(`SELECT * FROM ${quote(table)} WHERE identity = ?`, identity)
    if (row === undefined) throw new NotFoundError(kind, identity)
    return row
  }

  count(table: string, where = '1 = 1', ...params: unknown[]): number {
    const row = this.get<{ total: number }>(`SELECT COUNT(*) AS total FROM ${quote(table)} WHERE ${where}`, ...params)
    return Number(row?.total ?? 0)
  }

  close(): void {
    try {
      this.raw.close()
    } catch {
      // A second close is harmless during teardown.
    }
  }
}

/** Quote one SQLite identifier. */
export function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

/** Encode a JS value for SQLite: Boolean to 0/1, objects to JSON. */
export function encode(value: unknown): SqlValue {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value instanceof Uint8Array) return value
  return JSON.stringify(value)
}

/** Decode a JSON column, returning the fallback on malformed or absent data. */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/** SQLite stores booleans as integers. */
export function yes(value: unknown): boolean {
  return Number(value) === 1
}

/** First line of a SQL string, for compact diagnostics. */
function firstLine(sql: string): string {
  return sql.trim().split('\n', 1)[0]?.slice(0, 160) ?? ''
}

/** Resolve the coordination database file from config and the DSH home. */
export function resolveDatabasePath(configPath: string, databaseName: string): string {
  if (configPath.trim().length > 0) {
    return isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath)
  }
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, databaseName, `${databaseName}.db`)
}

/** Open the database and return it, closing on failure. */
export function openDatabase(path: string): CoordinationDatabase {
  return new CoordinationDatabase(path)
}

