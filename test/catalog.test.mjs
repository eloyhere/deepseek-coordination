import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.mjs'

/** Minimal host context that records skill, command and route registrations. */
function context() {
  const tools = new Map()
  const skills = []
  const commands = []
  const routes = new Map()
  const disposers = []
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      get: (name) => tools.get(name),
      definitions: () => [...tools.values()],
    },
    systemPrompt: { getSectionOrder: () => 0, getContextOrder: () => 0, section: () => () => {}, context: () => () => {} },
    skills: {
      register(definition) {
        skills.push(definition)
        return () => {
          const index = skills.indexOf(definition)
          if (index !== -1) skills.splice(index, 1)
        }
      },
    },
    commands: {
      register(definition) {
        commands.push(definition)
        return () => {
          const index = commands.indexOf(definition)
          if (index !== -1) commands.splice(index, 1)
        }
      },
    },
    sessions: { list: () => [] },
    agents: { get: () => undefined },
    on: () => () => {},
    effect: (factory) => {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    get: (name) => (name === 'webServer' ? { register: (route) => {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    } } : undefined),
    provide: () => () => {},
    inject: (_deps, callback) => {
      callback(ctx)
      return () => {}
    },
  }
  return { ctx, skills, commands, routes, disposers }
}

function config(storePath) {
  return {
    tenantId: 'test', rootId: 'root', storePath, notifications: false,
    prompt: false, skills: true, commands: true, routes: true,
    maxJournal: 100, maxReadChars: 100_000, maxWriteChars: 100_000,
  }
}

/** Drive one client-report POST through the registered route. */
async function report(handler, body) {
  const request = {
    method: 'POST',
    url: '/deepseek-coordination/amp/client-report',
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body))
    },
  }
  let payload
  const response = {
    writeHead: () => {},
    end: (text) => {
      payload = JSON.parse(text)
    },
  }
  await handler(request, response)
  return payload
}

function skill(skills, name) {
  return skills.find((entry) => entry.name === name)
}

test('the AMP skill and command catalog follows the reported host language', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'amp-catalog-'))
  const { ctx, skills, commands, routes, disposers } = context()
  try {
    await apply(ctx, config(join(directory, 'amp.sqlite')))
    assert.equal(skills.length, 10)
    assert.equal(commands.length, 2)
    assert.ok(skill(skills, 'amp-workspace'))

    const handler = routes.get('/deepseek-coordination/amp/client-report').handler

    assert.deepEqual((await report(handler, { phase: 'start', locale: 'en' })).ok, true)
    assert.equal(skill(skills, 'amp-workspace').description, 'List, read, outline, diff and CAS-write files inside the workspace root.')
    assert.equal(commands.find((entry) => entry.name === 'amp-modules').description, 'List the registered AMP modules and their model-facing verbs.')

    const before = skills.length
    await report(handler, { phase: 'locale', locale: 'en-US' })
    assert.equal(skills.length, before, 'the same language must not rebuild the catalog')

    await report(handler, { phase: 'locale', locale: 'zh-CN' })
    assert.equal(skill(skills, 'amp-workspace').description, '在工作区根目录内列出、读取、生成大纲、比较并 CAS 写入文件。')
    assert.ok(skill(skills, 'amp-workspace').content.includes('在工作区根目录内列出'))
    assert.equal(commands.find((entry) => entry.name === 'amp-modules').description, '列出已注册的 AMP 模块及其面向模型的动词。')

    await report(handler, { phase: 'locale', locale: 'ja-JP' })
    assert.equal(skill(skills, 'amp-workspace').description, 'ワークスペースルート内のファイルを一覧・読み取り・アウトライン・差分・CAS 書き込みします。')
    assert.equal(commands.find((entry) => entry.name === 'amp-modules').description, '登録済みの AMP モジュールとモデル向け動詞を一覧表示します。')

    const locale = routes.get('/deepseek-coordination/amp/locale').handler
    let value
    await locale({ method: 'GET' }, { writeHead: () => {}, end: (text) => { value = JSON.parse(text) } })
    assert.equal(value.value.locale, 'ja')
  } finally {
    for (const dispose of disposers) dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})
