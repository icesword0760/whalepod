/**
 * DSH 的 `Menu`（`dsh-client-ui-primitives/src/Menu.tsx`）把定位写在一条
 * `useLayoutEffect` 里，依赖数组是 `[open, portal, align, side, getAnchorRect]`，
 * 而它每跑一次就 `setFixedPos({ left, top })` —— 一个**新对象**。
 *
 * 于是 `getAnchorRect` 只要是内联箭头函数（每次渲染换一个引用），就会
 * 渲染 → 重新定位 → 改 state → 再渲染，React 数到第 50 层抛 #185
 * (`Maximum update depth exceeded`)，把整棵 slot 子树卸载成白屏。
 *
 * 菜单**关着**的时候那条分支写的是 `setFixedPos(null)`，同值会被 React 吞掉，
 * 所以卡片少时看不出任何异常；一个页签堆到十几张卡、每张各挂一个菜单，就必崩。
 * 2026-09-14 桌面端走查实测到这一条。
 *
 * 这道闸门是源码文本级的：`getAnchorRect` 必须传一个**具名的、引用稳定的**回调
 * （`useCallback` 或模块级常量），不能是内联函数字面量。没有任何 CI 会拦这件事。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return full.endsWith('.ts') || full.endsWith('.tsx') ? [full] : []
  })
}

describe('DSH Menu 的 getAnchorRect 必须引用稳定', () => {
  it('源码里没有任何一处把内联函数字面量传给 getAnchorRect', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8')
      text.split('\n').forEach((line, index) => {
        // `getAnchorRect={() => …}` / `getAnchorRect={(x) => …}` / `getAnchorRect={function …}`
        if (/getAnchorRect=\{\s*(\(|function\b|async\b)/.test(line)) {
          offenders.push(`${file.slice(SRC.length + 1)}:${index + 1} ${line.trim()}`)
        }
      })
    }
    expect(offenders, '内联箭头函数会让 DSH 的 Menu 每渲染一次就重新定位一次，卡片一多就把应用打成白屏').toEqual([])
  })

  it('两个挂菜单的卡片头都用 useCallback 稳住了这个回调', () => {
    for (const file of ['client/carousel/header-seats.tsx', 'client/carousel/CompactCardHeader.tsx']) {
      const text = readFileSync(join(SRC, file), 'utf8')
      expect(text, `${file} 应当有一个具名的 getAnchorRect`).toMatch(/const getAnchorRect = useCallback\(/)
      expect(text, `${file} 应当把它原样传给 Menu`).toMatch(/getAnchorRect=\{getAnchorRect\}/)
    }
  })
})
