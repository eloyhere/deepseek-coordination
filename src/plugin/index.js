/**
 * dsh-os host plugin.
 *
 * Registers one model-facing tool, `dsh_os`, that runs a verb of the atomic OS-interaction surface
 * and returns its JSON envelope verbatim.
 *
 * One tool rather than one tool per verb, deliberately:
 *   * the verb table is the contract and it lives in spec/verbs.tsv, so the tool schema does not have
 *     to be regenerated every time a verb is added or renamed (the `environment attribute` rename cost
 *     four edits once already);
 *   * an agent discovers the surface in a single call (`verb: "selfcheck"`) instead of from a
 *     several-hundred-line tool list;
 *   * the envelope is already the stable, parseable result shape, so the tool adds no second
 *     contract that could drift from the script's.
 *
 * The implementation is spawned by absolute path with an argv array. It is never invoked through a
 * shell string: that is what makes a path containing spaces stay a single argument, and it is the
 * core reason this surface exists.
 */

import { join } from 'node:path'

import { resolveInvocation, runScript, searchedDirectory } from './invoke.js'

export const name = 'dsh-os'

/** The plugin is inert without the tool registry; the approval seam is optional and read at use time. */
export const inject = ['tools']

/**
 * Parse an envelope, or undefined when the text is not one.
 *
 * Used only to READ the error code of a refusal. A caller that cannot parse it gets the text back
 * unchanged, so a malformed envelope is never made worse by this.
 */
