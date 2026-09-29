// @vitest-environment jsdom

import { Context } from '@deepseek-ai/cordis'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as themeApply, inject as themeInject, ThemeRuntime } from '@deepseek-ai/dsh-client-ui-theme/client'
import { apply, inject, LayoutController } from 'dsh-plugin-matou-layout/client'
import MatouLayoutService from 'dsh-plugin-matou-layout'

beforeEach(() => {
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((node) => { node.remove() })
})

async function bench() {
  const ctx = new Context()
  const slotsFiber = ctx.plugin(SlotRegistry)
  // Theme registers its Appearance settings row and requires the connection
  // seam for persistence; model this bench as a remote, memory-only browser.
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  // ui-theme's Appearance row binds a durable scope through these two.
  // The remote double also answers the plugin's namespace mount and the two
  // matouLayout methods, so the org mirror hydrates instead of degrading.
  const matouLayoutFace = {
    snapshot: async () => ({ ok: true, value: { revision: 0, state: { tasks: [], scenes: [], placements: [] } } }),
    apply: async () => ({ ok: true, value: { ok: true, value: { revision: 1, state: { tasks: [], scenes: [], placements: [] } } } }),
  }
  ctx.provide('remote', {
    $on: () => () => {},
    $mount: async () => async () => {},
    matouLayout: matouLayoutFace,
  } as never)
  // The mounted namespace is its own service; the plugin binds through it.
  ctx.provide('remote.matouLayout', matouLayoutFace as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  // The workbench actions read the session and workspace services; the bench
  // provides inert doubles so the plugin's fiber unparks.
  ctx.provide('sessions', {
    create: async () => 's', open: () => {}, clear: () => {}, pin: () => {}, unpin: () => {}, binding: () => undefined,
    fork: async () => 's', list: { getSnapshot: () => ({ ids: [], byId: {}, current: undefined }), subscribe: () => () => {} },
  } as never)
  ctx.provide('workspaces', {
    archiveSession: async () => undefined, create: async () => ({ workspaceId: 'w' }),
    list: { getSnapshot: () => ({ items: [], archivedSessionIds: [] }), subscribe: () => () => {} },
  } as never)
  ctx.provide('uiWorkspace', { pickDirectory: async () => null } as never)
  // drillTo's active-child picker reads this imperatively (see actions.ts's WorkbenchDeps.pendingInteractions).
  ctx.provide('uiSession', {
    pendingInteractions: { getSnapshot: () => new Map(), subscribe: () => () => {} },
  } as never)
  await ctx.plugin({ inject: themeInject, apply: themeApply }).await()
  await slotsFiber.await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry }
}

describe('ui-layout client apply', () => {
  it('declares its service dependencies', () => {
    expect(inject).toEqual(['slots', 'theme', 'locale', 'sessions', 'workspaces', 'remote', 'uiSession'])
    // 反例，钉住一次真实事故：`uiWorkspace` **不得**回到这个列表。
    // DSH 0.1.5 起 ui-workspace 自己 inject 了 `layout`，而 `layout` 正是本插件
    // 提供的；两边互为必需依赖就死锁，整个 Web 客户端启不来（实测 15 个条目全部
    // pending，页面只剩「Failed to load plugins」）。目录选择器改成用到时再取。
    expect(inject).not.toContain('uiWorkspace')
  })

  /**
   * 座位名与形态必须与官方 `ui-layout` 逐字一致——本插件是**替换**它的，
   * 占位者（ui-conversation / ui-sidebar / ui-sidebar-right）按官方的名字来注册。
   * 0.1.5 改了两个：`conversation` → `main`（keyed，root 作用域，会话内容降到
   * `main.conversation` 子座位），`details` → `rightbar`（作用域由 session 放宽到 root）。
   * 声明错名字不会报错，只会让那一栏什么都不显示——所以这条逐字钉住。
   */
  it('provides ctx.layout and registers AppFrame into root with the child declarations', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.get('layout')).toBeInstanceOf(LayoutController)
    // The one register() call occupied 'root'…
    expect(slots.entries('root')).toHaveLength(1)
    // …and declared the children in the ledger.
    expect(slots.spec('sidebar')).toEqual({ kind: 'single', scope: 'root' })
    expect(slots.spec('main')).toEqual({ kind: 'keyed', scope: 'root' })
    expect(slots.spec('rightbar')).toEqual({ kind: 'single', scope: 'root' })
    // 反例：旧名字必须已经不再声明，否则等于两套并存、占位者落到哪一边全看运气。
    expect(slots.spec('conversation')).toBeUndefined()
    expect(slots.spec('details')).toBeUndefined()
  })

  it('injects the workbench face with org/nav hooks and attaches the layout actions', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const actions = {
      setSidebar: vi.fn(), setDetails: vi.fn(), toggleSidebar: vi.fn(), openDetails: vi.fn(), closeDetails: vi.fn(),
    }
    const injected = (slots.entries('root')[0]!.inject as (actions: never) => Record<string, unknown>)(actions as never)
    expect(typeof injected.newSession).toBe('function')
    expect(typeof injected.navigate).toBe('function')
    const hooks = injected.hooks as Record<string, { getSnapshot: () => unknown; subscribe: (fn: () => void) => () => void }>
    expect(typeof hooks.org!.getSnapshot).toBe('function')
    expect(typeof hooks.nav!.subscribe).toBe('function')
    const layout = ctx.get('layout') as LayoutController
    layout.toggleSidebar()
    expect(actions.toggleSidebar).toHaveBeenCalledOnce()
  })

  it('theme presenter applies the initial snapshot, follows theme/change, and unwinds on dispose', async () => {
    const { ctx } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    // Initial getter application: jsdom has no matchMedia, system resolves light.
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
    const themeColorMeta = document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    expect(themeColorMeta).not.toBeNull()
    const theme = ctx.get('theme') as ThemeRuntime
    theme.setTheme('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(true)
    expect(document.head.querySelector('meta[name="theme-color"]')).toBe(themeColorMeta)
    await fiber.dispose()
    expect(document.documentElement.style.colorScheme).toBe('')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
    expect(themeColorMeta?.isConnected).toBe(false)
    // Listener is off: further theme changes no longer reach the document.
    theme.setTheme('light')
    theme.setTheme('dark')
    expect(document.documentElement.style.colorScheme).toBe('')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
  })

  it('teardown unwinds the service, the root registration, and the child declarations', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    expect(ctx.get('layout')).toBeUndefined()
    expect(slots.entries('root')).toHaveLength(0)
    expect(slots.spec('sidebar')).toBeUndefined()
    // The built-in root declaration survives entry teardown (renderer-owned).
    expect(slots.spec('root')).toEqual({ kind: 'single', scope: 'root' })
  })
})

describe('node half', () => {
  it('default-exports the org service bound to the matouLayout namespace', () => {
    expect(typeof MatouLayoutService).toBe('function')
    expect(MatouLayoutService.inject).toEqual(['storageDomain'])
    // The gateway's SRC dispatch discovers endpoints through @Remote markers
    // on the prototype; their absence would silently unpublish the API.
    const markers = Object.getOwnPropertyNames(MatouLayoutService.prototype)
    expect(markers).toContain('snapshot')
    expect(markers).toContain('apply')
  })
})
