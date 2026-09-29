/**
 * Translates a before/after DSH session-state snapshot into the notification
 * inputs `AgentNotificationStore.push()` should receive. **This module has no
 * source in 码头 to port from** — 码头's notifications are pushed by Claude
 * Code hook *events* (`ingestAgentNotification` fires once per envelope);
 * DSH exposes no such event stream, only *state* (which sessions are
 * currently pending an interaction, and each session's `running`/`completed`
 * flags). So instead of reacting to events, this module diffs two state
 * snapshots and reports the transitions that deserve a notification. It is
 * the one original adaptation layer in the S5 plan (see
 * `.superpowers/sdd/2026-09-05-s5-notifications/task-3-brief.md`) and is a
 * pure function: no React, no DOM, no `Date.now()`/timers — the caller
 * (Task 4's subscription glue) owns diffing cadence, and the store's own
 * `now` injection stamps the eventual timestamp.
 *
 * ## The seven derivation rules
 *
 * 1. A pending interaction *appears* for a session (present in `next.pending`
 *    but absent from `prev.pending`, OR present in both but with a changed
 *    `key` — a replacement request under the same session) produces one
 *    event. `kind === 'approval'` maps to `eventType: 'permission'` (headline
 *    "等待审批"); every other kind — including `'question'`, `'plan-review'`,
 *    and any third-party kind this module has never heard of — maps to
 *    `eventType: 'waiting'` (headline "等待输入"). See "Unknown kind" below
 *    for why the fallback is deliberate, not an oversight. `cooldownKey` is
 *    set to the raw `kind` string (not the collapsed `eventType`), so e.g. a
 *    `'question'` storm and a `'plan-review'` storm on the same session cool
 *    down independently of each other.
 * 2. A pending interaction *disappearing* (present in `prev.pending`, absent
 *    from `next.pending`) produces nothing. Going away is not "動静" worth a
 *    notification — only new asks are.
 * 3. A session's `completed` flag flipping `false`/absent → `true` produces a
 *    `completed` event (headline "已完成"). `true` → `true` (already seen)
 *    produces nothing — this is a one-shot edge trigger, not a level check.
 *    Per DSH's own `completed` semantics (only set while a session is
 *    non-focused and transitions from running to idle), a focused session's
 *    own completion never reaches here in the first place.
 * 4. Every produced event carries `isFocusedSession: sessionId ===
 *    focusedSessionId`; the store uses that flag to mark a focused session's
 *    own notification pre-read and silent.
 * 5. `workspaceId`/`taskId`/`sceneId` come from `locate(sessionId)`; a
 *    session `locate` cannot place gets explicit `null`s (not omitted keys)
 *    so the store still retains and can later reconcile the record.
 * 6. `eventId` is a deterministic function of the inputs alone
 *    (`${sessionId}:${kind}:${key}` for a pending-appeared event,
 *    `${sessionId}:completed` for a completion) — calling this function
 *    twice with the same `prev`/`next` pair yields byte-identical output,
 *    including `eventId`. That determinism falls out for free from staying a
 *    pure function; it is asserted explicitly in the test file as a guard
 *    against a future refactor accidentally reaching for `Date.now()` or
 *    `Math.random()`.
 * 8. A session DSH marks `origin === 'subagent'` produces nothing, whatever
 *    it does. A subagent is a worker some card started, not a card: the user
 *    cannot open it, cannot act on it, and does not need to be pulled away for
 *    it — the parent card's own completion is the signal that matters. Caught
 *    by the third live walkthrough (2026-09-07), where a subagent finishing a
 *    trivial errand put a 「未知工作区 / 未知事项 · 已完成」 row in the
 *    notification centre: unplaceable by rule 5 precisely BECAUSE it is not a
 *    card. The carousel has always applied this filter
 *    (`workbench/known-sessions.ts:24`); `AppFrame` built the lifecycle
 *    snapshot from the full `sessions.ids` and never did. Enforcing it here
 *    rather than at the snapshot keeps it a stated derivation rule with a
 *    pure test, next to the other seven.
 *
 * 7. If `prev` is `undefined` this function produces nothing at all,
 *    regardless of what `next` contains. This is the "first subscription"
 *    guard: the very first diff a caller runs has no real previous state to
 *    compare against, and without this rule every pre-existing pending
 *    interaction or already-completed session would explode into a
 *    notification the instant the page opens. `undefined` is a **deliberate
 *    signal from the caller**, not something this module infers from the
 *    snapshot's shape (Ruling-S5-6, correcting an earlier version of this
 *    rule): a caller passes `undefined` exactly once, for its very first
 *    call, and its own real previous snapshot — even a genuinely empty one,
 *    e.g. every session just got archived or the workspace is momentarily
 *    empty — on every call after that. An empty-but-real `prev` is diffed
 *    normally: nothing here treats "empty" as "first" anymore, so a
 *    transition out of a real empty state still produces its notification
 *    instead of being silently swallowed.
 *
 * ## Deliberately not implemented: an "error" category (Ruling-S5-3)
 *
 * 码头 has an `'error'` event type; this module does not derive one, on
 * purpose. `SessionSummary` — the shape available across *all* sessions —
 * carries no error field at all; a session's error state
 * (`openError`/`promptError`/`lastAgentError`) only exists on the
 * `SessionSnapshot` of a session that is currently *open*, so covering every
 * session would require fanning out a per-session subscription this module
 * has no access to (and the brief's inputs don't offer). DSH's own status
 * indicators (session state dots, etc.) never render an `'error'` state
 * either, so this is not a regression relative to the rest of the app — it's
 * an honestly-documented gap versus 码头, to close only if DSH later exposes
 * a list-level error signal.
 *
 * ## Unknown `kind` must still be rendered (project rule, Ruling-S5-4)
 *
 * DSH's `SessionPendingInteractionMap` is an open declaration-merged type: any
 * plugin can contribute its own pending-interaction `kind` via
 * `ctx.uiSession.registerPendingInteraction`. DSH's own workspace sidebar
 * (`ui-workspace/src/client/tree.ts`) narrows to a 3-value whitelist
 * (`'approval' | 'plan-review' | 'question'`) and silently drops anything
 * else. This module deliberately does **not** copy that whitelist: per this
 * project's "compatible with everything DSH supports" rule, an unrecognized
 * `kind` still produces a `waiting` ("等待输入") event rather than vanishing.
 * Copying the sidebar's whitelist here would make any third-party plugin's
 * pending state invisible to this plugin's notifications.
 * @module dsh-plugin-matou-layout/src/client/notifications/derive
 */

