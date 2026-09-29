// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MESSAGE_FORK_EVENT, MessageForkPanel, messageForkTarget, registerMessageFork } from '../src/client/carousel/message-fork.tsx'
afterEach(cleanup)
it('validates message identity and exact cut point', () => {
  expect(messageForkTarget({ sessionId: 'a', atSeq: 42 })).toEqual({ sessionId: 'a', atSeq: 42 })
  for (const atSeq of [undefined, -1, 1.5, NaN, '42']) expect(messageForkTarget({ sessionId: 'a', atSeq })).toBeUndefined()
})
it('claims the stock event, names before forking, preserves cut point and removes interception on disposal', async () => {
  const disposers: (() => void)[] = []
  let props: any
  const forkChild = vi.fn(async () => {})
  const list = { ids: ['a'], byId: { a: { blank: false, running: false } } }
  const ctx: any = {
    sessions: { list: { getSnapshot: () => list } },
    workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: [] }) } },
    effect: (fn: () => () => void) => disposers.push(fn()),
    slots: { inject: (_: string, fn: () => void) => fn(), register: (config: any) => { props = config.inject() } },
  }
  registerMessageFork(ctx, { getSnapshot: () => ({ org: { placements: [] } }) } as any, { forkChild } as any)
  render(<MessageForkPanel {...props} />)
  const request = () => window.dispatchEvent(new CustomEvent(MESSAGE_FORK_EVENT, { cancelable: true, detail: { sessionId: 'a', atSeq: 42 } }))
  act(() => { expect(request()).toBe(false) })
  expect(forkChild).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('取消'))
  expect(forkChild).not.toHaveBeenCalled()
  act(() => { request() })
  fireEvent.change(screen.getByLabelText('分支名称'), { target: { value: '选定回答的分支' } })
  fireEvent.click(screen.getByRole('button', { name: '创建子分支' }))
  await waitFor(() => expect(forkChild).toHaveBeenCalledWith('a', '选定回答的分支', 42))
  act(() => { disposers.forEach(fn => fn()) })
  expect(request()).toBe(true)
})
it('keeps the naming panel open on failure and allows retry', async () => {
  const target = { sessionId: 'a', atSeq: 42 }
  const submit = vi.fn().mockRejectedValueOnce(new Error('创建分支失败，请重试')).mockResolvedValueOnce(undefined)
  const close = vi.fn()
  render(<MessageForkPanel state={{ getSnapshot: () => target, subscribe: () => () => {} }}
    validate={(_, name) => name.trim() ? undefined : '请输入分支名称'} submit={submit} close={close} />)
  fireEvent.click(screen.getByRole('button', { name: '创建子分支' }))
  expect(submit).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('分支名称'), { target: { value: '重试分支' } })
  fireEvent.click(screen.getByRole('button', { name: '创建子分支' }))
  await screen.findByRole('alert')
  expect(close).not.toHaveBeenCalled()
  // Existing RenameDialog clears the error when the name is edited.
  fireEvent.change(screen.getByLabelText('分支名称'), { target: { value: '重试分支2' } })
  fireEvent.click(screen.getByRole('button', { name: '创建子分支' }))
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(submit).toHaveBeenCalledTimes(2)
})
