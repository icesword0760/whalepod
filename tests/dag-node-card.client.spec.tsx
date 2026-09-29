// @vitest-environment jsdom
/**
 * S4 Task 9: the DAG's two card components plus the stylesheet gate.
 *
 * Three families of assertion live here:
 *
 * 1. **Node card** — every branch of its copy (four status labels, the empty
 *    preview placeholder, the "no activity" fallback, the suppressed
 *    「子会话」 segment) and its provider-agnostic guarantee: 码头's node card
 *    carries a mode badge (`DagCanvas.tsx:244,284-289`, Claude / Codex / 队友 /
 *    Shell) which DSH has no dimension for, so nothing in the rendered DOM may
 *    ever say any of those words.
 * 2. **Aggregate card** — the four `data-*` hooks the canvas and the page walk
 *    read, the **+1** depth display (`DagCanvas.tsx:275` — depths are 0-based
 *    internally, 1-based on screen), the three counts, and the border-priority
 *    classes.
 * 3. **`dag.module.css` source gate** — the repo's global
 *    `* { corner-shape: superellipse(1.5) }` (`ui-theme`'s `corner-shape.css`)
 *    squashes every circle and pill into a squircle unless the declaration
 *    itself restores `corner-shape: round`. No CI checks this (DSH's contract
 *    tests only scan its own packages), so this spec IS the CI for it.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CSSProperties } from 'react'
import { transform } from 'lightningcss'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { zh } from '../src/client/locales.ts'
import type { MatouKey } from '../src/client/locales.ts'
import type { DagNodeView } from '../src/client/dag/graph.ts'
import type { DagAggregateItem } from '../src/client/dag/render-model.ts'
import { DagNodeCard, compactPath } from '../src/client/dag/DagNodeCard.tsx'
import { DagAggregateCard } from '../src/client/dag/DagAggregateCard.tsx'
import css from '../src/client/dag/dag.module.css'

afterEach(cleanup)

/**
 * The `dag.*` copy Task 13 adds to `locales.ts`. Held here so this spec can
 * run before that task lands AND stay green after it: the assertions below
 * check that the right KEY reached `t` with the right params, which this
 * double proves independently of whatever final wording Task 13 chooses.
 */
const DAG_COPY: Record<string, string> = {
  'dag.node.open': '打开会话：{title}',
  'dag.node.notice': '新通知：{title}',
  'dag.node.children': '子会话 {n}',
  'dag.node.activity': '最近活动 {time}',
  'dag.node.noActivity': '暂无活动',
  'dag.node.emptyPreview': '暂无会话摘要',
  'dag.status.idle': '空闲',
  'dag.aggregate.branch': '远层分支',
  'dag.aggregate.layer': '远层层级',
  'dag.aggregate.count': '共 {n} 个会话',
  'dag.aggregate.range': '第 {from}–{to} 层 · 点击展开',
  'dag.aggregate.running': '运行中 {n}',
  'dag.aggregate.waiting': '等待输入 {n}',
  'dag.aggregate.done': '已完成 {n}',
  'dag.aggregate.label': '展开远层会话：共 {n} 个会话，运行中 {running}，等待输入 {waiting}，已完成 {done}',
}

/** A `t` double over the real zh dictionary plus {@link DAG_COPY}, same `{name}` interpolation as the runtime. */
function spyT(): Translate<MatouKey> {
  const dict: Record<string, string> = { ...zh, ...DAG_COPY }
  return vi.fn((key: string, params?: Record<string, unknown>) =>
    (dict[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))) as Translate<MatouKey>
}

const STYLE: CSSProperties = { left: 50, top: 50, width: 260, height: 174 }

function nodeDouble(over: Partial<DagNodeView> = {}): DagNodeView {
  return {
    sessionId: 'S-A',
    createdSeq: 0,
    title: '登录修复',
    cwd: '/srv/app',
    childCount: 0,
    lastActivityAt: 0,
    preview: '',
    hasNotice: false,
    subagent: false,
    ...over,
  }
}

function aggregateDouble(over: Partial<DagAggregateItem> = {}): DagAggregateItem {
  return {
    key: 'branch:S-R:after',
    kind: 'branch',
    direction: 'after',
    branchRootId: 'S-R',
    targetSessionId: 'S-T',
    sessionIds: ['S-T', 'S-U'],
    sessionCount: 2,
    counts: { running: 0, waiting: 0, done: 0 },
    x: 790,
    y: 120,
    width: 260,
    height: 174,
    minimumDepth: 2,
    maximumDepth: 4,
    ...over,
  }
}

