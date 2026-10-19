/**
 * 传输层门面：工具只认这一套签名，底下是客户端半边还是 CDP 由配置决定。
 *
 *   client（默认）纯插件：路由往返到壳渲染进程，不需要任何启动参数
 *   cdp           可选：只有在应用带 --remote-debugging-port 启动时可用，
 *                 保留它是因为它能给出浏览器自己的无障碍树，也方便离线冒烟
 */
import * as cdp from './cdp.js'
import * as page from './page.js'
import * as clientPage from './client-page.js'

/** 插件启动时注入的桥；client 传输层靠它。 */
let bridge = null

/** 由 index.js 在装配时调用。 */
export function setBridge(value) {
  bridge = value
}

/** 当前传输层。 */
export function transportOf(config) {
  return config?.transport === 'cdp' ? 'cdp' : 'client'
}

/** 选一页并准备好会话。 */
export async function open(config, hint) {
  if (transportOf(config) === 'cdp') {
    const port = Number(config?.port) || 9222
    const target = await cdp.pickTarget(port, hint)
    const session = await cdp.attach(port, target)
    return { kind: 'cdp', cdp: session }
  }
  if (!bridge) throw new Error('侧栏插件的桥没有装配好（插件加载失败？）')
  return { kind: 'client', bridge, target: hint }
}

/** 关掉会话；只有 CDP 需要关连接。 */
export function close(session) {
  if (session?.kind === 'cdp') session.cdp.close()
}

/** 列页面。 */
export async function listTargets(config) {
  if (transportOf(config) === 'cdp') {
    const port = Number(config?.port) || 9222
    let all
    try {
      all = await cdp.listTargets(port)
    } catch (error) {
      throw new Error(cdp.unreachableHint(port, error.message))
    }
    return all.map((target) => ({
      id: target.id,
      type: target.type,
      url: target.url,
      title: target.title,
      usable: cdp.isPageTarget(target),
    }))
  }
  if (!bridge) throw new Error('侧栏插件的桥没有装配好（插件加载失败？）')
  return await clientPage.listTargets(bridge)
}

// --- 页面操作：两条路各取所长，签名一致 ---

export const pageInfo = (session) => pick(session, page.pageInfo, clientPage.pageInfo)(session)
export const readPage = (session, limit) => pick(session, page.readPage, clientPage.readPage)(session, limit)
export const snapshot = (session, maxLines) => pick(session, page.snapshot, clientPage.snapshot)(session, maxLines)
export const probeClick = (session, selector, text) => pick(session, page.probeClick, clientPage.probeClick)(session, selector, text)
export const clickAt = (session, x, y) => pick(session, page.clickAt, clientPage.clickAt)(session, x, y)
export const typeInto = (session, args) => pick(session, page.typeInto, clientPage.typeInto)(session, args)
export const evaluate = (session, code, timeoutMs) => pick(session, page.evaluate, clientPage.evaluate)(session, code, timeoutMs)
export const navigate = (session, url) => pick(session, page.navigate, clientPage.navigate)(session, url)
export const waitForSelector = (session, selector, timeoutMs) => pick(session, page.waitForSelector, clientPage.waitForSelector)(session, selector, timeoutMs)
export const screenshot = (session, fullPage) => pick(session, page.screenshot, clientPage.screenshot)(session, fullPage)

/** 按会话类型选实现。 */
function pick(session, cdpImpl, clientImpl) {
  return session?.kind === 'cdp' ? cdpImpl : clientImpl
}
