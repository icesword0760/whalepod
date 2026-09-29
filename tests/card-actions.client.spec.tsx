// @vitest-environment jsdom
/**
 * D5 (S3b Task 11d): the shared fork-naming dialog (`CardActionDialogs`,
 * reused by both `CardHeaderActions` and `CompactCardHeader`) must never
 * show DSH's raw backend prose to the user — see `humanizeForkError`'s doc
 * in `card-actions.tsx` for why. These tests exercise both the pure mapping
 * function and the dialog's actual catch path (a rejected `forkChild`/
 * `forkSibling`/`forkPeer` call).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { zh } from '../src/client/locales.ts'
import type { MatouKey } from '../src/client/locales.ts'
import { CardActionDialogs, humanizeForkError } from '../src/client/carousel/card-actions.tsx'
import type { CardForkActionsFace } from '../src/client/carousel/card-actions.tsx'

afterEach(cleanup)

/** A spy wrapping the real zh dictionary (same convention used across the carousel suites). */
function spyT() {
  return vi.fn((key: MatouKey, params?: Record<string, unknown>) =>
    zh[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? '')))
}

/**
 * The exact shape DSH's fork RPC throws (`ClientSessions.fork`'s
 * `SessionForkError`) when the source has no completed turn: a plain
 * structural double — not the real `SessionForkError`/`RemoteError` classes
 * — reusing this suite's established convention (`org-store.client.spec.ts`'s
 * `transportFailure`) of faking `RemoteFailure`'s exact shape rather than
 * importing DSH's real runtime classes into a unit test. `remoteErrorOf`
 * (the sanctioned discrimination path — see `humanizeForkError`'s doc)
 * only ever reads `isDSHRemoteError`/`code` structurally, so this is a
 * faithful double, not a shortcut.
 */
function forkUnavailableError(): Error {
  const sessionId = 'session-48fd4caa-6ea4-4c11-9c8e-000000000000'
  const rpcError = {
    isDSHRemoteError: true as const,
    code: 'session/fork-unavailable',
    message: `session "${sessionId}" has no completed turn to fork from`,
    details: { sessionId },
  }
  return Object.assign(
    new Error(`session fork failed: ${rpcError.code}: ${rpcError.message}`),
    { name: 'SessionForkError', rpcError, sourceSessionId: sessionId },
  )
}

function actionsDouble(over: Partial<CardForkActionsFace> = {}): CardForkActionsFace {
  return {
    forkChild: vi.fn(async () => undefined),
    forkSibling: vi.fn(async () => undefined),
    forkPeer: vi.fn(async () => undefined),
    removeCard: vi.fn(async () => undefined),
    ...over,
  }
}

const DIALOG_BASE = {
  sessionId: 'A',
  title: '登录修复',
  childCount: 0,
  renameSession: vi.fn(async () => undefined),
  childTitles: [],
  siblingTitles: [],
  renameOpen: false,
  onRenameClose: () => {},
  onForkClose: () => {},
  removeOpen: false,
  onRemoveClose: () => {},
}

/**
 * C2 (final review): 「仅本卡」does not orphan the descendants — it re-attaches
 * them — and the dialog has to say which of the two things happens, exactly as
 * 码头's own remove dialog does (`RemoveNodeDialog.tsx:31-35`).
 */
describe('CardActionDialogs — 移除对话框说明后代去向（C2，对齐码头 RemoveNodeDialog）', () => {
  it('有子代且本卡有父：「仅本卡」说明后代重连到当前节点的父级', () => {
    render(
      <CardActionDialogs
        {...DIALOG_BASE} childCount={2} hasParent actions={actionsDouble()} forkMode={null} removeOpen t={spyT()}
      />,
    )
    expect(screen.getByText(zh['card.remove.onlyThis.hint'])).toBeTruthy()
    expect(screen.queryByText(zh['card.remove.onlyThis.hintRoot'])).toBeNull()
  })

  it('有子代但本卡是根：「仅本卡」说明直接后代将成为根会话', () => {
    render(
      <CardActionDialogs
        {...DIALOG_BASE} childCount={2} actions={actionsDouble()} forkMode={null} removeOpen t={spyT()}
      />,
    )
    expect(screen.getByText(zh['card.remove.onlyThis.hintRoot'])).toBeTruthy()
    expect(screen.queryByText(zh['card.remove.onlyThis.hint'])).toBeNull()
  })

  it('无子代时不出现范围选择，也就不出现任何后代说明', () => {
    render(
      <CardActionDialogs {...DIALOG_BASE} actions={actionsDouble()} forkMode={null} removeOpen t={spyT()} />,
    )
    expect(screen.queryByText(zh['card.remove.onlyThis'])).toBeNull()
    expect(screen.queryByText(zh['card.remove.onlyThis.hintRoot'])).toBeNull()
  })
})

