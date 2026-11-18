/**
 * Plan-preview Markdown tests.
 *
 * `planPreview.ts` has only type imports, so Node's type stripping imports the
 * TypeScript source directly, like the other pure-model tests.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { planMarkdown, planPreviewTitle } = await import('../src/host/planPreview.ts')

test('renders the objective as a heading and every task as a checklist item', () => {
  const markdown = planMarkdown({
    objective: '  Confirm   plan dialog  ',
    tasks: ['  Locate the dialog  ', '', 'Add tests', 'Ship\nit'],
  })
  assert.equal(markdown, [
    '### Confirm plan dialog',
    '',
    '- [ ] Locate the dialog',
    '- [ ] Add tests',
    '- [ ] Ship it',
  ].join('\n'))
  assert.equal(planMarkdown({ objective: 'x', tasks: ['   '] }), undefined)
  assert.equal(planMarkdown({ objective: 'x', tasks: [] }), undefined)
})

test('caps the preview and keeps the dialog title inside the notification bound', () => {
  const tasks = Array.from({ length: 20 }, (_, index) => `task ${index + 1}`)
  const markdown = planMarkdown({ objective: 'Objective', tasks })
  assert.equal(markdown.split('\n').filter((line) => line.startsWith('- [ ] ')).length, 12)
  assert.equal(planPreviewTitle('  '), 'Plan')
  assert.equal(planPreviewTitle('x'.repeat(260)).length, 200)
})
