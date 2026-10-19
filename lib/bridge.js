/**
 * host 侧的桥：注册两条插件路由，把工具调用变成「客户端半边的往返」。
 *
 *   GET  /dsh-sidebar-cdp/jobs?wait=20000   客户端长轮询取任务（没有就挂住，超时 204）
 *   POST /dsh-sidebar-cdp/result            客户端回写结果
 *
 * 路由由本插件自己拥有，所以信任检查必须自己做：webserver 的普通路由不做任何
 * 检查，跳过它等于让本机任何进程都能借用户的登录态驱动侧栏。`connection`
 * 服务在时用它的判断（与 /api 同一套），不在时退化成仅回环。
 */
import { randomUUID } from 'node:crypto'

/** 客户端每 20s 至少来一次；超过这个时间没动静就认为它没在跑。 */
const CLIENT_STALE_MS = 45000

/**
 * 建一座桥并注册路由。
 * @param ctx 插件上下文（会等 webServer / connection 就位）。
 * @returns 只有 call 一个方法的对象。
 */
export function createBridge(ctx) {
  /** 排队等客户端取走的任务。 */
  const queue = []
  /** 等结果的调用方：jobId → {resolve, reject, timer}。 */
  const waiting = new Map()
  /** 挂着的长轮询响应，有新任务时叫醒它。 */
  let parked = null
  /** 客户端最后一次来取任务的时间。 */
  let lastPollAt = 0

  /** 叫醒挂着的长轮询（如果有）。 */
  function wake() {
    if (!parked) return
    const current = parked
    parked = null
    current.done()
  }

  /** 把一个任务交给客户端，并等它回话。 */
  function call(op, args = {}, timeoutMs = 30000) {
    const id = randomUUID()
    const job = { id, op, args }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id)
        const stale = Date.now() - lastPollAt > CLIENT_STALE_MS
        reject(new Error(stale
          ? '侧栏插件没有客户端半边在跑：桌面版需要重启一次（新客户端模块在启动时加载）。'
          : `客户端半边 ${timeoutMs}ms 没有回话（任务 ${op}）`))
      }, timeoutMs)
      waiting.set(id, { resolve, reject, timer })
      queue.push(job)
      wake()
    })
  }

  /** 读完请求体（只用于很小的 JSON）。 */
  async function readBody(request, limit = 1 << 20) {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > limit) throw new Error('请求体过大')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  /** 与 /api 同一套信任判断；没有 connection 服务时只放行回环来源。 */
  function rejection(scoped, request) {
    const connection = ctx.get?.('connection') ?? scoped?.connection
    if (connection?.requestRejection) return connection.requestRejection(request)
    const remote = request.socket?.remoteAddress || ''
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
    return loopback ? undefined : 403
  }

  /** 把路由挂到 webserver 上；插件卸载时随 effect 一起撤销。 */
  function registerRoutes() {
    ctx.inject(['webServer'], (scoped) => {
      scoped.effect(() => scoped.webServer.register({
        kind: 'exact',
        path: '/dsh-sidebar-cdp/jobs',
        handler: async (request, response) => {
          const denied = rejection(scoped, request)
          if (denied !== undefined) {
            response.writeHead(denied, { 'Content-Type': 'text/plain' })
            response.end(denied === 401 ? 'Unauthorized' : 'Forbidden')
            return
          }
          lastPollAt = Date.now()
          if (queue.length > 0) {
            response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
            response.end(JSON.stringify(queue.shift()))
            return
          }
          await new Promise((resolve) => {
            const timer = setTimeout(() => done(), 20000)
            const done = () => {
              clearTimeout(timer)
              if (parked === current) parked = null
              resolve()
            }
            const current = { done }
            parked = current
            // 客户端那边断开时不必等满 20 秒。注意监听 response 而不是 request：
            // Node 的 IncomingMessage 在请求体读完时就会 emit 'close'，GET 会立刻触发。
            response.on('close', done)
          })
          if (queue.length === 0) {
            response.writeHead(204, { 'Cache-Control': 'no-store' })
            response.end()
            return
          }
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          response.end(JSON.stringify(queue.shift()))
        },
      }), 'dsh-sidebar-cdp: jobs route')

      scoped.effect(() => scoped.webServer.register({
        kind: 'exact',
        path: '/dsh-sidebar-cdp/result',
        handler: async (request, response) => {
          const denied = rejection(scoped, request)
          if (denied !== undefined) {
            response.writeHead(denied, { 'Content-Type': 'text/plain' })
            response.end(denied === 401 ? 'Unauthorized' : 'Forbidden')
            return
          }
          let body
          try {
            body = JSON.parse(await readBody(request))
          } catch (error) {
            response.writeHead(400, { 'Content-Type': 'text/plain' })
            response.end(`bad json: ${error.message}`)
            return
          }
          const entry = waiting.get(body.id)
          if (entry) {
            waiting.delete(body.id)
            clearTimeout(entry.timer)
            if (body.ok) entry.resolve(body.value)
            else entry.reject(new Error(body.error || '客户端执行失败'))
          }
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end('{"ok":true}')
        },
      }), 'dsh-sidebar-cdp: result route')
    })
  }

  /** 客户端是否在跑（用于给出人话错误）。 */
  function connected() {
    return Date.now() - lastPollAt <= CLIENT_STALE_MS
  }

  return { call, registerRoutes, connected }
}
