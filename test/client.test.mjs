import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import * as React from 'react'

const require = createRequire(import.meta.url)

test('client bundle registers a lazy-CJS factory and three slots', async () => {
  let registration
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        registration = value
      },
    },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  new Function('window', code)(globalThis.window)
  assert.equal(registration.id, 'deepseek-coordination')
  const exports = registration.factory((id) => {
    if (id === 'react') return React
    if (id === 'react/jsx-runtime') return require('react/jsx-runtime')
    if (id === 'react-dom') return require('react-dom')
    if (id === 'react-dom/client') return require('react-dom/client')
    throw new Error(`unexpected client require: ${id}`)
  })
  assert.equal(typeof exports.apply, 'function')

  const registered = []
  const dictionaries = []
  const ctx = {
    effect: (factory) => factory(),
    locale: {
      getLocale: () => ({ active: 'zh' }),
      subscribe: () => () => {},
      register: (_namespace, value) => {
        dictionaries.push(value)
        return () => {}
      },
      bind: () => (key) => key,
    },
    slots: {
      inject: (_key, callback) => callback(),
      register: (options) => {
        registered.push(options)
        return () => {}
      },
    },
  }
  await exports.apply(ctx)
  const table = dictionaries[0] ?? {}
  assert.deepEqual(Object.keys(table).sort(), ['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'])
  const baseline = Object.keys(table.zh).sort()
  for (const locale of ['en', 'ja', 'es', 'fr', 'de', 'ru', 'pt']) {
    assert.deepEqual(Object.keys(table[locale] ?? {}).sort(), baseline, `${locale} must cover every key`)
    for (const key of baseline) assert.notEqual(table[locale][key], key, `${locale}.${key} must be translated`)
  }
  assert.ok(table.ja.protocol.length > 0)
  assert.deepEqual(registered.map((entry) => entry.name).sort(), [
    'conversation.input.dock',
    'conversation.input.dock',
    'settings.section',
  ])
})


