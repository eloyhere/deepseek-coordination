/**
 * Ecosystem parser wiring: Maven `pom.xml`, npm `package.json` and the parsers
 * registered for Python/Java/Rust/PHP/C-family/Book/Office.
 *
 * The cases are deliberately small and body-free: a POM with one module and two
 * dependencies, a `package.json` with all dependency sections plus scripts, a
 * malformed input of each kind (diagnostics, never a throw), and the registry's
 * exact-file-name matching (`pom.xml`/`package.json` while `.ts` keeps resolving
 * to the JavaScript parser; `SUMMARY.md` resolves to `book` while `README.md`
 * stays Markdown).
 *
 * The Office cases exercise the service's bounded byte path with an in-memory
 * OOXML package written to a temp workspace: `.docx` reaches `parseOffice(bytes)`
 * and the proprietary-format/size-cap refusals stay diagnostics.
 *
 * descriptive only: no edit, no build, no install; a real 'project create' would be a shell command behind DSH's permission model, not a plugin tool.
 *
 * Importing `parse-service.js` runs the production registration on the shared
 * `defaultParserRegistry`, so the registry assertions describe the real runtime
 * rather than a test-only registry.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zipSync, strToU8 } from 'fflate'
import { ParseService } from '../src/host/parse-service.js'
import { defaultParserRegistry } from '../src/host/text/index.js'
import { MavenParser } from '../src/host/text/maven.js'
import { NpmParser } from '../src/host/text/npm.js'

const POM = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>demo</artifactId>
  <version>1.2.3</version>
  <parent>
    <groupId>com.example</groupId>
    <artifactId>parent</artifactId>
    <version>9.9.9</version>
  </parent>
  <modules>
    <module>core</module>
  </modules>
  <dependencies>
    <dependency>
      <groupId>org.slf4j</groupId>
      <artifactId>slf4j-api</artifactId>
      <version>2.0.13</version>
    </dependency>
    <dependency>
      <groupId>junit</groupId>
      <artifactId>junit</artifactId>
      <scope>test</scope>
    </dependency>
  </dependencies>
</project>`

const PACKAGE_JSON = `{
  "name": "demo-app",
  "version": "1.0.0",
  "dependencies": {
    "react": "^18.2.0"
  },
  "devDependencies": {
    "typescript": "~5.6.0"
  },
  "peerDependencies": {
    "react-dom": ">=18.0.0"
  },
  "optionalDependencies": {
    "fsevents": "2.3.3"
  },
  "scripts": {
    "build": "tsdown --config tsdown.config.ts",
    "test": "node --test .tmp/test-build"
  }
}`

test('maven: POM module, dependencies and parent are body-free nodes', () => {
  const result = new MavenParser().parse(POM, { path: 'pom.xml' })
  const nodes = result.nodes ?? []

  const project = nodes.find((node) => node.kind === 'project')
  assert.equal(project?.name, 'demo')
  assert.equal(project?.label, 'com.example:demo')
  // The project's own <version> is explicit but must not become the label.
  assert.notEqual(project?.label, '1.2.3')

  assert.deepEqual(
    nodes.filter((node) => node.kind === 'module').map((node) => node.name),
    ['core'],
  )

  const dependencies = nodes.filter((node) => node.kind === 'dependency' && node.label !== 'parent')
  assert.deepEqual(dependencies.map((node) => node.name), ['org.slf4j:slf4j-api', 'junit:junit'])
  assert.equal(dependencies[0]?.label, '2.0.13')
  // No <version> element on junit: the label must stay absent, never guessed.
  assert.equal(dependencies[1]?.label, undefined)

  const parent = nodes.find((node) => node.kind === 'dependency' && node.label === 'parent')
  assert.equal(parent?.name, 'com.example:parent')

  const specifiers = result.references.map((reference) => reference.specifier)
  assert.ok(specifiers.includes('org.slf4j:slf4j-api'))
  assert.ok(specifiers.includes('junit:junit'))
  assert.ok(specifiers.includes('com.example:parent'))
  assert.ok(result.references.every((reference) => reference.external))
})

test('npm: dependencies, scripts and project nodes carry no command bodies', () => {
  const result = new NpmParser().parse(PACKAGE_JSON, { path: 'package.json' })
  const nodes = result.nodes ?? []

  const project = nodes.find((node) => node.kind === 'project')
  assert.equal(project?.name, 'demo-app')
  assert.equal(project?.label, 'demo-app@1.0.0')

  const dependencies = nodes.filter((node) => node.kind === 'dependency')
  assert.deepEqual(
    dependencies.map((node) => node.name),
    ['react', 'typescript', 'react-dom', 'fsevents'],
  )
  assert.equal(dependencies[0]?.label, '^18.2.0')
  assert.equal(dependencies[1]?.label, '~5.6.0')

  const scripts = nodes.filter((node) => node.kind === 'script')
  assert.deepEqual(scripts.map((node) => node.name), ['build', 'test'])
  for (const script of scripts) {
    assert.equal(script.description, undefined)
    assert.equal(script.label, undefined)
  }

  const serialized = JSON.stringify(nodes)
  assert.ok(!serialized.includes('tsdown --config'))
  assert.ok(!serialized.includes('node --test'))
  assert.ok(!serialized.includes('.tmp/test-build'))

  const specifiers = result.references.map((reference) => reference.specifier)
  assert.deepEqual(specifiers, ['react', 'typescript', 'react-dom', 'fsevents'])
  assert.ok(result.references.every((reference) => reference.external))
})

test('maven: malformed POM reports diagnostics instead of throwing', () => {
  const cases = [
    '<project><artifactId>broken',
    '<project><modules><module>a</module></project>',
    '<project><artifactId>x</artifactId',
    '<project><dependencies><dependency><groupId>x</groupId></dependency></dependencies></project>',
    'not xml at all',
  ]
  for (const source of cases) {
    const result = new MavenParser().parse(source, { path: 'pom.xml' })
    assert.ok(result.diagnostics.length > 0, `expected diagnostics for: ${source}`)
    assert.ok(
      result.diagnostics.some((diagnostic) => diagnostic.code === 'parse-error' || diagnostic.code === 'unverifiable'),
      `expected a parse/unverifiable diagnostic for: ${source}`,
    )
    assert.ok(Array.isArray(result.references))
  }
})

test('npm: malformed package.json reports diagnostics instead of throwing', () => {
  const cases = [
    '',
    'not json',
    '{ "name": "broken", "dependencies": { "left-pad": "1.3.0", ',
    '{ "scripts": { "build": "tsdown --config }',
    '{ "dependencies": { "left-pad": 42 } }',
  ]
  for (const source of cases) {
    const result = new NpmParser().parse(source, { path: 'package.json' })
    assert.ok(result.diagnostics.length > 0, `expected diagnostics for: ${source}`)
    assert.ok(
      result.diagnostics.some((diagnostic) => diagnostic.code === 'parse-error' || diagnostic.code === 'unverifiable'),
      `expected a parse/unverifiable diagnostic for: ${source}`,
    )
    assert.ok(Array.isArray(result.references))
  }
})

test('registry: pom.xml and package.json resolve by exact file name, .ts stays javascript', () => {
  assert.equal(defaultParserRegistry.resolve('pom.xml')?.id, 'maven')
  assert.equal(defaultParserRegistry.resolve('services/api/pom.xml')?.id, 'maven')
  assert.equal(defaultParserRegistry.resolve('package.json')?.id, 'npm')
  assert.equal(defaultParserRegistry.resolve('packages/web/package.json')?.id, 'npm')

  // Exact file names only: the shared extensions stay unclaimed.
  assert.equal(defaultParserRegistry.resolve('other.xml'), undefined)
  assert.equal(defaultParserRegistry.resolve('other.json'), undefined)

  // Existing parsers keep resolving exactly as before.
  assert.equal(defaultParserRegistry.resolve('src/host/text/parser.ts')?.id, 'javascript')
  assert.equal(defaultParserRegistry.resolve('src/a.js')?.id, 'javascript')
  assert.equal(defaultParserRegistry.resolve('README.md')?.id, 'markdown')

  // An exact file name wins over a conflicting parserId.
  assert.equal(defaultParserRegistry.resolve('pom.xml', 'npm')?.id, 'maven')
  // The id is still a fallback when no path is supplied.
  assert.equal(defaultParserRegistry.resolve(undefined, 'npm')?.id, 'npm')
})

/* ------------------------------------------------------------------------- *
 * New ecosystem parsers (Python/Java/Rust/PHP/C-family/Book/Office)
 * ------------------------------------------------------------------------- */

