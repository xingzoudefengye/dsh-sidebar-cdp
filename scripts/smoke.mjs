/**
 * 冒烟：用一个假 ctx 装好插件，然后对真实调试端口跑只读工具。
 *
 * 只读是刻意的——它跑在用户正开着的侧栏页面上，点、输入、导航会改人家的页面。
 * 写操作在 test-page.html 上单独验（`node scripts/smoke.mjs --write <port>`）。
 *
 * 用法：node scripts/smoke.mjs [port]
 */
import { apply } from '../lib/index.js'

const port = Number(process.argv[2]) || 9222
const write = process.argv.includes('--write')

// 假 ctx：只实现插件用到的那两件事，注册表收下来自己调。
const tools = new Map()
const ctx = {
  tools: { register: (tool) => { tools.set(tool.name, tool) } },
  effect: (factory) => factory(),
}

apply(ctx, { port })

console.log(`工具数：${tools.size} → ${[...tools.keys()].join(', ')}\n`)

const exec = { signal: new AbortController().signal }
let failed = 0

async function run(name, args = {}) {
  const tool = tools.get(name)
  if (!tool) { console.log(`✗ ${name}: 没有注册`); failed++; return undefined }
  try {
    const value = await tool.execute(args, exec)
    const text = tool.output.render(args, value)
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    console.log(`=== ${name} ===`)
    console.log(text.slice(0, 900))
    console.log()
    return value
  } catch (error) {
    console.log(`✗ ${name}: ${error.message}\n`)
    failed++
    return undefined
  }
}

await run('sidebar_targets')
await run('sidebar_read', { limit: 400 })
await run('sidebar_snapshot', { maxLines: 15 })
await run('sidebar_eval', { expression: 'document.title' })
await run('sidebar_wait', { selector: 'body', timeoutMs: 2000 })
await run('sidebar_screenshot')

if (write) {
  // 写操作只在测试页上有意义：给一个自带输入框与按钮的页面。
  await run('sidebar_navigate', { url: 'file:///E:/Projects/dsh-sidebar-cdp/test-page.html' })
  await run('sidebar_type', { selector: '#name', value: '小宋' })
  await run('sidebar_click', { text: '打招呼' })
  await run('sidebar_eval', { expression: "document.getElementById('out').textContent" })
}

console.log(failed === 0 ? '全部通过' : `${failed} 项失败`)
process.exitCode = failed === 0 ? 0 : 1
