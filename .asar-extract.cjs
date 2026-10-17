const fs = require('fs')
const path = require('path')
const p = 'R:\\harness\\resources\\app.asar'
const outRoot = process.env.TEMP + '\\dsh-checkout'
const fd = fs.openSync(p, 'r')
const head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0)
const jsonSize = head.readUInt32LE(8); const raw = Buffer.alloc(jsonSize); fs.readSync(fd, raw, 0, jsonSize, 16)
const text = raw.toString('utf8'); let depth=0,end=-1,inStr=false,esc=false
for (let i=0;i<text.length;i++){const c=text[i]; if(inStr){if(esc)esc=false;else if(c==='\\')esc=true;else if(c==='"')inStr=false;continue} if(c==='"')inStr=true; else if(c==='{')depth++; else if(c==='}'){depth--; if(depth===0){end=i+1;break}}}
const tree = JSON.parse(text.slice(0,end))
const dataBase = 16 + head.readUInt32LE(4) - 8
const prefixes = [
  'dsh/node_modules/@deepseek-ai/dsh-tools/',
  'dsh/node_modules/@deepseek-ai/dsh-llm/',
  'dsh/node_modules/@deepseek-ai/dsh-session/',
  'dsh/node_modules/@deepseek-ai/dsh-agent/',
  'dsh/node_modules/@deepseek-ai/dsh-agent-loop/',
  'dsh/node_modules/@deepseek-ai/dsh-subagent/',
  'dsh/node_modules/@deepseek-ai/dsh-settings/',
  'dsh/node_modules/@deepseek-ai/dsh-host-webserver/',
  'dsh/node_modules/@deepseek-ai/dsh-commands/',
  'dsh/node_modules/@deepseek-ai/dsh-goal/',
  'dsh/node_modules/@deepseek-ai/dsh-compaction/',
  'dsh/node_modules/@deepseek-ai/dsh-session-query-sqlite/',
  'dsh/node_modules/@deepseek-ai/dsh-storage/',
  'dsh/node_modules/@deepseek-ai/dsh-client-ui-slots/',
  'dsh/node_modules/@deepseek-ai/dsh-client-ui-settings/',
  'dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/',
  'dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/',
  'dsh/node_modules/@deepseek-ai/dsh-client-locale/',
  'dsh/node_modules/@deepseek-ai/dsh-client-ui-permission-presets/',
  'dsh/node_modules/@deepseek-ai/dsh-client-ui-goal/',
  'dsh/node_modules/@deepseek-ai/dsh-client-ui-plan/',
  'dsh/node_modules/@deepseek-ai/dsh-client-ui-primitives/',
  'dsh/node_modules/@deepseek-ai/dsh-web/',
  'dsh/node_modules/@deepseek-ai/dsh-web-search-deepseek/',
  'dsh/node_modules/@deepseek-ai/dsh-base/',
  'dsh/node_modules/@deepseek-ai/dsh/',
]
const keep = /\.(ts|tsx|js|mjs|cjs|json|md|yml|yaml|css)$/i
let copied=0, bytes=0
function walk(node, full) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const nextFull = full + '/' + name
    if (child.files) { walk(child, nextFull); continue }
    if (!keep.test(name)) continue
    if (child.size > 3_000_000) continue
    const dest = path.join(outRoot, nextFull.replace(/^\/?dsh[\\/]/, ''))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const buf = Buffer.alloc(child.size)
    fs.readSync(fd, buf, 0, child.size, dataBase + Number(child.offset))
    fs.writeFileSync(dest, buf)
    copied++; bytes += child.size
  }
}
for (const prefix of prefixes) {
  const parts = prefix.replace(/\/$/, '').split('/')
  let node = tree
  for (const part of parts) node = node.files[part]
  if (!node) { console.log('missing', prefix); continue }
  walk(node, prefix.replace(/\/$/, ''))
}
console.log('copied', copied, 'bytes', bytes, 'to', outRoot)
fs.closeSync(fd)

