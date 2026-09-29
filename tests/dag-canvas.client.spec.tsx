// @vitest-environment jsdom
/**
 * S4 Task 10: the DAG canvas — the component that finally puts Tasks 2/3/4
 * (`dag/layout.ts`, `dag/render-model.ts`, `dag/viewport.ts`) on screen.
 *
 * Every geometric expectation below is hand-computed from those three modules
 * rather than read back out of them, which is the only way this file can catch
 * a canvas that wires the right functions together in the wrong order. The two
 * fixtures and their arithmetic:
 *
 * - **TRIO** — `S-A` with two children. Column 0 holds one 174px card, column 1
 *   holds two (174 + 26 + 174 = 374), so `maxColumnHeight` is 374 and column 0
 *   is centred against it: `A` sits at `(50, 150)`, `B` at `(420, 50)`, `C` at
 *   `(420, 250)`. `layout.height` is `100 + 374 = 474`.
 * - **CHAIN** — five generations in a row, every column one card tall, so every
 *   card sits at `y = 50` and `x = 50 + 370 × depth`.
 *
 * jsdom reports `clientWidth`/`clientHeight` as 0 and has no `matchMedia`, so
 * the canvas's viewport fallbacks (码头 `DagCanvas.tsx:38-39`'s `|| 1000` /
 * `|| 700`) are what the numbers here are computed against: a 1000 × 700
 * viewport whose centre is `(500, 350)`, and `getBoundingClientRect()` is the
 * origin, so a wheel event's `clientX/clientY` IS its viewport-space point.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { zh } from '../src/client/locales.ts'
import type { MatouKey } from '../src/client/locales.ts'
import type { DagGraphView, DagNodeView } from '../src/client/dag/graph.ts'
import type { DagCanvasSearchHandlers } from '../src/client/dag/DagCanvas.tsx'
import { DagCanvas } from '../src/client/dag/DagCanvas.tsx'
import css from '../src/client/dag/dag.module.css'

afterEach(cleanup)

/**
 * The `dag.*` copy Task 13 adds to `locales.ts`. Held here so this spec runs
 * before that task lands and stays green after it — the assertions check that
 * the right KEY reached `t`, not that Task 13 picked any particular wording.
 */
const DAG_COPY: Record<string, string> = {
  'dag.label': '会话 DAG',
  'dag.empty': '这个页签里还没有会话',
  'dag.zoom.label': '画布缩放',
  'dag.zoom.in': '放大',
  'dag.zoom.out': '缩小',
  'dag.zoom.reset': '恢复 100%',
  'dag.zoom.focus': '聚焦当前节点',
  'dag.legend.label': '关系说明',
  'dag.legend.fork': 'Fork：继承对话',
  'dag.legend.derived': '普通关联：不继承对话',
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

function nodeDouble(over: Partial<DagNodeView> & { sessionId: string }): DagNodeView {
  return {
    createdSeq: 0,
    title: '会',
    cwd: '',
    childCount: 0,
    lastActivityAt: 0,
    preview: '',
    hasNotice: false,
    subagent: false,
    ...over,
  }
}

/** One root plus two children — two columns, so both edge kinds and the column-centring offset are exercised. */
const TRIO: DagGraphView = {
  sceneId: 'SC-1',
  nodes: [
    nodeDouble({ sessionId: 'S-A', createdSeq: 0, title: '甲' }),
    nodeDouble({ sessionId: 'S-B', parentSessionId: 'S-A', createdSeq: 1, title: '乙' }),
    nodeDouble({ sessionId: 'S-C', parentSessionId: 'S-A', createdSeq: 2, title: '丙' }),
  ],
  edges: [
    { parentSessionId: 'S-A', childSessionId: 'S-B', relationKind: 'forked-from' },
    { parentSessionId: 'S-A', childSessionId: 'S-C', relationKind: 'derived-from' },
  ],
}

/** Five generations in one line — deep enough that columns 2-4 fall outside the ±1 band and fold. */
const CHAIN: DagGraphView = {
  sceneId: 'SC-2',
  nodes: [
    nodeDouble({ sessionId: 'S-A', createdSeq: 0, title: '甲' }),
    nodeDouble({ sessionId: 'S-B', parentSessionId: 'S-A', createdSeq: 1, title: '乙' }),
    nodeDouble({ sessionId: 'S-C', parentSessionId: 'S-B', createdSeq: 2, title: '丙' }),
    nodeDouble({ sessionId: 'S-D', parentSessionId: 'S-C', createdSeq: 3, title: '丁' }),
    nodeDouble({ sessionId: 'S-E', parentSessionId: 'S-D', createdSeq: 4, title: '戊' }),
  ],
  edges: [
    { parentSessionId: 'S-A', childSessionId: 'S-B', relationKind: 'forked-from' },
    { parentSessionId: 'S-B', childSessionId: 'S-C', relationKind: 'forked-from' },
    { parentSessionId: 'S-C', childSessionId: 'S-D', relationKind: 'forked-from' },
    { parentSessionId: 'S-D', childSessionId: 'S-E', relationKind: 'forked-from' },
  ],
}

const EMPTY: DagGraphView = { sceneId: 'SC-3', nodes: [], edges: [] }

interface Harness {
  readonly canvas: HTMLElement
  readonly container: HTMLElement
  readonly onSelect: ReturnType<typeof vi.fn>
  readonly onTransformChange: ReturnType<typeof vi.fn>
  readonly handlers: () => DagCanvasSearchHandlers
}

/**
 * Let jsdom's `requestAnimationFrame` (and the canvas's own rAF coalescing)
 * run, inside `act` so React sees every resulting state update.
 * @param ms - how long to wait; one frame is ~16ms.
 */
async function frames(ms = 40): Promise<void> {
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, ms) }) })
}

