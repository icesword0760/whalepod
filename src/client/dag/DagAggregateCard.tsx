/**
 * One folded card standing in for a whole far branch (or, once the render
 * budget runs out, for several of them merged) — a pure presentation
 * component over the `DagAggregateItem` that `dag/render-model.ts` produced.
 * Ported from 码头's inline `DagAggregateCard` (`DagCanvas.tsx:256-282`).
 *
 * Two things to keep straight:
 *
 * - **Depths are 0-based internally and 1-based on screen.** The card prints
 *   `minimumDepth + 1`–`maximumDepth + 1` (码头 `:275`), so the copy matches
 *   how a person counts layers.
 * - **The third column is 「已完成」, not 「异常」.** 码头 counts
 *   running / needs-input / error (`dag-render-model.ts:219-227`); DSH's
 *   `SessionSummary` carries no failure bit anywhere, so this plugin counts
 *   `running` / `waiting` / `done` — the same three-state vocabulary
 *   `workbench/status.ts` already established. And the three need NOT add up
 *   to `sessionCount`: an idle session enters no column at all.
 *
 * Clicking a fold is not the same gesture as clicking a session. 码头 wires it
 * to `focusNode(targetSessionId)` only (`:224`) — the canvas pans onto the
 * branch so the user can see what was folded, and the overlay stays open. The
 * navigation-and-close sequence belongs to session cards alone.
 * @module dsh-plugin-matou-layout/src/client/dag/DagAggregateCard
 */
import type { CSSProperties } from 'react'
import clsx from 'clsx'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { MatouKey } from '../locales.ts'
import type { DagAggregateItem } from './render-model.ts'
import css from './dag.module.css'

export interface DagAggregateCardProps {
  aggregate: DagAggregateItem
  /** Geometry borrowed from the member card this fold stands on, so the stack looks anchored. */
  style: CSSProperties
  onClick: () => void
  t: Translate<MatouKey>
}

/**
 * Render one aggregate card.
 * @param props - the fold, its placement style, the click handler and `t`.
 * @returns the card button.
 */
export function DagAggregateCard({ aggregate, style, onClick, t }: DagAggregateCardProps) {
  const { counts } = aggregate
  return (
    <button
      type="button"
      className={clsx(
        css.aggregate,
        counts.running > 0 && css.hasRunning,
        counts.waiting > 0 && css.hasWaiting,
        counts.done > 0 && css.hasDone,
      )}
      style={style}
      data-aggregate-key={aggregate.key}
      data-aggregate-kind={aggregate.kind}
      data-aggregate-count={aggregate.sessionCount}
      data-direction={aggregate.direction}
      // Same drag exemption the session cards carry — see `DagNodeCard.tsx`.
      data-dag-aggregate=""
      aria-label={t('dag.aggregate.label', {
        n: aggregate.sessionCount,
        running: counts.running,
        waiting: counts.waiting,
        done: counts.done,
      })}
      onClick={onClick}
    >
      <span className={css.aggregateEyebrow}>
        {aggregate.kind === 'branch' ? t('dag.aggregate.branch') : t('dag.aggregate.layer')}
      </span>
      <strong className={css.aggregateCount}>{t('dag.aggregate.count', { n: aggregate.sessionCount })}</strong>
      <span className={css.aggregateRange}>
        {t('dag.aggregate.range', { from: aggregate.minimumDepth + 1, to: aggregate.maximumDepth + 1 })}
      </span>
      <span className={css.aggregateCounts}>
        <span className={css.countItem}>
          <i className={clsx(css.countDot, css.running)} aria-hidden="true" />
          {t('dag.aggregate.running', { n: counts.running })}
        </span>
        <span className={css.countItem}>
          <i className={clsx(css.countDot, css.waiting)} aria-hidden="true" />
          {t('dag.aggregate.waiting', { n: counts.waiting })}
        </span>
        <span className={css.countItem}>
          <i className={clsx(css.countDot, css.done)} aria-hidden="true" />
          {t('dag.aggregate.done', { n: counts.done })}
        </span>
      </span>
    </button>
  )
}
