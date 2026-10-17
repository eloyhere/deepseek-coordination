/**
 * The Client ↔ Host selection wire contract (v23 §6, §15.1).
 *
 * The five composer dropdowns never touch the database directly: they read and
 * write one `SelectionState` through the host's HTTP route. The host projects
 * the persisted `Selection`, the lock state of the session's active turn, and
 * DSH's live permission-preset catalog into this single shape.
 */
import type { Selection, Turn } from './entity.js'
import type { ControlName, SandboxMode } from './enum.js'

/** One DSH permission preset, projected for the dropdown. */
export interface PermissionPresetView {
  /** Preset key accepted by `POST /selection` and `POST /permission`. */
  value: string
  /** Human label, exactly as DSH's own access-mode menu shows it. */
  name: string
  description?: string
  /** Effective sandbox mode of the preset, when DSH exposes it. */
  sandbox?: SandboxMode | string
  /** Effective approval policy of the preset, when DSH exposes it. */
  approval?: string
}

/** The active turn, reduced to the fields the composer needs. */
export interface SelectionLockView {
  identity: number
  handle: string
  ordinal: number
  status: string
  profession: Turn['profession']
  locked: boolean
}

/** Everything the composer needs to render one session's five dropdowns. */
export interface SelectionState {
  /** DSH session id; the coordination selection is keyed by this string. */
  session: string
  /** The persisted choice for the next turn. */
  selection: Selection
  /** True while the session has a non-terminal turn: profession is read-only. */
  locked: boolean
  /** The turn that holds the lock, when there is one. */
  turn?: SelectionLockView
  /** DSH's live permission presets; empty when the host exposes none. */
  presets: PermissionPresetView[]
  /** The preset currently in force for the session, when known. */
  preset?: string
  /** The deployment default sandbox mode, used to explain an empty catalog. */
  defaultMode?: string
  /** Host config: whether the tooltip copy should be shown at all. */
  tooltip: boolean
}

/** Fields the composer may patch. Absent fields keep their stored value. */
export interface SelectionPatch {
  profession?: Selection['profession']
  interaction?: Selection['interaction']
  scene?: Selection['scene']
  validation?: Selection['validation']
  command?: Selection['command']
  /** DSH permission preset key; applied through `permissionPresets.set`. */
  preset?: string
}

/** Runtime description of one dropdown, used by docs and copy audits. */
export interface ControlDescriptor {
  name: ControlName
  label: string
  hint: string
  options: ReadonlyArray<{ value: string; label: string; hint: string }>
}
