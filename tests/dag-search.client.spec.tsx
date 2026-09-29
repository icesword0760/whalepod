// @vitest-environment jsdom
/**
 * S4 Task 11: the DAG overlay's node search box.
 *
 * `tests/dag-search.spec.ts` already pins the SCORING (`dag/search.ts`); this
 * file pins everything the box adds on top of it, and only that:
 *
 * 1. **The list the user actually sees** — score order, the 12-hit cap, the
 *    「无匹配」 line, and the panel staying away entirely while nothing is
 *    being searched.
 * 2. **Keyboard navigation inside the input** (spec §4; D-4 killed the global
 *    shortcuts but explicitly kept these) — `↓`/`↑` cycling and `Enter`.
 * 3. **The two-phase commit** (码头 `DagSearch.tsx:15-18`): `onPreview` fires
 *    NOW so the canvas glides onto the card, `onChoose` fires on the NEXT
 *    frame so the user sees which card they picked before the overlay closes.
 *    A single-call implementation, or one that fires them in the other order,
 *    must fail here.
 * 4. **Provider-agnostic subtitles** — 码头 prints `Claude Code · cwd`
 *    (`DagSearch.tsx:36`); DSH has no provider dimension, so the subtitle is
 *    the working directory alone and no provider word may reach the DOM.
 * 5. **Open-and-type** (D-4 / T-3) — the box takes focus on mount, which is
 *    the whole replacement for the cancelled Cmd+F.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { zh } from '../src/client/locales.ts'
import type { MatouKey } from '../src/client/locales.ts'
import type { DagNodeView } from '../src/client/dag/graph.ts'
import { DagSearch } from '../src/client/dag/DagSearch.tsx'

afterEach(cleanup)

/**
 * The `dag.search.*` copy Task 13 adds to `locales.ts`. Held here so this spec
 * runs before that task lands and stays green after it — the assertions check
 * that the right KEY reached `t`, not that Task 13 picked any wording.
 */
const DAG_COPY: Record<string, string> = {
  'dag.search.label': '搜索会话',
  'dag.search.placeholder': '搜索名称、目录或摘要…',
  'dag.search.results': '搜索结果',
  'dag.search.empty': '没有匹配的会话',
}

/** A `t` double over the real zh dictionary plus {@link DAG_COPY}, same `{name}` interpolation as the runtime. */
function spyT(): Translate<MatouKey> {
  const dict: Record<string, string> = { ...zh, ...DAG_COPY }
  return vi.fn((key: string, params?: Record<string, unknown>) =>
    (dict[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))) as Translate<MatouKey>
}

function nodeDouble(over: Partial<DagNodeView> & { readonly sessionId: string }): DagNodeView {
  return {
    createdSeq: 0,
    title: '未命名会话',
    cwd: '',
    childCount: 0,
    lastActivityAt: 0,
    preview: '',
    hasNotice: false,
    subagent: false,
    ...over,
  }
}

/**
 * One node per scoring tier of `dag/search.ts`, so 「按分数排序」 below is a
 * statement about the rendered order and not about the sort being called:
 * `S-1` 100 (title equals), `S-2` 80 (title prefix), `S-3` 60 (title contains),
 * `S-4` 30 (cwd contains), `S-5` 20 (preview contains).
 */
const TIERS: readonly DagNodeView[] = [
  // Deliberately mounted in the WRONG order, so a component that renders
  // `nodes` untouched cannot pass the ordering assertion by accident.
  nodeDouble({ sessionId: 'S-5', createdSeq: 4, title: '接口联调', cwd: '/srv/api', preview: '已经把登录态刷新了' }),
  nodeDouble({ sessionId: 'S-3', createdSeq: 2, title: '修复登录态', cwd: '/srv/api' }),
  nodeDouble({ sessionId: 'S-1', createdSeq: 0, title: '登录', cwd: '/srv/app' }),
  nodeDouble({ sessionId: 'S-4', createdSeq: 3, title: '缓存清理', cwd: '/srv/登录服务' }),
  nodeDouble({ sessionId: 'S-2', createdSeq: 1, title: '登录修复', cwd: '/srv/app' }),
]

/** 15 equally-scoring hits (every title starts with 「会话」), ordered only by `createdSeq`. */
const FIFTEEN: readonly DagNodeView[] = Array.from({ length: 15 }, (_, index) => {
  const ordinal = String(index + 1).padStart(2, '0')
  return nodeDouble({ sessionId: `S-${ordinal}`, createdSeq: index, title: `会话 ${ordinal}` })
})