function parseEnvelope(text) {
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Ask the DSH approval seam for a one-shot decision on one call.
 *
 * A host plugin does NOT register an answerer to reach the user — the opposite is true. The Web
 * composition already ships `dsh-client-ui-approval`, which answers `approval/request` and renders the
 * banner ("tool X requests elevated execution" with Reject / Allow once). A plugin only has to ASK, and
 * the client renders it. That is why this file carries no UI code for the decision.
 *
 * Three facts about the seam shape the code below, all read from `@deepseek-ai/dsh-user-approval`:
 *
 *   * `request()` reads `req.agent.session`, so a call with no agent THROWS rather than being refused
 *     politely. The caller must not invoke it in that case, which is why `agent` is passed in and
 *     checked here rather than being trusted.
 *   * the only grant in the outcome vocabulary is `'allowed-once'`; `'rejected'`, `'cancelled'` and
 *     `'unavailable'` all mean "no". They are reported distinctly so the caller can say which happened.
 *   * a session whose policy is `never` resolves to `'rejected'` BEFORE the waterfall, so no prompt is
 *     ever rendered. That is a deployment setting, not a fault in this code, and the message says so.
 *
 * The seam is consumed opportunistically with `ctx.get('approval')`, the same way `dsh-tools` does it: a
 * deployment without the approval service keeps every verb that does not need a prompt.
 */
async function askApproval(ctx, { agent, callId, toolName, reason, displayReason, signal }) {
  const approval = typeof ctx.get === 'function' ? ctx.get('approval') : undefined
  if (approval === undefined) {
    return { granted: false, outcome: 'unavailable', detail: 'no approval service is loaded in this deployment' }
  }
  if (agent === undefined || agent === null) {
    return { granted: false, outcome: 'unavailable', detail: 'the call carries no agent, so there is no session to route an approval through' }
  }
  try {
    const outcome = await approval.request({ agent, toolName, ...callId === undefined ? {} : { callId }, reason, displayReason, signal })
    if (outcome === 'allowed-once') return { granted: true, outcome }
    return { granted: false, outcome, detail: outcome === 'rejected' ? 'the request was refused (a session policy of "never" refuses before any prompt is shown)' : undefined }
  } catch (error) {
    return { granted: false, outcome: 'unavailable', detail: error instanceof Error ? error.message : String(error) }
  }
}

export function apply(ctx, rawConfig) {
  // `?? {}` rather than a default parameter: Cordis passes a row's config as `null` when the row declares
  // none, and a default parameter only fires for `undefined`. Every entry point in this package guards the
  // same way, so a row whose config is trimmed degrades to defaults instead of failing to activate.
  const config = rawConfig ?? {}
  const timeoutMs = config.timeoutMs ?? 120000

  ctx.tools.register({
    name: 'dsh_os',
    description: [
      'Run one verb of the dsh-os atomic OS-interaction surface and return its JSON envelope.',
      'Use verb "selfcheck" first to list every verb with its arguments, flags and platform support.',
      'Arguments are passed as separate argv elements, so a value containing spaces stays one value;',
      'both the positional form (file create "./a.txt" "123" "utf-8-bom") and the named form',
      '(file create path="./a.txt" content="123") are accepted.',
      'Read-only verbs need no authorization; mutating verbs require allow: true.',
    ].join(' '),
    parameters: {
      // A COMPLETE JSON Schema, not the property map that `defineTool` accepts.
      //
      // The registry's `register()` takes a finished schema and does not compile one for you: only the
      // internal `defineTool` runs `parameterSchemaSpecToJsonSchema` over a { name: {...} } map. Passing
      // the bare map here ships a schema whose root has no `type`, and the provider rejects the whole
      // request with `schema must be a JSON Schema of 'type: "object"', got 'type: null'`.
      type: 'object',
      properties: {
        verb: {
          type: 'string',
          description: 'Verb to run, e.g. "selfcheck", "file charset", "environment attribute get".',
        },
        arguments: {
          type: 'array',
          items: { type: 'string' },
          description: 'Positional arguments and named arguments (name="value") in any order.',
        },
        flags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Flags, e.g. "--scope", "user", "--recursive". Prefix with -- exactly as documented.',
        },
        allow: {
          type: 'boolean',
          description: 'Authorization for a mutating verb. Required by create, delete, edit, execute, window, keyboard, clipboard, text, structure.',
        },
      },
      required: ['verb'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const invocation = resolveInvocation(config)
      if (invocation === null) {
        // The message names the directory that was actually searched, because the first version of
        // this code reported a plausible-looking path that was one level off and cost a debugging
        // round to find.
        const searched = searchedDirectory(config)
        throw new Error(
          `dsh-os has no entry point for platform "${process.platform}"; searched ${searched}` +
          ' (run tools/build.ps1 to generate it, or set the scriptPath config)',
        )
      }

      // The verb may be given as several words; the script resolves multi-word verbs itself, so it is
      // split here rather than guessed at.
      const baseArgs = [...String(args.verb).trim().split(/\s+/)]
      for (const value of args.arguments ?? []) baseArgs.push(String(value))
      for (const flag of args.flags ?? []) baseArgs.push(String(flag))

      const runOnce = (withAllow) => runScript(
        invocation,
        withAllow ? [...baseArgs, '--allow'] : baseArgs,
        timeoutMs,
        exec?.signal,
      )

      let result = await runOnce(args.allow === true)

      if (result.timedOut) {
        throw new Error(`dsh-os verb "${args.verb}" timed out after ${timeoutMs}ms`)
      }

      let text = result.stdout.trim()
      if (text === '') {
        // An empty stdout would leave the caller with nothing to parse, so the exit code and the
        // captured diagnostics are reported instead of an empty success.
        throw new Error(
          `dsh-os verb "${args.verb}" produced no envelope (exit ${result.code})` +
          (result.stderr.trim() ? `: ${result.stderr.trim()}` : ''),
        )
      }

      // A refusal that a user decision could actually resolve is turned into one, ONCE, in this same
      // call: mutating verbs answer `E_PERMISSION` when they arrive without `--allow`, so the user is
      // asked and the verb is retried with it. Asking is skipped when the request already carried
      // `--allow`, because then the refusal came from somewhere a prompt cannot change.
      if (args.allow !== true) {
        const refusal = parseEnvelope(text)
        if (refusal?.error?.code === 'E_PERMISSION') {
          const decision = await askApproval(ctx, {
            agent: exec?.agent,
            callId: exec?.callId,
            toolName: 'dsh_os',
            reason: `dsh-os verb "${args.verb}" needs authorization`,
            displayReason: {
              en: `dsh-os wants to run "${args.verb}", which changes something on this machine.`,
            },
            signal: exec?.signal,
          })
          if (decision.granted) {
            result = await runOnce(true)
            if (result.timedOut) {
              throw new Error(`dsh-os verb "${args.verb}" timed out after ${timeoutMs}ms after approval`)
            }
            text = result.stdout.trim()
          } else if (decision.outcome !== 'unavailable' || decision.detail !== undefined) {
            // Report the refusal as the typed envelope the caller already branches on, with the reason
            // attached — a bare "no" from a prompt that was never shown would be indistinguishable
            // from a verb that failed on its own.
            return JSON.stringify({
              ok: false,
              verb: refusal.verb ?? String(args.verb).trim().replace(/\s+/g, '.'),
              error: {
                code: 'E_PERMISSION',
                message: `"${args.verb}" was not authorized (approval: ${decision.outcome})`,
                ...decision.detail === undefined ? {} : { hint: decision.detail },
              },
              meta: { ...refusal.meta, approval: decision.outcome },
            })
          }
        }
      }

      if (text === '') {
        throw new Error(`dsh-os verb "${args.verb}" produced no envelope after approval (exit ${result.code})`)
      }

      // The envelope is returned verbatim, including when ok is false: a typed failure is a result the
      // caller must be able to read (error.code is authoritative), not an exception that loses it.
      return text
    },
  })
}
