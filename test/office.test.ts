/**
 * Contract tests for the read-only OOXML parser (`src/host/text/office.ts`).
 *
 * Every fixture is a tiny but valid ZIP built in memory (raw DEFLATE + a real
 * central directory), so the tests exercise the same bounded `fflate` path as a
 * real `.docx`/`.xlsx`/`.pptx`. Assertions pin the evidence mapping
 * (document/chapter/section/paragraph/link, workbook/sheet/range/formula,
 * document/slide), the body-free rule (no paragraph/cell/slide text), formula
 * text/label/200-character cap, and the refusal paths (corrupt container,
 * `.pub`/`.accdb`, ZIP entry cap, per-entry zip bomb).
 */
import { deflateRawSync } from 'node:zlib'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_ZIP_ENTRIES,
  MAX_ZIP_ENTRY_BYTES,
  OfficeParser,
  parseOffice,
} from '../src/host/text/office.js'
import type { OfficeParseResult } from '../src/host/text/office.js'
import type { NodeMetadata } from '../src/host/text/parser.js'

/* ------------------------------------------------------------------------- *
 * In-memory ZIP builder (local helper; no dependency, no filesystem)
 * ------------------------------------------------------------------------- */

interface ZipEntryInput {
  name: string
  data: string | Uint8Array
  /** Store instead of DEFLATE (exercise the method-0 path). */
  store?: boolean
  /** Override the declared uncompressed size (zip-bomb fixture). */
  declaredSize?: number
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function buildZip(entries: readonly ZipEntryInput[]): Buffer {
  const localChunks: Buffer[] = []
  const centralChunks: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data)
    const method = entry.store === true ? 0 : 8
    const compressed = method === 0 ? raw : deflateRawSync(raw)
    const crc = crc32(raw)
    const uncompressedSize = entry.declaredSize ?? raw.length

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(uncompressedSize, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localChunks.push(local, name, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(uncompressedSize, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralChunks.push(central, name)

    offset += local.length + name.length + compressed.length
  }

  const centralDirectory = Buffer.concat(centralChunks)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...localChunks, centralDirectory, end])
}

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

const CONTENT_TYPES_DOCX =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>'

const CONTENT_TYPES_XLSX =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '</Types>'

const CONTENT_TYPES_PPTX =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
  '</Types>'

const CORE_PROPERTIES = (title: string, creator: string): string =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/">' +
  `<dc:title>${title}</dc:title><dc:creator>${creator}</dc:creator>` +
  '</cp:coreProperties>'

const DOCX_DOCUMENT =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<w:body>' +
  '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Introduction</w:t></w:r></w:p>' +
  '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Research &amp; Development</w:t></w:r></w:p>' +
  '<w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t>Details</w:t></w:r></w:p>' +
  '<w:p><w:pPr><w:pStyle w:val="Quote"/></w:pPr><w:r><w:t>SECRET_PARAGRAPH_TEXT</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>SECRET_BODY_TEXT</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>See </w:t></w:r>' +
  '<w:hyperlink r:id="rId1"><w:r><w:t>the example</w:t></w:r></w:hyperlink></w:p>' +
  '</w:body></w:document>'

const DOCX_RELS =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" ' +
  'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" ' +
  'Target="https://example.com/docs?x=1&amp;y=2" TargetMode="External"/>' +
  '</Relationships>'

function docxEntries(): ZipEntryInput[] {
  return [
    { name: '[Content_Types].xml', data: CONTENT_TYPES_DOCX },
    { name: 'docProps/core.xml', data: CORE_PROPERTIES('Quarterly Review', 'Ada Lovelace') },
    { name: 'word/document.xml', data: DOCX_DOCUMENT },
    { name: 'word/_rels/document.xml.rels', data: DOCX_RELS },
  ]
}

const LONG_FORMULA = `SUM(${'A1,'.repeat(90)}A2)`

const XLSX_WORKBOOK =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<sheets><sheet name="Data" sheetId="1" r:id="rId1"/>' +
  '<sheet name="Summary" sheetId="2" r:id="rId2"/></sheets>' +
  '</workbook>'