/** A wall-clock timestamp whose local `HH:MM` needs zero padding on both halves. */
const NINE_OH_FIVE = new Date(2026, 0, 2, 9, 5, 0).getTime()

describe('DagNodeCard — 顶行状态（四档，与 workbench/status.ts 的三态点同一套词汇）', () => {
  it('state="ongoing" 显示「运行中」并画 ongoing 状态点', () => {
    const { container } = render(<DagNodeCard node={nodeDouble({ state: 'ongoing' })} focused={false} style={STYLE} onClick={vi.fn()} t={spyT()} />)
    expect(screen.getByText('运行中')).toBeTruthy()
    expect(container.querySelector('[data-state="ongoing"]')).not.toBeNull()
  })

  it('state="warning" 显示「等待输入」并画 warning 状态点', () => {
    const { container } = render(<DagNodeCard node={nodeDouble({ state: 'warning' })} focused={false} style={STYLE} onClick={vi.fn()} t={spyT()} />)
    expect(screen.getByText('等待输入')).toBeTruthy()
    expect(container.querySelector('[data-state="warning"]')).not.toBeNull()
  })

  it('state="done" 显示「已完成」并画 done 状态点', () => {
    const { container } = render(<DagNodeCard node={nodeDouble({ state: 'done' })} focused={false} style={STYLE} onClick={vi.fn()} t={spyT()} />)
    expect(screen.getByText('已完成')).toBeTruthy()
    expect(container.querySelector('[data-state="done"]')).not.toBeNull()
  })

  it('state 缺失显示「空闲」：不画 StateDot，改画一颗中性灰点', () => {
    const { container } = render(<DagNodeCard node={nodeDouble()} focused={false} style={STYLE} onClick={vi.fn()} t={spyT()} />)
    expect(screen.getByText('空闲')).toBeTruthy()
    expect(container.querySelector('[data-state]')).toBeNull()
    expect(container.querySelector(`.${css.idleDot}`)).not.toBeNull()
  })
})

describe('DagNodeCard — 未读通知（码头 dag.css:39-43 的 has-notification）', () => {
  it('hasNotice 为真时出现通知点并给卡片加描边类', () => {
    render(<DagNodeCard node={nodeDouble({ hasNotice: true })} focused={false} style={STYLE} onClick={vi.fn()} t={spyT()} />)
    expect(screen.getByRole('img', { name: '新通知：登录修复' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '打开会话：登录修复' }).className).toContain(css.hasNotice)
  })

  it('hasNotice 为假时既无通知点也无描边类', () => {
    render(<DagNodeCard node={nodeDouble()} focused={false} style={STYLE} onClick={vi.fn()} t={spyT()} />)
    expect(screen.queryByRole('img', { name: /新通知/ })).toBeNull()
    expect(screen.getByRole('button', { name: '打开会话：登录修复' }).className).not.toContain(css.hasNotice)
  })
})

describe('DagNodeCard — 目录行（compactPath，码头 DagCanvas.tsx:331-335）', () => {
  it('超过 42 字符的目录压成「…/最后两段」，title 属性仍是完整路径', () => {
    const cwd = '/Users/example/Documents/AIProjects/deepseek-harness/packages/client'
    render(<DagNodeCard node={nodeDouble({ cwd })} focused={false} style={STYLE} onClick={vi.fn()} t={spyT()} />)
    const path = screen.getByText('…/packages/client')
    expect(path.getAttribute('title')).toBe(cwd)
  })

  it('42 字符以内的目录原样显示', () => {
    render(<DagNodeCard node={nodeDouble({ cwd: '/srv/app' })} focused={false} style={STYLE} onClick={vi.fn()} t={spyT()} />)
    expect(screen.getByText('/srv/app')).toBeTruthy()
  })

  it('目录为空时整行不渲染', () => {
    const { container } = render(<DagNodeCard node={nodeDouble({ cwd: '' })} focused={false} style={STYLE} onClick={vi.fn()} t={spyT()} />)
    expect(container.querySelector(`.${css.path}`)).toBeNull()
  })

  it('compactPath 对没有分隔符的超长单段路径原样返回（不截成 …/）', () => {
    const flat = 'x'.repeat(60)
    expect(compactPath(flat)).toBe(flat)
    expect(compactPath('/srv/app')).toBe('/srv/app')
  })
})

