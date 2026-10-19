# dsh-sidebar-cdp

让 agent 直接读、点 DSH 桌面版侧栏里那个**原生浏览器页面**——不是另开一个有头窗口，也不是 iframe 镜像。

**纯插件，零配置**：装完就能用，不需要启动参数、不需要改快捷方式、不碰官方桌面版。

## 它是怎么做到的

工具注册在 host 进程，而页面是壳渲染进程里的一个 `<webview>`。所以插件有两半：

```
host 进程                          壳渲染进程
sidebar_* 九个工具        ──路由──►  client.js
  GET  /dsh-sidebar-cdp/jobs          └─ 抓 <webview> 元素
  POST /dsh-sidebar-cdp/result        └─ executeJavaScript / sendInputEvent / capturePage
```

三个能力都长在 `<webview>` 元素上：

| 能力 | 用途 |
|---|---|
| `executeJavaScript` | 读正文、取结构树、填输入框、跑任意表达式 |
| `sendInputEvent` | **真实**鼠标事件（`element.click()` 是合成事件，`isTrusted === false`） |
| `capturePage` | 像素截图 |

宿主和客户端之间只隔着插件自己的两条 HTTP 路由；客户端长轮询取任务，执行完回写结果。没有第二个进程，没有端口，没有对应用的任何修改。

## 兼容性

| 平台 | 支持 | 说明 |
| --- | --- | --- |
| Windows 10/11 | ✅ 已实测（Windows 11，DSH 0.2.1-rc.2 桌面版） | `install-desktop.mjs` 与 `smoke.mjs` 都是 Node 脚本，PowerShell 里直接 `node` 跑 |
| macOS | ⚠️ 设计支持，未实测 | 桌面版 profile 路径同样是 `~/.dsh/profiles/desktop`；`<webview>` 的 `executeJavaScript` / `sendInputEvent` / `capturePage` 是 Electron 跨平台 API |
| Linux | ❌ | 官方桌面版不发 Linux |

- **Node**：`engines` 要求 `>=22`。
- **DSH**：`peerDependencies` 全是 `*`，不锁版本；需要能装第三方 bundle 的 0.2.x（本文按 0.2.1-rc.2 验证）。
- **只对桌面版有效**：它驱动的是应用自己的 `<webview>`，web 端（浏览器里开 `127.0.0.1:…`）的侧栏没有这种元素。

## 安装

装官方桌面版，启动一次（它会创建 profile），然后：

```bash
git clone https://github.com/xingzoudefengye/dsh-sidebar-cdp
node dsh-sidebar-cdp/scripts/install-desktop.mjs
# 完成 → 完全退出桌面版，从图标重新启动
```

