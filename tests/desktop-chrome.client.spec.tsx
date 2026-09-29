// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopChrome } from '../src/client/DesktopChrome.tsx'
afterEach(() => { cleanup(); delete (window as any).dshDesktop })
it('leaves browser and non-integrated windows untouched', () => {
  const { container } = render(<DesktopChrome width={280} />)
  expect(container.innerHTML).toBe('')
})
it('reserves native control space when collapsed and calls the existing application menu', async () => {
  const showAppMenu = vi.fn(async () => {})
  ;(window as any).dshDesktop = { integratedTitlebar: true, showAppMenu }
  const { container } = render(<DesktopChrome width={56} />)
  expect((container.firstChild as HTMLElement).style.width).toBe('112px')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '应用菜单' })) })
  expect(showAppMenu).toHaveBeenCalledOnce()
})
