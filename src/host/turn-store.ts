import type {
  CommandType,
  Interaction,
  Profession,
  Scene,
  Validation,
} from "../shared/enum.js";
import type { Turn } from "../shared/entity.js";

export interface CreateTurnInput {
  handle: string;
  session: number;
  ordinal: number;
  command: CommandType;
  interaction: Interaction;
  scene: Scene;
  validation: Validation;
  profession: Profession;
  lockedAt: number;
  effort: string;
  created: number;
  prompt: { handle: string; content: string; created: number; media?: string };
  commandFace?: {
    handle: string;
    type: CommandType;
    content: string;
    created: number;
  };
  /** Rebuilds retain the prior iteration and incremented rebuild count. */
  iteration?: number;
  rebuild?: number;
}

export interface PromptSnapshot {
  content: string;
  media?: string;
}

export interface CommandSnapshot {
  type: CommandType;
  content: string;
}

export interface TurnStore {
  get(identity: number): Turn;
  list(session: number): Turn[];
  active(session: number): Turn | undefined;
  activeAll(): Turn[];
  maxOrdinal(session: number): number;
  count(session: number): number;
  prompt(identity: number): PromptSnapshot | undefined;
  latestCommand(turn: number): CommandSnapshot | undefined;
  create(input: CreateTurnInput): Turn;
  update(identity: number, patch: Record<string, unknown>): Turn;
}
