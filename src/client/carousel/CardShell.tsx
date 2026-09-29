/**
 * One carousel card's shell (mockup `card`, 码头 `SessionCard`): a focused
 * card defers its header entirely to DSH's official session header — Task 8
 * appends 码头's card actions into that header through a global slot seat
 * (`registerHeaderSeats`, see `header-seats.tsx`), which appears automatically
 * inside `renderPane`'s official conversation render; this shell does not
 * reserve or forward anything for it. A non-focused card draws its own 42px
 * {@link CompactCardHeader} instead. Never both — that is the "two heads"
 * this shell exists to avoid (see the module doc in Carousel.tsx). Static
 * structure only: no scrolling/centering/hover behavior (Task 9).
 *
 * D2 exception (S3b Task 11c): DSH hides its own official header for a
 * *blank* session (never had a turn) regardless of focus (`headerHidden` in
 * `ConversationSession.module.css`), so a focused-but-blank card would
 * otherwise render no header at all — no title, no "⋯" menu, no child badge.
 * The compact header is drawn whenever `!focused || {@link officialHeaderHidden}`,
 * so a focused blank session still gets its 42px header; it never doubles
 * with DSH's own because both sides now evaluate the SAME predicate over the
 * SAME live session snapshot (I4 — D2 originally read the session LIST's
 * `blank`, which lags the instance by a full round trip and produced two
 * heads for exactly as long as the first prompt was in flight, permanently if
 * it failed).
 * @module dsh-plugin-matou-layout/src/client/carousel/CardShell
 */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives/src/StateDot.tsx'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { MatouKey } from '../locales.ts'
import type { CompactCardMenuProps } from './CompactCardHeader.tsx'
import { CompactCardHeader } from './CompactCardHeader.tsx'
import css from './carousel.module.css'

/** One carousel card's view model; the carousel and the DAG (S4) share this shape. */
export interface CardModel {
  readonly sessionId: string
  readonly title: string
  readonly state?: StateDotState | undefined
  readonly hasNotice: boolean
  readonly hasRing: boolean
  readonly childCount: number
  readonly childState?: StateDotState | undefined
  readonly focused: boolean
  /**
   * `SessionSummary.blank` off DSH's session LIST: true while the session has
   * never had an accepted turn. Only the fallback for
   * {@link officialHeaderHidden} — the authoritative signal is the session
   * instance's own live snapshot, which the list projection lags by a full
   * round trip (I4). Kept because a card can exist before its binding does.
   */
  readonly blank: boolean
}

/** The `SessionSnapshot` fields {@link officialHeaderHidden} reads (DSH's per-session live lifecycle). */
export interface SessionLifecycleFacts {
  readonly blank: boolean
  readonly running: boolean
  /** A prompt call has BEGUN on this session — true from the frame the user hits send, before acceptance. */
  readonly promptAttempted: boolean
}

/**
 * Reads one session's live lifecycle. This is a React hook (it subscribes),
 * so a given `CardShell` must receive either the same function or none for
 * its whole lifetime — AppFrame wires one stable value bound from
 * `WorkbenchInjected.keyedHooks.sessionLifecycle`, and a test that omits it
 * omits it everywhere.
 */
export type UseSessionLifecycle =
  <S>(sessionId: string, selector: (facts: SessionLifecycleFacts | undefined) => S) => S

/** No live snapshot available (no binding, or a caller that never wired one): calls no hooks. */
const NO_LIFECYCLE: UseSessionLifecycle = (_sessionId, selector) => selector(undefined)

/**
 * Whether DSH is hiding its OWN official session header for this session —
 * the predicate `ConversationSessionHeader` itself evaluates
 * (`ui-conversation`'s `hideChrome = session.blank &&
 * conversationPhase(session, conversation) === 'blank'`), restated over the
 * facts a plugin can reach. Expanding `conversationPhase` for the only branch
 * that matters (`blank` true, which makes its `!blank && !awaitingFirstTurn`
 * term false) leaves: hidden iff blank AND not running AND no prompt has been
 * attempted.
 *
 * One term is deliberately not reproduced: `conversation.activeTargets.size >
 * 0`, the Conversation assembler's "some render target is streaming" set,
 * which no plugin-facing API exposes. It can only be non-empty once assembly
 * events flow, which for a session with no turn and no prompt attempt does
 * not happen; `running` covers the streaming case that would matter. If that
 * state were ever reached this would answer "hidden" while DSH shows its
 * header — the two-heads direction — so it is named here rather than assumed
 * away.
 * @param facts - the session instance's live snapshot, or undefined when no binding exists yet.
 * @param listBlank - `SessionSummary.blank` from the session list, the honest fallback without a snapshot.
 * @returns whether DSH's official header is hidden, so the card must draw its own.
 */
export function officialHeaderHidden(facts: SessionLifecycleFacts | undefined, listBlank: boolean): boolean {
  if (facts === undefined) return listBlank
  return facts.blank && !facts.running && !facts.promptAttempted
}

export interface CardShellProps {
  card: CardModel
  /** Renders the official `conversation` slot for this card (AppFrame wires the real one in Task 10). */
  renderPane: (sessionKey: string, focused: boolean) => ReactNode
  /** Resolves the compact card's "⋯" menu data (Ruling-9); omitted keeps that button static chrome. */
  cardMenu?: (sessionId: string) => CompactCardMenuProps
  /** Live per-session lifecycle read; omitted falls back to `card.blank`. See {@link UseSessionLifecycle}. */
  useSessionLifecycle?: UseSessionLifecycle
  t: Translate<MatouKey>
}

export function CardShell({ card, renderPane, cardMenu, useSessionLifecycle, t }: CardShellProps) {
  const readLifecycle = useSessionLifecycle ?? NO_LIFECYCLE
  const headerHidden = readLifecycle(card.sessionId, facts => officialHeaderHidden(facts, card.blank))
  return (
    <article
      className={clsx(css.card, card.focused && css.isFocused, card.hasRing && css.hasRing)}
      aria-current={card.focused ? 'true' : 'false'}
    >
      {card.focused && !headerHidden
        ? null
        : (
          <CompactCardHeader
            sessionId={card.sessionId}
            title={card.title}
            state={card.state}
            hasNotice={card.hasNotice}
            childCount={card.childCount}
            childState={card.childState}
            {...cardMenu === undefined ? {} : { menu: cardMenu(card.sessionId) }}
            t={t}
          />
        )}
      <div className={css.pane}>{renderPane(card.sessionId, card.focused)}</div>
    </article>
  )
}
