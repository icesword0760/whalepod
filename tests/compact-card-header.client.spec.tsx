// @vitest-environment jsdom
/**
 * Ruling-9 coverage: the compact card's own "⋯" dropdown must carry the same
 * fork/rename/remove actions the focused card's official header offers via
 * `CardHeaderActions` (`header-seats.client.spec.tsx`) — running gate, same-
 * layer uniqueness, and cascade-remove included. Prior to this fix round
 * this whole surface (~100 lines in `CompactCardHeader.tsx`) had zero test
 * coverage (review I3).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { zh } from '../src/client/locales.ts'
import type { MatouKey } from '../src/client/locales.ts'
import { CompactCardHeader } from '../src/client/carousel/CompactCardHeader.tsx'
import type { CompactCardMenuProps } from '../src/client/carousel/CompactCardHeader.tsx'

afterEach(cleanup)

/** A spy wrapping the real zh dictionary (same convention as card-shell.client.spec.tsx). */
function spyT() {
  return vi.fn((key: MatouKey, params?: Record<string, unknown>) =>
    zh[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? '')))
}

function menuDouble(over: Partial<CompactCardMenuProps> = {}): CompactCardMenuProps {
  return {
    actions: {
      drillTo: vi.fn(),
      forkChild: vi.fn(async () => undefined),
      forkSibling: vi.fn(async () => undefined),
      forkPeer: vi.fn(async () => undefined),
      removeCard: vi.fn(async () => undefined),
    },
    renameSession: vi.fn(async () => undefined),
    canForkSibling: false,
    selfRunning: false,
    parentRunning: false,
    selfForkReady: true,
    parentForkReady: true,
    childTitles: [],
    siblingTitles: [],
    ...over,
  }
}

const BASE_PROPS = { sessionId: 'A', title: '登录修复', hasNotice: false, childCount: 0 }

describe('CompactCardHeader — "⋯" 静态外观（menu 未传，card-shell 既有夹具的原始行为）', () => {
  it('未传 menu 时"⋯"是静态装饰，无 aria-label、点击无反应', () => {
    render(<CompactCardHeader {...BASE_PROPS} t={spyT()} />)
    expect(screen.queryByRole('button', { name: '更多操作' })).toBeNull()
    expect(screen.getByText('⋯')).toBeTruthy()
  })
})

