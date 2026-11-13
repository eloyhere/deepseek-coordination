import assert from 'node:assert/strict'
import test from 'node:test'
import {
  IntakeError,
  expansionText,
  mapAnswers,
  normalizeIntake,
  popupQuestions,
} from '../src/host/intakeCore.ts'

const QUESTION = {
  id: 'scope',
  header: 'Scope',
  question: 'How large should the first pass be?',
  detail: 'The request can be delivered in stages.',
  options: [
    { label: 'Minimal', description: 'Ship the smallest useful change.' },
    { label: 'Full', description: 'Cover every requested surface.' },
  ],
  kind: 'decision',
}

const PROPOSALS = [
  { title: 'Popup first', summary: 'Ask before implementing.', recommended: true },
  { title: 'Implement first', summary: 'Ship then clarify.', tradeoffs: 'Higher rework risk.' },
]

test('normalizes questions, option ids and popup shape', () => {
  const intake = normalizeIntake({
    topic: '  Intake flow  ',
    questions: [QUESTION, { question: 'Which host?', options: ['Windows', 'Linux'] }],
  })
  assert.equal(intake.topic, 'Intake flow')
  assert.equal(intake.questions.length, 2)
  assert.deepEqual(intake.questions[0].options.map((option) => option.id), ['scope:o1', 'scope:o2'])
  assert.equal(intake.questions[0].kind, 'decision')
  assert.equal(intake.questions[1].id, 'q2')
  assert.equal(intake.questions[1].kind, 'clarification')

  const popup = popupQuestions(intake)
  assert.equal(popup[0].id, 'scope')
  assert.equal(popup[0].options[0].label, 'Minimal')
  assert.equal(popup[0].options[0].description, 'Ship the smallest useful change.')
  assert.equal(popup[0].multiSelect, undefined)
})

test('adds a decision question for proposals and puts the recommendation first', () => {
  const intake = normalizeIntake({
    questions: [QUESTION],
    proposals: PROPOSALS,
    expansion: {
      goal: 'Make the agent ask first.',
      assumptions: ['The native popup is mounted.'],
      unknowns: ['Question count.'],
    },
  })
  assert.equal(intake.questions.length, 2)
  const proposal = intake.questions[1]
  assert.equal(proposal.id, 'proposal')
  assert.equal(proposal.kind, 'decision')
  assert.equal(proposal.options[0].label, 'Popup first')
  assert.equal(proposal.options[1].label, 'Implement first')
  assert.match(proposal.detail, /Goal: Make the agent ask first/)
  assert.match(proposal.detail, /Assumptions: The native popup is mounted/)
  assert.equal(intake.proposals[0].recommended, true)
})

test('uses expansion approaches when proposals are absent', () => {
  const intake = normalizeIntake({
    questions: [QUESTION],
    expansion: { approaches: PROPOSALS },
  })
  assert.equal(intake.questions.length, 2)
  assert.equal(intake.proposals.length, 2)
  assert.equal(intake.questions[1].id, 'proposal')
})

test('maps selected labels and custom text back to the intake', () => {
  const intake = normalizeIntake({
    questions: [QUESTION, { id: 'notes', question: 'Anything else?', options: ['None', 'Details'] }],
    proposals: PROPOSALS,
  })
  const answers = mapAnswers(intake, {
    answers: [
      { id: 'scope', selected: ['Minimal'] },
      { id: 'notes', selected: [], custom: 'Keep it behind a preference.' },
      { id: 'proposal', selected: ['Popup first'] },
    ],
  })
  assert.deepEqual(answers[0].optionIds, ['scope:o1'])
  assert.equal(answers[0].text, 'Minimal')
  assert.equal(answers[0].skipped, false)
  assert.equal(answers[1].custom, 'Keep it behind a preference.')
  assert.deepEqual(answers[1].optionIds, [])
  assert.equal(answers[2].selected[0], 'Popup first')
  assert.equal(answers[2].skipped, false)
})

test('marks empty answers as skipped and ignores unknown labels', () => {
  const intake = normalizeIntake({ questions: [QUESTION] })
  const answers = mapAnswers(intake, {
    answers: [{ id: 'scope', selected: ['Not offered', 'Minimal'] }],
  })
  assert.deepEqual(answers[0].selected, ['Minimal'])
  assert.equal(answers[0].skipped, false)
  assert.equal(mapAnswers(intake, { answers: [{ id: 'scope', selected: [] }] })[0].skipped, true)
})

test('rejects invalid intake shapes with a typed error', () => {
  assert.throws(() => normalizeIntake({ questions: [] }), IntakeError)
  assert.throws(() => normalizeIntake({ questions: [{ question: 'One option?', options: ['Only'] }] }), /at least two options/)
  assert.throws(() => normalizeIntake({
    questions: [
      { id: 'same', question: 'A?', options: ['1', '2'] },
      { id: 'same', question: 'B?', options: ['1', '2'] },
    ],
  }), /duplicate question id/)
  assert.throws(() => normalizeIntake({ questions: [QUESTION], proposals: [PROPOSALS[0]] }), /at least two approaches/)
})

test('accepts three questions plus proposals and appends the decision question', () => {
  const intake = normalizeIntake({
    questions: [
      QUESTION,
      { id: 'second', question: 'Second?', options: ['A', 'B'] },
      { id: 'third', question: 'Third?', options: ['A', 'B'] },
    ],
    proposals: PROPOSALS,
  })
  assert.equal(intake.questions.length, 4)
  assert.equal(intake.questions[3].id, 'proposal')
  assert.equal(intake.questions[3].options[0].label, 'Popup first')
})

test('renders expansion context without empty labels', () => {
  assert.equal(expansionText({ assumptions: [], unknowns: [] }), '')
  assert.equal(
    expansionText({ goal: 'Goal', assumptions: ['A'], unknowns: ['U'] }),
    'Goal: Goal\nAssumptions: A\nOpen questions: U',
  )
})

test('accepts the compact payload and stays small', () => {
  const input = {
    topic: 'Fix intake',
    question: 'Which scope?',
    options: ['Small', 'Full'],
    summary: 'Keep the call small.',
    proposals: ['Patch first', 'Rewrite'],
  }
  const intake = normalizeIntake(input)
  assert.equal(intake.questions.length, 2)
  assert.equal(intake.questions[0].detail, 'Keep the call small.')
  assert.equal(intake.proposals.length, 2)
  assert.equal(intake.proposals[0].recommended, true)
  assert.equal(intake.questions[1].id, 'proposal')
  assert.ok(JSON.stringify(input).length < 500)
})

test('uses injected copy for generated labels', () => {
  const intake = normalizeIntake(
    { question: 'Q?', options: ['A', 'B'], proposals: ['P1', 'P2'] },
    {
      proposalHeader: '方案选择',
      proposalQuestion: '选择一个方案方向',
      goal: '目标',
      assumptions: '假设',
      openQuestions: '待确认',
    },
  )
  assert.equal(intake.questions[1].header, '方案选择')
  assert.equal(intake.questions[1].question, '选择一个方案方向')
})
