// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ImportPanel } from '../src/client/import/ImportPanel.tsx'
import type { ImportRequest, ImportResult } from '../src/import/wire.ts'
afterEach(() => { cleanup(); vi.useRealTimers() })
const empty: ImportResult = { workspace: 'test', path: '/test', items: [], total: 0, scanning: false, warning: '', messages: [], messageCount: 0, imported: false }
const item = (id: string) => ({ id, source: 'codex' as const, title: `session-${id}`, snippet: 'hello', updatedAt: 1, version: '1' })
const state = { subscribe: () => () => {}, getSnapshot: () => 'target' }
it('debounces search and ignores stale server results', async () => {
  vi.useFakeTimers()
  let resolveOld!: (result: ImportResult) => void
  const request = vi.fn((input: ImportRequest) => input.query === 'old' ? new Promise<ImportResult>(r => { resolveOld = r }) : Promise.resolve({ ...empty, items: [item(input.query || 'initial')], total: 1 }))
  render(<ImportPanel state={state} request={request} close={() => {}} completed={() => {}} />)
  await act(async () => {})
  fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value: 'old' } })
  await act(async () => { vi.advanceTimersByTime(199) })
  expect(request).toHaveBeenCalledTimes(1)
  await act(async () => { vi.advanceTimersByTime(1) })
  fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value: 'new' } })
  await act(async () => { vi.advanceTimersByTime(200) })
  await act(async () => { resolveOld({ ...empty, items: [item('old')], total: 1 }) })
  expect(screen.getByText('session-new')).toBeTruthy()
  expect(screen.queryByText('session-old')).toBeNull()
})
it('loads preview only after selection and prevents duplicate import clicks', async () => {
  let finish!: (result: ImportResult) => void
  const request = vi.fn((input: ImportRequest) => {
    if (input.action === 'import') return new Promise<ImportResult>(r => { finish = r })
    return Promise.resolve(input.action === 'list' ? { ...empty, items: [item('one')], total: 1 } : { ...empty, messages: [{ role: 'user' as const, text: '<script>not executed</script>' }], messageCount: 1 })
  })
  const close = vi.fn(); const completed = vi.fn()
  render(<ImportPanel state={state} request={request} close={close} completed={completed} />)
  await act(async () => {})
  expect(request).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByText('session-one'))
  await act(async () => {})
  expect(screen.getByText('<script>not executed</script>')).toBeTruthy()
  expect(document.querySelector('script')).toBeNull()
  fireEvent.click(screen.getByText('导入此会话'))
  fireEvent.click(screen.getByText('正在导入…'))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(close).not.toHaveBeenCalled()
  expect(request.mock.calls.filter(([r]) => r.action === 'import')).toHaveLength(1)
  await act(async () => { finish({ ...empty, imported: true }) })
  expect(completed).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce()
})
it('shows failure and allows rescan recovery', async () => {
  const request = vi.fn().mockRejectedValueOnce(new Error('读取失败')).mockResolvedValue(empty)
  render(<ImportPanel state={state} request={request} close={() => {}} completed={() => {}} />)
  await act(async () => {})
  expect(screen.getByRole('alert').textContent).toBe('读取失败')
  fireEvent.click(screen.getByText('重新扫描'))
  await act(async () => {})
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByText('当前项目暂无可导入的会话')).toBeTruthy()
})
it('opens latest preview, navigates with a stable snapshot and refreshes the list without replacing the page', async () => {
  vi.useFakeTimers()
  const request = vi.fn(async (input: ImportRequest): Promise<ImportResult> => input.action === 'list'
    ? { ...empty, items: [item('one')], total: 1 }
    : { ...empty, previewPage: input.previewPage ?? 2, previewPages: 3, previewVersion: '1', messageCount: 50, messages: [{ role: 'assistant', text: `page-${input.previewPage ?? 2}` }] })
  render(<ImportPanel state={state} request={request} close={() => {}} completed={() => {}} />)
  await act(async () => {})
  fireEvent.click(screen.getByText('session-one')); await act(async () => {})
  expect(screen.getByText('page-2')).toBeTruthy()
  fireEvent.click(screen.getByText('最早')); await act(async () => {})
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'preview', previewPage: 0, previewVersion: '1' }))
  expect(screen.getByText('page-0')).toBeTruthy()
  await act(async () => { vi.advanceTimersByTime(15000) })
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'list', refresh: true }))
  expect(screen.getByText('page-0')).toBeTruthy()
  fireEvent.click(screen.getByText('最新')); await act(async () => {})
  expect(screen.getByText('page-2')).toBeTruthy()
})