/**
 * 用户报的（2026-09-14）：移除对话框写的是「该会话将被归档。是否继续？」。
 *
 * 「归档」是 DSH 内部 API 的名字（`workspaces.archiveSession`）——用户无从知道它
 * 意味着什么，更不知道自己的文件会不会跟着没。**行为**当初是照码头做的（卡片从
 * 会话列表和关系图里消失、项目文件不动、选「仅本卡」时子代重挂到父级），**文案**
 * 没有：码头 `RemoveNodeDialog` 的 `leafBody` 讲的是看得见的后果，且两条分支都带
 * 一句 `filesUnchanged`（「项目文件保持不变」）——那正是用户此刻最想知道的事。
 */
describe('移除对话框的文案不得泄露内部词汇（对齐码头 removeDialog）', () => {
  const INTERNAL = [/归档/, /archive/i]

  it('无子代时：讲后果 + 明确安抚文件不受影响，不出现「归档」', () => {
    for (const re of INTERNAL) expect(zh['card.remove.body']).not.toMatch(re)
    expect(zh['card.remove.body']).toContain('会话列表')
    expect(zh['card.remove.body']).toContain('项目文件不受影响')
  })

  it('有子代时：选择范围那一屏同样带上「文件不受影响」', () => {
    for (const re of INTERNAL) expect(zh['card.remove.scope']).not.toMatch(re)
    expect(zh['card.remove.scope']).toContain('项目文件不受影响')
  })

  it('标题点名被移除的那张卡（码头 `removeDialog.title(name)`）', () => {
    expect(zh['card.remove.title']).toContain('{name}')
  })

  it('渲染出来的对话框里没有任何内部词汇', () => {
    render(
      <CardActionDialogs
        {...DIALOG_BASE} title="登录流程" actions={actionsDouble()} forkMode={null} removeOpen t={spyT()}
      />,
    )
    const dialog = screen.getByRole('dialog')
    for (const re of INTERNAL) expect(dialog.textContent ?? '').not.toMatch(re)
    expect(dialog.textContent).toContain('登录流程') // 标题点名了这张卡
  })
})

describe('humanizeForkError（D5：裸英文/裸 UUID 不得直出）', () => {
  it('session/fork-unavailable 映射为「未就绪」中文文案，且原始错误记录到 console', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const error = forkUnavailableError()
    const result = humanizeForkError(error, spyT())
    expect(result.message).toBe(zh['card.fork.notReady'])
    expect(result.message).not.toMatch(/session-|fork-unavailable|has no completed turn/)
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('fork failed'), error)
    spy.mockRestore()
  })

  it('其他 fork 失败（重名/目录问题/网关错误等）映射为通用「创建分支失败」文案，不泄漏原始英文', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const error = new Error('gateway/internal: failed to resolve fork workspace for session "x"')
    const result = humanizeForkError(error, spyT())
    expect(result.message).toBe(zh['card.fork.error'])
    expect(result.message).not.toMatch(/gateway|workspace/)
    spy.mockRestore()
  })

  it('非 Error 的抛出值（如字符串）同样映射为通用文案，不直出', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const result = humanizeForkError('raw string throw', spyT())
    expect(result.message).toBe(zh['card.fork.error'])
    spy.mockRestore()
  })
})