describe('DagNodeCard — 正文（D-3：turnOutline 摘要，不是终端尾 4 行）', () => {
  it('preview 非空时原样渲染', () => {
    render(<DagNodeCard node={nodeDouble({ preview: '已改完登录态刷新，等你确认' })} focused={false} style={STYLE} onClick={vi.fn()} t={spyT()} />)
    expect(screen.getByText('已改完登录态刷新，等你确认')).toBeTruthy()
  })

  it('preview 为空时显示占位文案', () => {
    render(<DagNodeCard node={nodeDouble({ preview: '' })} focused={false} style={STYLE} onClick={vi.fn()} t={spyT()} />)
    expect(screen.getByText('暂无会话摘要')).toBeTruthy()
  })
})

describe('DagNodeCard — 末行（子会话数 · 最近活动）', () => {
  it('childCount 为 0 时不渲染「子会话」段，但最近活动仍在', () => {
    render(<DagNodeCard node={nodeDouble({ childCount: 0, lastActivityAt: NINE_OH_FIVE })} focused={false} style={STYLE} onClick={vi.fn()} t={spyT()} />)
    expect(screen.queryByText(/子会话/)).toBeNull()
    expect(screen.getByText('最近活动 09:05')).toBeTruthy()
  })

  it('childCount 大于 0 时渲染「子会话 N」（含子代理，诚实差异 4）', () => {
    render(<DagNodeCard node={nodeDouble({ childCount: 3, lastActivityAt: NINE_OH_FIVE })} focused={false} style={STYLE} onClick={vi.fn()} t={spyT()} />)
    expect(screen.getByText('子会话 3')).toBeTruthy()
  })

  it('lastActivityAt 为 0 时显示「暂无活动」而不是 1970 年的时刻', () => {
    render(<DagNodeCard node={nodeDouble({ lastActivityAt: 0 })} focused={false} style={STYLE} onClick={vi.fn()} t={spyT()} />)
    expect(screen.getByText('暂无活动')).toBeTruthy()
    expect(screen.queryByText(/最近活动/)).toBeNull()
  })
})

