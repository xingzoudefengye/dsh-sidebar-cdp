/**
 * 冒烟：用假 ctx 装好插件，确认九个工具都注册了。
 *
 * 默认只验注册——客户端传输层要连桌面版的壳渲染进程，独立 node 进程里没有它。
 * 加 `--cdp 9222` 会对真实调试端口跑只读工具（仅在应用带 --remote-debugging-port
 * 启动时可用，那是可选旁路）。
 *
 * 用法：
 *   node scripts/smoke.mjs
 *   node scripts/smoke.mjs --cdp 9222
 */
import { apply } from '../lib/index.js'

const cdpIndex = process.argv.indexOf('--cdp')
const port = cdpIndex >= 0 ? Number(process.argv[cdpIndex + 1]) || 9222 : null

const tools = new Map()

// 假 ctx：只实现插件用到的那几件事，注册表收下来自己调。
const scope = {
  tools: { register: (tool) => { tools.set(tool.name, tool) } },
  effect: (factory) => factory(),
  get: () => undefined,
  webServer: {
    // 路由装配要能跑通；冒烟里没有真的客户端来轮询。
    register: () => () => {},
    registerUpgrade: () => () => {},
  },
  connection: { requestRejection: () => undefined },
}
const ctx = {
  ...scope,
  inject: (_deps, factory) => factory(scope),
}

apply(ctx, port === null ? { transport: 'client' } : { transport: 'cdp', port })

console.log(`工具数：${tools.size} → ${[...tools.keys()].join(', ')}`)
if (tools.size !== 9) {
  console.error('✗ 工具数量不对')
  process.exit(1)
}

if (port === null) {
  console.log('注册通过。真实链路：在桌面版里打开侧栏网页后调用 sidebar_targets。')
  process.exit(0)
}

const exec = { signal: new AbortController().signal }
let failed = 0

async function run(name, args = {}) {
  const tool = tools.get(name)
  try {
    const value = await tool.execute(args, exec)
    const text = tool.output.render(args, value)
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    console.log(`=== ${name} ===`)
    console.log(text.slice(0, 900))
    console.log()
  } catch (error) {
    console.log(`✗ ${name}: ${error.message}\n`)
    failed++
  }
}

await run('sidebar_targets')
await run('sidebar_read', { limit: 400 })
await run('sidebar_snapshot', { maxLines: 15 })
await run('sidebar_eval', { expression: 'document.title' })
await run('sidebar_wait', { selector: 'body', timeoutMs: 2000 })
await run('sidebar_screenshot')

console.log(failed === 0 ? '全部通过' : `${failed} 项失败`)
process.exitCode = failed === 0 ? 0 : 1