describe('CardActionDialogs — fork 提交失败时的错误显示（D5）', () => {
  it('forkChild 失败于 session/fork-unavailable：对话框显示中文「未就绪」提示，而非裸英文/UUID', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const actions = actionsDouble({ forkChild: vi.fn(async () => { throw forkUnavailableError() }) })
    render(<CardActionDialogs {...DIALOG_BASE} actions={actions} forkMode="child" t={spyT()} />)
    const input = await screen.findByLabelText('分支名称') as HTMLInputElement
    fireEvent.change(input, { target: { value: '子分支A' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(zh['card.fork.notReady'])
    expect(alert.textContent).not.toMatch(/session-|fork-unavailable|has no completed turn/)
    spy.mockRestore()
  })

  it('forkSibling 失败于其他原因：对话框显示通用中文失败提示，而非裸英文', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const actions = actionsDouble({
      forkSibling: vi.fn(async () => { throw new Error('gateway/internal: something broke') }),
    })
    render(<CardActionDialogs {...DIALOG_BASE} actions={actions} forkMode="sibling" t={spyT()} />)
    const input = await screen.findByLabelText('分支名称') as HTMLInputElement
    fireEvent.change(input, { target: { value: '兄弟A' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(zh['card.fork.error'])
    expect(alert.textContent).not.toMatch(/gateway/)
    spy.mockRestore()
  })

  it('forkPeer 失败于 session/fork-unavailable：对话框显示中文「未就绪」提示', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const actions = actionsDouble({ forkPeer: vi.fn(async () => { throw forkUnavailableError() }) })
    render(<CardActionDialogs {...DIALOG_BASE} actions={actions} forkMode="peer" t={spyT()} />)
    const input = await screen.findByLabelText('分支名称') as HTMLInputElement
    fireEvent.change(input, { target: { value: '平级A' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(zh['card.fork.notReady'])
    spy.mockRestore()
  })
})


/**
 * 首次活体走查（2026-09-06）逮到的第二个缺陷。
 *
 * 复现：在一个只剩一张卡的页签里点「移除」→「确认移除」。卡片确实没被删掉
 *（`workbench/actions.ts` 的 `removeCard` 按 spec §3「会清空页签时拒绝」抛错），
 * 但对话框照常关闭，页面上**没有任何提示**——用户看到的是「我点了确认，什么都
 * 没发生」，与「坏了」无法区分。
 *
 * 根因是 `onConfirm` 只有 `await actions.removeCard(...)` 而没有 catch，
 * 那个拒绝变成了无人接手的 promise rejection。同文件的 fork 路径早就有轻提示
 *（`card.fork.blocked` / `card.fork.notReady` / `card.fork.error`），只是移除
 * 没用上这套。
 */
describe('CardActionDialogs — 移除被拒绝时必须给出提示（活体走查所获）', () => {
  it('removeCard 因「会清空页签」被拒时，显示中文提示而不是静默关闭', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const actions = actionsDouble({
      removeCard: vi.fn(async () => {
        throw new Error('matou-layout: removing this would leave the tab with no sessions; keep at least one')
      }),
    })
    render(
      <CardActionDialogs {...DIALOG_BASE} actions={actions} forkMode={null} removeOpen t={spyT()} />,
    )
    fireEvent.click(screen.getByText(zh['card.remove.confirm']))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(zh['card.remove.lastInScene'])
    // 裸英文/内部前缀不许直出给用户
    expect(alert.textContent).not.toMatch(/matou-layout|leave the tab|keep at least one/)
    spy.mockRestore()
  })

  it('removeCard 因其他原因失败：给通用中文提示，同样不静默', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const actions = actionsDouble({
      removeCard: vi.fn(async () => { throw new Error('gateway/internal: boom') }),
    })
    render(
      <CardActionDialogs {...DIALOG_BASE} actions={actions} forkMode={null} removeOpen t={spyT()} />,
    )
    fireEvent.click(screen.getByText(zh['card.remove.confirm']))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(zh['card.remove.error'])
    expect(alert.textContent).not.toMatch(/gateway/)
    spy.mockRestore()
  })

  it('移除成功时不出现任何提示（反例，证明上面两条不是恒真）', async () => {
    const actions = actionsDouble({ removeCard: vi.fn(async () => undefined) })
    render(
      <CardActionDialogs {...DIALOG_BASE} actions={actions} forkMode={null} removeOpen t={spyT()} />,
    )
    fireEvent.click(screen.getByText(zh['card.remove.confirm']))
    await new Promise(r => setTimeout(r, 50))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