/**
 * Mount the canvas and wait out the first-mount focus frame.
 * @param graph - the projection to draw.
 * @param over - optional props (`focusedSessionId` defaults to `S-A`).
 * @returns the mounted canvas plus its spies.
 */
async function mount(graph: DagGraphView, over: { focusedSessionId?: string; initialTransform?: { x: number; y: number; scale: number } } = {}): Promise<Harness> {
  const onSelect = vi.fn()
  const onTransformChange = vi.fn()
  let captured: DagCanvasSearchHandlers | undefined
  const { container } = render(
    <DagCanvas
      graph={graph}
      focusedSessionId={over.focusedSessionId ?? 'S-A'}
      initialTransform={over.initialTransform}
      onSelect={onSelect}
      onTransformChange={onTransformChange}
      renderSearch={(handlers) => { captured = handlers; return <input aria-label="搜索会话" /> }}
      t={spyT()}
    />,
  )
  await frames()
  return {
    canvas: container.querySelector('[role="group"]') as HTMLElement,
    container: container as HTMLElement,
    onSelect,
    onTransformChange,
    handlers: () => captured as DagCanvasSearchHandlers,
  }
}

describe('DagCanvas — 世界层与渲染预算', () => {
  it('渲染出的节点卡数量与 data-rendered-node-count 一致', async () => {
    const h = await mount(TRIO)
    expect(h.canvas.getAttribute('data-rendered-node-count')).toBe('3')
    expect(h.container.querySelectorAll('[data-dag-node]')).toHaveLength(3)
    expect(h.canvas.getAttribute('data-rendered-aggregate-count')).toBe('0')
  })

  it('远层折叠：五代直链在 ±1 层外只画 2 张真卡 + 1 张聚合卡，且聚合卡数量与诊断属性一致', async () => {
    const h = await mount(CHAIN)
    expect(h.canvas.getAttribute('data-rendered-node-count')).toBe('2')
    expect(h.canvas.getAttribute('data-rendered-aggregate-count')).toBe('1')
    expect(h.container.querySelectorAll('[data-dag-node]')).toHaveLength(2)
    expect(h.container.querySelectorAll('[data-dag-aggregate]')).toHaveLength(1)
  })

  it('世界层带上 layout 的宽高与 translate3d/scale 变换', async () => {
    const h = await mount(TRIO)
    const world = h.container.querySelector(`.${css.world}`) as HTMLElement
    expect(world.style.width).toBe('730px')
    expect(world.style.height).toBe('474px')
    expect(world.style.transform).toBe('translate3d(320px,113px,0) scale(1)')
  })

  /* 调研的「复核修正 4」：可见层必须跟视口走，不能钉在焦点卡上。钉住的写法
     （直接用 `visibleLayers(layout, previewSessionId)`）能通过本文件其余每一
     条断言 —— TRIO 只有两列、CHAIN 的其它用例都没把视口推出焦点 ±1 列 ——
     所以这条用例是整份 spec 里唯一能把它逼红的地方。 */
  it('横向拖出两列后可见层跟着视口走，而不是钉在焦点卡上（否则拖动会拖出一片空白）', async () => {
    const h = await mount(CHAIN)
    expect(h.container.querySelector('[data-session-id="S-E"]')).toBeNull()
    fireEvent.wheel(h.canvas, { deltaX: 1110, deltaY: 0 })
    await frames()
    // 视口中心落到世界 x = 500 −(−790) = 1290，即第 3 列；焦点仍是第 0 列的 S-A。
    expect(h.canvas.getAttribute('data-pan')).toBe('-790,213')
    expect(h.canvas.getAttribute('data-rendered-node-count')).toBe('3')
    expect(h.container.querySelector('[data-session-id="S-E"]')).not.toBeNull()
    expect(h.container.querySelector('[data-session-id="S-A"]')).toBeNull()
  })

  it('空图渲染 role="status" 空态，且不画世界层', async () => {
    const h = await mount(EMPTY)
    const status = h.container.querySelector('[role="status"]') as HTMLElement
    expect(status.textContent).toBe('这个页签里还没有会话')
    expect(h.container.querySelector(`.${css.world}`)).toBeNull()
    expect(h.canvas.getAttribute('data-rendered-node-count')).toBe('0')
  })
})

