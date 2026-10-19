/**
 * 页面侧的操作：读文本、取无障碍树、点、输入、等、截图。
 *
 * 每个函数只做一件事并返回结构化结果；工具层负责把它渲染成给模型看的文字。
 * 页面上的一切都是不可信数据：这里只取它、报告它，不执行页面给的字符串。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 截图目录放在系统临时区，不需要清理契约。 */
export const SHOT_DIR = join(tmpdir(), 'dsh-sidebar-cdp', 'shots')

/** 「按选择器或可见文字找到元素」的页内实现，点与输入共用同一套定位词汇。 */
export const RESOLVE_JS = `(function(selector, text){
  if (selector) {
    const el = document.querySelector(selector);
    if (!el) return { error: 'no element matches selector: ' + selector };
    return { el };
  }
  const wanted = (text || '').trim();
  if (!wanted) return { error: 'needs selector or text' };
  const nodes = Array.from(document.querySelectorAll('a,button,input,[role=button],[role=link],summary,label,li,td,th,h1,h2,h3,h4,p,span,div'));
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const exact = nodes.find(n => norm(n.innerText || n.value || n.textContent) === wanted);
  const hit = exact || nodes.find(n => norm(n.innerText || n.value || n.textContent).includes(wanted));
  if (!hit) return { error: 'no element contains text: ' + wanted };
  return { el: hit };
})`

/** 页内求值；页面抛错时把页面自己的错误原话带出来，而不是只说「失败」。 */
export async function evaluate(session, expression, timeoutMs = 20000) {
  const result = await session.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, timeoutMs)
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails
    throw new Error(detail.exception?.description || detail.text || '页内求值失败')
  }
  return result.result?.value
}

/** 当前地址、标题、就绪状态。 */
export function pageInfo(session) {
  return evaluate(session, '({ url: location.href, title: document.title, ready: document.readyState })')
}

/** 读可见文本与前 40 条链接；长度按调用方给的预算截断。 */
export function readPage(session, limit) {
  return evaluate(session, `(() => {
    const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim();
    const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 40).map(a => ({
      text: (a.innerText || a.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
      href: a.href,
    })).filter(l => l.text);
    return { text: text.slice(0, ${limit}), truncated: text.length > ${limit}, links };
  })()`)
}

/** 无障碍树压成一行一个节点；ignored 节点提升子节点，InlineTextBox 丢弃。 */
export function formatAx(nodes, maxLines) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]))
  const lines = []
  const walk = (node, depth) => {
    if (!node || lines.length >= maxLines) return
    const role = node.role?.value || ''
    if (node.ignored || role === 'InlineTextBox') {
      for (const id of node.childIds || []) walk(byId.get(id), depth)
      return
    }
    const name = (node.name?.value || '').replace(/\s+/g, ' ').trim()
    if (role || name) {
      const pad = '  '.repeat(Math.min(depth, 12))
      lines.push(`${pad}${role}${name ? ` "${name.slice(0, 120)}"` : ''}`)
      depth += 1
    }
    for (const id of node.childIds || []) walk(byId.get(id), depth)
  }
  walk(nodes[0], 0)
  if (lines.length === 0) lines.push('(empty accessibility tree)')
  return lines.join('\n')
}

/** 取整棵无障碍树并压成文本，同时报出实际节点数与是否截断。 */
export async function snapshot(session, maxLines, timeoutMs = 30000) {
  await session.send('Accessibility.enable', {}, timeoutMs).catch(() => {})
  const { nodes = [] } = await session.send('Accessibility.getFullAXTree', {}, timeoutMs)
  const text = formatAx(nodes, maxLines)
  return { text, nodes: nodes.length, truncated: text.split('\n').length >= maxLines }
}

/**
 * 点之前先问页面三件事：元素盒子在哪、落点是不是它、谁在上面。
 * 真实鼠标打到遮罩上时「没报错」是最危险的成功，所以落点不是它就不点。
 */