describe('CompactCardHeader — "⋯" 菜单（Ruling-9：与聚焦卡官方头菜单同一套动作）', () => {
  it('点击"⋯"打开菜单：重命名…/创建子分支/⑂ Fork 会话/移除；canForkSibling 假时不含兄弟分支', async () => {
    const menu = menuDouble()
    render(<CompactCardHeader {...BASE_PROPS} menu={menu} t={spyT()} />)
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    expect(await screen.findByRole('menuitem', { name: '重命名…' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '创建子分支' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Fork 会话/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '移除' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: '兄弟分支' })).toBeNull()
  })

  it('canForkSibling 为真时菜单含兄弟分支项', async () => {
    const menu = menuDouble({ canForkSibling: true })
    render(<CompactCardHeader {...BASE_PROPS} menu={menu} t={spyT()} />)
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    expect(await screen.findByRole('menuitem', { name: '兄弟分支' })).toBeTruthy()
  })

  it('菜单「创建子分支」打开命名对话框，提交调用 forkChild(sessionId, name)', async () => {
    const menu = menuDouble()
    render(<CompactCardHeader {...BASE_PROPS} menu={menu} t={spyT()} />)
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '创建子分支' }))
    const input = await screen.findByLabelText('分支名称') as HTMLInputElement
    fireEvent.change(input, { target: { value: '子分支X' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await vi.waitFor(() => { expect(menu.actions.forkChild).toHaveBeenCalledWith('A', '子分支X') })
  })

  it('菜单「兄弟分支」打开命名对话框，提交调用 forkSibling——不是 forkPeer', async () => {
    const menu = menuDouble({ canForkSibling: true })
    render(<CompactCardHeader {...BASE_PROPS} menu={menu} t={spyT()} />)
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '兄弟分支' }))
    const input = await screen.findByLabelText('分支名称') as HTMLInputElement
    fireEvent.change(input, { target: { value: '兄弟X' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await vi.waitFor(() => { expect(menu.actions.forkSibling).toHaveBeenCalledWith('A', '兄弟X') })
    expect(menu.actions.forkPeer).not.toHaveBeenCalled()
  })

  it('菜单「⑂ Fork 会话」打开命名对话框，提交调用 forkPeer——不是 forkSibling', async () => {
    const menu = menuDouble()
    render(<CompactCardHeader {...BASE_PROPS} menu={menu} t={spyT()} />)
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Fork 会话/ }))
    const input = await screen.findByLabelText('分支名称') as HTMLInputElement
    fireEvent.change(input, { target: { value: '平级X' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await vi.waitFor(() => { expect(menu.actions.forkPeer).toHaveBeenCalledWith('A', '平级X') })
    expect(menu.actions.forkSibling).not.toHaveBeenCalled()
  })

  it('菜单「移除」打开确认对话框（无子代=单一确认），确认后调用 removeCard(sessionId, false)', async () => {
    const menu = menuDouble()
    render(<CompactCardHeader {...BASE_PROPS} menu={menu} t={spyT()} />)
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '移除' }))
    expect(screen.queryByText('仅本卡')).toBeNull() // no children: no cascade-scope choice
    fireEvent.click(await screen.findByRole('button', { name: '确认移除' }))
    await vi.waitFor(() => { expect(menu.actions.removeCard).toHaveBeenCalledWith('A', false) })
  })

  it('有子代时移除对话框显示"仅本卡/含所有子代"选择，选中含所有子代后调用 removeCard(sessionId, true)', async () => {
    const menu = menuDouble()
    render(<CompactCardHeader {...BASE_PROPS} childCount={2} menu={menu} t={spyT()} />)
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '移除' }))
    const withDescendants = await screen.findByLabelText(/含所有子代/)
    fireEvent.click(withDescendants)
    fireEvent.click(screen.getByRole('button', { name: '确认移除' }))
    await vi.waitFor(() => { expect(menu.actions.removeCard).toHaveBeenCalledWith('A', true) })
  })

  it('运行中的源会话点「创建子分支」只弹提示，不打开命名对话框、不 fork（spec §4）', async () => {
    const menu = menuDouble({ selfRunning: true })
    render(<CompactCardHeader {...BASE_PROPS} menu={menu} t={spyT()} />)
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '创建子分支' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(zh['card.fork.blocked'])
    expect(screen.queryByLabelText('分支名称')).toBeNull()
    expect(menu.actions.forkChild).not.toHaveBeenCalled()
  })

  it('运行中的有效父点「兄弟分支」只弹提示，不 fork', async () => {
    const menu = menuDouble({ canForkSibling: true, parentRunning: true })
    render(<CompactCardHeader {...BASE_PROPS} menu={menu} t={spyT()} />)
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '兄弟分支' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(menu.actions.forkSibling).not.toHaveBeenCalled()
  })

  it('D4：源会话尚无完成回合（selfForkReady=false）时点「创建子分支」只弹提示（未就绪文案），不 fork', async () => {
    const menu = menuDouble({ selfForkReady: false })
    render(<CompactCardHeader {...BASE_PROPS} menu={menu} t={spyT()} />)
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '创建子分支' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(zh['card.fork.notReady'])
    expect(screen.queryByLabelText('分支名称')).toBeNull()
    expect(menu.actions.forkChild).not.toHaveBeenCalled()
  })

  it('D4：有效父尚无完成回合（parentForkReady=false）时点「兄弟分支」只弹提示，不 fork', async () => {
    const menu = menuDouble({ canForkSibling: true, parentForkReady: false })
    render(<CompactCardHeader {...BASE_PROPS} menu={menu} t={spyT()} />)
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '兄弟分支' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(zh['card.fork.notReady'])
    expect(menu.actions.forkSibling).not.toHaveBeenCalled()
  })

  it('D4：菜单「⑂ Fork 会话」在源会话未就绪时也只弹提示，不 fork', async () => {
    const menu = menuDouble({ selfForkReady: false })
    render(<CompactCardHeader {...BASE_PROPS} menu={menu} t={spyT()} />)
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Fork 会话/ }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(zh['card.fork.notReady'])
    expect(menu.actions.forkPeer).not.toHaveBeenCalled()
  })

  it('命名对话框拒绝同层重名（同层唯一校验，childTitles 命中）', async () => {
    const menu = menuDouble({ childTitles: ['已存在'] })
    render(<CompactCardHeader {...BASE_PROPS} menu={menu} t={spyT()} />)
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '创建子分支' }))
    const input = await screen.findByLabelText('分支名称') as HTMLInputElement
    fireEvent.change(input, { target: { value: '已存在' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(menu.actions.forkChild).not.toHaveBeenCalled()
  })

  it('命名对话框拒绝超过 64 字的分支名', async () => {
    const menu = menuDouble()
    render(<CompactCardHeader {...BASE_PROPS} menu={menu} t={spyT()} />)
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '创建子分支' }))
    const input = await screen.findByLabelText('分支名称') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'x'.repeat(65) } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(menu.actions.forkChild).not.toHaveBeenCalled()
  })

  it('子会话徽标点击调用 drillTo(sessionId)（"子会话徽标紧凑头已自带"，Ruling-9）', () => {
    const menu = menuDouble()
    render(<CompactCardHeader {...BASE_PROPS} childCount={3} menu={menu} t={spyT()} />)
    fireEvent.click(screen.getByRole('button', { name: /子会话 3/ }))
    expect(menu.actions.drillTo).toHaveBeenCalledWith('A')
  })
})
