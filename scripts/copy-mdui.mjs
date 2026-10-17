/**
 * Copy MDUI's global stylesheet into the built package.
 *
 * The client half imports MDUI's component JS through the bundler, but its theme
 * sheet is plain CSS: tsdown does not process CSS imports, so the file is copied
 * next to lib/index.mjs and served by the host half at /deepseek-coordination/static/.
 * Copying rather than loading from a CDN keeps the plugin version-locked to the
 * MDUI it was built against and working without network access.
 */
import { copyFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(packageRoot, 'node_modules', 'mdui', 'mdui.css')
const targetDir = join(packageRoot, 'lib', 'static')

await mkdir(targetDir, { recursive: true })
await copyFile(source, join(targetDir, 'mdui.css'))
console.log('copied mdui.css -> lib/static/mdui.css')
