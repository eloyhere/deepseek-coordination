/**
 * Plan-dialog copy tests: DSH-authored plan options are localized for display,
 * while the source label stays the answer value.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { localizeDialogOption } = await import('../src/client/planDialog.ts')

test('localizes known plan-review options without touching the source label', () => {
  const approve = { label: 'Approve', description: 'Leave plan mode; the plan is carried out from the next step.' }
  assert.deepEqual(localizeDialogOption(approve, 'zh'), {
    label: '批准',
    description: '离开计划模式，从下一步开始执行计划。',
  })
  assert.equal(localizeDialogOption(approve, 'ja').label, '承認')
  assert.equal(localizeDialogOption(approve, 'en').label, 'Approve')
  assert.equal(localizeDialogOption(approve, 'pt').label, 'Aprovar')
  // Display copy only: the original label remains the answer value.
  assert.equal(approve.label, 'Approve')
})

test('leaves unknown and description-less options untouched', () => {
  const custom = { label: 'Custom', description: 'x' }
  assert.equal(localizeDialogOption(custom, 'zh'), custom)
  assert.deepEqual(localizeDialogOption({ label: 'Keep planning' }, 'zh'), { label: '继续规划' })
})