describe('DagCanvas — 边（三次贝塞尔 + 关系种类 + 根引导）', () => {
  it('边的 d 是以两端 x 的中点为控制点的三次贝塞尔（码头 DagCanvas.tsx:203-209）', async () => {
    const h = await mount(TRIO)
    const forked = h.container.querySelector(`.${css.edgeForked}`) as SVGPathElement
    // A 右缘中点 (310,237) → B 左缘中点 (420,137)，mid = (310+420)/2 = 365。
    expect(forked.getAttribute('d')).toBe('M 310 237 C 365 237, 365 137, 420 137')
    const derived = h.container.querySelector(`.${css.edgeDerived}`) as SVGPathElement
    expect(derived.getAttribute('d')).toBe('M 310 237 C 365 237, 365 337, 420 337')
  })

  it('两种 relationKind 落到两个不同的类名，并各自带 data-relation-kind', async () => {
    const h = await mount(TRIO)
    const forked = h.container.querySelector(`.${css.edgeForked}`) as SVGPathElement
    const derived = h.container.querySelector(`.${css.edgeDerived}`) as SVGPathElement
    expect(css.edgeForked).not.toBe(css.edgeDerived)
    expect(forked.getAttribute('data-relation-kind')).toBe('forked-from')
    expect(derived.getAttribute('data-relation-kind')).toBe('derived-from')
    expect(forked.classList.contains(css.edgeDerived)).toBe(false)
    expect(derived.classList.contains(css.edgeForked)).toBe(false)
  })

  it('箭头 marker 与根引导虚线都画出来了，根引导只连可见的 depth-0 卡片', async () => {
    const h = await mount(TRIO)
    expect(h.container.querySelector('marker#dag-arrow')).not.toBeNull()
    const guides = h.container.querySelectorAll(`.${css.rootGuide}`)
    expect(guides).toHaveLength(1)
    // layout.height / 2 = 237；根卡 A 的纵向中点也是 237，左缘 x = 50。
    expect(guides[0]?.getAttribute('d')).toBe('M 12 237 C 28 237, 32 237, 50 237')
  })

  it('两端都不可见的边不画：五代直链只留下两端都在画面上的两条', async () => {
    const h = await mount(CHAIN)
    expect(h.container.querySelectorAll(`.${css.edge}`)).toHaveLength(2)
  })
})