interface Harness {
  readonly input: HTMLInputElement
  readonly onPreview: ReturnType<typeof vi.fn>
  readonly onChoose: ReturnType<typeof vi.fn>
  readonly onQueryChange: ReturnType<typeof vi.fn>
  readonly container: HTMLElement
  readonly rerenderWith: (nodes: readonly DagNodeView[]) => void
  readonly setQuery: (query: string) => void
}

/**
 * Mount the box. `query` present ⇒ controlled mount (what the overlay uses so
 * its Esc handler can clear the query, T-4); absent ⇒ the box owns the query.
 * @param nodes - the graph's nodes.
 * @param query - the controlled query, or undefined for an uncontrolled mount.
 * @returns the input, the three spies and two re-render helpers.
 */
function mount(nodes: readonly DagNodeView[], query?: string): Harness {
  const onPreview = vi.fn()
  const onChoose = vi.fn()
  const onQueryChange = vi.fn()
  const element = (over: { nodes?: readonly DagNodeView[]; query?: string | undefined }) => (
    <DagSearch
      nodes={over.nodes ?? nodes}
      query={'query' in over ? over.query : query}
      onQueryChange={onQueryChange}
      onPreview={onPreview}
      onChoose={onChoose}
      t={spyT()}
    />
  )
  const { container, rerender } = render(element({}))
  return {
    input: screen.getByRole('searchbox') as HTMLInputElement,
    onPreview,
    onChoose,
    onQueryChange,
    container: container as HTMLElement,
    rerenderWith: (next) => { rerender(element({ nodes: next })) },
    setQuery: (next) => { rerender(element({ query: next })) },
  }
}

/** Type into the box (uncontrolled mounts only — a controlled mount echoes its prop). */
function type(input: HTMLInputElement, value: string): void {
  fireEvent.change(input, { target: { value } })
}

/** Let the `requestAnimationFrame` that carries `onChoose` run. */
async function frames(ms = 40): Promise<void> {
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, ms) }) })
}

/** The rendered hits, in DOM order. */
function optionTitles(): string[] {
  return screen.queryAllByRole('option').map((option) => option.querySelector('strong')?.textContent ?? '')
}

/** The index of the currently selected hit, or -1. */
function activeIndex(): number {
  return screen.queryAllByRole('option').findIndex((option) => option.getAttribute('aria-selected') === 'true')
}

describe('DagSearch — 输入框本身', () => {
  it('是 type="search" role="searchbox"，带 aria-label 与 placeholder', () => {
    const h = mount(TIERS)
    expect(h.input.tagName).toBe('INPUT')
    expect(h.input.getAttribute('type')).toBe('search')
    expect(h.input.getAttribute('aria-label')).toBe('搜索会话')
    expect(h.input.getAttribute('placeholder')).toBe('搜索名称、目录或摘要…')
  })

  it('挂载即自动聚焦（D-4 取消 Cmd+F 之后的唯一入口）', () => {
    const h = mount(TIERS)
    expect(document.activeElement).toBe(h.input)
  })

  it('每次按键都通知 onQueryChange（浮层靠它知道查询非空，T-4 的第一次 Esc 只清空）', () => {
    const h = mount(TIERS)
    type(h.input, '登')
    expect(h.onQueryChange).toHaveBeenCalledWith('登')
  })
})

