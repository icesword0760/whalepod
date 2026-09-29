import { describe, expect, it, vi } from 'vitest'
import { LayoutController } from 'dsh-plugin-matou-layout/src/client/service.ts'
import type { PanelActions } from 'dsh-plugin-matou-layout/src/client/service.ts'

function fakePanels(): PanelActions {
  return {
    setSidebar: vi.fn(),
    setDetails: vi.fn(),
    toggleSidebar: vi.fn(),
    setNarrow: vi.fn(),
    openDetails: vi.fn(),
    closeDetails: vi.fn(),
  }
}

describe('LayoutController', () => {
  it('把面板动作转发给已接上的动作集', () => {
    const service = new LayoutController()
    const panels = fakePanels()
    service.attachPanels(panels)

    service.toggleSidebar()
    service.openRightbar(true, false)
    service.closeRightbar()

    expect(panels.toggleSidebar).toHaveBeenCalledTimes(1)
    expect(panels.openDetails).toHaveBeenCalledTimes(1)
    expect(panels.closeDetails).toHaveBeenCalledTimes(1)
    expect(panels.setSidebar).not.toHaveBeenCalled()
    expect(panels.setDetails).not.toHaveBeenCalled()
  })

  /**
   * `track: false` 的意思是「这一栏不占位」——等价于关掉它。
   * 若实现只认 `openRightbar` 这个名字就无脑开栏，这条会红。
   */
  it('openRightbar(track=false) 关栏，而不是开栏', () => {
    const service = new LayoutController()
    const panels = fakePanels()
    service.attachPanels(panels)
    service.openRightbar(false, false)
    expect(panels.closeDetails).toHaveBeenCalledTimes(1)
    expect(panels.openDetails).not.toHaveBeenCalled()
  })

  it('fullscreen presentation opens instead of closing the file panel', () => {
    const service = new LayoutController()
    const panels = fakePanels()
    service.attachPanels(panels)
    service.openRightbar(false, true)
    expect(panels.openDetails).toHaveBeenCalledTimes(1)
    expect(panels.closeDetails).not.toHaveBeenCalled()
  })

  it('fails loud before the root entry wired its actions', () => {
    const service = new LayoutController()
    expect(() => { service.toggleSidebar() }).toThrow(/panel actions not wired/)
    expect(() => { service.openRightbar(true, false) }).toThrow(/panel actions not wired/)
    expect(() => { service.closeRightbar() }).toThrow(/panel actions not wired/)
  })

  /**
   * 0.1.5 新增的两个成员。官方的 `ui-workspace` 导航在运行时会调它们
   * （`navigation.ts:136,140,149,167`），本插件是 `ctx.layout` 的提供方，
   * 缺了就是官方导航当场崩，不是类型小事。
   */
  describe('0.1.5 新增契约', () => {
    it('beginNavigation：后一次导航把前一次的信号取消掉', () => {
      const service = new LayoutController()
      const first = service.beginNavigation()
      expect(first.aborted).toBe(false)
      const second = service.beginNavigation()
      expect(first.aborted).toBe(true)
      expect(second.aborted).toBe(false)
    })

    it('dispose：卸载时把待定导航取消', () => {
      const service = new LayoutController()
      const signal = service.beginNavigation()
      service.dispose()
      expect(signal.aborted).toBe(true)
    })

    it('selectPanel(null)：回到工作台，不抛错，并取消待定导航', () => {
      const service = new LayoutController()
      const signal = service.beginNavigation()
      expect(() => { service.selectPanel(null) }).not.toThrow()
      expect(signal.aborted).toBe(true)
    })

    /**
     * 本布局的中央就是工作台，没有第二个主面板。与其接下调用再默默显示工作台，
     * 不如明说——否则将来真有插件注册了主面板，会静默不显示且无从查起。
     */
    it('selectPanel(非 null)：明确报错说本布局没有别的主面板', () => {
      const service = new LayoutController()
      expect(() => { service.selectPanel('settings' as never) })
        .toThrow(/no main panels besides the workbench/)
    })
  })

  it('re-attach overwrites the stale action set (entry re-register)', () => {
    const service = new LayoutController()
    const stale = fakePanels()
    const fresh = fakePanels()
    service.attachPanels(stale)
    service.attachPanels(fresh)

    service.toggleSidebar()

    expect(stale.toggleSidebar).not.toHaveBeenCalled()
    expect(fresh.toggleSidebar).toHaveBeenCalledTimes(1)
  })
})
