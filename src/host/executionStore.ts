import type { Session } from "../shared/entity.js";

/** Persistence contract for the Execution aggregate. Values crossing the port are domain objects. */
export interface ExecutionStore {
  findByHandle(handle: string): Session | undefined;
  get(identity: number): Session;
  list(): Session[];
  create(session: Omit<Session, "identity">): Session;
  update(
    identity: number,
    patch: Partial<
      Pick<Session, "interaction" | "scene" | "validation" | "profile">
    >,
  ): void;
  reactivate(identity: number, generation: number): void;
  end(identity: number, ended: number): void;
  count(): number;
}
