/**
 * Coordination session records.
 *
 * A coordination session mirrors one live DSH session by its public id. The
 * DSH id is stored in `handle`, so a host restart can re-attach without
 * inventing a second identity. Business fields (interaction/scene/validation)
 * are owned here; DSH remains the authority for the live agent and its log.
 */
import type { CoordinationConfig } from './config.js'
import type { CoordinationDatabase } from './database.js'
import type { ModuleHost } from './module.js'
import type { Session } from '../shared/entity.js'
import type { Interaction, Scene, Validation } from '../shared/enum.js'
import { mapTurn } from './row.js'
import type { Row } from './row.js'
import { toInteraction, toScene, toValidation } from '../shared/enum.js'

export interface SessionMetadata extends Record<string, unknown> {
  cwd?: string
  profile?: string
  principal?: string
  generation?: number
}

export class SessionModule {
  private readonly db: CoordinationDatabase
  private readonly config: CoordinationConfig
  private readonly host: ModuleHost

  constructor(host: ModuleHost) {
    this.host = host
    this.db = host.db
    this.config = host.config
  }

  /** Find the coordination record for a DSH session id, creating it once. */
  ensure(sessionId: string, metadata: SessionMetadata = {}): Session {
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      throw new Error('session id must be a non-empty string')
    }
    const existing = this.byHandle(sessionId)
    if (existing !== undefined) {
      if (existing.status === 'ended') {
        this.db.update(
          'session',
          { status: 'active', ended: null, generation: existing.generation + 1 },
          'identity = ?',
          existing.identity,
        )
        return this.get(existing.identity)
      }
      return existing
    }
    const created = this.host.clock.now()
    const identity = this.db.insert('session', {
      handle: sessionId,
      principal: typeof metadata.principal === 'string' ? metadata.principal : 'local',
      sandbox: typeof metadata.cwd === 'string' ? metadata.cwd : '',
      interaction: this.config.defaults.interaction,
      scene: this.config.defaults.scene,
      validation: this.config.defaults.validation,
      profile: typeof metadata.profile === 'string' ? metadata.profile : '',
      generation: typeof metadata.generation === 'number' ? metadata.generation : 1,
      status: 'active',
      created,
    })
    return this.get(identity)
  }

  get(identity: number): Session {
    return mapSession(this.db.require<Row>('session', identity, 'session'))
  }

  byHandle(handle: string): Session | undefined {
    const row = this.db.get<Row>('SELECT * FROM session WHERE handle = ?', handle)
    return row === undefined ? undefined : mapSession(row)
  }

  list(): Session[] {
    return this.db.all<Row>('SELECT * FROM session ORDER BY identity ASC').map(mapSession)
  }

  update(identity: number, patch: Partial<Pick<Session, 'interaction' | 'scene' | 'validation' | 'profile'>>): Session {
    this.get(identity)
    this.db.update(
      'session',
      {
        interaction: patch.interaction,
        scene: patch.scene,
        validation: patch.validation,
        profile: patch.profile,
      },
      'identity = ?',
      identity,
    )
    return this.get(identity)
  }

  end(identity: number): Session {
    this.get(identity)
    this.db.update('session', { status: 'ended', ended: this.host.clock.now() }, 'identity = ?', identity)
    return this.get(identity)
  }

  /** The latest active turn for one coordination session, if any. */
  activeTurn(identity: number): ReturnType<typeof mapTurn> | undefined {
    const row = this.db.get<Row>(
      `SELECT * FROM turn
       WHERE session = ? AND status NOT IN ('done', 'failed', 'cancelled', 'abandoned')
       ORDER BY identity DESC LIMIT 1`,
      identity,
    )
    return row === undefined ? undefined : mapTurn(row)
  }

  /** Expose defaults for the selection module without importing config. */
  defaults(): { interaction: Interaction; scene: Scene; validation: Validation } {
    return {
      interaction: toInteraction(this.config.defaults.interaction),
      scene: toScene(this.config.defaults.scene),
      validation: toValidation(this.config.defaults.validation),
    }
  }

  metrics(): number {
    return this.db.count('session')
  }
}

export function mapSession(row: Row): Session {
  return {
    identity: Number(row.identity),
    handle: String(row.handle),
    principal: String(row.principal),
    sandbox: String(row.sandbox),
    interaction: toInteraction(row.interaction),
    scene: toScene(row.scene),
    validation: toValidation(row.validation),
    profile: String(row.profile),
    generation: Number(row.generation),
    status: row.status === 'ended' ? 'ended' : 'active',
    created: Number(row.created),
    ...(row.ended === null || row.ended === undefined ? {} : { ended: Number(row.ended) }),
  }
}
