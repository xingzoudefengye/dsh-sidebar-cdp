#!/usr/bin/env node
/**
 * 把 dsh-sidebar-cdp 装进桌面版 profile。
 *
 * 为什么要这个脚本：桌面版 profile 由应用独占管理，`dsh plugin add` 会直接拒绝
 * （"managed exclusively by the Electron application"）。所以这里做等价的两步：
 * 往 profile 的 package.json 里写依赖 + bundles，然后在那个目录跑 pnpm install。
 *
 * 纯插件路线不需要调试端口，也不需要改快捷方式——装完重启桌面版即可。
 * （曾经手工加过 --remote-debugging-port 的机器：scripts/patch-shortcuts.ps1 -Remove）
 *
 * 用法：
 *   node scripts/install-desktop.mjs                 # 从 GitHub 装（另一台机器）
 *   node scripts/install-desktop.mjs --spec=link:E:/Projects/dsh-sidebar-cdp
 *   node scripts/install-desktop.mjs --dry-run       # 只看会改什么
 *
 * 参数：--dry-run  --no-install  --spec=<pnpm spec>
 */

import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = 'dsh-sidebar-cdp'
const DEFAULT_SPEC = 'github:xingzoudefengye/dsh-sidebar-cdp'

const options = new Map()
for (const raw of process.argv.slice(2)) {
  const [key, value = 'true'] = raw.replace(/^--/, '').split('=')
  options.set(key, value)
}
const spec = options.get('spec') ?? DEFAULT_SPEC
const dryRun = options.get('dry-run') === 'true'
const skipInstall = options.get('no-install') === 'true'

const tag = dryRun ? '[dry-run] ' : ''
const say = (text) => console.log(`${tag}${text}`)
const step = (n, text) => console.log(`\n${tag}${n}. ${text}`)

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', 'desktop')
const pkgPath = join(profileDir, 'package.json')

if (!existsSync(pkgPath)) {
  console.error(`找不到桌面版 profile：${pkgPath}`)
  console.error('先把官方桌面版启动一次（它会自己创建这个 profile），再回来跑本脚本。')
  process.exit(1)
}

let pkg
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
} catch (error) {
  console.error(`读不懂 ${pkgPath}：${error.message}`)
  process.exit(1)
}

say(`profile：${profileDir}`)

// ---------- 备份 ----------

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
const backupDir = join(tmpdir(), `dsh-desktop-profile-${stamp}`)
if (!dryRun) {
  mkdirSync(backupDir, { recursive: true })
  for (const name of ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml']) {
    const source = join(profileDir, name)
    if (existsSync(source)) copyFileSync(source, join(backupDir, name))
  }
  say(`已备份 profile 原文 → ${backupDir}`)
}

// ---------- 改 package.json ----------

step(1, `写入依赖与 bundles（${spec}）`)

pkg.dependencies ??= {}
pkg.dsh ??= {}
pkg.dsh.profile ??= {}
pkg.dsh.profile.bundles ??= []

const before = pkg.dependencies[PKG]
pkg.dependencies[PKG] = spec
say(before === spec ? `  依赖已是 ${spec}` : `  依赖：${before ?? '(无)'} → ${spec}`)

if (pkg.dsh.profile.bundles.includes(PKG)) {
  say('  bundles 已包含，跳过')
} else {
  pkg.dsh.profile.bundles.push(PKG)
  say(`  bundles += ${PKG}（共 ${pkg.dsh.profile.bundles.length} 项）`)
}

if (!dryRun) {
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  say(`  已写入 ${pkgPath}`)
}

// ---------- pnpm install ----------

step(2, '在 profile 目录安装依赖')
if (skipInstall) {
  say('  --no-install，跳过')
} else if (dryRun) {
  say(`  会执行：pnpm install（工作目录 ${profileDir}）`)
} else {
  let pnpmVersion = ''
  try {
    pnpmVersion = execSync('pnpm --version', { encoding: 'utf8' }).trim()
  } catch {
    console.error('没找到 pnpm。先跑 `corepack enable` 或 `npm i -g pnpm`，再重试。')
    process.exit(1)
  }
  say(`  pnpm ${pnpmVersion}`)
  execSync('pnpm install', { cwd: profileDir, stdio: 'inherit' })

  const installed = join(profileDir, 'node_modules', PKG)
  say(existsSync(installed) ? `  已就位：${installed}` : `  警告：${installed} 不存在，检查上面的安装输出`)
}

// ---------- 收尾 ----------

console.log(`\n${tag}完成。下一步：完全退出桌面版（不是最小化），从桌面图标重新启动。`)
console.log('重启后在侧栏浏览器里打开一个网页，agent 就会有 sidebar_targets / sidebar_read 等九个工具。')
console.log('不需要启动参数，也不需要改快捷方式。')
