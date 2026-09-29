// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { zh } from '../src/client/locales.ts'
import type { MatouKey } from '../src/client/locales.ts'
import { Breadcrumb } from '../src/client/carousel/Breadcrumb.tsx'

afterEach(cleanup)

/** A spy wrapping the real zh dictionary (same convention as card-shell.client.spec.tsx). */
function spyT() {
  return vi.fn((key: MatouKey, params?: Record<string, unknown>) =>
    zh[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? '')))
}

describe('Breadcrumb', () => {
  it('渲染「返回父会话」按钮 + 「X 的子会话 · N 个会话」，经 t() 取文案（spec §4）', () => {
    const t = spyT()
    render(<Breadcrumb parentTitle="登录修复" count={3} onReturnToParent={() => {}} t={t} />)
    expect(screen.getByRole('button', { name: /返回父会话/ })).toBeTruthy()
    expect(screen.getByText('登录修复 的子会话 · 3 个会话')).toBeTruthy()
    expect(t).toHaveBeenCalledWith('breadcrumb.children', { title: '登录修复', n: 3 })
    expect(t).toHaveBeenCalledWith('breadcrumb.return')
  })

  it('点击「返回父会话」按钮调用 onReturnToParent', () => {
    const onReturnToParent = vi.fn()
    render(<Breadcrumb parentTitle="A" count={1} onReturnToParent={onReturnToParent} t={spyT()} />)
    fireEvent.click(screen.getByRole('button', { name: /返回父会话/ }))
    expect(onReturnToParent).toHaveBeenCalledTimes(1)
  })

  it('容器带 role="navigation" 与本地化 aria-label（层级导航）', () => {
    const t = spyT()
    render(<Breadcrumb parentTitle="A" count={1} onReturnToParent={() => {}} t={t} />)
    const nav = screen.getByRole('navigation')
    expect(nav.getAttribute('aria-label')).toBe('层级导航')
    expect(t).toHaveBeenCalledWith('breadcrumb.nav')
  })

  it('count 为 0（子会话刚被移除殆尽）仍正确渲染，不抛错', () => {
    render(<Breadcrumb parentTitle="A" count={0} onReturnToParent={() => {}} t={spyT()} />)
    expect(screen.getByText('A 的子会话 · 0 个会话')).toBeTruthy()
  })
})
