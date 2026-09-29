/**
 * 侧栏用到的两个字形。
 *
 * 其余图标一律用 DSH 自带的 `ui-primitives/src/icons`（折叠箭头、文件夹、加号、
 * 省略号）——本项目一贯的分工是**交互对齐码头、观感用 DSH 的**，自己画的越少越好。
 * 这里只补两个 DSH 图标集里没有、而码头侧栏必须有的：
 *
 * - {@link IconTaskLines}：事项行的前导字形。几何照抄码头
 *   `assets/terminal-reference/terminal/dark_lujing.svg`（13.4×9.4，四条圆头横线，
 *   第 2、4 条两端各内缩 2）——不是照抄它那份被 Figma 导出成上千个贝塞尔点的
 *   path，而是按同样的尺寸重画成四条线段，视觉一致、可读可改。
 * - {@link IconPin}：置顶标记。码头用的是 lucide 的 `pin`，DSH 图标集里没有对应
 *   的，这里画一个同类的图钉（横梁 + 外张的两腿 + 针尖）。此前这里放的是 emoji
 *   「📌」，在不同系统上是彩色位图，跟同排全是描边线条的图标不是一个语言。
 * @module dsh-plugin-matou-layout/src/client/workbench/icons
 */

interface GlyphProps {
  readonly size?: number
  readonly className?: string | undefined
}

/** 事项行的前导字形：四条横线，第 2、4 条内缩（码头 `dark_lujing.svg` 的几何）。 */
export function IconTaskLines({ size = 14, className }: GlyphProps) {
  return (
    <svg
      width={size}
      height={(size * 10) / 14}
      viewBox="0 0 14 10"
      fill="none"
      className={className}
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <line x1="0.7" y1="0.7" x2="13.3" y2="0.7" />
        <line x1="2.7" y1="3.7" x2="11.3" y2="3.7" />
        <line x1="0.7" y1="6.3" x2="13.3" y2="6.3" />
        <line x1="2.7" y1="9.3" x2="11.3" y2="9.3" />
      </g>
    </svg>
  )
}

/** 置顶标记：横梁 + 外张的两腿 + 针尖。 */
export function IconPin({ size = 13, className }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 2h6" />
        <path d="M6.2 2v4.1L4 8.6V10h8V8.6L9.8 6.1V2" />
        <path d="M8 10v4" />
      </g>
    </svg>
  )
}