describe('DagNodeCard — 外壳契约（按钮语义 / 定位 / 画布钩子）', () => {
  it('根元素是 button，aria-label 含标题，带 data-session-id 与拖拽豁免钩子 data-dag-node', () => {
    render(<DagNodeCard node={nodeDouble()} focused={false} style={STYLE} onClick={vi.fn()} t={spyT()} />)
    const button = screen.getByRole('button', { name: '打开会话：登录修复' })
    expect(button.tagName).toBe('BUTTON')
    expect(button.getAttribute('type')).toBe('button')
    expect(button.getAttribute('data-session-id')).toBe('S-A')
    expect(button.hasAttribute('data-dag-node')).toBe(true)
  })

  it('style 原样落到内联样式上（布局算出来的世界坐标）', () => {
    render(<DagNodeCard node={nodeDouble()} focused={false} style={STYLE} onClick={vi.fn()} t={spyT()} />)
    const button = screen.getByRole('button', { name: '打开会话：登录修复' })
    expect(button.style.left).toBe('50px')
    expect(button.style.width).toBe('260px')
  })

  it('focused 为真才加聚焦类', () => {
    const { rerender } = render(<DagNodeCard node={nodeDouble()} focused={false} style={STYLE} onClick={vi.fn()} t={spyT()} />)
    expect(screen.getByRole('button', { name: '打开会话：登录修复' }).className).not.toContain(css.isFocused)
    rerender(<DagNodeCard node={nodeDouble()} focused style={STYLE} onClick={vi.fn()} t={spyT()} />)
    expect(screen.getByRole('button', { name: '打开会话：登录修复' }).className).toContain(css.isFocused)
  })

  it('点击调用 onClick', () => {
    const onClick = vi.fn()
    render(<DagNodeCard node={nodeDouble()} focused={false} style={STYLE} onClick={onClick} t={spyT()} />)
    fireEvent.click(screen.getByRole('button', { name: '打开会话：登录修复' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('DagNodeCard — Provider 无关（码头的模式徽标一律不移植）', () => {
  it('即使 props 上挂着 currentMode 样的字段，DOM 里也不出现任何 provider 字样', () => {
    const node = { ...nodeDouble({ preview: '在跑测试', cwd: '/srv/app' }), currentMode: 'claude-code' } as DagNodeView
    const { container } = render(<DagNodeCard node={node} focused={false} style={STYLE} onClick={vi.fn()} t={spyT()} />)
    expect(screen.queryByText(/Claude|Codex|Shell|队友/)).toBeNull()
    expect(container.textContent).not.toMatch(/Claude|Codex|Shell|队友|claude-code/)
  })
})

describe('DagAggregateCard — 眉题、总数与深度区间（显示值 = 内部深度 + 1）', () => {
  it('kind="branch" 的眉题是「远层分支」', () => {
    render(<DagAggregateCard aggregate={aggregateDouble({ kind: 'branch' })} style={STYLE} onClick={vi.fn()} t={spyT()} />)
    expect(screen.getByText('远层分支')).toBeTruthy()
  })

  it('kind="layer-overflow" 的眉题是「远层层级」', () => {
    render(<DagAggregateCard aggregate={aggregateDouble({ kind: 'layer-overflow' })} style={STYLE} onClick={vi.fn()} t={spyT()} />)
    expect(screen.getByText('远层层级')).toBeTruthy()
  })

  it('渲染 sessionCount 与「第 3–5 层」（minimumDepth 2 / maximumDepth 4 各 +1）', () => {
    render(<DagAggregateCard aggregate={aggregateDouble({ sessionCount: 7, minimumDepth: 2, maximumDepth: 4 })} style={STYLE} onClick={vi.fn()} t={spyT()} />)
    expect(screen.getByText('共 7 个会话')).toBeTruthy()
    expect(screen.getByText('第 3–5 层 · 点击展开')).toBeTruthy()
  })
})

describe('DagAggregateCard — 三栏计数（DSH 的 running/waiting/done，没有「异常」档）', () => {
  it('三个计数各自渲染，且 aria-label 汇总同一组数字', () => {
    const aggregate = aggregateDouble({ sessionCount: 6, counts: { running: 2, waiting: 1, done: 3 } })
    render(<DagAggregateCard aggregate={aggregate} style={STYLE} onClick={vi.fn()} t={spyT()} />)
    expect(screen.getByText('运行中 2')).toBeTruthy()
    expect(screen.getByText('等待输入 1')).toBeTruthy()
    expect(screen.getByText('已完成 3')).toBeTruthy()
    expect(screen.getByRole('button', { name: '展开远层会话：共 6 个会话，运行中 2，等待输入 1，已完成 3' })).toBeTruthy()
  })

  it('不渲染任何「异常」档（码头 counts.error 在 DSH 无对应信号）', () => {
    const { container } = render(<DagAggregateCard aggregate={aggregateDouble()} style={STYLE} onClick={vi.fn()} t={spyT()} />)
    expect(container.textContent).not.toMatch(/异常|出错/)
  })
})

describe('DagAggregateCard — 边框优先级类与 data-* 钩子', () => {
  it('三栏都有数时三个类同时挂上（优先级交给 CSS 的 :not() 链）', () => {
    const aggregate = aggregateDouble({ counts: { running: 2, waiting: 1, done: 3 } })
    const { container } = render(<DagAggregateCard aggregate={aggregate} style={STYLE} onClick={vi.fn()} t={spyT()} />)
    const button = container.querySelector('[data-aggregate-key]') as HTMLElement
    expect(button.className).toContain(css.hasRunning)
    expect(button.className).toContain(css.hasWaiting)
    expect(button.className).toContain(css.hasDone)
  })

  it('三栏全 0 时一个状态类都不挂', () => {
    const { container } = render(<DagAggregateCard aggregate={aggregateDouble()} style={STYLE} onClick={vi.fn()} t={spyT()} />)
    const button = container.querySelector('[data-aggregate-key]') as HTMLElement
    expect(button.className).not.toContain(css.hasRunning)
    expect(button.className).not.toContain(css.hasWaiting)
    expect(button.className).not.toContain(css.hasDone)
  })

  it('四个 data-* 钩子齐全，并带拖拽豁免钩子 data-dag-aggregate', () => {
    const aggregate = aggregateDouble({ key: 'layer:0-4:before', kind: 'layer-overflow', direction: 'before', sessionCount: 9 })
    const { container } = render(<DagAggregateCard aggregate={aggregate} style={STYLE} onClick={vi.fn()} t={spyT()} />)
    const button = container.querySelector('[data-aggregate-key]') as HTMLElement
    expect(button.getAttribute('data-aggregate-key')).toBe('layer:0-4:before')
    expect(button.getAttribute('data-aggregate-kind')).toBe('layer-overflow')
    expect(button.getAttribute('data-aggregate-count')).toBe('9')
    expect(button.getAttribute('data-direction')).toBe('before')
    expect(button.hasAttribute('data-dag-aggregate')).toBe(true)
  })

  it('点击调用 onClick', () => {
    const onClick = vi.fn()
    render(<DagAggregateCard aggregate={aggregateDouble()} style={STYLE} onClick={onClick} t={spyT()} />)
    fireEvent.click(screen.getByRole('button', { name: /展开远层会话/ }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('dag.module.css — 源文本闸门（没有 CI 会拦，这段测试就是那个 CI）', () => {
  const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), '../src/client/dag/dag.module.css')
  const source = readFileSync(cssPath, 'utf8')
  /** Every innermost declaration block; nested at-rules yield their inner blocks, which is what we want. */
  const blocks = source.match(/\{[^{}]*\}/g) ?? []
  const roundish = blocks.filter((block) => /border-radius\s*:[^;]*(50%|999px)/.test(block))

  it('用 tsdown 的同一套 lightningcss 配置能编译通过（vitest 的 css:false 不会替我们发现语法错）', () => {
    expect(() => transform({
      filename: cssPath,
      code: readFileSync(cssPath),
      cssModules: { pattern: 'matou_[local]_[hash]' },
      minify: false,
    })).not.toThrow()
  })

  it('至少存在一处圆点/胶囊声明（否则下面那条断言会空转通过）', () => {
    expect(roundish.length).toBeGreaterThan(0)
  })

  it('每一处 border-radius: 50% / 999px 都在同一声明块里补了 corner-shape: round', () => {
    for (const block of roundish) expect(block).toMatch(/corner-shape\s*:\s*round/)
  })

  it('正文框高度容得下三行 clamp：3 × 字号 × 行高 + 上下内边距 ≤ height（照抄码头的 48px 会切掉第三行）', () => {
    const block = source.match(/\.preview\s*\{[^}]*\}/)?.[0] ?? ''
    expect(block).toMatch(/-webkit-line-clamp:\s*3/)
    const read = (pattern: RegExp): number => Number(block.match(pattern)?.[1] ?? Number.NaN)
    const height = read(/[;{\s]height:\s*([\d.]+)px/)
    const fontSize = read(/font-size:\s*([\d.]+)px/)
    const lineHeight = read(/line-height:\s*([\d.]+)\s*;/)
    const padding = read(/padding:\s*([\d.]+)px/)
    expect([height, fontSize, lineHeight, padding].some(Number.isNaN)).toBe(false)
    expect(3 * fontSize * lineHeight + 2 * padding).toBeLessThanOrEqual(height)
  })

  it('缩放到 0.4 时隐藏正文/元信息/目录（码头 dag.css:73）', () => {
    const gate = source.match(/\[data-scale\^="0\.4"\][^{]*\{[^}]*\}/)
    expect(gate).not.toBeNull()
    const rule = gate?.[0] ?? ''
    expect(rule).toContain('.preview')
    expect(rule).toContain('.meta')
    expect(rule).toContain('.path')
    expect(rule).toMatch(/visibility\s*:\s*hidden/)
  })

  it('prefers-reduced-motion 下关掉过渡与到达动画（码头 dag.css:91-94）', () => {
    const index = source.indexOf('@media (prefers-reduced-motion: reduce)')
    expect(index).toBeGreaterThan(-1)
    const tail = source.slice(index)
    expect(tail).toMatch(/animation\s*:\s*none/)
    expect(tail).toMatch(/transition-duration\s*:\s*1ms/)
  })

  it('聚合卡边框优先级是 waiting > running > done 的 :not() 链（没有 error 档）', () => {
    expect(source).toMatch(/\.aggregate\.hasWaiting\b/)
    expect(source).toMatch(/\.aggregate\.hasRunning:not\(\.hasWaiting\)/)
    expect(source).toMatch(/\.aggregate\.hasDone:not\(\.hasWaiting\):not\(\.hasRunning\)/)
    expect(source).not.toMatch(/hasError/)
  })

  it('颜色一律走 DSH 的 --dsw-* token，不写死 rgb/hex 字面量（码头那份 dark 调色板与 .light-theme 副本一概不移植）', () => {
    // Prose is allowed to NAME the banned forms; only declarations are checked.
    const declarations = source.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(declarations).toContain('--dsw-alias-state-business-primary')
    expect(declarations).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(declarations).not.toMatch(/\brgb\(/)
    expect(declarations).not.toMatch(/light-theme/)
  })
})