describe('DagSearch — 结果面板的出现与消失', () => {
  it('空查询时结果面板整个不渲染（「没在搜」不是「全都命中」）', () => {
    mount(TIERS)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('只输入空白时也不渲染面板（否则「没在搜」会被误报成「无匹配」）', () => {
    const h = mount(TIERS)
    type(h.input, '   ')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('查询无命中时面板出现，里面是「没有匹配的会话」且一条 option 都没有', () => {
    const h = mount(TIERS)
    type(h.input, '完全不存在的东西')
    expect(screen.getByRole('listbox', { name: '搜索结果' })).toBeTruthy()
    expect(screen.getByText('没有匹配的会话')).toBeTruthy()
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })

  it('有命中时不渲染「没有匹配的会话」', () => {
    const h = mount(TIERS)
    type(h.input, '登录')
    expect(screen.queryByText('没有匹配的会话')).toBeNull()
  })
})

describe('DagSearch — 结果排序与上限', () => {
  it('按 dag/search.ts 的分数降序渲染（100 / 80 / 60 / 30 / 20），不是 nodes 的原顺序', () => {
    const h = mount(TIERS)
    type(h.input, '登录')
    expect(optionTitles()).toEqual(['登录', '登录修复', '修复登录态', '缓存清理', '接口联调'])
  })

  it('每条 option 带 data-session-id，首条默认选中', () => {
    const h = mount(TIERS)
    type(h.input, '登录')
    const options = screen.getAllByRole('option')
    expect(options[0]?.getAttribute('data-session-id')).toBe('S-1')
    expect(activeIndex()).toBe(0)
  })

  it('最多渲染 12 条（码头 DagSearch.tsx:33），第 13 条起不出现', () => {
    const h = mount(FIFTEEN)
    type(h.input, '会话')
    expect(optionTitles()).toHaveLength(12)
    expect(optionTitles().at(-1)).toBe('会话 12')
    expect(screen.queryByText('会话 13')).toBeNull()
  })
})

describe('DagSearch — 输入框内的 ↑ / ↓（spec §4 明文要求，不是全局快捷键）', () => {
  it('↓↓↑ 之后选中第 2 条', () => {
    const h = mount(TIERS)
    type(h.input, '登录')
    fireEvent.keyDown(h.input, { key: 'ArrowDown' })
    fireEvent.keyDown(h.input, { key: 'ArrowDown' })
    fireEvent.keyDown(h.input, { key: 'ArrowUp' })
    expect(activeIndex()).toBe(1)
  })

  it('↓ 走到底再按回到第一条', () => {
    const h = mount(TIERS)
    type(h.input, '登录')
    for (let index = 0; index < 5; index += 1) fireEvent.keyDown(h.input, { key: 'ArrowDown' })
    expect(activeIndex()).toBe(0)
  })

  it('第一条按 ↑ 回到最后一条', () => {
    const h = mount(TIERS)
    type(h.input, '登录')
    fireEvent.keyDown(h.input, { key: 'ArrowUp' })
    expect(activeIndex()).toBe(4)
  })

  it('循环只在渲染出来的 12 条里绕，不会选中被截掉的第 15 条', () => {
    const h = mount(FIFTEEN)
    type(h.input, '会话')
    fireEvent.keyDown(h.input, { key: 'ArrowUp' })
    expect(activeIndex()).toBe(11)
    fireEvent.keyDown(h.input, { key: 'Enter' })
    expect(h.onPreview).toHaveBeenCalledWith('S-12')
  })

  it('↑ / ↓ 阻止默认行为（否则光标会在输入框里乱跳）', () => {
    const h = mount(TIERS)
    type(h.input, '登录')
    expect(fireEvent.keyDown(h.input, { key: 'ArrowDown' })).toBe(false)
    expect(fireEvent.keyDown(h.input, { key: 'ArrowUp' })).toBe(false)
  })

  it('无结果时 ↑ / ↓ 什么都不做，也不阻止默认行为', () => {
    const h = mount(TIERS)
    type(h.input, '完全不存在的东西')
    expect(fireEvent.keyDown(h.input, { key: 'ArrowDown' })).toBe(true)
    expect(activeIndex()).toBe(-1)
  })

  it('改查询后选中项回到第一条', () => {
    const h = mount(TIERS)
    type(h.input, '登录')
    fireEvent.keyDown(h.input, { key: 'ArrowDown' })
    expect(activeIndex()).toBe(1)
    type(h.input, '登录修')
    expect(activeIndex()).toBe(0)
  })

  it('结果因 nodes 刷新而变少时，选中项夹紧到最后一条而不是落到范围外', () => {
    const h = mount(TIERS)
    type(h.input, '登录')
    fireEvent.keyDown(h.input, { key: 'ArrowDown' })
    fireEvent.keyDown(h.input, { key: 'ArrowDown' })
    fireEvent.keyDown(h.input, { key: 'ArrowDown' })
    expect(activeIndex()).toBe(3)
    h.rerenderWith(TIERS.filter((node) => node.sessionId === 'S-1' || node.sessionId === 'S-2'))
    expect(optionTitles()).toEqual(['登录', '登录修复'])
    expect(activeIndex()).toBe(1)
    fireEvent.keyDown(h.input, { key: 'Enter' })
    expect(h.onPreview).toHaveBeenCalledWith('S-2')
  })
})

describe('DagSearch — 选中的两段式提交（码头 DagSearch.tsx:15-18）', () => {
  it('Enter 先 onPreview，onChoose 留到下一帧', async () => {
    const h = mount(TIERS)
    type(h.input, '登录')
    fireEvent.keyDown(h.input, { key: 'ArrowDown' })
    fireEvent.keyDown(h.input, { key: 'Enter' })
    expect(h.onPreview).toHaveBeenCalledWith('S-2')
    expect(h.onChoose).not.toHaveBeenCalled()
    await frames()
    expect(h.onChoose).toHaveBeenCalledWith('S-2')
    expect(h.onPreview.mock.invocationCallOrder[0]).toBeLessThan(h.onChoose.mock.invocationCallOrder[0] as number)
  })

  it('Enter 阻止默认行为', () => {
    const h = mount(TIERS)
    type(h.input, '登录')
    expect(fireEvent.keyDown(h.input, { key: 'Enter' })).toBe(false)
  })

  it('无结果时 Enter 既不 onPreview 也不 onChoose', async () => {
    const h = mount(TIERS)
    type(h.input, '完全不存在的东西')
    fireEvent.keyDown(h.input, { key: 'Enter' })
    await frames()
    expect(h.onPreview).not.toHaveBeenCalled()
    expect(h.onChoose).not.toHaveBeenCalled()
  })

  it('点击某条结果同样是先 onPreview、下一帧才 onChoose', async () => {
    const h = mount(TIERS)
    type(h.input, '登录')
    fireEvent.click(screen.getAllByRole('option')[2] as HTMLElement)
    expect(h.onPreview).toHaveBeenCalledWith('S-3')
    expect(h.onChoose).not.toHaveBeenCalled()
    await frames()
    expect(h.onChoose).toHaveBeenCalledWith('S-3')
  })

  it('指针悬停改选中项（码头 :32 的 onPointerEnter），但不预览也不跳转', () => {
    const h = mount(TIERS)
    type(h.input, '登录')
    fireEvent.pointerEnter(screen.getAllByRole('option')[3] as HTMLElement)
    expect(activeIndex()).toBe(3)
    expect(h.onPreview).not.toHaveBeenCalled()
    expect(h.onChoose).not.toHaveBeenCalled()
  })
})

describe('DagSearch — 副标题（T-3：只有目录，没有 provider）', () => {
  it('副标题就是 cwd 原文', () => {
    const h = mount(TIERS)
    type(h.input, '登录')
    expect(screen.getByText('/srv/登录服务')).toBeTruthy()
  })

  it('cwd 为空的结果不渲染副标题，只剩标题', () => {
    const h = mount([nodeDouble({ sessionId: 'S-X', title: '登录', cwd: '' })])
    type(h.input, '登录')
    const option = screen.getByRole('option')
    expect(option.querySelector('strong')?.textContent).toBe('登录')
    expect(option.querySelector('span')).toBeNull()
  })

  it('即使 node 上挂着 currentMode 样的字段，DOM 里也不出现任何 provider 字样（码头 :36 的分支不移植）', () => {
    const base = nodeDouble({ sessionId: 'S-X', title: '登录', cwd: '/srv/app' })
    const node = { ...base, currentMode: 'claude-code' } as DagNodeView
    const h = mount([node])
    type(h.input, '登录')
    expect(h.container.textContent).not.toMatch(/Claude|Codex|Shell|队友|claude-code/)
  })
})

describe('DagSearch — 受控查询（浮层的 Esc 清空要用，T-4）', () => {
  it('传了 query 就显示外部的值，打字只上报不自行改值', () => {
    const h = mount(TIERS, '登录')
    expect(h.input.value).toBe('登录')
    expect(optionTitles()).toHaveLength(5)
    type(h.input, '登录修')
    expect(h.onQueryChange).toHaveBeenCalledWith('登录修')
    expect(h.input.value).toBe('登录')
  })

  it('父组件把 query 清空后结果面板整个消失（Esc 第一次只清空的落点）', () => {
    const h = mount(TIERS, '登录')
    expect(screen.getByRole('listbox')).toBeTruthy()
    h.setQuery('')
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