脚本做两件事：往 `~/.dsh/profiles/desktop/package.json` 写依赖与 `dsh.profile.bundles`（桌面版 profile 由应用独占管理，`dsh plugin add` 会拒绝写入），然后在那个目录跑 `pnpm install`。改配置前备份到 `%TEMP%\dsh-desktop-profile-<时间戳>\`。

参数：`--dry-run` 只看会改什么，`--no-install` 只改配置，`--spec=link:<路径>` 装本机源码。

## 验证

按顺序四步，每步都有可核对的输出：

1. **host 半边**：`node scripts/smoke.mjs` → `工具数：9 → sidebar_targets, …` + `注册通过`。
2. **重启桌面版**（完全退出，不是最小化），侧栏「+ → 浏览器」打开任意页面。
3. **列页面**：让 agent 调 `sidebar_targets` → 应该看到 `w<id> 标题 — 地址` 一行。
4. **真链路**：`sidebar_read` 能出正文 → `sidebar_click` 点一个链接并看标题变化 →
   `sidebar_screenshot` 返回 PNG 路径（用普通文件工具读回来确认不是白图）。

排错见下节。

## 工具

| 工具 | 用途 |
|---|---|
| `sidebar_targets` | 列出侧栏里所有页面（`*` 标记可操作的） |
| `sidebar_read` | 读可见文本 + 前 40 条链接，最省 token 的入口 |
| `sidebar_snapshot` | 结构树（role + 名字 + `[e12]` 引用），用来找控件 |
| `sidebar_click` | 按选择器或可见文字点击，真实鼠标，落点被遮住时拒绝 |
| `sidebar_type` | 聚焦并写入，回报**读回来**的值 |
| `sidebar_eval` | 页内执行 JS，兜底用 |
| `sidebar_navigate` | 跳转并等加载完成 |
| `sidebar_wait` | 等某个选择器出现 |
| `sidebar_screenshot` | 截图写盘，返回路径 |

所有工具都接受 `target`（URL / 标题子串或 id，缺省取最后打开的那页）。

**四个边界，先说清楚**：

- `sidebar_screenshot` 拍到的是**视口**，不是整页（`capturePage()` 没有 `captureBeyondViewport`；`fullPage` 参数目前无效）。
- `sidebar_snapshot` 是**DOM 结构树**，不是浏览器的无障碍树。角色由标签与 `role` 属性推出来，够用来找控件，但不如真 AX 树准。
- `sidebar_eval` 的返回值不可结构化克隆时会被处理：函数/`Map` 类会退化成 JSON 文本，**DOM 节点则直接变成 `{}`**（Electron 的静默行为，不报错）——要节点信息就在页面里先取属性，例如 `document.body.className`。
- **窄侧栏会把桌面布局裁掉。** 侧栏页面宽约 575 CSS 像素（截图 863 px = 575×dpr1.5），而百度这类首页按 1260 宽布局、还把 `overflow-x` 设成 hidden，于是右侧元素既看不见也横滚不到，`sidebar_click` 会如实拒绝而不是乱点。要够到它就把页面缩小：`sidebar_eval` 跑 `document.body.style.zoom = '0.45'`，用完再置空。

工具在动手前会挡掉三种"看起来成功"的情况：元素尺寸为 0（新版页面常把老 input 留成 0×0 的壳）、落点被别的元素接住、元素在视口外滚也滚不过去。命中多处时优先挑**屏幕内**那一个（吸顶导航和页尾导航常是同一个链接的两份）。

## 可选旁路：CDP

应用假如正好带 `--remote-debugging-port=9222` 启动，可以把它切到 `transport: 'cdp'`（改 profile 的 `cordis.patch.yml`）：这条路能给出浏览器自己的无障碍树，也方便离线冒烟（`node scripts/smoke.mjs 9222`）。**默认不用它**，上面两处边界在默认路径下即适用。

## 安全

两条路由自己做信任检查（`connection.requestRejection`，与 `/api` 同一套），只接受带会话认证的请求，且宿主只监听回环。它能做的事等于"用你侧栏那个浏览器的登录态操作页面"，不值得对任何本机进程开放。

## 排错

| 现象 | 原因 |
|---|---|
| `侧栏里没有打开的网页` | 侧栏浏览器没开页面；打开一个地址即可 |
| `侧栏插件没有客户端半边在跑` | 装着插件之后没重启过桌面版；新客户端模块在启动时加载 |
| 装了插件但工具列表里没有 `sidebar_*` | 检查 profile `package.json` 的 `dsh.profile.bundles` 里有 `dsh-sidebar-cdp`，以及 `node_modules/dsh-sidebar-cdp` 是软的还是真目录 |
| 工具返回 `value is not lossless JSON` | 0.1.0 的 bug（桥返回 `{value,page}` 没取 `.value`），升到 0.1.1 并重启 |
| 第一次操作抛 `An object could not be cloned` | 0.1.0 的 bug（注入页面库时把带函数的对象当返回值），升到 0.1.1 并重启 |
| 改了代码但行为没变 | 客户端半边（`lib/client.js`）热更；host 半边（`index/tools/bridge/client-page`）必须重启桌面版 |

## 卸载

从 `~/.dsh/profiles/desktop/package.json` 里删掉 `dependencies` 与 `dsh.profile.bundles` 中的
`dsh-sidebar-cdp`，在该目录 `pnpm install`，然后完全退出并重启桌面版。
截图落在系统临时目录（`%TEMP%\sidebar-cdp\shots\`），可以直接删。

## 相关插件

| 插件 | 关系 |
|---|---|
| [`dsh-browser`](https://github.com/xingzoudefengye/dsh-browser) | 旧方案：每会话起独立 Chrome 再镜像到侧栏。和官方侧栏不共享页面，2026-10 起被本插件取代 |
| [`dsh-env`](https://github.com/xingzoudefengye/dsh-env)（私有） | 另一台机器的复原清单里会通过 `git clone` + `install-desktop.mjs` 装本插件 |

## 目录

```
lib/index.js        插件入口：装配桥 + 注册工具
lib/tools.js        九个工具的定义与渲染
lib/bridge.js       两条路由、任务队列、信任检查
lib/driver.js       传输层门面（client 默认 / cdp 可选）
lib/client-page.js  host 侧的客户端传输实现（与 page.js 同签名）
lib/client.js       客户端半边（壳渲染进程）+ 注入页面的库
lib/cdp.js          CDP 传输（旁路）
lib/page.js         CDP 下的页面操作（旁路）
lib/schema.js       作者写法 → JSON Schema + 参数校验（不依赖 dsh-tools）
scripts/install-desktop.mjs  装进桌面版 profile
scripts/smoke.mjs            假 ctx 冒烟
scripts/patch-shortcuts.ps1  维护：把快捷方式上的 --remote-debugging-port 去掉（曾经加过才有用）
```

维护须知见 [AGENTS.md](AGENTS.md)。

## 许可

MIT
