/**
 * One session card on the DAG canvas — a pure presentation component: it
 * reads no store, computes no layout, and derives nothing the projection has
 * not already resolved. Everything it shows comes off the `DagNodeView`
 * `dag/graph.ts` built; everything about WHERE it sits comes off the `style`
 * `dag/layout.ts` computed.
 *
 * Ported from 码头's inline `DagNodeCard` (`DagCanvas.tsx:229-252`), with two
 * deliberate subtractions and one substitution:
 *
 * - **No mode badge.** 码头's card carries `modeLabel(node.currentMode)` in
 *   its top-right corner (`:244`, `:284-289`: Claude / Codex / 队友 / Shell).
 *   DSH sessions have no provider dimension at all — the difference between
 *   two sessions is which optional projections they carry, not which vendor
 *   runs them — so there is nothing to badge and no provider list to hardcode.
 * - **No worktree / git / shared-directory row.** 码头 shows a branch name in
 *   place of the path and a 「共享工作树」 pill (`:237-238`, `:246-252`); DSH
 *   models none of it. The working directory alone is the honest path line.
 * - **The body is D-3's turn summary, not terminal output.** 码头 prints the
 *   last four PTY lines (`:245`); DSH sessions are not PTYs, so `graph.ts`'s
 *   `lastTurnPreview` supplies the last turn's assistant response instead.
 *   `dag/search.ts` scores against the SAME field, so a search hit always
 *   highlights a card whose visible text contains the query.
 *
 * The card is a real `<button>`: clicking it is the overlay's primary
 * navigation (spec §4「点节点」), so it must be reachable and announceable
 * without a mouse.
 * @module dsh-plugin-matou-layout/src/client/dag/DagNodeCard
 */
import type { CSSProperties } from 'react'
import clsx from 'clsx'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives/src/StateDot.tsx'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives/src/StateDot.tsx'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { MatouKey } from '../locales.ts'
import type { DagNodeView } from './graph.ts'
import css from './dag.module.css'

export interface DagNodeCardProps {
  node: DagNodeView
  /** The canvas's own preview selection — NOT the carousel's focus (码头 `DagCanvas.tsx:214`). */
  focused: boolean
  /** World-space `left/top/width/height` from `dag/layout.ts`; the card never sizes itself. */
  style: CSSProperties
  onClick: () => void
  t: Translate<MatouKey>
}

/**
 * 码头's own path shortener (`DagCanvas.tsx:331-335`): a path over 42
 * characters collapses to its last two segments. A long path with nothing to
 * split on is returned untouched rather than mangled — the CSS ellipsis
 * handles that case.
 * @param value - the working directory.
 * @returns the display path.
 */
export function compactPath(value: string): string {
  if (value.length <= 42) return value
  const parts = value.split('/').filter(Boolean)
  return parts.length > 1 ? `…/${parts.slice(-2).join('/')}` : value
}

/**
 * The status word beside the dot. Four rungs, the same vocabulary the strip's
 * dot uses (`workbench/status.ts`'s `sessionDotState`) so one session never
 * reads as 「运行中」 here and something else there.
 *
 * `StateDotState` also has an `'error'` member for other DSH surfaces, but
 * `sessionDotState` can never return it — DSH's `SessionSummary` carries no
 * failure bit — so it falls through to 「空闲」 rather than inventing an
 * 「异常」 rung this plugin has no signal for.
 * @param state - the node's dot state, absent when idle.
 * @param t - the workbench translator.
 * @returns the translated status word.
 */
function statusLabel(state: StateDotState | undefined, t: Translate<MatouKey>): string {
  if (state === 'warning') return t('session.status.waiting')
  if (state === 'ongoing') return t('session.status.running')
  if (state === 'done') return t('session.status.completed')
  return t('dag.status.idle')
}

/**
 * 「最近活动 HH:MM」 in local wall-clock time, zero-padded on both halves
 * (码头 `DagCanvas.tsx:319-323`). A node with no recorded activity says so
 * instead of rendering the epoch — 码头 falls back to an interaction sequence
 * number there, which DSH does not expose.
 * @param lastActivityAt - `SessionSummary.updatedAt`, or `0`.
 * @param t - the workbench translator.
 * @returns the translated activity line.
 */
function activityLabel(lastActivityAt: number, t: Translate<MatouKey>): string {
  if (lastActivityAt === 0) return t('dag.node.noActivity')
  const date = new Date(lastActivityAt)
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return t('dag.node.activity', { time })
}

/**
 * Render one session card.
 * @param props - the projection, the preview flag, the placement style, the click handler and `t`.
 * @returns the card button.
 */
export function DagNodeCard({ node, focused, style, onClick, t }: DagNodeCardProps) {
  return (
    <button
      type="button"
      className={clsx(css.card, focused && css.isFocused, node.hasNotice && css.hasNotice)}
      style={style}
      data-session-id={node.sessionId}
      // The canvas's drag gesture ignores pointer-downs that land on a card
      // (码头 `DagCanvas.tsx:149` tests its class names; data attributes are
      // the stabler hook, and `DagCanvas.tsx` — Task 10 — reads this one).
      data-dag-node=""
      aria-label={t('dag.node.open', { title: node.title })}
      onClick={onClick}
    >
      {node.hasNotice && (
        <span className={css.notice} role="img" aria-label={t('dag.node.notice', { title: node.title })} />
      )}
      <span className={css.topRow}>
        {node.state === undefined
          ? <span className={css.idleDot} aria-hidden="true" />
          : <StateDot state={node.state} />}
        {statusLabel(node.state, t)}
      </span>
      <strong className={css.title} title={node.title}>{node.title}</strong>
      {node.cwd !== '' && (
        <span className={css.path} title={node.cwd}>{compactPath(node.cwd)}</span>
      )}
      <p className={clsx(css.preview, node.preview === '' && css.isEmpty)}>
        {node.preview === '' ? t('dag.node.emptyPreview') : node.preview}
      </p>
      <span className={css.meta}>
        {node.childCount > 0 && (
          <>
            {/* Counts the children DRAWN HERE, subagents included — a wider
                count than the card header's own 「子会话 N」 badge, which
                excludes them (`carousel/header-seats.tsx`). Deliberate: that
                badge answers 「能下钻到哪一层」, this one answers 「这张图上它
                下面挂了几个」. */}
            <span>{t('dag.node.children', { n: node.childCount })}</span>
            <span aria-hidden="true"> · </span>
          </>
        )}
        <span>{activityLabel(node.lastActivityAt, t)}</span>
      </span>
    </button>
  )
}
