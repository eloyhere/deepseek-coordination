import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AmpPreferencesStore } from '../src/host/preferences.ts'
import { registerAmpPrompt } from '../src/host/prompt.ts'
import { fileWriteTakeoverGuard } from '../src/host/writeTakeover.ts'

test('file-write takeover migrates old preferences and persists only boolean changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'amp-write-prefs-'))
  try {
    const file = join(root, 'preferences.json')
    writeFileSync(file, JSON.stringify({ takeoverFileRead: true }))
    const store = new AmpPreferencesStore(file)
    assert.equal(store.get().takeoverFileRead, true)
    assert.equal(store.get().takeoverFileWrite, false)
    store.update({ takeoverFileWrite: true })
    assert.equal(new AmpPreferencesStore(file).get().takeoverFileWrite, true)
    store.update({ takeoverFileWrite: 'false' })
    assert.equal(store.get().takeoverFileWrite, true)
    store.update({ takeoverFileWrite: false })
    assert.equal(new AmpPreferencesStore(file).get().takeoverFileWrite, false)
    assert.equal(store.get().takeoverFileRead, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('write takeover guard blocks native writes only for enabled workspaces', () => {
  const enabled = new Set(['/project'])
  const host = {
    rootOfAgent: (agent) => agent?.session?.header?.cwd,
    preferencesFor: (root) => ({ get: () => ({ takeoverFileWrite: enabled.has(root) }) }),
  }
  const guard = fileWriteTakeoverGuard(host)
  const agent = { session: { header: { cwd: '/project' } } }
  assert.equal(guard({ name: 'attention_manifest_protocol_workspace', agent }), undefined)
  assert.equal(guard({ name: 'read', agent }), undefined)
  for (const name of ['write', 'replace', 'edit', 'apply_patch']) {
    const reason = guard({ name, agent })
    assert.match(reason, /workspace\.write/)
    assert.match(reason, /replace/)
    assert.match(reason, /expectedBaseHash/)
  }
  assert.equal(guard({ name: 'write', agent: { session: { header: { cwd: '/other' } } } }), undefined)
})

test('write takeover context follows live workspace preferences independently of read takeover', () => {
  const contexts = new Map()
  const sections = new Map()
  const preferences = new Map([
    ['project-a', { takeoverFileWrite: false, takeoverFileRead: true }],
    ['project-b', { takeoverFileWrite: true, takeoverFileRead: false }],
  ])
  registerAmpPrompt({
    systemPrompt: {
      getSectionOrder: () => 0,
      getContextOrder: () => 0,
      section: (definition) => sections.set(definition.name, definition),
      context: (definition) => contexts.set(definition.name, definition),
    },
  }, {
    agentModules: [],
    catalog: [],
    preferencesFor: (root) => ({ get: () => preferences.get(root) ?? {} }),
  })
  const write = contexts.get('deepseek-coordination:file-write-takeover')
  const read = contexts.get('deepseek-coordination:takeover')
  const assembly = (cwd) => ({ agent: { session: { header: { cwd } } } })
  assert.equal(write.text(assembly('project-a')), '')
  assert.match(read.text(assembly('project-a')), /File-read takeover is enabled/)
  assert.match(read.text(assembly('project-a')), /outline form first/)
  assert.match(read.text(assembly('project-a')), /workspace\.outline/)
  assert.match(read.text(assembly('project-a')), /phase: "outline"/)
  assert.match(sections.get('deepseek-coordination:amp-contract').text, /Outline before content/)
  assert.match(sections.get('deepseek-coordination:amp-contract').text, /project outline, then file outline, then content/)
  assert.match(write.text(assembly('project-b')), /workspace\.write/)
  assert.match(write.text(assembly('project-b')), /expectedBaseHash/)
  assert.equal(read.text(assembly('project-b')), '')
  preferences.get('project-a').takeoverFileWrite = true
  assert.match(write.text(assembly('project-a')), /File-write takeover is enabled/)
  preferences.get('project-b').takeoverFileWrite = false
  assert.equal(write.text(assembly('project-b')), '')
})
