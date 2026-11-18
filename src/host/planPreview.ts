/**
 * Markdown preview of one intake-drafted plan.
 *
 * The plan dialog is the plugin's own surface: DSH's plan review belongs to the
 * DSH client, while this module produces the Markdown that the AMP client
 * renders through the same safe parser as the question dialogs (headings, task
 * lists, inline emphasis; raw HTML stays text). The builder is pure so the host
 * composition can call it without loading client code.
 */

export interface PlanPreviewInput {
  /** Short objective; it becomes the body heading. */
  readonly objective: string
  /** Short task titles, in execution order. */
  readonly tasks: readonly string[]
}

/** The preview is a dialog body, not the plan store: keep it small. */
const MAX_PREVIEW_TASKS = 12
const MAX_TASK_CHARS = 160
const MAX_OBJECTIVE_CHARS = 300

/** Collapse one task title to a single safe check-list line. */
function taskLine(task: string): string | undefined {
  const text = task.replace(/\s+/g, ' ').trim()
  return text.length === 0 ? undefined : text.slice(0, MAX_TASK_CHARS)
}

/**
 * Render the drafted plan as Markdown, or `undefined` when it has no task.
 *
 * The body is the objective as a heading plus one `- [ ]` line per task. The
 * dialog title carries the same objective, so the payload stays readable when
 * it is copied out of the dialog.
 */
export function planMarkdown(input: PlanPreviewInput): string | undefined {
  const objective = input.objective.replace(/\s+/g, ' ').trim().slice(0, MAX_OBJECTIVE_CHARS)
  const tasks = input.tasks
    .map(taskLine)
    .filter((line): line is string => line !== undefined)
    .slice(0, MAX_PREVIEW_TASKS)
  if (tasks.length === 0) return undefined
  const lines = objective.length === 0 ? [] : [`### ${objective}`, '']
  for (const task of tasks) lines.push(`- [ ] ${task}`)
  return lines.join('\n')
}

/** Dialog title for one preview; the notification bounds titles at 200 chars. */
export function planPreviewTitle(objective: string): string {
  const text = objective.replace(/\s+/g, ' ').trim()
  return (text.length === 0 ? 'Plan' : text).slice(0, 200)
}
