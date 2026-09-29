/**
 * D1 (S3b Task 11c review, Critical): locks the fix for "compact cards failed
 * to hide DSH's official session header". jsdom does not run CSS Modules
 * (no cascade, no `:global()`, no computed styles), so this cannot assert on
 * rendered layout — instead it runs the SAME production toolchain the plugin
 * ships with (`tsdown.config.mjs`'s css-modules plugin: `lightningcss`
 * `transform` with the exact `cssModules` pattern) over the real
 * `carousel.module.css`, and asserts on the compiled rule's shape. That is a
 * stronger guarantee than a hand-rolled regex over the source text: it is
 * byte-for-byte what ships to the browser.
 *
 * Root cause (see the comment above the rule in carousel.module.css): DSH's
 * `SlotOutlet` wraps every `renderSlot(...)` call in a `[data-slot="…"]`
 * anchor div carrying an INLINE `style="display: contents"`
 * (`scoped-slots.tsx`'s `ANCHOR_STYLE`). An inline style always outranks a
 * stylesheet rule of equal-or-lower specificity, so a plain
 * `[data-slot='conversation.session.header'] { display: none }` compiles
 * fine, "matches" the element, and does nothing — the anchor (and DSH's
 * header inside it) stays visible. The fix targets the anchor's own
 * children (`> *`) instead: the anchor itself contributes no box
 * (`display: contents`), so hiding what's inside it has the same visual
 * effect without ever having to out-rank an inline style.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'lightningcss'
import { describe, expect, it } from 'vitest'

const CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../src/client/carousel/carousel.module.css')

/**
 * Compiles the real stylesheet exactly as `tsdown.config.mjs`'s
 * `matou-layout-css-modules` plugin does for the shipped client bundle.
 */
function compileShippedCss(): string {
  const result = transform({
    filename: CSS_PATH,
    code: readFileSync(CSS_PATH),
    cssModules: { pattern: 'matou_[local]_[hash]' },
    minify: false,
  })
  return Buffer.from(result.code).toString('utf8')
}

/**
 * 空白卡上的「选择工作区」芯片必须一直藏着。
 *
 * 码头的卡片没有这种控件——工作目录由卡片挂在哪个工作区/事项下决定
 * （`session-canvas/SessionCard.tsx` 是个纯壳子，连 workspace 这个词都不出现）。
 *
 * 在 DSH 上它不只是多余，而是个陷阱：`ConversationRoot.tsx:306` 把这颗芯片的
 * `onPick` 接到了 `selectWorkspace()`，**会把会话整个挪到另一个工作区**；而本插件
 * 给卡片定位只看自己的落位记录（`workbench/known-sessions.ts` 里没有工作区这一维）。
 * 于是换一下工作区，卡片会留在原来的事项下，实际干活的目录却换了地方。
 */
describe('carousel.module.css — 卡片里不得出现「选择工作区」入口', () => {
  it('工作区座位的直接子元素被隐藏（隐藏锚点自身会被内联 display:contents 盖过，形同虚设）', () => {
    const css = compileShippedCss()
    expect(css).not.toMatch(/\[data-slot="conversation\.hero\.workspace"\]\s*\{[^}]*display:\s*none/)
    expect(css).toMatch(
      /\.matou_card_[\w-]+\s+\.matou_pane_[\w-]+\s+\[data-slot="conversation\.hero\.workspace"\]\s*>\s*\*\s*\{\s*display:\s*none;?\s*\}/,
    )
  })

  it('同一行里的那颗芯片按钮也被隐藏（它不在座位里，得用 :has() 从座位反查该行）', () => {
    const css = compileShippedCss()
    expect(css).toMatch(
      /:has\(\s*>\s*\[data-slot="conversation\.hero\.workspace"\]\s*\)\s*>\s*button\s*\{\s*display:\s*none;?\s*\}/,
    )
  })

  it('同排的 Agent 预设（标准模式）不受牵连——那确实是每张卡自己的选择', () => {
    const css = compileShippedCss()
    expect(css).not.toMatch(/conversation\.hero\.agentPreset/)
  })
})

describe('carousel.module.css — 隐藏官方会话头的规则不得退化（D1）', () => {
  it('编译产物里，锚点包装 div 自身绝不能直接带 display:none（会被内联 display:contents 盖过，形同虚设）', () => {
    const css = compileShippedCss()
    // Any rule whose selector ends at the bare anchor (no child combinator
    // after it) and declares display:none is exactly the regressed,
    // silently-broken form this guards against — regardless of what
    // precedes it in the selector chain (`.pane`, `:not(.isFocused)`, …).
    const bareAnchorDisplayNone = /\[data-slot="conversation\.session\.header"\]\s*\{[^}]*display:\s*none/
    expect(css).not.toMatch(bareAnchorDisplayNone)
  })

  it('编译产物里存在「隐藏锚点的直接子元素」规则，且限定在非聚焦卡（:not(.isFocused)）上', () => {
    const css = compileShippedCss()
    // The shipped rule: `.card:not(.isFocused) .pane [data-slot='…'] > * { display: none }`,
    // scoped by the compiled (hashed) `.isFocused`/`.pane` class names. The
    // `:not(...)` wrapping is exactly what proves this is scoped away from
    // the focused card (a bare `.isFocused …` selector, without `:not()`,
    // would instead target the focused card and is not what this asserts).
    // 哈希段用 [\w-]+ 而不是 \w+：lightningcss 的哈希是 base64url 字母表，
    // 含 `-` 与 `_`，且由**文件路径**参与计算——同一份源码在不同工作树下
    // 算出的哈希不同。原来的 \w+ 只是碰巧在主工作树的路径下没撞上连字符，
    // 换一个工作树（S7 那条分支）就整条转红，而规则本身一字未改。
    const childHideRule =
      /:not\(\.matou_isFocused_[\w-]+\)\s+\.matou_pane_[\w-]+\s+\[data-slot="conversation\.session\.header"\]\s*>\s*\*\s*\{\s*display:\s*none;?\s*\}/
    expect(css).toMatch(childHideRule)
  })
})


/**
 * 首次活体走查（2026-09-06）逮到的缺陷，用同一条编译管线守住。
 *
 * `useCarouselController` 的每一处滚动数学——聚焦居中、悬停保证完整可见、
 * 边缘浏览推进、几何持久化——都把 `card.offsetLeft` 当作「这张卡在带子内容
 * 里的位置」。但 `offsetLeft` 是相对**最近的定位祖先**算的：轮播容器若是
 * `position: static`，参照就跳到外层 `.frame`，每个位置凭空多出一整条左侧栏
 * 的宽度。
 *
 * 实测（1456px 视口、侧栏 280px）：卡片真实位置 594，代码读到 874，居中目标
 * 于是从 284 变成 564 —— 点一张卡它不居中，而是贴着左边、右边空出 590px。
 * 侧栏折叠时误差还会跟着变，症状就更难认。
 *
 * **为什么只能这么测**：jsdom 不做布局，`offsetLeft` 恒为 0；而本模块的单测
 * 按设计注入测量替身（见 `useCarouselController` 的模块文档），喂进去的是人
 * 工写好的「正确值」。于是这条不变式在 JS 层没有任何测试能触及——它是一条
 * 纯粹的 CSS 契约，只能在 CSS 上钉住。
 */
describe('轮播容器必须是卡片槽位的 offsetParent', () => {
  it('编译后的 .carousel 带 position: relative', () => {
    const css = compileShippedCss()
    const rule = /\.matou_carousel_[\w-]+\s*\{[^}]*position:\s*relative[^}]*\}/
    expect(css).toMatch(rule)
  })
})