describe('DagCanvas — 缩放（按钮 / Ctrl+滚轮）', () => {
  it('＋ 与 − 各按 0.1 步进', async () => {
    const h = await mount(TRIO)
    fireEvent.click(h.container.querySelector('[aria-label="放大"]') as HTMLElement)
    expect(h.canvas.getAttribute('data-scale')).toBe('1.1')
    fireEvent.click(h.container.querySelector('[aria-label="缩小"]') as HTMLElement)
    expect(h.canvas.getAttribute('data-scale')).toBe('1')
  })

  it('放大被 clamp 在 2、缩小被 clamp 在 0.4（码头 DagCanvas.tsx:291-293）', async () => {
    const h = await mount(TRIO)
    const zoomIn = h.container.querySelector('[aria-label="放大"]') as HTMLElement
    for (let index = 0; index < 14; index += 1) fireEvent.click(zoomIn)
    expect(h.canvas.getAttribute('data-scale')).toBe('2')
    const zoomOut = h.container.querySelector('[aria-label="缩小"]') as HTMLElement
    for (let index = 0; index < 24; index += 1) fireEvent.click(zoomOut)
    expect(h.canvas.getAttribute('data-scale')).toBe('0.4')
  })

  it('百分比按钮回到初始变换 {70,40,1}，而不是只把 scale 拨回 1', async () => {
    const h = await mount(TRIO)
    fireEvent.click(h.container.querySelector('[aria-label="放大"]') as HTMLElement)
    fireEvent.wheel(h.canvas, { deltaX: 40, deltaY: 40 })
    await frames()
    expect(h.canvas.getAttribute('data-pan')).not.toBe('70,40')
    fireEvent.click(h.container.querySelector('[aria-label="恢复 100%"]') as HTMLElement)
    expect(h.canvas.getAttribute('data-scale')).toBe('1')
    expect(h.canvas.getAttribute('data-pan')).toBe('70,40')
  })

  it('百分比按钮上写的是当前缩放的百分数', async () => {
    const h = await mount(TRIO)
    fireEvent.click(h.container.querySelector('[aria-label="放大"]') as HTMLElement)
    expect((h.container.querySelector('[aria-label="恢复 100%"]') as HTMLElement).textContent).toBe('110%')
  })

  it('Ctrl+滚轮以指针为不动点缩放：exp(-deltaY × 0.002)，且平移随之补偿', async () => {
    const h = await mount(TRIO)
    expect(h.canvas.getAttribute('data-pan')).toBe('320,113')
    fireEvent.wheel(h.canvas, { deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0 })
    await frames()
    // factor = exp(0.2) = 1.2214027581601699；指针在视口原点，世界原点在 (320,113)。
    expect(h.canvas.getAttribute('data-scale')).toBe('1.22')
    expect(h.canvas.getAttribute('data-pan')).toBe('390.85,138.02')
  })

  it('Meta+滚轮走同一条缩放分支（触控板捏合在 macOS 上带 metaKey 的那一路）', async () => {
    const h = await mount(TRIO)
    fireEvent.wheel(h.canvas, { deltaY: 100, metaKey: true, clientX: 0, clientY: 0 })
    await frames()
    expect(h.canvas.getAttribute('data-scale')).toBe('0.82')
  })

  /* D-4：一个快捷键都不做。码头 `DagCanvas.tsx:119-134` 在 window 上挂了
     Cmd/Ctrl + `=` / `-` / `0` / `F`，照抄过来会跟 DSH 自己的键位打架，所以这条
     用例守着「画布不监听任何全局键盘事件」。 */
  it('不装任何全局快捷键：Cmd/Ctrl + 0 / = / − / F 都不动画布（D-4）', async () => {
    const h = await mount(TRIO)
    fireEvent.wheel(h.canvas, { deltaX: 40, deltaY: 40 })
    await frames()
    const pan = h.canvas.getAttribute('data-pan')
    expect(pan).toBe('280,73')
    for (const key of ['0', '=', '+', '-', 'f']) {
      fireEvent.keyDown(document, { key, metaKey: true })
      fireEvent.keyDown(document, { key, ctrlKey: true })
    }
    await frames()
    expect(h.canvas.getAttribute('data-pan')).toBe(pan)
    expect(h.canvas.getAttribute('data-scale')).toBe('1')
  })
})

