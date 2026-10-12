// json-field.mjs - read one field from a JSON envelope on stdin, addressed by a dotted path.
//
// The test harnesses need to assert on one field of an envelope. Doing that with sed was wrong twice
// over: it cannot see into nested objects, so a path like result.cursor.x was impossible, and a
// same-named top-level field in `meta` won - it reported meta's "platform":"windows" where the real
// answer was result.platform "x11", and two failures were blamed on working code.
//
// It is a file rather than an inline `node -e` because passing a JSON envelope and a JavaScript program
// through PowerShell's argument quoting mangles both, which cost a round to discover.
//
// Usage: json-field.mjs result.cursor.x   < envelope.json
// Prints the value, or nothing when the path is absent or the input is not JSON. Never a partial match:
// an unparseable envelope yields the empty string so the caller's assertion fails loudly rather than
// passing on a coincidence.
const path = (process.argv[2] || '').split('.').filter(Boolean)

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  let value
  try {
    value = JSON.parse(input)
  } catch {
    process.stdout.write('')
    return
  }
  for (const key of path) {
    if (value === null || value === undefined) break
    value = value[key]
  }
  if (value === undefined || value === null) {
    process.stdout.write('')
  } else if (typeof value === 'object') {
    process.stdout.write(JSON.stringify(value))
  } else {
    process.stdout.write(String(value))
  }
})