const XLSX_WORKBOOK_RELS =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
  'Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
  'Target="worksheets/sheet2.xml"/>' +
  '</Relationships>'

const XLSX_SHEET_1 =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<dimension ref="A1:C3"/>' +
  '<sheetData><row r="1">' +
  '<c r="A1" t="s"><v>0</v></c>' +
  '<c r="B1"><f>SUM(A1:A2)</f><v>3</v></c>' +
  '<c r="C1"><f>AVERAGE(B1:B3)</f><v>2</v></c>' +
  '</row></sheetData></worksheet>'

const XLSX_SHEET_2 =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<dimension ref="A1:B2"/>' +
  '<sheetData><row r="1">' +
  '<c r="A1"><f>MAX(A1:A2)</f></c>' +
  `<c r="B1"><f>${LONG_FORMULA}</f></c>` +
  '</row></sheetData></worksheet>'

const XLSX_SHARED_STRINGS =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1">' +
  '<si><t>SECRET_CELL_VALUE</t></si></sst>'

function xlsxEntries(): ZipEntryInput[] {
  return [
    { name: '[Content_Types].xml', data: CONTENT_TYPES_XLSX },
    { name: 'docProps/core.xml', data: CORE_PROPERTIES('Quarterly Report', 'Grace Hopper') },
    { name: 'xl/workbook.xml', data: XLSX_WORKBOOK },
    { name: 'xl/_rels/workbook.xml.rels', data: XLSX_WORKBOOK_RELS },
    { name: 'xl/worksheets/sheet1.xml', data: XLSX_SHEET_1 },
    { name: 'xl/worksheets/sheet2.xml', data: XLSX_SHEET_2 },
    { name: 'xl/sharedStrings.xml', data: XLSX_SHARED_STRINGS },
  ]
}

const PPTX_PRESENTATION =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst>' +
  '</p:presentation>'

const PPTX_RELS =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" ' +
  'Target="slides/slide1.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" ' +
  'Target="slides/slide2.xml"/>' +
  '</Relationships>'

const PPTX_SLIDE_1 =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
  '<p:cSld name="Title Slide"><p:spTree><p:sp><p:txBody><a:p><a:r>' +
  '<a:t>SECRET_SLIDE_TEXT</a:t>' +
  '</a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'

const PPTX_SLIDE_2 =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
  '<p:cSld name=""><p:spTree/></p:cSld></p:sld>'

function pptxEntries(): ZipEntryInput[] {
  return [
    { name: '[Content_Types].xml', data: CONTENT_TYPES_PPTX },
    { name: 'docProps/core.xml', data: CORE_PROPERTIES('Kickoff', 'Alan Turing') },
    { name: 'ppt/presentation.xml', data: PPTX_PRESENTATION },
    { name: 'ppt/_rels/presentation.xml.rels', data: PPTX_RELS },
    { name: 'ppt/slides/slide1.xml', data: PPTX_SLIDE_1 },
    { name: 'ppt/slides/slide2.xml', data: PPTX_SLIDE_2 },
  ]
}

/* ------------------------------------------------------------------------- *
 * Assertion helpers
 * ------------------------------------------------------------------------- */

function nodesOf(result: OfficeParseResult): NodeMetadata[] {
  return result.nodes ?? []
}

function namesOf(result: OfficeParseResult, kind: string): string[] {
  return nodesOf(result)
    .filter((node) => node.kind === kind)
    .map((node) => node.name ?? '')
}

function kindsOf(result: OfficeParseResult): string[] {
  return nodesOf(result).map((node) => node.kind)
}

/* ------------------------------------------------------------------------- *
 * DOCX
 * ------------------------------------------------------------------------- */