describe('DagCanvas — 平移（滚轮 / 拖拽）', () => {
  it('不带修饰键的滚轮是平移，按 deltaX/deltaY 反向移动', async () => {
    const h = await mount(TRIO)
    fireEvent.wheel(h.canvas, { deltaX: 30, deltaY: 20 })
    await frames()
    expect(h.canvas.getAttribute('data-pan')).toBe('290,93')
    expect(h.canvas.getAttribute('data-scale')).toBe('1')
  })

  /* React 18 把 `wheel` 注册成根容器上的 PASSIVE 监听器（react-dom 的
     `addTrappedEventListener` 对 touchstart / touchmove / wheel 强制 passive），
     所以码头 `DagCanvas.tsx:137` 那句 `event.preventDefault()` 其实是空转 ——
     捏合缩放会连浏览器一起放大。`dispatchEvent` 返回 false 才说明真的拦住了。 */
  it('滚轮监听是非被动的：preventDefault 真的拦得住浏览器自己的缩放/滚动', async () => {
    const h = await mount(TRIO)
    expect(fireEvent.wheel(h.canvas, { deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0 })).toBe(false)
    expect(fireEvent.wheel(h.canvas, { deltaX: 30, deltaY: 20 })).toBe(false)
  })

  it('在画布空白处按下并拖动会平移画布', async () => {
    const h = await mount(TRIO)
    fireEvent.pointerDown(h.canvas, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(h.canvas, { pointerId: 1, clientX: 60, clientY: 87 })
    await frames()
    expect(h.canvas.getAttribute('data-pan')).toBe('370,190')
    fireEvent.pointerUp(h.canvas, { pointerId: 1, clientX: 60, clientY: 87 })
    expect(h.canvas.getAttribute('data-pan')).toBe('370,190')
  })

  it('在节点卡上按下不起拖（码头 DagCanvas.tsx:149 的豁免选择器，这里换成 data 钩子）', async () => {
    const h = await mount(TRIO)
    const card = h.container.querySelector('[data-dag-node]') as HTMLElement
    fireEvent.pointerDown(card, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(h.canvas, { pointerId: 1, clientX: 200, clientY: 200 })
    await frames()
    expect(h.canvas.getAttribute('data-pan')).toBe('320,113')
  })

  it('右键按下不起拖', async () => {
    const h = await mount(TRIO)
    fireEvent.pointerDown(h.canvas, { button: 2, pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(h.canvas, { pointerId: 1, clientX: 200, clientY: 200 })
    await frames()
    expect(h.canvas.getAttribute('data-pan')).toBe('320,113')
  })

  it('抬指之后继续移动不再平移', async () => {
    const h = await mount(TRIO)
    fireEvent.pointerDown(h.canvas, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(h.canvas, { pointerId: 1, clientX: 60, clientY: 87 })
    fireEvent.pointerUp(h.canvas, { pointerId: 1, clientX: 60, clientY: 87 })
    fireEvent.pointerMove(h.canvas, { pointerId: 1, clientX: 400, clientY: 400 })
    await frames()
    expect(h.canvas.getAttribute('data-pan')).toBe('370,190')
  })
})

describe('DagCanvas — 首次居中与视口持久化接线', () => {
  it('没有 initialTransform 时首帧把焦点会话居中', async () => {
    const h = await mount(TRIO)
    // A 的中心是 (180, 237)，1000×700 视口的中心是 (500, 350)。
    expect(h.canvas.getAttribute('data-pan')).toBe('320,113')
  })

  it('给了 initialTransform 就用它，不做首次自动居中（实时刷新不得动用户的视口）', async () => {
    const h = await mount(TRIO, { initialTransform: { x: 70, y: 40, scale: 1 } })
    expect(h.canvas.getAttribute('data-pan')).toBe('70,40')
    expect(h.canvas.getAttribute('data-scale')).toBe('1')
  })

  /* 浮层（Task 12）每收到一次会话摘要刷新就会重渲染一次，而它的 initialTransform
     是从 localStorage 读回来的 —— 每次都是一个新对象、值却一样。码头那条按对象
     身份触发的 effect（`DagCanvas.tsx:83-88`）会在每一次刷新把用户拖到的位置拽
     回存档点，正是它自己 `:116` 注释里写着不许发生的事。 */
  it('父组件重渲染时给一个「等值但新建」的 initialTransform，不把用户的视口拽回去', async () => {
    const element = (restored: { x: number; y: number; scale: number }) => (
      <DagCanvas graph={TRIO} focusedSessionId="S-A" initialTransform={restored} onSelect={vi.fn()} t={spyT()} />
    )
    const { container, rerender } = render(element({ x: 70, y: 40, scale: 1 }))
    await frames()
    const canvas = container.querySelector('[role="group"]') as HTMLElement
    fireEvent.wheel(canvas, { deltaX: 30, deltaY: 20 })
    await frames()
    expect(canvas.getAttribute('data-pan')).toBe('40,20')
    rerender(element({ x: 70, y: 40, scale: 1 }))
    await frames()
    expect(canvas.getAttribute('data-pan')).toBe('40,20')
    // 值真的换了（切页签、读回另一条持久化视口）时仍然采纳，不能硬化成「只认挂载那一次」。
    rerender(element({ x: 5, y: 6, scale: 1 }))
    await frames()
    expect(canvas.getAttribute('data-pan')).toBe('5,6')
  })

  it('每次提交变换都上报 onTransformChange（画布只负责报告，debounce 是浮层的事）', async () => {
    const h = await mount(TRIO, { initialTransform: { x: 70, y: 40, scale: 1 } })
    h.onTransformChange.mockClear()
    fireEvent.click(h.container.querySelector('[aria-label="放大"]') as HTMLElement)
    expect(h.onTransformChange).toHaveBeenCalledTimes(1)
    // 以视口中心 (500,350) 为不动点放大到 1.1：x = 500 − 430×1.1，y = 350 − 310×1.1。
    const next = h.onTransformChange.mock.calls[0]?.[0] as { x: number; y: number; scale: number }
    expect(next.scale).toBeCloseTo(1.1, 10)
    expect(next.x).toBeCloseTo(27, 10)
    expect(next.y).toBeCloseTo(9, 10)
    expect(h.canvas.getAttribute('data-pan')).toBe('27,9')
  })

  it('⌖ 把画布带回当前预览节点，并在视口上挂 is-animating 类（240ms 后摘掉）', async () => {
    const h = await mount(TRIO)
    fireEvent.wheel(h.canvas, { deltaX: 200, deltaY: 200 })
    await frames()
    expect(h.canvas.getAttribute('data-pan')).toBe('120,-87')
    fireEvent.click(h.container.querySelector('[aria-label="聚焦当前节点"]') as HTMLElement)
    expect(h.canvas.getAttribute('data-pan')).toBe('320,113')
    expect(h.canvas.classList.contains(css.isAnimating)).toBe(true)
    await frames(300)
    expect(h.canvas.classList.contains(css.isAnimating)).toBe(false)
  })
})

describe('DagCanvas — 选择与折叠展开', () => {
  it('点节点卡调用 onSelect 并把 previewSessionId 移过去', async () => {
    const h = await mount(TRIO)
    const cardB = h.container.querySelector('[data-session-id="S-B"]') as HTMLElement
    expect(cardB.className).not.toContain(css.isFocused)
    fireEvent.click(cardB)
    expect(h.onSelect).toHaveBeenCalledTimes(1)
    expect(h.onSelect).toHaveBeenCalledWith('S-B')
    expect((h.container.querySelector('[data-session-id="S-B"]') as HTMLElement).className).toContain(css.isFocused)
    expect((h.container.querySelector('[data-session-id="S-A"]') as HTMLElement).className).not.toContain(css.isFocused)
  })

  it('点聚合卡不调用 onSelect，只把画布带到它的 targetSessionId 上（码头 :224）', async () => {
    const h = await mount(CHAIN)
    fireEvent.click(h.container.querySelector('[data-dag-aggregate]') as HTMLElement)
    expect(h.onSelect).not.toHaveBeenCalled()
    // 折叠卡的 target 是边界列（depth 2）的 S-C，位于 (790, 50)。
    expect(h.canvas.getAttribute('data-pan')).toBe('-420,213')
    const cardC = h.container.querySelector('[data-session-id="S-C"]') as HTMLElement
    expect(cardC).not.toBeNull()
    expect(cardC.className).toContain(css.isFocused)
  })
})

describe('DagCanvas — 搜索框接线（Task 11 的 DagSearch 由 Task 12 插进来）', () => {
  it('把 onPreview / onChoose 交给 renderSearch：预览只移画布，选中才 onSelect', async () => {
    const h = await mount(TRIO)
    act(() => { h.handlers().onPreview('S-C') })
    // C 在 (420, 250)，中心 (550, 337)。
    expect(h.canvas.getAttribute('data-pan')).toBe('-50,13')
    expect(h.onSelect).not.toHaveBeenCalled()
    act(() => { h.handlers().onChoose('S-B') })
    expect(h.onSelect).toHaveBeenCalledWith('S-B')
  })

  it('renderSearch 渲染出来的东西真的挂在工具栏里', async () => {
    const h = await mount(TRIO)
    const input = h.container.querySelector('[aria-label="搜索会话"]') as HTMLElement
    expect(input).not.toBeNull()
    expect(input.closest(`.${css.toolbar}`)).not.toBeNull()
  })
})

describe('DagCanvas — 无障碍与图例', () => {
  it('画布是 role="group" 且有可读名字；缩放组与图例各自带 aria-label', async () => {
    const h = await mount(TRIO)
    // 明确断言角色本身，而不是只靠 harness 的选择器间接失败。要防的回归是
    // 「照着码头改回 application」：那个角色让读屏交出方向键逐条读卡片的能力，
    // 而本画布一个快捷键都不绑（D-4），换不回任何东西（S4 审查 I-3）。
    expect(h.canvas.getAttribute('role')).toBe('group')
    expect(h.canvas.getAttribute('aria-label')).toBe('会话 DAG')
    expect(h.container.querySelector('[role="application"]')).toBeNull()
    expect(h.container.querySelector('[aria-label="画布缩放"]')).not.toBeNull()
    expect(h.container.querySelector('[aria-label="关系说明"]')).not.toBeNull()
  })

  it('图例两条：Fork 继承对话 / 普通关联不继承', async () => {
    const h = await mount(TRIO)
    const legend = h.container.querySelector('[aria-label="关系说明"]') as HTMLElement
    expect(legend.textContent).toContain('Fork：继承对话')
    expect(legend.textContent).toContain('普通关联：不继承对话')
  })

  it('SVG 边层对辅助技术隐藏（信息已由卡片与图例给出）', async () => {
    const h = await mount(TRIO)
    expect((h.container.querySelector('svg') as SVGElement).getAttribute('aria-hidden')).toBe('true')
  })

  it('不渲染任何 provider / 模式字样（DSH 没有这个维度）', async () => {
    const h = await mount(TRIO)
    expect(h.container.textContent).not.toMatch(/Claude|Codex|Shell|队友/)
  })
})

describe('dag.module.css — 画布段的源文本闸门', () => {
  const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), '../src/client/dag/dag.module.css')
  const source = readFileSync(cssPath, 'utf8')
  /** The same stylesheet with its comments stripped: the prose deliberately NAMES the properties it refuses to ship. */
  const declarations = source.replace(/\/\*[\s\S]*?\*\//g, '')

  it('世界层的 transform-origin 是 0 0（否则 scale 会绕中心转，所有坐标都错位）', () => {
    const block = source.match(/\.world\s*\{[^}]*\}/)?.[0] ?? ''
    expect(block).toMatch(/transform-origin:\s*0\s+0/)
  })

  it('is-animating 时世界层有 240ms 过渡（码头 dag.css:12）', () => {
    expect(source).toMatch(/\.canvas\.isAnimating\s+\.world\s*\{[^}]*transition:\s*transform\s+240ms/)
  })

  it('derived-from 是 6 4 虚线、forked-from 不是（码头 dag.css:33,35）', () => {
    const derived = source.match(/\.edgeDerived\s*\{[^}]*\}/)?.[0] ?? ''
    const forked = source.match(/\.edgeForked\s*\{[^}]*\}/)?.[0] ?? ''
    expect(derived).toMatch(/stroke-dasharray:\s*6\s+4/)
    expect(forked).not.toMatch(/stroke-dasharray/)
    expect(forked).toMatch(/stroke:\s*var\(--dsw-/)
  })

  it('prefers-reduced-motion 下世界层的过渡也被关掉，不只是卡片', () => {
    const index = source.indexOf('@media (prefers-reduced-motion: reduce)')
    expect(index).toBeGreaterThan(-1)
    expect(source.slice(index)).toMatch(/\.world/)
  })

  it('没有留下 Electron 无边框窗口才需要的 -webkit-app-region 拖拽区（码头 dag.css:13-19）', () => {
    // 闸门管的是声明；注释里可以（也应该）写清为什么不做。
    expect(declarations).not.toContain('-webkit-app-region')
  })
})
