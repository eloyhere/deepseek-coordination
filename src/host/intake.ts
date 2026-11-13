/** Register the one-call intake flow: expand, native popup, durable AMP questions, answers. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  answerQuestion,
  askQuestion,
  createQuestion,
  createStoreQuestionStore,
  type Question,
  type QuestionOption,
} from 'attention-manifest-protocol/question'
import type { AmpHost } from './amp.js'
import { jsonSafe } from './json.js'
import { toolCopy } from './toolCopy.js'
import {
  mapAnswers,
  normalizeIntake,
  popupQuestions,
  type IntakeAnswer,
  type NormalizedIntake,
} from './intakeCore.js'

export * from './intakeCore.js'

/** Record the popup's answers in the AMP question lifecycle, fail-open per row. */
export function recordAnswers(
  store: ReturnType<typeof createStoreQuestionStore>,
  records: ReadonlyMap<string, Question>,
  answers: readonly IntakeAnswer[],
  now: string,
): void {
  for (const answer of answers) {
    if (answer.skipped) continue
    const question = records.get(answer.id)
    if (question === undefined) continue
    try {
      const answered = answerQuestion(question, {
        expectedVersion: question.version,
        actor: 'dsh-user',
        now,
        text: answer.text,
        ...(answer.optionIds.length === 0 ? {} : { optionIds: answer.optionIds }),
      })
      store.put(answered)
    } catch {
      // An answer that no longer matches the lifecycle must not lose the popup result.
    }
  }
}

/** Register the single-call intake tool used immediately after a user request. */
export function registerIntakeTool(ctx: Context, host: AmpHost): void {
  ctx.tools.register(defineTool({
    name: 'deepseek_coordination_intake',
    description: [
      'Run the post-input intake flow: open the native question popup and return the answers plus a selected approach.',
      'Use one compact call: topic, one question, 2-4 short options, and 2-3 short proposal titles; optional summary and detail.',
      'Never pass nested expansion/questions objects. Keep the args small so the stream cannot truncate.',
      'Then propose the plan with attention_manifest_protocol_plan (propose_draft) or attention_manifest_protocol_harness (operation=plan).',
    ].join(' '),
    parameters: {
      topic: { type: 'string', description: 'Short restatement of the user request.' },
      question: { type: 'string', required: true, description: 'One concrete clarification question.' },
      options: {
        type: 'array',
        description: 'Two to four short option labels.',
        items: { type: 'string' },
      },
      summary: { type: 'string', description: 'Optional one-sentence expanded understanding.' },
      detail: { type: 'string', description: 'Optional short context shown with the question.' },
      proposals: {
        type: 'array',
        description: 'Two or three short approach titles; the first is treated as recommended.',
        items: { type: 'string' },
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) return jsonSafe({ ok: false, error: { code: 'binding_invalid', message: 'the intake flow needs an agent session' } })
      let intake: NormalizedIntake
      try {
        intake = normalizeIntake(args, toolCopy(host.locale))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return jsonSafe({ ok: false, error: { code: 'invalid_parameters', message: `${toolCopy(host.locale).invalidIntake}: ${message}` } })
      }
      const service = host.ctx.get('userQuestions') as
        | { ask(request: Record<string, unknown>): Promise<unknown> }
        | undefined
      if (service === undefined) {
        return jsonSafe({ ok: false, error: { code: 'not_available', message: 'no user-question popup provider is mounted' } })
      }

      const sessionId = agent.id
      const now = new Date().toISOString()
      const store = createStoreQuestionStore(host.kernel(host.rootOfAgent(agent)).store)
      const records = new Map<string, Question>()
      try {
        for (const question of intake.questions) {
          const created = createQuestion({
            id: `dsh:question:${sessionId}:${randomUUID()}`,
            sessionId,
            kind: question.kind,
            prompt: question.question,
            ...(question.detail === undefined ? {} : { rationale: question.detail }),
            options: question.options.map((option): QuestionOption => ({ id: option.id, label: option.label })),
            allowMultiple: question.multiSelect,
            blocking: true,
            askedBy: 'dsh-model',
            now,
          })
          const asked = askQuestion(created, { expectedVersion: created.version, actor: 'dsh-model', now })
          store.put(asked)
          records.set(question.id, asked)
        }
      } catch (error) {
        return jsonSafe({ ok: false, error: { code: 'invalid_state', message: error instanceof Error ? error.message : String(error) } })
      }

      let raw: unknown
      // The native popup is blocking. Bound the wait so a popup that never
      // becomes visible cannot leave the harness looking hung forever.
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 180_000)
      try {
        raw = await service.ask({ agent, questions: popupQuestions(intake), signal: controller.signal })
      } catch (error) {
        const timedOut = controller.signal.aborted
        return jsonSafe({
          ok: false,
          error: {
            code: timedOut ? 'question_timeout' : 'question_cancelled',
            message: timedOut
              ? toolCopy(host.locale).intakeTimeout
              : error instanceof Error ? error.message : String(error),
            questionIds: [...records.values()].map((question) => question.id),
          },
        })
      } finally {
        clearTimeout(timeout)
      }

      const answers = mapAnswers(intake, raw)
      recordAnswers(store, records, answers, new Date().toISOString())
      const proposalAnswer = answers.find((answer) => answer.id === 'proposal')
      const selectedProposal = proposalAnswer === undefined || proposalAnswer.selected.length === 0
        ? undefined
        : intake.proposals.find((proposal) => proposal.title === proposalAnswer.selected[0])
      const notes = host.notes.get(sessionId) ?? []
      notes.push({
        kind: 'intake',
        at: now,
        ...(intake.topic === undefined ? {} : { topic: intake.topic }),
        questionIds: [...records.values()].map((question) => question.id),
        answers: answers.map((answer) => ({
          id: answer.id,
          selected: answer.selected,
          ...(answer.custom === undefined ? {} : { custom: answer.custom }),
        })),
        ...(selectedProposal === undefined ? {} : { proposal: selectedProposal.title }),
      })
      host.notes.set(sessionId, notes.slice(-100))

      return jsonSafe({
        ok: true,
        value: {
          ...(intake.topic === undefined ? {} : { topic: intake.topic }),
          ...(intake.expansion === undefined ? {} : { expansion: intake.expansion }),
          questions: intake.questions.map((question) => ({
            id: question.id,
            ampId: records.get(question.id)?.id,
            question: question.question,
            options: question.options,
          })),
          answers,
          proposals: intake.proposals,
          ...(selectedProposal === undefined ? {} : { selectedProposal }),
          next: 'plan',
        },
      })
    },
  }))
}