import type { AgentNotificationInput } from './store.ts'

/** One session's currently active pending interaction — DSH's own open shape (`kind` is any string). */
export interface PendingInteractionSnapshotEntry {
  /** Opaque request identity; a replacement request for the same session uses a new key. */
  readonly key: string
  /** Domain-owned presentation discriminator. Open string — third-party plugins add their own. */
  readonly kind: string
  readonly sessionId: string
}

/** Mirrors `useSessionPendingInteraction()`'s value: current pending interaction by session id. */
export type PendingSnapshot = ReadonlyMap<string, PendingInteractionSnapshotEntry>

/** The subset of a session's lifecycle facts this module needs, mirroring DSH's session list shape. */
export interface SessionLifecycleSnapshot {
  readonly running: boolean
  /** Set while non-focused and transitioning from running to idle; DSH's own "done, unseen" signal. */
  readonly completed?: boolean
  readonly displayTitle?: string
  /**
   * DSH's own provenance flag. `'subagent'` means this session is a worker a
   * card started, not a card itself — see rule 8 in the module doc.
   */
  readonly origin?: 'subagent' | undefined
}

/** Mirrors `sessions.byId`: every known session's lifecycle facts, keyed by session id. */
export type SessionsSnapshot = Readonly<Record<string, SessionLifecycleSnapshot>>

/** The before/after state this module diffs: one session-pending map plus one session-lifecycle map. */
export interface NotificationSnapshot {
  readonly pending: PendingSnapshot
  readonly sessions: SessionsSnapshot
}

/** A session's place in the workspace/task/scene hierarchy; `null` in any slot means "not found". */
export interface SessionLocation {
  readonly workspaceId: string | null
  readonly taskId: string | null
  readonly sceneId: string | null
}

/** Supplied by the org-derived view: locates a session's hierarchy, or all-`null` if it can't. */
export type LocateSession = (sessionId: string) => SessionLocation

const WAITING_TITLE = '等待输入'
const PERMISSION_TITLE = '等待审批'
const COMPLETED_TITLE = '已完成'

