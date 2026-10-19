/**
 * 客户端半边：跑在 DSH 桌面版的壳渲染进程里，直接操作侧栏那个 <webview>。
 *
 * 为什么需要它：agent 的工具注册在 host 进程（独立的 node 进程），而页面在
 * 渲染进程。两者之间只隔着插件自己的 HTTP 路由：这里长轮询 host 取任务，执行完
 * 把结果写回去。这样不需要 --remote-debugging-port，也不需要碰官方桌面版。
 *
 * 三个原生能力（都在 <webview> 元素上，实测可用）：
 *   executeJavaScript  读写页面
 *   sendInputEvent     真实鼠标事件（element.click() 不是可信事件）
 *   capturePage        像素
 *
 * 文件形态是客户端的 ModuleLoader 包装，不是普通 ESM——壳由 loader 加载它。
 */
window.__ModuleLoader__.load({
  id: 'dsh-sidebar-cdp',
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports

    /** 只驱动官方侧栏浏览器面板自己创建的 guest；其它 webview 一概不碰。 */
    const SELECTOR = 'webview[data-sidebar-browser-frame="webview"]'
    const JOB_URL = '/dsh-sidebar-cdp/jobs'
    const RESULT_URL = '/dsh-sidebar-cdp/result'
    /** 藏起已断言的提示：老版本没有 Optional chaining 也没关系，壳是新 Chromium。 */
    const POLL_WAIT_MS = 20000

    /** 页内库的版本；改这个字符串就会让所有页面重新注入一次。 */
    const LIB_VERSION = '4'

    /**
     * 注入到被访问页面里的库。函数体被 toString() 后送进 executeJavaScript，
     * 因此它是字符串的一部分，不能引用这个文件里的任何变量。
     */
    function guestLibrary() {
      const state = {
        v: '4',
        refs: new Map(),      // Element → 'e12'
        byRef: new Map(),     // 'e12' → Element
        nextRef: 1,
      }

      const ROLE_BY_TAG = {
        a: 'link', button: 'button', input: 'textbox', textarea: 'textbox',
        select: 'combobox', img: 'img', h1: 'heading', h2: 'heading', h3: 'heading',
        h4: 'heading', h5: 'heading', h6: 'heading', ul: 'list', ol: 'list',
        li: 'listitem', nav: 'navigation', main: 'main', header: 'banner',
        footer: 'contentinfo', table: 'table', tr: 'row', td: 'cell', th: 'columnheader',
        form: 'form', dialog: 'dialog', iframe: 'iframe', label: 'label',
      }

      /** 元素是否画得出来（隐藏的不进树，也不参与定位）。 */
      function visible(el) {
        if (!el || !el.getBoundingClientRect) return false
        if (el.closest('[aria-hidden="true"]')) return false
        const style = getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
        const rect = el.getBoundingClientRect()
        return rect.width > 0 || rect.height > 0
      }

      /** 元素的可见名字，按 aria-label / alt / title / 文本 的顺序取。 */
      function nameOf(el) {
        const attr = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title')
        if (attr && attr.trim()) return collapse(attr)
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          const value = el.value?.trim()
          if (value) return collapse(value)
        }
        const text = el.innerText || el.textContent || ''
        return collapse(text)
      }

      function collapse(text) {
        return String(text).replace(/\s+/g, ' ').trim().slice(0, 120)
      }

      /** 稳定的元素引用：同一页内重取快照不重编号。 */
      function refOf(el) {
        let ref = state.refs.get(el)
        if (ref) return ref
        ref = `e${state.nextRef++}`
        state.refs.set(el, ref)
        state.byRef.set(ref, el)
        return ref
      }

      function roleOf(el) {
        const explicit = el.getAttribute('role')
        if (explicit) return explicit
        if (el.tagName === 'INPUT') {
          const type = (el.getAttribute('type') || 'text').toLowerCase()
          if (type === 'checkbox') return 'checkbox'
          if (type === 'radio') return 'radio'
          if (type === 'submit' || type === 'button') return 'button'
          if (type === 'search') return 'searchbox'
          return 'textbox'
        }
        return ROLE_BY_TAG[el.tagName.toLowerCase()] || el.tagName.toLowerCase()
      }

      /** 结构树：画得出来的元素，一层一行，自带 ref 供 click/type 用。 */
      function tree(maxLines) {
        const out = []
        let nodes = 0
        const walk = (el, depth) => {
          if (out.length >= maxLines) return
          const tag = el.tagName.toLowerCase()
          if (['script', 'style', 'noscript', 'meta', 'link', 'head', 'template'].includes(tag)) return
          if (!visible(el)) return
          if (el.getAttribute('aria-hidden') === 'true') return
          // 纯文本容器不单独成行，名字挂在父节点上
          const role = roleOf(el)
          const name = nameOf(el)
          out.push(`${'  '.repeat(depth)}${role}${name ? ` ${JSON.stringify(name)}` : ''} [${refOf(el)}]`)
          nodes += 1
          for (const child of el.children) walk(child, depth + 1)
        }
        const root = document.body || document.documentElement
        if (root) walk(root, 0)
        return { text: out.join('\n'), nodes, truncated: out.length >= maxLines }
      }

      /** 元素中心是否落在视口里——桌面版页面常带出屏的重复导航，优先动看得见的那个。 */
      function inViewport(el) {
        const rect = el.getBoundingClientRect()
        const x = rect.left + rect.width / 2
        const y = rect.top + rect.height / 2
        return x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight
      }

      /**
       * 按 CSS 选择器或可见文字找元素；selector 优先。
       * 返回 `{ el }` 或 `{ error }`——找不到和「找到了但看不见」必须分开报，
       * 新版页面常把老 input 留成 0×0 的壳，往里写等于白写。
       * 多处命中时优先挑屏幕内的：同一个链接常有两份（吸顶导航 + 页尾导航）。
       */
      function locate(hint) {
        if (!hint) return { error: '没有给出选择器或文字' }
        if (hint.selector) {
          let all = []
          try { all = [...document.querySelectorAll(hint.selector)] } catch { return { error: `选择器写错了：${hint.selector}` } }
          if (all.length === 0) return { error: `没找到目标：选择器 ${hint.selector}` }
          const shown = all.filter((el) => visible(el))
          const best = shown.find((el) => inViewport(el)) || shown[0]
          if (!best) return { error: `${hint.selector} 匹配到 ${all.length} 个元素，但都不可见（0×0 或被藏起来），没有操作` }
          return { el: best }
        }
        const needle = collapse(hint.text || '')
        if (!needle) return { error: '没有给出选择器或文字' }
        const candidates = [...document.querySelectorAll('body *')].filter((el) => visible(el))
        const exact = candidates.filter((el) => collapse(el.innerText || el.textContent || '') === needle)
        const loose = exact.length ? [] : candidates.filter((el) => collapse(el.innerText || el.textContent || '').includes(needle))
        const found = [...exact, ...loose].find((el) => inViewport(el)) || exact[0] || loose[0]
        if (!found) return { error: `没找到文字「${hint.text}」` }
        return { el: found }
      }

      /**
       * 点击前的四条判断：尺寸、落点、是否被盖住、是否在视口内。
       * 落点被别的元素接住时默认拒绝——"没报错"是最危险的成功。
       */
      function probe(hint) {
        const hit = locate(hint)
        if (hit.error) return { error: hit.error }
        const el = hit.el
        const tag = el.tagName.toLowerCase()
        const label = nameOf(el)

        // 先就近滚（不横着甩页面）；还在视口外才按中心滚过去。桌面版页面塞进窄侧栏时
        // 右侧元素本来就出屏，不横滚就永远点不到。
        el.scrollIntoView({ block: 'center', inline: 'nearest' })
        let rect = el.getBoundingClientRect()
        let x = rect.left + rect.width / 2
        let y = rect.top + rect.height / 2
        const outside = () => x < 0 || y < 0 || x > innerWidth || y > innerHeight
        if (outside()) {
          el.scrollIntoView({ block: 'center', inline: 'center' })
          rect = el.getBoundingClientRect()
          x = rect.left + rect.width / 2
          y = rect.top + rect.height / 2
        }
        if (rect.width === 0 && rect.height === 0) {
          return { error: `${tag}「${label}」尺寸是 0（画不出来），没有点击` }
        }
        if (outside()) {
          return { error: `${tag}「${label}」不在视口内（${Math.round(x)},${Math.round(y)}，视口 ${innerWidth}×${innerHeight}），滚过去也够不着，没有点击` }
        }
        const receiver = document.elementFromPoint(x, y)
        const covered = receiver !== el && !el.contains(receiver)
        return {
          tag, label, x, y, covered,
          blocker: covered ? `${receiver?.tagName?.toLowerCase() || '另一个元素'}${nameOf(receiver) ? `「${nameOf(receiver)}」` : ''}` : null,
        }
      }

      /** 写入并回报读回来的值——页面吞掉输入时不能报成功。 */
      function typeInto(hint) {
        const hit = locate(hint)
        if (hit.error) return { error: hit.error }
        const el = hit.el
        const tag = el.tagName.toLowerCase()
        if (el.disabled) return { error: `${tag} 处于 disabled 状态，没有输入` }
        if (el.readOnly) return { error: `${tag} 是只读的，没有输入` }
        el.focus()
        const setter = Object.getOwnPropertyDescriptor(
          el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
          'value',
        )?.set
        if (setter) setter.call(el, hint.value)
        else el.value = hint.value
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        const typed = { tag, type: el.getAttribute('type') || '', value: el.value }
        if (hint.submit) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }))
          el.form?.requestSubmit?.()
        }
        return typed
      }

      const api = {
        v: '4',
        info: () => ({ url: location.href, title: document.title }),
        read: (limit) => {
          const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n')
          const links = [...document.querySelectorAll('a[href]')]
            .slice(0, 40)
            .map((a) => ({ text: collapse(a.innerText || a.textContent || ''), href: a.href }))
          return {
            text: text.length > limit ? `${text.slice(0, limit)}\n…` : text,
            truncated: text.length > limit,
            links,
          }
        },
        tree,
        probe,
        typeInto,
        has: (hint) => !locate(hint).error,
        click: (hint) => {
          const hit = locate(hint)
          if (hit.error) return { error: hit.error }
          hit.el.click()
          return { ok: true }
        },
      }
      globalThis.__dshSidebarCdp = api
      return api
    }

    // ---------- 与页面元素打交道 ----------

    /** 所有官方侧栏浏览器页面。 */
    function pages() {
      return [...document.querySelectorAll(SELECTOR)]
    }

    /** 按 URL / 标题子串或 id 选一页；缺省取最后打开的那页。 */
    function pick(hint) {
      const all = pages()
      if (all.length === 0) {
        throw new Error('侧栏里没有打开的网页：在右侧栏「+ → 浏览器」里打开一个地址，再重试。')
      }
      if (!hint) return all[all.length - 1]
      const key = String(hint).trim()
      const hit = all.find((el) => pageIdOf(el) === key)
        || all.find((el) => safe(() => el.getURL())?.includes(key))
        || all.find((el) => safe(() => el.getTitle())?.includes(key))
      if (!hit) {
        const seen = all.map((el) => `${pageIdOf(el)} ${safe(() => el.getURL())}`).join(' | ')
        throw new Error(`没有匹配 "${key}" 的页面，可选：${seen}`)
      }
      return hit
    }

    function pageIdOf(el) {
      const id = safe(() => el.getWebContentsId())
      return id === undefined || id === null ? '(unknown)' : `w${id}`
    }

    function safe(fn) {
      try { return fn() } catch { return undefined }
    }

    /** 页面里可能被导航冲掉，所以每次都问一次标记。 */
    async function ensureLibrary(el) {
      const ok = await el.executeJavaScript(`globalThis.__dshSidebarCdp?.v === '${LIB_VERSION}'`, true)
      if (ok) return
      // 注意：executeJavaScript 会把结果结构化克隆回渲染进程，而库本体里有函数和
      // Map——直接返回它必然抛 "An object could not be cloned"。所以用 Boolean() 吞掉。
      await el.executeJavaScript(`Boolean((${guestLibrary.toString()})())`, true)
    }

    async function evalInPage(el, code) {
      await ensureLibrary(el)
      try {
        return await el.executeJavaScript(code, true)
      } catch (error) {
        const message = String(error?.message || error)
        if (!/could not be cloned/i.test(message)) throw error
        // 返回值本身克隆不了（DOM 节点、Map、函数…）：让页面先 JSON 化，再取回字符串。
        // code 是语句而不是表达式时会再失败一次，那就把原始错误抛出去。
        let text
        try {
          text = await el.executeJavaScript(
            `(() => { try { return JSON.stringify((${code})) ?? 'null' } catch (e) { return JSON.stringify(String(e)) } })()`,
            true,
          )
        } catch {
          throw error
        }
        try { return JSON.parse(text) } catch { return text }
      }
    }

    /** 鼠标事件是真实的：坐标是 webview 内部的 CSS 像素，与 getBoundingClientRect 同一套。 */
    function press(el, x, y) {
      const base = { x, y, button: 'left', clickCount: 1, modifiers: [] }
      el.sendInputEvent({ type: 'mouseMove', ...base })
      el.sendInputEvent({ type: 'mouseDown', ...base })
      el.sendInputEvent({ type: 'mouseUp', ...base })
    }

    /** 等导航结束；webview 的 did-stop-loading 是唯一可靠信号。 */
    function loadAndWait(el, url, timeoutMs = 20000) {
      return new Promise((resolve, reject) => {
        let settled = false
        const finish = (error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          el.removeEventListener('did-stop-loading', onStop)
          el.removeEventListener('did-fail-load', onFail)
          if (error) reject(error)
          else resolve()
        }
        const onStop = () => finish()
        const onFail = (event) => {
          // -3 是被另一次导航打断，不算失败
          if (event.errorCode === -3) return
          finish(new Error(`加载失败：${event.errorDescription || event.errorCode}`))
        }
        const timer = setTimeout(() => finish(new Error(`导航超时（${timeoutMs}ms）`)), timeoutMs)
        el.addEventListener('did-stop-loading', onStop)
        el.addEventListener('did-fail-load', onFail)
        el.loadURL(url)
      })
    }

    // ---------- 任务 ----------

    /** 执行一个任务；返回可以被 JSON 序列化的结果。 */
    async function run(job) {
      const args = job.args || {}
      switch (job.op) {
        case 'targets': {
          const all = pages().map((el) => ({
            id: pageIdOf(el),
            url: safe(() => el.getURL()) ?? el.getAttribute('src') ?? '',
            title: safe(() => el.getTitle()) ?? '',
            loading: safe(() => el.isLoading()) ?? false,
            box: [el.clientWidth, el.clientHeight],
          }))
          return { pages: all, shellUrl: location.href }
        }
        case 'eval': {
          const el = pick(args.target)
          const value = await evalInPage(el, args.code)
          return { value, page: { url: safe(() => el.getURL()), title: safe(() => el.getTitle()) } }
        }
        case 'info': {
          const el = pick(args.target)
          return { page: { url: safe(() => el.getURL()), title: safe(() => el.getTitle()) } }
        }
        case 'locate': {
          const el = pick(args.target)
          const probe = await evalInPage(el, `__dshSidebarCdp.probe(${JSON.stringify({ selector: args.selector, text: args.text })})`)
          return { probe, page: { url: safe(() => el.getURL()), title: safe(() => el.getTitle()) } }
        }
        case 'press': {
          const el = pick(args.target)
          press(el, args.x, args.y)
          return { ok: true }
        }
        case 'capture': {
          const el = pick(args.target)
          const image = await el.capturePage()
          if (!image) throw new Error('capturePage 返回空图像')
          const dataUrl = image.toDataURL()
          const size = safe(() => image.getSize()) ?? null
          return { dataUrl, size, page: { url: safe(() => el.getURL()), title: safe(() => el.getTitle()) } }
        }
        case 'navigate': {
          const el = pick(args.target)
          await loadAndWait(el, args.url, args.timeoutMs ?? 20000)
          return { page: { url: safe(() => el.getURL()), title: safe(() => el.getTitle()) } }
        }
        case 'ping':
          return { pong: true, pages: pages().length }
        default:
          throw new Error(`未知任务：${job.op}`)
      }
    }

    // ---------- 长轮询循环 ----------

    /**
     * 与 host 的往返：取任务 → 执行 → 写结果。
     * 断线不是错误，隔一秒再试；壳重载也是从这一句重新开始。
     */
    async function loop(isStopped) {
      let backoff = 1000
      while (!isStopped()) {
        let job
        try {
          const response = await fetch(`${JOB_URL}?wait=${POLL_WAIT_MS}`, { headers: { Accept: 'application/json' } })
          if (response.status === 204) { backoff = 1000; continue }
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          job = await response.json()
          backoff = 1000
        } catch {
          await new Promise((resolve) => setTimeout(resolve, backoff))
          backoff = Math.min(backoff * 2, 15000)
          continue
        }
        if (!job || typeof job.id !== 'string') continue
        let body
        try {
          body = { id: job.id, ok: true, value: await run(job) }
        } catch (error) {
          body = { id: job.id, ok: false, error: String(error?.message || error) }
        }
        try {
          await fetch(RESULT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        } catch {
          // 结果没送到，host 那侧会超时；下一轮继续。
        }
      }
    }

    /**
     * 客户端插件本体。
     * @param ctx 壳里的客户端上下文。
     */
    function apply(ctx) {
      let stopped = false
      ctx.effect(() => {
        stopped = false
        void loop(() => stopped)
        return () => { stopped = true }
      }, 'dsh-sidebar-cdp: sidebar driver')
    }

    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