test('registry: the seven wired parsers are registered and resolve by extension or name', () => {
  for (const id of ['python', 'java', 'rust', 'php', 'c-family', 'book', 'office']) {
    assert.equal(defaultParserRegistry.get(id)?.id, id, `parser id "${id}" must be registered`)
  }

  // Language extensions resolve to their dedicated parser.
  assert.equal(defaultParserRegistry.resolve('src/app.py')?.id, 'python')
  assert.equal(defaultParserRegistry.resolve('src/app.pyi')?.id, 'python')
  assert.equal(defaultParserRegistry.resolve('src/app.pyw')?.id, 'python')
  assert.equal(defaultParserRegistry.resolve('src/Main.java')?.id, 'java')
  assert.equal(defaultParserRegistry.resolve('src/lib.rs')?.id, 'rust')
  assert.equal(defaultParserRegistry.resolve('src/index.php')?.id, 'php')
  assert.equal(defaultParserRegistry.resolve('src/native/widget.cpp')?.id, 'c-family')
  assert.equal(defaultParserRegistry.resolve('src/native/widget.c')?.id, 'c-family')
  assert.equal(defaultParserRegistry.resolve('src/native/widget.hpp')?.id, 'c-family')

  // The book parser claims the exact SUMMARY file names (file-name-first) and
  // the `.book` extension; plain Markdown/`.txt` files stay unclaimed by it.
  assert.equal(defaultParserRegistry.resolve('docs/SUMMARY.md')?.id, 'book')
  assert.equal(defaultParserRegistry.resolve('books/summary.txt')?.id, 'book')
  assert.equal(defaultParserRegistry.resolve('books/story.book')?.id, 'book')
  assert.equal(defaultParserRegistry.resolve('README.md')?.id, 'markdown')
  assert.equal(defaultParserRegistry.resolve('sources/a.ts')?.id, 'javascript')
  assert.equal(defaultParserRegistry.resolve('notes/story.txt'), undefined)

  // Office containers resolve to the byte-path parser (the service decides
  // between the OOXML byte read and the proprietary-format refusal).
  assert.equal(defaultParserRegistry.resolve('docs/review.docx')?.id, 'office')
  assert.equal(defaultParserRegistry.resolve('finance/report.xlsx')?.id, 'office')
  assert.equal(defaultParserRegistry.resolve('decks/intro.pptx')?.id, 'office')
  assert.equal(defaultParserRegistry.resolve('docs/legacy.pub')?.id, 'office')
  assert.equal(defaultParserRegistry.resolve('docs/legacy.accdb')?.id, 'office')
})