export async function probeClick(session, selector, text) {
  return evaluate(session, `(() => {
    const r = ${RESOLVE_JS}(${JSON.stringify(selector || '')}, ${JSON.stringify(text || '')});
    if (r.error) return r;
    const el = r.el;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return { error: 'element has no box (hidden?)' };
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    const top = document.elementFromPoint(x, y);
    return {
      x, y,
      hit: !!(top && (top === el || el.contains(top) || top.contains(el))),
      tag: el.tagName,
      label: (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
      blocker: top && top !== el ? (top.tagName + ' ' + (top.className || '')) : '',
    };
  })()`)
}

/** 真实鼠标事件：移动、按下、抬起，三件套。 */
export async function clickAt(session, x, y) {
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

/**
 * 输入：先确认焦点真的落在目标上（页面会抢焦点），拿到就用真实 insertText；
 * 再兜底用原生 setter 写值并派发 input/change（React 受控组件由此更新），
 * 最后把读回来的值交给调用方——不报「假成功」。
 */
export async function typeInto(session, { selector, text, value, submit }) {
  const target = JSON.stringify(selector || '')
  const hint = JSON.stringify(text || '')
  const next = JSON.stringify(value ?? '')

  const focus = await evaluate(session, `(() => {
    const r = ${RESOLVE_JS}(${target}, ${hint});
    if (r.error) return r;
    const el = r.el;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    if (typeof el.select === 'function') el.select();
    return { focused: document.activeElement === el, tag: el.tagName, type: el.type || '', readOnly: !!el.readOnly, disabled: !!el.disabled };
  })()`)
  if (focus.error) throw new Error(focus.error)
  if (focus.readOnly) throw new Error(`目标 ${focus.tag} 是只读的，没有输入任何字符`)
  if (focus.disabled) throw new Error(`目标 ${focus.tag} 是禁用的，没有输入任何字符`)

  if (focus.focused) await session.send('Input.insertText', { text: String(value ?? '') })

  const typed = await evaluate(session, `(() => {
    const r = ${RESOLVE_JS}(${target}, ${hint});
    if (r.error) return r;
    const el = r.el;
    const next = ${next};
    if (el.isContentEditable) {
      if (!(el.textContent || '').includes(next)) {
        el.focus();
        el.textContent = next;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: next }));
      }
    } else if ((el.value ?? '') !== next) {
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, next); else el.value = next;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { tag: el.tagName, type: el.type || '', value: el.value ?? el.textContent ?? '' };
  })()`)
  if (typed.error) throw new Error(typed.error)

  if (submit) {
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await new Promise((resolve) => setTimeout(resolve, 800))
  }
  return typed
}

/** 等一个选择器出现；返回等了多久，超时就报出到底等了什么。 */
export async function waitForSelector(session, selector, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const found = await evaluate(session, `!!document.querySelector(${JSON.stringify(selector)})`)
    if (found) return { found: true, waitedMs: Date.now() - started }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`等待 ${selector} 超时（${timeoutMs}ms）`)
}

/** 截图写盘；返回路径与大小。 */
export async function screenshot(session, fullPage) {
  await session.send('Page.enable').catch(() => {})
  // fromSurface 走合成器，页面被遮挡/后台化时可能一直等不到帧；超时就退回渲染器路径。
  let shot
  try {
    shot = await session.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: !!fullPage,
      fromSurface: true,
    }, 30000)
  } catch {
    shot = await session.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      fromSurface: false,
      optimizeForSpeed: true,
    }, 30000)
  }
  mkdirSync(SHOT_DIR, { recursive: true })
  const file = join(SHOT_DIR, `shot-${Date.now()}.png`)
  const bytes = Buffer.from(shot.data, 'base64')
  writeFileSync(file, bytes)
  return { path: file, bytes: bytes.length }
}

/** 导航并等 load 事件（不依赖 readyState 轮询，跳转中的页面也会等对）。 */
export async function navigate(session, url, timeoutMs = 30000) {
  await session.send('Page.enable')
  const loaded = new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    session.on('Page.loadEventFired', () => { clearTimeout(timer); resolve() })
  })
  const result = await session.send('Page.navigate', { url }, timeoutMs)
  if (result.errorText) throw new Error(`导航失败：${result.errorText}`)
  await loaded
  return pageInfo(session)
}
