import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ChainEngine } from '../src/host/chain.js'
import { fileHandleFor, nodeHandleFor, nodeKeyOf } from '../src/host/nodeRegistry.js'
import { ParseService } from '../src/host/parseService.js'
import type { ParsedFile } from '../src/host/parseService.js'

function parsedFixture(t: { after(callback: () => void): void }, files: Record<string, string>): ParsedFile[] {
  const root = mkdtempSync(join(tmpdir(), 'coordination-chain-outline-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  const parser = new ParseService({ workspaceRoot: root })
  t.after(() => parser.clear())
  return Object.keys(files).map(path => parser.parse({ path }))
}

test('chain index links nested code declarations by strict parser spans', t => {
  const parsed = parsedFixture(t, {
    'src/nested.ts': 'class Box {\n  method() {}\n}\n',
  })[0]
  assert.ok(parsed)
  const chain = new ChainEngine()
  t.after(() => chain.dispose())
  chain.index(parsed)

  const type = parsed.nodes.find(node => node.kind === 'class' && node.name === 'Box')
  const method = parsed.nodes.find(node => node.kind === 'method' && node.name === 'method')
  assert.ok(type)
  assert.ok(method)
  const typeHandle = nodeHandleFor(parsed.path, type.kind, nodeKeyOf(type))
  const methodHandle = nodeHandleFor(parsed.path, method.kind, nodeKeyOf(method))
  assert.deepEqual(
    chain.dependenciesOf(typeHandle, { relation: 'contains' }).links.map(link => link.handle),
    [methodHandle],
  )
  assert.ok(chain.dependenciesOf(methodHandle, { relation: 'part_of' }).links.some(
    link => link.handle === typeHandle,
  ))
})

test('chain index links TypeScript interface method signatures', t => {
  const parsed = parsedFixture(t, {
    'src/contracts.ts': 'interface Service {\n  run(): void;\n  stop(): void;\n  title: string;\n}\nclass Worker { execute() {} }\n',
  })[0]
  assert.ok(parsed)
  const chain = new ChainEngine()
  t.after(() => chain.dispose())
  chain.index(parsed)
  const service = parsed.nodes.find(node => node.kind === 'interface' && node.name === 'Service')
  const run = parsed.nodes.find(node => node.kind === 'method' && node.name === 'run')
  const stop = parsed.nodes.find(node => node.kind === 'method' && node.name === 'stop')
  assert.ok(service)
  assert.ok(run)
  assert.ok(stop)
  const parent = nodeHandleFor(parsed.path, service.kind, nodeKeyOf(service))
  const children = chain.dependenciesOf(parent, { relation: 'contains' }).links.map(link => link.handle)
  assert.ok(children.includes(nodeHandleFor(parsed.path, run.kind, nodeKeyOf(run))))
  assert.ok(children.includes(nodeHandleFor(parsed.path, stop.kind, nodeKeyOf(stop))))
  const title = parsed.nodes.find(node => node.kind === 'property' && node.name === 'title')
  assert.ok(title)
  assert.ok(children.includes(nodeHandleFor(parsed.path, title.kind, nodeKeyOf(title))))
  const execute = parsed.nodes.find(node => node.kind === 'method' && node.name === 'execute')
  assert.ok(execute)
  assert.ok(!children.includes(nodeHandleFor(parsed.path, execute.kind, nodeKeyOf(execute))))
})

test('chain index resolves TeX partOf locators for chapter and section', t => {
  const parsed = parsedFixture(t, {
    'docs/outline.tex': String.raw`\documentclass{book}\chapter{Overview}\section{Details}`,
  })[0]
  assert.ok(parsed)
  const chain = new ChainEngine()
  t.after(() => chain.dispose())
  chain.index(parsed)

  const chapter = parsed.nodes.find(node => node.kind === 'chapter')
  const section = parsed.nodes.find(node => node.kind === 'section')
  assert.ok(chapter)
  assert.ok(section)
  const chapterHandle = nodeHandleFor(parsed.path, chapter.kind, nodeKeyOf(chapter))
  const sectionHandle = nodeHandleFor(parsed.path, section.kind, nodeKeyOf(section))
  assert.deepEqual(
    chain.dependenciesOf(chapterHandle, { relation: 'contains' }).links.map(link => link.handle),
    [sectionHandle],
  )
  assert.ok(chain.dependenciesOf(sectionHandle, { relation: 'part_of' }).links.some(
    link => link.handle === chapterHandle,
  ))
})

test('chain index does not invent code hierarchy from kind alone', t => {
  const parsed = parsedFixture(t, {
    'src/siblings.ts': 'class Outer {}\nfunction sibling() {}\n',
  })[0]
  assert.ok(parsed)
  const chain = new ChainEngine()
  t.after(() => chain.dispose())
  chain.index(parsed)

  assert.ok(parsed.path)
  const sibling = parsed.nodes.find(node => node.kind === 'function' && node.name === 'sibling')
  assert.ok(sibling)
  const siblingHandle = nodeHandleFor(parsed.path, sibling.kind, nodeKeyOf(sibling))
  assert.deepEqual(chain.dependenciesOf(siblingHandle, { relation: 'part_of' }).links.map(link => link.handle), [fileHandleFor(parsed.path)])
  assert.equal(chain.dependenciesOf(fileHandleFor(parsed.path), { relation: 'contains' }).links.some(
    link => link.handle === siblingHandle,
  ), true)
})