/* ------------------------------------------------------------------------- *
 * Office byte path (ParseService)
 * ------------------------------------------------------------------------- */

const DOCX_CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Override PartName="/word/document.xml" ' +
  'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>'

const DOCX_DOCUMENT_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:body>' +
  '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Introduction</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>SECRET_BODY_TEXT</w:t></w:r></w:p>' +
  '</w:body></w:document>'

/** A tiny valid OOXML package, built in memory (no fixture file, no Office). */
function docxBytes(): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8(DOCX_CONTENT_TYPES),
    'word/document.xml': strToU8(DOCX_DOCUMENT_XML),
  })
}

test('parse service: .docx is parsed through the bounded Office byte path', () => {
  const root = mkdtempSync(join(tmpdir(), 'coordination-wiring-'))
  try {
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docs', 'review.docx'), docxBytes())
    writeFileSync(join(root, 'docs', 'legacy.pub'), Buffer.from('not a real publisher file'))
    const service = new ParseService({ workspaceRoot: root })

    const parsed = service.parse({ path: 'docs/review.docx' })
    assert.equal(parsed.parserId, 'office')
    assert.equal(parsed.charset, 'binary')
    assert.equal(parsed.status, 'parsed')
    assert.equal(parsed.truncated, false)
    assert.equal(parsed.bomBytes, 0)
    assert.equal(parsed.file.reference?.parserId, 'office')
    assert.ok(
      (parsed.file.reference?.mediaType ?? '').includes('wordprocessingml'),
      'the file node carries the OOXML media type',
    )
    const kinds = parsed.nodes.map((node) => node.kind)
    assert.ok(kinds.includes('document'), `expected a document node, got ${kinds.join(', ')}`)
    assert.ok(kinds.includes('chapter'), `expected a chapter node, got ${kinds.join(', ')}`)
    assert.equal(parsed.nodes.find((node) => node.kind === 'chapter')?.name, 'Introduction')
    // No body text is projected, even though the package contains it.
    assert.ok(!JSON.stringify(parsed).includes('SECRET_BODY_TEXT'))

    // The metadata-only result is cached like a text parse.
    const again = service.parse({ path: 'docs/review.docx' })
    assert.equal(again.cached, true)
    assert.equal(again.parserId, 'office')
    assert.equal(again.nodes.length, parsed.nodes.length)

    // `.pub` is refused with the parser's own diagnostic; no byte is read.
    const refused = service.parse({ path: 'docs/legacy.pub' })
    assert.equal(refused.parserId, 'office')
    assert.equal(refused.status, 'unverifiable')
    assert.deepEqual(refused.nodes, [])
    assert.ok(
      refused.diagnostics.some((diagnostic) => (diagnostic.code as string) === 'unsupported-format'),
      'expected the Office parser unsupported-format diagnostic',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('parse service: an Office package above the byte cap is refused, never partially parsed', () => {
  const root = mkdtempSync(join(tmpdir(), 'coordination-wiring-'))
  try {
    writeFileSync(join(root, 'big.docx'), Buffer.alloc(256, 0x50))
    const service = new ParseService({ workspaceRoot: root, maxFileBytes: 64 })
    const parsed = service.parse({ path: 'big.docx' })

    assert.equal(parsed.parserId, 'office')
    assert.equal(parsed.truncated, true)
    assert.deepEqual(parsed.nodes, [])
    assert.ok(
      parsed.diagnostics.some((diagnostic) => diagnostic.code === 'text-limit'),
      'expected a text-limit diagnostic for the size cap',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
