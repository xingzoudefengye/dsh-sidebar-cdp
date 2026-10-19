/**
 * CDP 管道：读 /json/list，开一条 WebSocket，发 JSON-RPC。
 *
 * 桌面版带 --remote-debugging-port 启动后，侧栏那个 <webview> 就是一个独立
 * target；这里只做传输，不认识页面内容（页面操作在 page.js）。
 *
 * 没有第三方依赖：Node 24 自带 fetch 和 WebSocket。
 */

/** 连不上端口时给模型看的话；两处（列表与附着）共用，免得措辞漂移。 */
export function unreachableHint(port, cause) {
  return [
    `连不上桌面版的调试端口 127.0.0.1:${port}（${cause}）。`,
    '侧栏浏览器只有在应用带 --remote-debugging-port=9222 启动时才可见。',
    '双击桌面图标（快捷方式已带该参数）或运行 E:\\Projects\\dsh-sidebar-cdp\\launch-debug.cmd，然后重试。',
  ].join('')
}

/** 带超时的 fetch JSON；超时与网络错误都归一成 Error。 */
export async function httpJson(url, timeoutMs = 5000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/** 一条 WebSocket 连接上的 JSON-RPC 会话。 */
export class CdpSession {
  #ws
  #nextId = 1
  #pending = new Map()
  #listeners = new Map()
  #sessionId

  constructor(ws, sessionId) {
    this.#ws = ws
    this.#sessionId = sessionId
    ws.addEventListener('message', (event) => this.#dispatch(event.data))
    ws.addEventListener('close', () => this.#failAll(new Error('CDP 连接已关闭')))
    ws.addEventListener('error', () => this.#failAll(new Error('CDP 连接出错')))
  }

  /** 打开一条连接；握手超时会关掉半开的 socket。 */
  static open(wsUrl, sessionId, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl)
      const timer = setTimeout(() => {
        try { ws.close() } catch {}
        reject(new Error(`CDP 连接超时（${timeoutMs}ms）`))
      }, timeoutMs)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(new CdpSession(ws, sessionId)) }, { once: true })
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败')) }, { once: true })
    })
  }

  #dispatch(raw) {
    let message
    try { message = JSON.parse(typeof raw === 'string' ? raw : raw.toString()) } catch { return }
    if (typeof message.id === 'number') {
      const pending = this.#pending.get(message.id)
      if (!pending) return
      this.#pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(`${message.error.message || 'CDP 错误'}`))
      else pending.resolve(message.result ?? {})
      return
    }
    // 事件：按方法名分发给订阅者，多个订阅者各拿一份。
    for (const handler of this.#listeners.get(message.method) ?? []) {
      try { handler(message.params ?? {}) } catch {}
    }
  }

  /** 发一条命令并等它的结果；每条命令各自计时，避免一个页面卡住整次调用。 */
  send(method, params = {}, timeoutMs = 20000) {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      try {
        const payload = { id, method, params }
        // flatten 模式下，命令要带上目标会话 id 才会落到那一页上。
        if (this.#sessionId) payload.sessionId = this.#sessionId
        this.#ws.send(JSON.stringify(payload))
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(error)
      }
    })
  }

  on(event, handler) {
    const list = this.#listeners.get(event) ?? []
    list.push(handler)
    this.#listeners.set(event, list)
  }

  #failAll(error) {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }

  close() { try { this.#ws.close() } catch {} }
}

/** 当前调试端口上所有可操作的页面（page 与 webview）。 */
export async function listTargets(port, timeoutMs = 5000) {
  const all = await httpJson(`http://127.0.0.1:${port}/json/list`, timeoutMs)
  return all.filter((t) => t.type === 'page' || t.type === 'webview')
}

/** 真正是网页的 target（排除 devtools:// 和浏览器内部页）。 */
export function isPageTarget(target) {
  return typeof target.url === 'string' && /^(https?|file):/.test(target.url) && !target.url.startsWith('devtools://')
}

/**
 * 选一页：target 指的是 id、URL 子串或标题子串；没给就取最后打开的那页。
 * 侧栏每开一个标签就是一个 target，顺序是 Chromium 给的插入顺序。
 */
export async function pickTarget(port, hint, timeoutMs = 5000) {
  let all
  try { all = await listTargets(port, timeoutMs) } catch (error) {
    throw new Error(unreachableHint(port, error.message))
  }
  const usable = all.filter(isPageTarget)
  if (usable.length === 0) {
    throw new Error(`端口 ${port} 上没有可操作的页面，现有 target：${all.map((t) => `${t.type} ${t.url}`).join(' | ') || '(无)'}`)
  }
  if (!hint) return usable[usable.length - 1]
  const hit = usable.find((t) => t.id === hint)
    || usable.find((t) => t.url.includes(hint))
    || usable.find((t) => (t.title || '').includes(hint))
  if (!hit) throw new Error(`没有匹配 "${hint}" 的页面，可选：${usable.map((t) => t.url).join(' | ')}`)
  return hit
}

/** 附着到一页：有页面级 socket 就直连，否则走浏览器 socket + flatten 会话。 */
export async function attach(port, target) {
  if (target.webSocketDebuggerUrl) return CdpSession.open(target.webSocketDebuggerUrl)
  const version = await httpJson(`http://127.0.0.1:${port}/json/version`)
  const browser = await CdpSession.open(version.webSocketDebuggerUrl)
  try {
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId: target.id, flatten: true })
    return CdpSession.open(version.webSocketDebuggerUrl, sessionId)
  } finally { browser.close() }
}