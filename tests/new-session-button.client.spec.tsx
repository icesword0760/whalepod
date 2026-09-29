// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NewSessionButton } from '../src/client/carousel/NewSessionButton.tsx'
import { CompactCardHeader } from '../src/client/carousel/CompactCardHeader.tsx'
import { zh } from '../src/client/locales.ts'
import type { MatouKey } from '../src/client/locales.ts'
const t = (key: MatouKey) => zh[key]
afterEach(cleanup)
describe('card new session control', () => {
  it('passes the clicked card, blocks repeat clicks until completion, and does not activate its parent', async () => {
    let finish!: () => void
    const create = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const activate = vi.fn()
    render(<div onClick={activate}><NewSessionButton sessionId="B" create={create} t={t} /></div>)
    const button = screen.getByRole('button', { name: '新会话' }) as HTMLButtonElement
    fireEvent.click(button)
    expect(activate).not.toHaveBeenCalled()
    fireEvent.click(button)
    expect(create).toHaveBeenCalledExactlyOnceWith('B')
    expect(button.disabled).toBe(true)
    finish()
    await waitFor(() => { expect(button.disabled).toBe(false) })
  })
  it('shows failure and allows a retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const create = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    render(<NewSessionButton sessionId="B" create={create} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '新会话' }))
    expect(await screen.findByText(zh['scene.action.error'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '新会话' }))
    await waitFor(() => { expect(create).toHaveBeenCalledTimes(2) })
    expect(screen.queryByText(zh['scene.action.error'])).toBeNull()
    vi.restoreAllMocks()
  })
  it('places the terminal-plus control immediately before the compact more button', () => {
    const noop = vi.fn()
    render(<CompactCardHeader sessionId="B" title="B" hasNotice={false} childCount={0} t={t} menu={{
      actions: { newSessionNextTo: vi.fn(async () => {}), drillTo: noop, forkChild: noop, forkSibling: noop, forkPeer: noop, removeCard: noop },
      renameSession: noop, canForkSibling: false, selfRunning: false, parentRunning: false,
      selfForkReady: false, parentForkReady: false, childTitles: [], siblingTitles: [],
    }} />)
    const add = screen.getByRole('button', { name: '新会话' })
    expect(add.querySelector('svg[data-icon="panel-right-open"]')).toBeTruthy()
    expect(add.nextElementSibling).toBe(screen.getByRole('button', { name: zh['card.menu.more'] }))
  })
})
