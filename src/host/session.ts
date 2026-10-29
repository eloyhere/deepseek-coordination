/**
 * Coordination session records.
 *
 * A coordination session mirrors one live DSH session by its public id. The
 * DSH id is stored in `handle`, so a host restart can re-attach without
 * inventing a second identity. Business fields (interaction/scene/validation)
 * are owned here; DSH remains the authority for the live agent and its log.
 */
import type { CoordinationConfig } from "./config.js";
import type { Session } from "../shared/entity.js";
import type { Interaction, Scene, Validation } from "../shared/enum.js";
import { toInteraction, toScene, toValidation } from "../shared/enum.js";
import type { ExecutionStore } from "./execution-store.js";
import type { Clock } from "./handle.js";

export interface SessionMetadata extends Record<string, unknown> {
  cwd?: string;
  profile?: string;
  principal?: string;
  generation?: number;
}

export class SessionModule {
  private readonly store: ExecutionStore;
  private readonly config: CoordinationConfig;
  private readonly clock: Clock;

  constructor(store: ExecutionStore, config: CoordinationConfig, clock: Clock) {
    this.store = store;
    this.config = config;
    this.clock = clock;
  }

  /** Find the coordination record for a DSH session id, creating it once. */
  ensure(sessionId: string, metadata: SessionMetadata = {}): Session {
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      throw new Error("session id must be a non-empty string");
    }
    const existing = this.byHandle(sessionId);
    if (existing !== undefined) {
      if (existing.status === "ended") {
        this.store.reactivate(existing.identity, existing.generation + 1);
        return this.get(existing.identity);
      }
      return existing;
    }
    const created = this.clock.now();
    return this.store.create({
      handle: sessionId,
      principal:
        typeof metadata.principal === "string" ? metadata.principal : "local",
      sandbox: typeof metadata.cwd === "string" ? metadata.cwd : "",
      interaction: this.config.defaults.interaction,
      scene: this.config.defaults.scene,
      validation: this.config.defaults.validation,
      profile: typeof metadata.profile === "string" ? metadata.profile : "",
      generation:
        typeof metadata.generation === "number" ? metadata.generation : 1,
      status: "active",
      created,
    });
  }

  get(identity: number): Session {
    return this.store.get(identity);
  }

  byHandle(handle: string): Session | undefined {
    return this.store.findByHandle(handle);
  }

  list(): Session[] {
    return this.store.list();
  }

  update(
    identity: number,
    patch: Partial<
      Pick<Session, "interaction" | "scene" | "validation" | "profile">
    >,
  ): Session {
    this.store.get(identity);
    this.store.update(identity, patch);
    return this.get(identity);
  }

  end(identity: number): Session {
    this.store.get(identity);
    this.store.end(identity, this.clock.now());
    return this.get(identity);
  }

  /** Expose defaults for the selection module without importing config. */
  defaults(): {
    interaction: Interaction;
    scene: Scene;
    validation: Validation;
  } {
    return {
      interaction: toInteraction(this.config.defaults.interaction),
      scene: toScene(this.config.defaults.scene),
      validation: toValidation(this.config.defaults.validation),
    };
  }

  metrics(): number {
    return this.store.count();
  }
}