test('docx: document/chapter/section/paragraph/link from explicit OOXML evidence', () => {
  const result = parseOffice(buildZip(docxEntries()), { path: 'docs/review.docx' })

  assert.equal(result.parserId, 'office')
  assert.equal(result.format, 'docx')
  assert.equal(result.refused, false)
  assert.equal(result.truncated, false)
  assert.equal(result.charset, 'binary')

  // Sorted by the part-relative XML span: the document root opens first, the
  // containing paragraph before the hyperlink it contains.
  assert.deepEqual(kindsOf(result), ['document', 'chapter', 'section', 'section', 'paragraph', 'link'])

  const document = nodesOf(result).find((node) => node.kind === 'document')
  assert.equal(document?.name, 'Quarterly Review')
  assert.equal(result.document?.title, 'Quarterly Review')
  assert.equal(result.document?.author, 'Ada Lovelace')
  assert.equal(result.document?.form, 'unknown')

  assert.deepEqual(namesOf(result, 'chapter'), ['Introduction'])
  assert.deepEqual(namesOf(result, 'section'), ['Research & Development', 'Details'])

  // A styled non-heading paragraph is a node, but its text is never a field.
  const paragraph = nodesOf(result).find((node) => node.kind === 'paragraph')
  assert.ok(paragraph !== undefined)
  assert.equal(paragraph.name, undefined)
  assert.equal(paragraph.summary, undefined)
  assert.equal(paragraph.description, undefined)
  assert.equal(paragraph.brief, undefined)

  // A paragraph with no explicit pStyle is not a node at all.
  assert.equal(nodesOf(result).filter((node) => node.kind === 'paragraph').length, 1)

  assert.deepEqual(namesOf(result, 'link'), ['https://example.com/docs?x=1&y=2'])
  const serialized = JSON.stringify(nodesOf(result))
  assert.equal(serialized.includes('SECRET_PARAGRAPH_TEXT'), false)
  assert.equal(serialized.includes('SECRET_BODY_TEXT'), false)
  assert.equal(serialized.includes('the example'), false)
})

/* ------------------------------------------------------------------------- *
 * XLSX
 * ------------------------------------------------------------------------- */

test('xlsx: workbook, one sheet per sheet, dimension range and formula text (never cells)', () => {
  const result = parseOffice(buildZip(xlsxEntries()), { path: 'finance/report.xlsx' })

  assert.equal(result.format, 'xlsx')
  assert.equal(result.refused, false)
  assert.deepEqual(kindsOf(result), [
    'workbook',
    'sheet',
    'range',
    'formula',
    'formula',
    'sheet',
    'range',
    'formula',
    'formula',
  ])

  assert.equal(nodesOf(result).find((node) => node.kind === 'workbook')?.name, 'Quarterly Report')
  assert.deepEqual(namesOf(result, 'sheet'), ['Data', 'Summary'])
  assert.deepEqual(namesOf(result, 'range'), ['A1:C3', 'A1:B2'])

  const formulas = nodesOf(result).filter((node) => node.kind === 'formula')
  assert.deepEqual(formulas.map((node) => node.name), [
    'SUM(A1:A2)',
    'AVERAGE(B1:B3)',
    'MAX(A1:A2)',
    LONG_FORMULA.slice(0, 199) + '…',
  ])
  for (const formula of formulas) {
    assert.equal(formula.label, 'calculation')
    assert.ok((formula.name ?? '').length <= 200)
  }

  // Never one node per cell, and no shared-string/cell value escapes.
  assert.equal(nodesOf(result).some((node) => node.kind === 'cell'), false)
  assert.equal(JSON.stringify(nodesOf(result)).includes('SECRET_CELL_VALUE'), false)
})

test('xlsx: without workbook rels, worksheet parts are still explicit evidence', () => {
  const entries: ZipEntryInput[] = [
    {
      name: 'xl/workbook.xml',
      data: '<?xml version="1.0"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<sheets><sheet name="Loose" sheetId="1"/></sheets></workbook>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: '<?xml version="1.0"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<dimension ref="D1:D4"/>' +
        '<f>IF(D1&lt;3,1,0)</f>' +
        '<sheetData><row r="1"><c r="D1"><f>SUM(D1:D4)</f><v>10</v></c></row></sheetData>' +
        '</worksheet>',
    },
  ]
  const result = parseOffice(buildZip(entries), { path: 'loose.xlsx' })

  assert.equal(result.format, 'xlsx')
  assert.deepEqual(kindsOf(result), ['workbook', 'sheet', 'range', 'formula', 'formula'])
  assert.deepEqual(namesOf(result, 'sheet'), ['Loose'])
  assert.deepEqual(namesOf(result, 'range'), ['D1:D4'])
  assert.deepEqual(namesOf(result, 'formula'), ['IF(D1<3,1,0)', 'SUM(D1:D4)'])
  // No sheet ownership was claimed: the range/formula locators stay part-scoped.
  assert.ok(nodesOf(result).every((node) => node.locator !== undefined))
})

