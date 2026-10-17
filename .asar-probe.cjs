const fs = require('fs')
const p = 'R:\\harness\\resources\\app.asar'
const fd = fs.openSync(p, 'r')
const head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0)
const jsonSize = head.readUInt32LE(8); const raw = Buffer.alloc(jsonSize); fs.readSync(fd, raw, 0, jsonSize, 16)
const text = raw.toString('utf8'); let depth=0,end=-1,inStr=false,esc=false
for (let i=0;i<text.length;i++){const c=text[i]; if(inStr){if(esc)esc=false;else if(c==='\\')esc=true;else if(c==='"')inStr=false;continue} if(c==='"')inStr=true; else if(c==='{')depth++; else if(c==='}'){depth--; if(depth===0){end=i+1;break}}}
const tree = JSON.parse(text.slice(0,end))
const node = tree.files.dsh.files.node_modules.files['@deepseek-ai'].files['dsh-tools']
function walk(n, pre, d) { for (const [k,v] of Object.entries(n.files||{})) { if (v.files) { console.log('D', d, pre+k); walk(v, pre+k+'/', d+1) } else console.log('F', d, pre+k, v.size) } }
walk(node, '', 0)
fs.closeSync(fd)
