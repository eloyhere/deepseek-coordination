/**
 * Rust and PHP lexical parser tests.
 *
 * The fixtures pin the precise taxonomy: `enum` maps to `enumeration`, while
 * Rust `struct`/`trait`/`impl` and PHP `class`/`trait` stay `class` with the
 * language nuance in `label`. Malformed input must produce diagnostics, never a
 * throw, and a large generated file must stay well inside a generous bound.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRust, rustParser } from '../src/host/text/rust.js'
import { parsePhp, phpParser } from '../src/host/text/php.js'
import type { NodeMetadata } from '../src/host/text/parser.js'

function ofKind(nodes: readonly NodeMetadata[], kind: string): NodeMetadata[] {
  return nodes.filter((node) => node.kind === kind)
}

function names(nodes: readonly NodeMetadata[]): string[] {
  return nodes.map((node) => node.name ?? '')
}

const RUST_FIXTURE = [
  '//! Crate docs are not projected.',
  'use std::collections::HashMap;',
  'pub use crate::model::User;',
  '',
  'macro_rules! define_hidden {',
  '    () => { struct Hidden; };',
  '}',
  '',
  '#[derive(Debug)]',
  'pub mod store {',
  '    pub const LIMIT: usize = 8;',
  '',
  '    pub fn helper() -> usize {',
  '        LIMIT',
  '    }',
  '}',
  '',
  'pub struct Config {',
  '    pub name: String,',
  '}',
  '',
  'pub enum Mode {',
  '    Fast,',
  '    Slow,',
  '}',
  '',
  'pub trait Service {',
  '    fn run(&self);',
  '}',
  '',
  'pub const MAX_ITEMS: usize = 32;',
  '',
  'impl Config {',
  '    pub fn new() -> Self {',
  '        Config { name: String::new() }',
  '    }',
  '',
  '    fn secret(&self) -> bool {',
  '        true',
  '    }',
  '}',
].join('\n')

const PHP_FIXTURE = [
  '<?php',
  'namespace App\\Service;',
  '',
  'use App\\Contracts\\Handler;',
  'use App\\Contracts\\Logger as Log;',
  '',
  "require_once 'bootstrap.php';",
  '',
  'class Worker',
  '{',
  '    private Handler $handler;',
  '',
  '    public function __construct(Handler $handler)',
  '    {',
  '        $this->handler = $handler;',
  '    }',
  '',
  '    public function run(): void',
  '    {',
  '        $local = 1;',
  '    }',
  '}',
  '',
  'interface Runnable',
  '{',
  '    public function run(): void;',
  '}',
  '',
  'trait Logs',
  '{',
  '    public function log(string $message): void',
  '    {',
  '    }',
  '}',
  '',
  'enum Mode: string',
  '{',
  "    case Fast = 'fast';",
  '}',
  '',
  '$boot = 1;',
  "$config = ['debug' => true];",
].join('\n')

test('rust fixture maps imports and items onto precise node kinds', () => {
  const result = parseRust(RUST_FIXTURE, { path: 'src/lib.rs' })
  const nodes = result.nodes ?? []

  assert.equal(result.parserId, 'rust')
  assert.deepEqual(
    result.references.map((reference) => reference.specifier),
    ['std::collections::HashMap', 'crate::model::User'],
  )
  // crate-rooted paths are local; std is filed as a bare/external module path.
  assert.equal(result.references[0]?.external, true)
  assert.equal(result.references[1]?.external, false)

  const moduleNode = nodes.find((node) => node.kind === 'module')
  assert.equal(moduleNode?.name, 'store')
  assert.equal(moduleNode?.label, 'mod')

  const structNode = nodes.find(
    (node) => node.kind === 'class' && node.name === 'Config' && node.label === 'struct',
  )
  assert.ok(structNode !== undefined, 'struct must map to class')
  assert.equal(structNode?.label, 'struct')

  // The parent contract: impl maps to class, implemented type is the name, and
  // the human-facing label is the full, unabbreviated word "implementation".
  const implNode = nodes.find((node) => node.kind === 'class' && node.label === 'implementation')
  assert.ok(implNode !== undefined, 'impl must map to class with label implementation')
  assert.equal(implNode?.name, 'Config')

  // `enum` has a dedicated kind; the Rust keyword stays in `label`.
  const enumNode = nodes.find((node) => node.kind === 'enumeration')
  assert.equal(enumNode?.name, 'Mode')
  assert.equal(enumNode?.label, 'enum')
  const traitNode = nodes.find((node) => node.kind === 'class' && node.label === 'trait')
  assert.equal(traitNode?.name, 'Service')

  assert.deepEqual(
    names(ofKind(nodes, 'method')),
    ['new', 'secret'],
    'only direct impl members become methods',
  )
  assert.deepEqual(names(ofKind(nodes, 'function')), ['helper'])

  const items = ofKind(nodes, 'variable')
  assert.ok(items.some((node) => node.name === 'MAX_ITEMS' && node.label === 'const'))
  assert.ok(items.some((node) => node.name === 'LIMIT' && node.label === 'const'))

  const importations = ofKind(nodes, 'importation')
  assert.deepEqual(names(importations), ['std::collections::HashMap', 'crate::model::User'])
  assert.deepEqual(importations.map((node) => node.label), ['use', 'use'])

  // Attributes and macros never become nodes.
  assert.equal(nodes.some((node) => node.name === 'derive'), false)
  assert.equal(nodes.some((node) => node.name === 'Hidden'), false)
})

test('php fixture maps namespace, imports, class methods and variables', () => {
  const result = parsePhp(PHP_FIXTURE, { path: 'src/index.php' })
  const nodes = result.nodes ?? []

  assert.equal(result.parserId, 'php')
  assert.deepEqual(
    result.references.map((reference) => reference.specifier),
    ['App\\Contracts\\Handler', 'App\\Contracts\\Logger', 'bootstrap.php'],
  )
  assert.equal(result.references[0]?.external, true)
  assert.equal(result.references[2]?.external, false)

  const namespaceNode = nodes.find((node) => node.kind === 'module')
  assert.equal(namespaceNode?.name, 'App\\Service')
  assert.equal(namespaceNode?.label, 'namespace')

  const classNode = nodes.find((node) => node.kind === 'class' && node.name === 'Worker')
  assert.equal(classNode?.label, 'class')
  // `interface`/`enum` no longer fold into `class`; `trait` still does, labelled.
  const interfaceNode = nodes.find((node) => node.name === 'Runnable')
  assert.equal(interfaceNode?.kind, 'interface')
  assert.equal(interfaceNode?.label, 'interface')
  const traitNode = nodes.find((node) => node.name === 'Logs')
  assert.equal(traitNode?.kind, 'class')
  assert.equal(traitNode?.label, 'trait')
  const enumNode = nodes.find((node) => node.name === 'Mode')
  assert.equal(enumNode?.kind, 'enumeration')
  assert.equal(enumNode?.label, 'enum')
  assert.deepEqual(
    nodes.filter((node) => node.kind === 'class').map((node) => node.name),
    ['Worker', 'Logs'],
  )

  const methods = ofKind(nodes, 'method')
  assert.ok(methods.some((node) => node.name === '__construct'))
  assert.ok(methods.some((node) => node.name === 'run'))

  // The `$` is kept exactly as written, and only top-level assignments count.
  assert.deepEqual(names(ofKind(nodes, 'variable')), ['$boot', '$config'])
  assert.equal(nodes.some((node) => node.name === '$handler'), false)
  assert.equal(nodes.some((node) => node.name === '$local'), false)

  const importations = ofKind(nodes, 'importation')
  assert.deepEqual(importations.map((node) => node.label), ['use', 'use', 'require_once'])
  assert.ok(importations.some((node) => node.name === 'bootstrap.php'))
})

test('php heredoc and inline html are masked before scanning', () => {
  const source = [
    '<?php',
    'class Real { public function ok(): void {} }',
    '$sql = <<<SQL',
    'class Fake { public function nope(): void {} }',
    'SQL;',
    '?>',
    '<div class="html">class AlsoFake { public function nope(): void {} }</div>',
    '<?php',
    '$tail = 1;',
  ].join('\n')
  const result = parsePhp(source, { path: 'src/masked.php' })
  const nodes = result.nodes ?? []

  assert.ok(nodes.some((node) => node.kind === 'class' && node.name === 'Real'))
  assert.equal(nodes.some((node) => node.name === 'Fake'), false)
  assert.equal(nodes.some((node) => node.name === 'AlsoFake'), false)
  assert.equal(nodes.some((node) => node.name === 'nope'), false)
  assert.ok(nodes.some((node) => node.kind === 'variable' && node.name === '$tail'))
})

test('malformed rust and php input reports diagnostics without throwing', () => {
  const rustSource = 'use ;\nstruct { fn broken( { impl Foo { fn x() {'
  const parseBadRust = (): ReturnType<typeof parseRust> =>
    parseRust(rustSource, { path: 'src/bad.rs' })
  assert.doesNotThrow(parseBadRust)
  const rustResult = parseBadRust()
  assert.equal(rustResult.parserId, 'rust')
  assert.ok(rustResult.diagnostics.length > 0, 'malformed Rust must produce diagnostics')
  assert.ok(rustResult.diagnostics.some((diagnostic) => diagnostic.code === 'parse-error'))

  const phpSources = [
    '<?php namespace ; class { public function broken( { $x = 1;',
    '<?php\n$ok = 1;\necho <<<EOT\nnever terminated',
  ]
  for (const phpSource of phpSources) {
    const parseBadPhp = (): ReturnType<typeof parsePhp> =>
      parsePhp(phpSource, { path: 'src/bad.php' })
    assert.doesNotThrow(parseBadPhp)
    const phpResult = parseBadPhp()
    assert.equal(phpResult.parserId, 'php')
    assert.ok(phpResult.diagnostics.length > 0, 'malformed PHP must produce diagnostics')
    assert.ok(phpResult.diagnostics.some((diagnostic) =>
      diagnostic.code === 'parse-error' || diagnostic.code === 'unverifiable'))
  }
})

test('large generated rust and php sources parse under a generous time bound', () => {
  const generatorCount = 1_500
  const rustLines = ['use std::collections::HashMap;']
  for (let index = 0; index < generatorCount; index += 1) {
    rustLines.push(`pub fn generated_${index}(value: i32) -> i32 { value + ${index} }`)
  }
  const rustSource = rustLines.join('\n')
  const rustStart = Date.now()
  const rustResult = parseRust(rustSource, { path: 'src/large.rs' })
  const rustElapsed = Date.now() - rustStart
  assert.equal(rustResult.truncated, false)
  assert.equal(ofKind(rustResult.nodes ?? [], 'function').length, generatorCount)
  assert.ok(rustElapsed < 5_000, `Rust parse took ${rustElapsed} ms`)

  const phpLines = ['<?php', 'namespace App;', 'class Big {']
  for (let index = 0; index < generatorCount; index += 1) {
    phpLines.push(`    public function method_${index}(): int { return ${index}; }`)
  }
  phpLines.push('}', '$done = true;')
  const phpSource = phpLines.join('\n')
  const phpStart = Date.now()
  const phpResult = parsePhp(phpSource, { path: 'src/large.php' })
  const phpElapsed = Date.now() - phpStart
  assert.equal(phpResult.truncated, false)
  assert.equal(ofKind(phpResult.nodes ?? [], 'method').length, generatorCount)
  assert.ok(phpElapsed < 5_000, `PHP parse took ${phpElapsed} ms`)
})

test('rust and php parser descriptors expose stable ids and extensions', () => {
  assert.equal(rustParser.id, 'rust')
  assert.deepEqual(rustParser.extensions, ['.rs'])
  assert.equal(phpParser.id, 'php')
  assert.deepEqual(phpParser.extensions, ['.php'])
  assert.equal(parseRust('', { path: 'empty.rs' }).parserId, 'rust')
  assert.equal(parsePhp('', { path: 'empty.php' }).parserId, 'php')
})
