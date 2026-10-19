/**
 * dsh-sidebar-cdp —— 让 agent 直接读、点 DSH 桌面版侧栏里那个原生浏览器页面。
 *
 * 两半，都在这一个插件里：
 *   host 半边（本文件）：注册九个工具 + 两条插件自己的 HTTP 路由
 *   客户端半边（lib/client.js）：跑在壳渲染进程里，直接操作 <webview> 元素
 *
 * 默认走客户端半边：不需要 --remote-debugging-port，不改快捷方式，不碰官方
 * 桌面版——装插件即用。`transport: 'cdp'` 是可选旁路，只在应用正好带着调试
 * 端口启动时可用（能给出浏览器自己的无障碍树，也方便离线冒烟）。
 *
 * 依赖面为零（只有 node: 内建模块）：外部插件的 import 是在它自己的目录里解析的，
 * host 的 node_modules 不在解析路径上，见 lib/schema.js 顶部注释。
 *
 * @module dsh-sidebar-cdp
 */
import { createBridge } from './bridge.js'
import { registerTools } from './tools.js'
import { setBridge } from './driver.js'

/** Loader row identity. */
export const name = 'dsh-sidebar-cdp'

/** 注册工具需要工具注册表；路由在 webServer 就位后自己挂。 */
export const inject = ['tools']

/**
 * @param ctx 插件上下文。
 * @param config 行配置；transport 默认 client，port 只服务 cdp 旁路。
 */
export function apply(ctx, config = {}) {
  const bridge = createBridge(ctx)
  bridge.registerRoutes()
  setBridge(bridge)

  registerTools(ctx, () => ({
    transport: config?.transport === 'cdp' ? 'cdp' : 'client',
    port: Number(config?.port) || 9222,
  }))
}
