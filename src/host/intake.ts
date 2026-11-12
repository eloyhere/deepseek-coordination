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
      'Run the post-input intake flow in one call: expand the request, show the native question popup, and return the answers plus proposed approaches.',
      'Use it once after a new substantive user message, before other tools.',
      'Ask 1-2 concrete questions (2-4 options each) and pass 2-3 proposed approaches; the tool adds a decision question so the user picks a direction.',
      'Then propose the plan with attention_manifest_protocol_plan (propose_draft) or attention_manifest_protocol_harness (operation=plan).',
    ].join(' '),
    parameters: {
      topic: { type: 'string', description: 'Short restatement of the user request.' },
      questions: {
        type: 'array',
        description: 'One to three clarification questions. Each needs at least two options.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', description: 'Stable question id; defaults to q1, q2, q3.' },
            header: { type: 'string', description: 'Short header shown above the question.' },
            question: { type: 'string', required: true, description: 'The question text.' },
            detail: { type: 'string', description: 'Optional context or expansion for this question.' },
            options: {
              type: 'array',
              description: 'Two to five options; strings or { label, description } objects.',
              items: { type: 'json' },
            },
            multiSelect: { type: 'boolean', description: 'Allow more than one option.' },
            kind: { type: 'string', enum: ['clarification', 'decision', 'confirmation'], description: 'AMP question kind.' },
          },
        },
      },
      expansion: {
        type: 'object',
        description: 'Expanded understanding of the request, shown as context and used for approach selection.',
        additionalProperties: false,
        properties: {
          goal: { type: 'string', description: 'The concrete goal in one sentence.' },
          summary: { type: 'string', description: 'Expanded requirement summary.' },
          assumptions: { type: 'array', description: 'Assumptions being made.', items: { type: 'string' } },
          unknowns: { type: 'array', description: 'Unknowns the popup should resolve.', items: { type: 'string' } },
          approaches: {
            type: 'array',
            description: 'Alternative approaches; used as proposals when proposals is absent.',
            items: { type: 'json' },
          },
        },
      },
      proposals: {
        type: 'array',
        description: 'Two to four concrete approaches. One may be recommended; the tool adds a decision question.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            title: { type: 'string', required: true },
            summary: { type: 'string', description: 'What this approach does.' },
            tradeoffs: { type: 'string', description: 'Costs, risks or tradeoffs.' },
            recommended: { type: 'boolean', description: 'Mark the recommended approach; it is listed first.' },
          },
        },
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
        intake = normalizeIntake(args)
      } catch (error) {
        return jsonSafe({ ok: false, error: { code: 'invalid_parameters', message: error instanceof Error ? error.message : String(error) } })
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
      try {
        raw = await service.ask({ agent, questions: popupQuestions(intake) })
      } catch (error) {
        return jsonSafe({
          ok: false,
          error: {
            code: 'question_cancelled',
            message: error instanceof Error ? error.message : String(error),
            questionIds: [...records.values()].map((question) => question.id),
          },
        })
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
