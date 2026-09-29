// 开发模式的桌面窗口启动器：把本插件装进 DSH 官方 Desktop Host 的一次性开发档里。
// 不产出可分发的安装包 —— 上游公开源码缺 fs-ext，打包链路跑不通（见 docs/migration-015.md）。
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, realpathSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { prepareDevelopmentProject } from '../../deepseek-harness/apps/desktop/scripts/development-project.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../../deepseek-harness/apps/desktop/src/host-protocol.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const pluginName = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).name

// DSH 源码位置沿用 scripts/setup-dev-env.sh 的约定：DSH_REPO，否则取同级的 deepseek-harness 软链。
const upstream = realpathSync(process.env.DSH_REPO ?? resolve(dirname(root), 'deepseek-harness'))
if (!existsSync(resolve(upstream, 'apps/desktop/package.json'))) {
  throw new Error(`在 ${upstream} 没找到 DSH 源码；用 DSH_REPO 指到 DeepSeek Harness 检出目录。`)
}
if (!existsSync(resolve(root, 'lib/client.js'))) throw new Error('先跑 pnpm run build。')

const app = resolve(upstream, 'apps/desktop')
const require = createRequire(resolve(app, 'package.json'))
const manifest = JSON.parse(readFileSync(resolve(app, 'package.json'), 'utf8'))
const profile = resolve(app, '.desktop-build/development/project')
const home = resolve(root, '.runtime/harness-home')
mkdirSync(home, { recursive: true, mode: 0o700 })

prepareDevelopmentProject({
  projectDir: profile,
  cliDir: resolve(upstream, 'apps/cli'),
  hostDir: resolve(upstream, 'apps/desktop-host'),
  dependencyDir: resolve(upstream, 'node_modules/.pnpm/node_modules'),
  release: {
    schemaVersion: 1,
    version: manifest.version,
    hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    nodeVersion: process.versions.node,
    pnpmVersion: JSON.parse(readFileSync(resolve(app, 'node_modules/pnpm/package.json'), 'utf8')).version,
  },
})

// prepareDevelopmentProject 每次都会重建 profile，所以插件必须在它之后挂进去。
symlinkSync(root, resolve(profile, `node_modules/${pluginName}`), 'dir')
const pkgPath = resolve(profile, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
pkg.dependencies[pluginName] = '0.0.0'
// --stock：跑原生 DSH 桌面端，用来对照哪些行为是我们改的。
if (!process.argv.includes('--stock')) pkg.dsh.profile.bundles.push(pluginName)
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

const child = spawn(require('electron'), [
  // 窗口被挡住时别冻结渲染：走查要靠真实帧率，浏览器标签页那套节流坑过三轮。
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--inspect=127.0.0.1:19429',
  '--remote-debugging-port=19422',
  `--user-data-dir=${resolve(root, '.runtime/electron-user-data')}`,
  app,
], {
  cwd: app,
  stdio: 'inherit',
  env: {
    ...process.env,
    DSH_HOME: home,
    DSH_DESKTOP_NODE_BINARY: process.execPath,
    DSH_DESKTOP_OPEN_DEVTOOLS: '0',
    DSH_DESKTOP_HOST_INSPECT_PORT: '19430',
  },
})
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
