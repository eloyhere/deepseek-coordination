/** AMP question lifecycle (0.14.0): durable clarification/decision requests. */
import { randomUUID } from 'node:crypto'
import {
  QUESTION_STATES,
  askQuestion,
  createQuestion,
  createStoreQuestionStore,
} from 'attention-manifest-protocol/question'
import type { QuestionKind, QuestionOption, QuestionState } from 'attention-manifest-protocol/question'
import { AMP_PREFIX } from '../names.js'
import type { AmpHost } from '../amp.js'
import { entityId, failure, ok, page, sessionOf } from './shared.js'
import type { HandlerMap, Params } from './shared.js'

const ACTOR = 'dsh-question'
const KINDS: readonly QuestionKind[] = ['clarification', 'decision', 'confirmation']

function key(module: string, verb: string): string {
  return `${AMP_PREFIX}_${module}.${verb}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function kindOf(value: unknown): QuestionKind | undefined {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value) ? value as QuestionKind : undefined
}

function stateOf(value: unknown): QuestionState | undefined {
  return typeof value === 'string' && (QUESTION_STATES as readonly string[]).includes(value) ? value as QuestionState : undefined
}

/** Parse declared options, dropping malformed entries instead of failing the call. */
function optionsOf(value: unknown): QuestionOption[] | undefined {
  if (!Array.isArray(value)) return undefined
  const options: QuestionOption[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as Record<string, unknown>
    if (typeof record.id !== 'string' || record.id.length === 0) continue
    if (typeof record.label !== 'string' || record.label.length === 0) continue
    options.push({ id: record.id, label: record.label })
  }
  return options
}

/**
 * Question verbs.
 *
 * AMP 0.14.0 ships the pure lifecycle plus `createStoreQuestionStore`, which
 * persists `EntityKind: "question"` through the kernel store the plugin already
 * owns. `open` creates and asks in one host decision (the model asked), which
 * matches the verb summary: "the host decides when to ask it".
 */
export function questionHandlers(host: AmpHost): HandlerMap {
  return {
    [key('question', 'get')]: (parameters: Params) => {
      const id = entityId(parameters)
      if (id === undefined) return failure('invalid_parameters', 'id is required')
      try {
        const question = createStoreQuestionStore(host.kernel().store).get(id)
        return question === undefined ? failure('not_found', `question ${id} was not found`) : ok(question)
      } catch (error) {
        return failure('invalid_state', messageOf(error))
      }
    },

    [key('question', 'list')]: (parameters: Params) => {
      const sessionId = entityId(parameters, 'sessionId') ?? sessionOf(host)
      const intentId = entityId(parameters, 'intentId')
      const state = stateOf(parameters.state)
      try {
        const rows = createStoreQuestionStore(host.kernel().store).list({
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(intentId === undefined ? {} : { intentId }),
          ...(state === undefined ? {} : { state }),
        })
        return ok(page(rows, parameters))
      } catch (error) {
        return failure('invalid_state', messageOf(error))
      }
    },

    [key('question', 'open')]: (parameters: Params) => {
      const sessionId = entityId(parameters, 'sessionId') ?? sessionOf(host)
      if (sessionId === undefined) return failure('invalid_parameters', 'sessionId is required')
      const prompt = typeof parameters.prompt === 'string' ? parameters.prompt.trim() : ''
      if (prompt.length === 0) return failure('invalid_parameters', 'prompt is required')
      const now = new Date().toISOString()
      const kind = kindOf(parameters.kind) ?? 'clarification'
      const options = optionsOf(parameters.options)
      const intentId = entityId(parameters, 'intentId')
      const turnId = entityId(parameters, 'turnId')
      const rationale = typeof parameters.rationale === 'string' && parameters.rationale.trim().length > 0
        ? parameters.rationale.trim()
        : undefined
      const expiresAt = typeof parameters.expiresAt === 'string' && Number.isFinite(Date.parse(parameters.expiresAt))
        ? parameters.expiresAt
        : undefined
      try {
        const created = createQuestion({
          id: `dsh:question:${sessionId}:${randomUUID()}`,
          sessionId,
          ...(intentId === undefined ? {} : { intentId }),
          ...(turnId === undefined ? {} : { turnId }),
          kind,
          prompt,
          ...(rationale === undefined ? {} : { rationale }),
          ...(options === undefined ? {} : { options }),
          allowMultiple: parameters.allowMultiple === true,
          blocking: parameters.blocking === true,
          ...(expiresAt === undefined ? {} : { expiresAt }),
          askedBy: ACTOR,
          now,
        })
        const asked = askQuestion(created, { expectedVersion: created.version, actor: ACTOR, now })
        const store = createStoreQuestionStore(host.kernel().store)
        store.put(asked)
        return ok(asked)
      } catch (error) {
        return failure('invalid_state', messageOf(error))
      }
    },
  }
}