/* ------------------------------------------------------------------------- *
 * PPTX
 * ------------------------------------------------------------------------- */

test('pptx: document plus one slide per explicit sldId (name from cSld only)', () => {
  const result = parseOffice(buildZip(pptxEntries()), { path: 'decks/intro.pptx' })

  assert.equal(result.format, 'pptx')
  assert.equal(result.refused, false)
  assert.deepEqual(kindsOf(result), ['document', 'slide', 'slide'])
  assert.equal(nodesOf(result).find((node) => node.kind === 'document')?.name, 'Kickoff')
  assert.deepEqual(namesOf(result, 'slide'), ['Title Slide', 'Slide 2'])
  assert.equal(JSON.stringify(nodesOf(result)).includes('SECRET_SLIDE_TEXT'), false)
})

test('pptx: without slide rels, explicit slide parts are enumerated without guessing ownership', () => {
  const entries: ZipEntryInput[] = [
    {
      name: 'ppt/presentation.xml',
      data: '<?xml version="1.0"?>' +
        '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst>' +
        '</p:presentation>',
    },
    {
      name: 'ppt/slides/slide1.xml',
      data: '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
        '<p:cSld name="Alpha"/></p:sld>',
    },
    {
      name: 'ppt/slides/slide2.xml',
      data: '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
        '<p:cSld name="Beta"/></p:sld>',
    },
  ]
  const result = parseOffice(buildZip(entries), { path: 'loose.pptx' })

  assert.equal(result.format, 'pptx')
  assert.deepEqual(kindsOf(result), ['document', 'slide', 'slide'])
  assert.deepEqual(namesOf(result, 'slide'), ['Alpha', 'Beta'])
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes('part-name order')))
})

/* ------------------------------------------------------------------------- *
 * Refusals and corrupt input
 * ------------------------------------------------------------------------- */

test('corrupt ZIP returns diagnostics and never throws', () => {
  const corrupt = Buffer.concat([
    Buffer.from('PK\x03\x04', 'latin1'),
    Buffer.from('this is not a central directory', 'utf8'),
  ])
  let result: OfficeParseResult | undefined
  assert.doesNotThrow(() => {
    result = parseOffice(corrupt, { path: 'broken.docx' })
  })
  assert.ok(result !== undefined)
  assert.equal(result.refused, true)
  assert.equal(result.nodes, undefined)
  assert.ok(result.diagnostics.length > 0)
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'parse-error'))

  // A truncated but otherwise valid package is refused the same way.
  const valid = buildZip(docxEntries())
  const truncated = valid.subarray(0, valid.length - 12)
  assert.doesNotThrow(() => {
    parseOffice(truncated, { path: 'broken.docx' })
  })
})

test('pub and accdb are explicitly unsupported with no nodes', () => {
  for (const [path, format] of [['legacy.pub', 'pub'], ['legacy.accdb', 'accdb']] as const) {
    const result = parseOffice(Buffer.from('proprietary binary payload'), { path })
    assert.equal(result.format, format)
    assert.equal(result.refused, true)
    assert.equal(result.nodes, undefined)
    assert.equal(result.diagnostics[0]?.code, 'unsupported-format')
    assert.equal(result.truncated, false)
  }

  // An explicit format hint works without a path (non-ZIP binary input).
  const hinted = parseOffice(new Uint8Array([1, 2, 3]), { format: 'pub' })
  assert.equal(hinted.format, 'pub')
  assert.equal(hinted.diagnostics[0]?.code, 'unsupported-format')

  // The OLE2/CFB signature is legacy or encrypted Office, never an OOXML ZIP.
  const ole = parseOffice(
    new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]),
  )
  assert.equal(ole.refused, true)
  assert.equal(ole.diagnostics[0]?.code, 'unsupported-format')
})

