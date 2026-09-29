/**
 * The carousel's drill-layer breadcrumb (mockup `breadcrumb`, 码头
 * `SessionBreadcrumb.tsx`): a "返回父会话" button plus "X 的子会话 · N 个
 * 会话". Shown by `AppFrame` only when the current layer has a parent (spec
 * §4: "顶部面包屑…" + "← / ↑ 键返回" — the keyboard half of that already lives
 * in `Carousel`'s `onReturnToParent` wiring; this component is the visible
 * button doing the same thing).
 * @module dsh-plugin-matou-layout/src/client/carousel/Breadcrumb
 */
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { MatouKey } from '../locales.ts'
import css from './breadcrumb.module.css'

export interface BreadcrumbProps {
  /** The drilled-into parent session's display title. */
  parentTitle: string
  /** How many sessions sit in this layer (the "N 个会话" count). */
  count: number
  onReturnToParent: () => void
  t: Translate<MatouKey>
}

export function Breadcrumb({ parentTitle, count, onReturnToParent, t }: BreadcrumbProps) {
  return (
    <div className={css.breadcrumb} role="navigation" aria-label={t('breadcrumb.nav')}>
      <button type="button" className={css.back} onClick={onReturnToParent}>
        ← {t('breadcrumb.return')}
      </button>
      <span className={css.label}>{t('breadcrumb.children', { title: parentTitle, n: count })}</span>
    </div>
  )
}
