/**
 * 客户端传输层的 host 侧门面：与 page.js 同名的函数，内部走桥到壳渲染进程。
 *
 * 这样九个工具只认这套签名，换传输层不改工具语义。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 截图目录与旧的 CDP 实现共用，模型的下一个动作不受传输层影响。 */
const SHOT_DIR = join(tmpdir(), 'sidebar-cdp', 'shots')

/**
 * 打开一页。客户端传输层不需要附着，只保住"选哪一页"这个提示。
 * @param config 插件配置
 * @param hint 选页提示
 */
export async function open(_config, hint) {
  return { kind: 'client', target: hint }
}

/** 一页的标题与地址。 */
export async function pageInfo(session) {
  const answer = await session.bridge.call('info', { target: session.target }, 15000)
  return answer.page
}

/** 读正文与前 40 条链接。 */
export async function readPage(session, limit) {
  return await session.bridge.call('eval', {
    target: session.target,
    code: `__dshSidebarCdp.read(${Number(limit) || 12000})`,
  }, 30000)
}

/** 结构树（客户端模式下是 DOM 结构，不是浏览器无障碍树）。 */
export async function snapshot(session, maxLines) {
  return await session.bridge.call('eval', {
    target: session.target,
    code: `__dshSidebarCdp.tree(${Number(maxLines) || 200})`,
  }, 30000)
}

/**
 * 点击前的落点判断。
 * @returns {{error?:string, hit:boolean, blocker:string|null, x:number, y:number, tag:string, label:string}}
 */
export async function probeClick(session, selector, text) {
  const answer = await session.bridge.call('locate', { target: session.target, selector, text }, 30000)
  const probe = answer.probe || {}
  return {
    error: probe.error,
    hit: probe.error ? false : !probe.covered,
    blocker: probe.blocker ?? null,
    x: probe.x ?? 0,
    y: probe.y ?? 0,
    tag: probe.tag ?? '',
    label: probe.label ?? '',
  }
}

/** 在页面坐标上按一次真实鼠标。 */
export async function clickAt(session, x, y) {
  await session.bridge.call('press', { target: session.target, x, y }, 15000)
}

/** 写入并回报读回来的值。 */
export async function typeInto(session, { selector, text, value, submit }) {
  const typed = await session.bridge.call('eval', {
    target: session.target,
    code: `__dshSidebarCdp.typeInto(${JSON.stringify({ selector, text, value, submit: Boolean(submit) })})`,
  }, 30000)
  if (typed?.error) throw new Error(typed.error)
  return typed
}

/** 在页面里求值。 */
export async function evaluate(session, expression, timeoutMs) {
  const answer = await session.bridge.call('eval', { target: session.target, code: expression }, timeoutMs)
  return answer.value
}

/** 导航并等加载结束。 */
export async function navigate(session, url) {
  const answer = await session.bridge.call('navigate', { target: session.target, url, timeoutMs: 20000 }, 45000)
  return answer.page
}

/** 轮询等一个选择器出现。 */
export async function waitForSelector(session, selector, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const found = await session.bridge.call('eval', {
      target: session.target,
      code: `__dshSidebarCdp.has(${JSON.stringify({ selector })})`,
    }, 15000)
    if (found.value === true) return { found: true, waitedMs: Date.now() - started }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return { found: false, waitedMs: Date.now() - started }
}

/** 截图写盘；客户端给的是 dataURL，这里落成 PNG。 */
export async function screenshot(session, _fullPage) {
  const answer = await session.bridge.call('capture', { target: session.target }, 60000)
  const comma = answer.dataUrl.indexOf(',')
  const bytes = Buffer.from(answer.dataUrl.slice(comma + 1), 'base64')
  mkdirSync(SHOT_DIR, { recursive: true })
  const path = join(SHOT_DIR, `shot-${Date.now()}.png`)
  writeFileSync(path, bytes)
  return { path, bytes: bytes.length }
}

/** 侧栏里所有页面。 */
export async function listTargets(bridge) {
  const answer = await bridge.call('targets', {}, 15000)
  return (answer.pages || []).map((page) => ({
    id: page.id,
    type: 'webview',
    url: page.url,
    title: page.title,
    usable: true,
  }))
}