/** Rule 1's kind → (eventType, headline) mapping. See the module doc's "Unknown kind" section. */
function categoryForKind(kind: string): { eventType: 'permission' | 'waiting'; title: string } {
  if (kind === 'approval') return { eventType: 'permission', title: PERMISSION_TITLE }
  return { eventType: 'waiting', title: WAITING_TITLE }
}

function pendingInteractionEvent(
  entry: PendingInteractionSnapshotEntry,
  next: NotificationSnapshot,
  focusedSessionId: string | undefined,
  locate: LocateSession,
): AgentNotificationInput {
  const { eventType, title } = categoryForKind(entry.kind)
  const location = locate(entry.sessionId)
  const displayTitle = next.sessions[entry.sessionId]?.displayTitle
  return {
    eventId: `${entry.sessionId}:${entry.kind}:${entry.key}`,
    eventType,
    title,
    ...(displayTitle ? { subtitle: displayTitle } : {}),
    workspaceId: location.workspaceId,
    taskId: location.taskId,
    sceneId: location.sceneId,
    sessionId: entry.sessionId,
    cooldownKey: entry.kind,
    isFocusedSession: entry.sessionId === focusedSessionId,
  }
}

function completedEvent(
  sessionId: string,
  next: NotificationSnapshot,
  focusedSessionId: string | undefined,
  locate: LocateSession,
): AgentNotificationInput {
  const location = locate(sessionId)
  const displayTitle = next.sessions[sessionId]?.displayTitle
  return {
    eventId: `${sessionId}:completed`,
    eventType: 'completed',
    title: COMPLETED_TITLE,
    ...(displayTitle ? { subtitle: displayTitle } : {}),
    workspaceId: location.workspaceId,
    taskId: location.taskId,
    sceneId: location.sceneId,
    sessionId,
    isFocusedSession: sessionId === focusedSessionId,
  }
}

/**
 * Diff two session-state snapshots and return the notification inputs the
 * transition between them warrants. See the module doc for the seven rules
 * this implements. Pure: calling it twice with the same arguments returns
 * arrays that are `toEqual` (same length, same fields, same `eventId`s) —
 * nothing here reads the clock, randomness, or any other ambient state.
 * @param prev - the previously observed snapshot, or `undefined` when the
 * caller has no prior observation yet (its very first call only — see rule
 * 7). A real, even genuinely empty, previous snapshot is never `undefined`.
 */
export function deriveNotificationEvents(
  prev: NotificationSnapshot | undefined,
  next: NotificationSnapshot,
  focusedSessionId: string | undefined,
  locate: LocateSession,
): AgentNotificationInput[] {
  // Rule 7: no prior observation to diff against — stay silent rather than
  // exploding every pre-existing pending interaction and already-completed
  // session into a notification. `undefined` is the caller's explicit
  // "first call" signal (Ruling-S5-6), never inferred from `next`/`prev`'s
  // own emptiness.
  if (prev === undefined) return []

  const events: AgentNotificationInput[] = []
  /** Rule 8: a subagent is a worker a card started, never a card. */
  const isSubagent = (sessionId: string): boolean =>
    next.sessions[sessionId]?.origin === 'subagent' || prev.sessions[sessionId]?.origin === 'subagent'

  // Rule 1 (appearance) + rule 2 (disappearance produces nothing, so we only
  // ever walk `next.pending` — anything only in `prev.pending` is skipped by
  // construction, not by an explicit check).
  for (const [sessionId, entry] of next.pending) {
    if (isSubagent(sessionId)) continue
    const previousEntry = prev.pending.get(sessionId)
    if (previousEntry !== undefined && previousEntry.key === entry.key) continue
    events.push(pendingInteractionEvent(entry, next, focusedSessionId, locate))
  }

  // Rule 3: completed false/absent -> true, one-shot edge trigger.
  for (const sessionId of Object.keys(next.sessions)) {
    if (isSubagent(sessionId)) continue
    const wasCompleted = prev.sessions[sessionId]?.completed === true
    const isCompleted = next.sessions[sessionId]?.completed === true
    const stoppedInBackground = prev.sessions[sessionId]?.running === true
      && next.sessions[sessionId]?.running === false
      && sessionId !== focusedSessionId
      && !next.pending.has(sessionId)
    if (!(isCompleted && !wasCompleted) && !stoppedInBackground) continue
    const event = completedEvent(sessionId, next, focusedSessionId, locate)
    // DSH running->idle also includes cancellation/errors: do not claim success.
    if (stoppedInBackground) event.title = '本轮已结束'
    events.push(event)
  }

  return events
}
