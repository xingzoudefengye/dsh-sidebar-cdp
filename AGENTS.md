# AGENTS.md — dsh-sidebar-cdp

本目录是 harness 之外的外部 DSH 插件，自己是一个 git 仓库；`lib/` 是**提交进仓库的产物**（手写、无构建步骤），安装方不需要 pnpm build。

## 唯一不可让步的目标

**纯插件，用户无感。** 不改官方桌面版、不改启动快捷方式、不加 `--remote-debugging-port`、不改 app.asar。任何"要用户先改一下应用"的方案一律否决——哪怕它更省事。

`transport: 'cdp'` 只是旁路选项（应用恰好带着调试端口启动时可用），**不能**成为默认路径，也不能成为任何工具的前置条件。

## 两半结构

| 半边 | 文件 | 跑在哪 |
|---|---|---|
| host | `lib/index.js` `lib/tools.js` `lib/bridge.js` `lib/driver.js` `lib/client-page.js` | host 进程（独立 node） |
| client | `lib/client.js` | 桌面版壳渲染进程（`dsh-app://app`） |

**为什么必须两半**：agent 的工具注册在 host 进程，而 `<webview>` 元素在渲染进程。host 进程不是 Electron 主进程（`--expose-internals ... dsh-desktop-host`），拿不到 `webContents`；所以只能由客户端半边去碰元素，host 通过插件自己的 HTTP 路由请求它。

通道两条路由（`lib/bridge.js`）：`GET /dsh-sidebar-cdp/jobs`（客户端长轮询取任务）、`POST /dsh-sidebar-cdp/result`（回写结果）。路由由插件拥有，所以信任检查自己做：`connection.requestRejection(request)`，与 `/api` 同一套。

## 客户端 bundle 的硬约束

- 必须是 `window.__ModuleLoader__.load({ id: 'dsh-sidebar-cdp', factory })` 形态，末尾 `return module.exports`，`exports.apply` / `exports.inject` 供客户端 loader 调用。写成普通 ESM 不会被加载。
- `package.json` 的 `dsh.client` 声明 `{ inject: [], platform: 'web' }`，`exports` 里要有 `"./client": "./lib/client.js"`。
- 改客户端半边**不用重启**（`dsh-client-hmr` 500ms 轮询 `mtime/size` 推新 bundle）；改 host 半边要重启桌面版。利用这一点：host 保持薄，逻辑尽量放客户端。

## 踩过的坑（都是实测）

1. **自己建的 `<webview>` 挂不上。** `document.createElement('webview')` 能创建、`webviewTag === true`，但 `dom-ready` 永远不来——主进程只批准官方侧栏面板创建的 guest。所以选择器写死 `webview[data-sidebar-browser-frame="webview"]`，不造新元素。
2. **`IncomingMessage` 的 `'close'` 会立刻触发。** GET 请求体读完就 emit，长轮询会被瞬间唤醒成忙轮询。挂 `response.on('close')`。
3. **导航会清掉注入的页面库。** 每次操作前查 `globalThis.__dshSidebarCdp?.v`，版本不对就重新注入 (`guestLibrary.toString()`)。
4. **`executeJavaScript` 的结果必须可 JSON 序列化**，Promise 会被 await；函数会被序列化成 `{}`，要调用它就在页面里调。
5. **截图是视口，不是整页。** `capturePage()` 没有 `captureBeyondViewport`；`fullPage` 参数目前无效，不要在描述里承诺整页。
6. **别在 `<webview>` 上用 `element.click()` 冒充点击。** 那是合成事件（`isTrusted === false`），有些站点不认；`sendInputEvent` 才是真实鼠标，坐标是 webview 内部 CSS 像素，与 `getBoundingClientRect` 同一套。

## 改完怎么验

```bash
node --check lib/*.js          # 语法
node scripts/smoke.mjs         # 用假 ctx 装插件，只验证 host 半边能注册
```

真实链路只能这样验：重启桌面版 → 侧栏开一个网页 → 在会话里调 `sidebar_targets`，再 `sidebar_read` / `sidebar_eval` / `sidebar_screenshot`。**改了客户端半边可以先不重启**，但要在 GUI 里真的调一次工具，HMR 只保证 bundle 换了，不保证行为对。

## 仓库纪律

- 安装/卸载都走 `scripts/install-desktop.mjs`（桌面版 profile 由应用独占管理，`dsh plugin add` 会拒绝写入）。
- 机器相关的路径（profile 目录、exe 位置）只能出现在脚本里靠环境变量推导，不写死。
- 临时探针脚本放系统临时目录，不进仓库。