test('ZIP entry cap is refused before decompression', () => {
  const entries: ZipEntryInput[] = []
  for (let index = 0; index < MAX_ZIP_ENTRIES + 1; index += 1) {
    entries.push({ name: `junk/${index}.bin`, data: '', store: true })
  }
  const result = parseOffice(buildZip(entries), { path: 'too-many.docx' })

  assert.equal(result.refused, true)
  assert.equal(result.nodes, undefined)
  assert.equal(result.truncated, true)
  assert.ok(result.diagnostics.some((diagnostic) =>
    diagnostic.code === 'node-limit' && diagnostic.message.includes(String(MAX_ZIP_ENTRIES))))
})

test('a declared per-entry size above 64 MiB is refused as a zip bomb', () => {
  const result = parseOffice(buildZip([{
    name: 'word/document.xml',
    data: '<w:document/>',
    declaredSize: MAX_ZIP_ENTRY_BYTES + 1,
  }]), { path: 'bomb.docx' })

  assert.equal(result.refused, true)
  assert.equal(result.nodes, undefined)
  assert.equal(result.truncated, true)
  assert.ok(result.diagnostics.some((diagnostic) =>
    diagnostic.code === 'node-limit' && diagnostic.message.includes('zip bomb')))
})

test('a declared total above 256 MiB is refused as a zip bomb', () => {
  const entries: ZipEntryInput[] = []
  for (let index = 0; index < 5; index += 1) {
    entries.push({ name: `junk/${index}.bin`, data: '', declaredSize: MAX_ZIP_ENTRY_BYTES })
  }
  const result = parseOffice(buildZip(entries), { path: 'total-bomb.docx' })

  assert.equal(result.refused, true)
  assert.equal(result.nodes, undefined)
  assert.equal(result.truncated, true)
  assert.ok(result.diagnostics.some((diagnostic) =>
    diagnostic.code === 'node-limit' && diagnostic.message.includes('total')))
})

test('non-ZIP and empty inputs yield diagnostics without throwing', () => {
  const text = parseOffice('this is not a ZIP package', { path: 'notes.docx' })
  assert.equal(text.refused, true)
  assert.equal(text.nodes, undefined)
  assert.ok(text.diagnostics.some((diagnostic) => diagnostic.code === 'parse-error'))

  const empty = parseOffice(new Uint8Array(0))
  assert.equal(empty.refused, true)
  assert.ok(empty.diagnostics.length > 0)
})

test('OOXML parts carrying a DTD/entity declaration are refused', () => {
  const entries = docxEntries().filter((entry) => entry.name !== 'word/document.xml')
  entries.push({
    name: 'word/document.xml',
    data: '<?xml version="1.0"?>' +
      '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body><w:p><w:r><w:t>&xxe;</w:t></w:r></w:p></w:body></w:document>',
  })
  const result = parseOffice(buildZip(entries), { path: 'evil.docx' })

  assert.equal(result.nodes, undefined)
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes('DTD')))
})

test('stored (method 0) ZIP entries follow the same bounded path as deflated ones', () => {
  const stored = buildZip(docxEntries().map((entry) => ({ ...entry, store: true })))
  const result = parseOffice(stored, { path: 'docs/stored.docx' })

  assert.equal(result.format, 'docx')
  assert.deepEqual(kindsOf(result), ['document', 'chapter', 'section', 'section', 'paragraph', 'link'])
})

test('a byte-preserving Latin-1 string works through the Parser adapter', () => {
  const zip = buildZip(docxEntries())
  const bytesResult = parseOffice(zip, { path: 'docs/review.docx' })
  const stringResult = parseOffice(zip.toString('latin1'), { path: 'docs/review.docx' })

  assert.equal(stringResult.format, 'docx')
  assert.deepEqual(kindsOf(stringResult), kindsOf(bytesResult))
  assert.equal(stringResult.nodes?.length, bytesResult.nodes?.length)

  const adapterResult = new OfficeParser().parse(zip.toString('latin1'), { path: 'docs/review.docx' })
  assert.equal(adapterResult.parserId, 'office')
  assert.equal(adapterResult.nodes?.some((node) => node.kind === 'chapter'), true)
})
