/**
 * Merges 码头's card-header actions into DSH's OWN official session header
 * instead of drawing a second one (mockup/design-doc "两个头" problem — see
 * the Carousel/CardShell module docs). Registers one entry into DSH's
 * right-aligned `conversation.session.header.utilities` seat (declared by
 * ui-conversation, rendered inside `renderSlot('conversation.session.header.utilities', {})`
 * — see `ConversationSessionHeader` in that package): order 30, after the
 * shipped agent-preset (-10), schedule-catalog (10), and agent-team/job-list
 * (20) occupants, so 码头's actions sit last.
 *
 * `CardHeaderActions` (Ruling-1, see plan `docs/superpowers/plans/2026-09-04-s3b-card-carousel.md`
 * ledger) is deliberately decoupled from DSH's runtime hook shapes: it takes
 * plain, already-resolved facts (`childCount`, `canForkSibling`, …) and a
 * small local `CardHeaderActionsFace` — not `WorkbenchActions` — so this
 * component is fully testable and completable without waiting on Task 10's
 * `forkChild`/`forkSibling`/`forkPeer`/`drillTo` implementations. Ruling-1
 * caps nothing about the FACE's method count — only that it stays local and
 * doesn't depend on `WorkbenchActions` growing those methods first — so the
 * face carries two distinct fork verbs (see `forkSibling` vs `forkPeer`
 * below), not one merged one.
 *
 * `CardHeaderActionsEntry` (the connector actually registered below) derives
 * every fact it honestly can from real data: `title`/`childCount` from DSH's
 * own standard `useSessions` hook, `canForkSibling` and the placement half of
 * `childCount` from the plugin's own organization mirror store (`orgStore` —
 * the same instance `apply()` already threads into `workbenchFace()` as
 * `hooks: {org}`; `ctx.matouOrg`'s backing store), and `childState` by
 * aggregating direct
 * children's own dot state (`workbench/status.ts`'s `sessionDotState`) plus
 * `useSessionPendingInteraction` (a framework-standard prop, not something
 * this face has to invent). `renameSession` keeps its own direct delegate
 * (`ctx.sessions.binding(id)?.session.rename` — no `WorkbenchActions`
 * equivalent exists); `drillTo`/`forkChild`/`forkSibling`/`forkPeer`/
 * `removeCard` (Task 10) delegate to the plugin's one real `WorkbenchActions`
 * instance (`registerHeaderSeats`'s 3rd param) rather than re-deriving their
 * own resolution logic — see that function's doc and `actions.ts`'s
 * `performFork`/`locationOf`.
 * @module dsh-plugin-matou-layout/src/client/carousel/header-seats
 */
import { useCallback, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives/src/StateDot.tsx'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives/src/StateDot.tsx'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives/src/Menu.tsx'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives/src/Menu.tsx'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives/src/Toast.tsx'
import type { HostObservable, InjectFace, PropsRuntime, Translate, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MatouKey } from '../locales.ts'
import type { WorkbenchActions } from '../workbench/actions.ts'
import { CHILD_STATE_PRIORITY, sessionDotState } from '../workbench/status.ts'
import type { OrgMirrorState } from '../org/store.ts'
import { CardActionDialogs, useCardActionState } from './card-actions.tsx'
import type { CardForkActionsFace } from './card-actions.tsx'
import { childrenOfLevel } from './graph.ts'
import type { CarouselNode } from './graph.ts'
import { placementsBySessionOf, projectCarouselNodes } from './nodes.ts'
import { ActionIcon } from '../workbench/ActionIcon.tsx'
import { NewSessionButton } from './NewSessionButton.tsx'
import css from './header-seats.module.css'

/**
 * The actions 码头's card header needs that DSH does not already provide
 * anywhere: create a child branch, create a sibling branch, create a peer
 * branch, dive into a session's children, remove the card. Deliberately
 * local to this module (Ruling-1) — NOT a subset of `WorkbenchActions` — so
 * `CardHeaderActions` neither requires nor waits on Task 10's real
 * implementations landing on that type first. Every method takes the target
 * session id explicitly (mirrors `TeamActionInjected`'s convention) rather
 * than closing over one, since the seat's registrant binds one shared face
 * across every session.
 */
export interface CardHeaderActionsFace extends CardForkActionsFace {
  newSessionNextTo?: (sessionId: string) => Promise<void>
  downloadSessionLog?: (sessionId: string) => Promise<void>
  /** Navigate into `sessionId`'s children (码头 `onOpenChildren`/`onNavigateToChildren`). */
  drillTo(sessionId: string): void
  /**
   * Fork a new child of `sessionId` (码头 `onFork`, `relationMode: 'child'`).
   * `name` is the already-validated (same-layer-unique, ≤64 chars) branch
   * name collected by the caller's naming dialog — see `card-actions.tsx`.
   */
  forkChild(sessionId: string, name: string): Promise<void>
  /**
   * Fork a new SIBLING of `sessionId`: the new card attaches under
   * `sessionId`'s effective parent, and its conversation is resumed FROM
   * THAT PARENT — 码头's spec §4 "forked-from" relation (`onForkSibling`,
   * `relationMode: 'sibling'`). Only ever offered once that parent can
   * itself be forked (the header button's `canForkSibling` gate).
   */
  forkSibling(sessionId: string, name: string): Promise<void>
  /**
   * Fork a new PEER of `sessionId`: the new card ALSO attaches under
   * `sessionId`'s effective parent, but its conversation is resumed FROM
   * `sessionId` ITSELF — a copy of the current conversation, not the
   * parent's — 码头's spec §4 "derived-from" relation (`onForkPeer`,
   * `relationMode: 'peer'`, the context menu's "⑂ Fork 会话"). Distinct
   * fork state source from `forkSibling` even though both land the new
   * card at the same tree position — see the module doc / spec §4's table.
   */
  forkPeer(sessionId: string, name: string): Promise<void>
  /**
   * Remove `sessionId`'s card (码头 `onRemoveBranch`); the caller confirms
   * first (`card-actions.tsx`'s `ConfirmDialog`, including the "仅本卡/含所有子代"
   * choice once there are children).
   */
  removeCard(sessionId: string, cascade: boolean): void
}

/**
 * Presentational props for {@link CardHeaderActions}: every fact arrives
 * already resolved (no DSH standard hooks here — see the module doc). The
 * seat's connector component (below) is what actually derives these from
 * live session data.
 */
export interface CardHeaderActionsProps {
  sessionId: string
  /** Current display title — the rename dialog's prefilled draft. */
  title: string
  /** Direct children count (subagents excluded — they surface in the S4 DAG, not this badge). */
  childCount: number
  childState?: StateDotState | undefined
  /**
   * Whether `sessionId` has a valid effective parent — 码头 never shows the
   * sibling-fork affordance for a root-level session (no parent at all).
   */
  canForkSibling: boolean
  actions: CardHeaderActionsFace
  /** Already-shipped `WorkbenchActions.renameSession`, reused as-is for the context menu's rename dialog. */
  renameSession: (sessionId: string, title: string) => Promise<void>
  /**
   * Whether the fork's state source is currently running — gates the
   * "create child branch"/"⑂ Fork 会话" affordances (spec §4: fork on a
   * running source only toasts, never forks). Defaults to `false` (allowed)
   * when the caller doesn't know — this is honest degradation, not a real
   * default: a caller that never wires it simply never blocks.
   */
  selfRunning?: boolean
  /** Same gate for "兄弟分支": whether `sessionId`'s effective PARENT is running. */
  parentRunning?: boolean
  /**
   * Whether `sessionId` itself has at least one completed turn to fork from
   * (D4, S3b Task 11d — spec §4 "源会话未就绪…点 fork 只弹提示，不 fork",
   * the other half of "未就绪" besides `selfRunning`; see
   * `forkReadyFromBlank`'s doc for the honest `blank`-based signal and its
   * known gap). Gates "创建子分支"/"⑂ Fork 会话" — `performFork`'s
   * `stateSourceId` is `sessionId` for both (`actions.ts`). Defaults to
   * `true` (ready) when the caller doesn't know — honest degradation, same
   * policy as `selfRunning`'s default: an unwired caller never blocks.
   */
  selfForkReady?: boolean
  /** Same gate for "兄弟分支": whether `sessionId`'s effective PARENT has a completed turn to fork from. */
  parentForkReady?: boolean
  /** Sibling titles in `sessionId`'s own children (forkChild's target layer), for the naming dialog's uniqueness check. */
  childTitles?: readonly string[]
  /** Sibling titles in `sessionId`'s own layer (forkSibling/forkPeer's target layer). */
  siblingTitles?: readonly string[]
  t: Translate<MatouKey>
}

/**
 * 码头's card-header actions, rendered inside DSH's own session header seat:
 * the child-session badge (click drills in), the "create child branch" and
 * conditional "sibling branch" buttons, and the "remove" button — plus a
 * right-click context menu (码头 TerminalPane's pane menu) with rename,
 * peer-fork ("⑂ Fork 会话", `forkPeer` — distinct from the toolbar's
 * `forkSibling`, see `CardHeaderActionsFace`'s doc), and remove entries. The
 * menu opens at the pointer position, matching 码头's own affordance, rather
 * than anchored to a trigger button. Fork buttons and the menu's remove entry
 * open the shared `card-actions.tsx` dialogs (naming + uniqueness + running
 * gate; archive confirm) rather than calling the face directly.
 */
export function CardHeaderActions({
  sessionId, title, childCount, childState, canForkSibling, actions, renameSession, t,
  selfRunning = false, parentRunning = false, selfForkReady = true, parentForkReady = true,
  childTitles = [], siblingTitles = [],
}: CardHeaderActionsProps) {
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null)
  // DSH `Menu` 的定位 useLayoutEffect 把 `getAnchorRect` 列进依赖，并且每跑一次都
  // `setFixedPos({left, top})` 写一个新对象。传内联箭头 = 每次渲染都换引用 = 渲染→定位→
  // 改 state→再渲染，React 数到第 50 层就抛 #185 把整个应用卸载掉。菜单关着时那条分支
  // 写的是 `null`（同值会被 React 吞掉），所以卡片少的时候看不出来；一个页签堆到十几张
  // 卡、每张各挂一个菜单，就必崩。按会话数量绑定引用，只有锚点真的变了才重新定位。
  const getAnchorRect = useCallback(
    () => menuAnchor === null ? null : new DOMRect(menuAnchor.x, menuAnchor.y, 0, 0),
    [menuAnchor],
  )
  const dialogs = useCardActionState()
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState(false)

  const menuItems: MenuEntry[] = [
    { id: 'rename', label: t('card.menu.rename') },
    { id: 'forkPeer', label: t('card.menu.forkPeer'), icon: '⑂' },
    ...(actions.downloadSessionLog === undefined ? [] : [{ id: 'download', label: t('card.menu.download'), disabled: downloading }]),
    { id: 'remove', label: t('card.remove'), danger: true },
  ]

  return (
    <div
      className={css.actions}
      data-matou-download={actions.downloadSessionLog === undefined ? undefined : ""}
      onContextMenu={(event) => {
        event.preventDefault()
        setMenuAnchor({ x: event.clientX, y: event.clientY })
      }}
    >
      {childCount > 0 && (
        <button
          type="button"
          className={css.actionButton}
          onClick={() => { actions.drillTo(sessionId) }}
        >
          {childState !== undefined && <StateDot state={childState} size={8} />}
          {t('card.children', { n: childCount })}
        </button>
      )}
      <button
        type="button"
        className={css.iconButton}
        aria-label={t('card.forkChild')}
        title={t('card.forkChild')}
        onClick={() => { dialogs.startFork('child', selfRunning, selfForkReady) }}
      >
        <ActionIcon name="layers-plus" />
      </button>
      {canForkSibling && (
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('card.forkSibling')}
          title={t('card.forkSibling')}
          onClick={() => { dialogs.startFork('sibling', parentRunning, parentForkReady) }}
        >
          <ActionIcon name="copy-plus" />
        </button>
      )}
      <button
        type="button"
        className={css.iconButton}
        aria-label={t('card.remove')}
        title={t('card.remove')}
        onClick={() => { dialogs.openRemove() }}
      >
        <ActionIcon name="circle-minus" />
      </button>
      {actions.newSessionNextTo !== undefined && (
        <NewSessionButton sessionId={sessionId} create={actions.newSessionNextTo} t={t} />
      )}
      <button
        type="button"
        className={css.actionButton}
        aria-label={t('card.menu.more')}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          setMenuAnchor({ x: rect.left, y: rect.bottom })
        }}
      >⋯</button>
      <Menu
        open={menuAnchor !== null}
        anchor={<></>}
        portal
        getAnchorRect={getAnchorRect}
        items={menuItems}
        onClose={() => { setMenuAnchor(null) }}
        onSelect={(id) => {
          setMenuAnchor(null)
          if (id === 'download' && actions.downloadSessionLog !== undefined && !downloading) {
            setDownloading(true)
            setDownloadError(false)
            void actions.downloadSessionLog(sessionId).catch(() => { setDownloadError(true) })
              .finally(() => { setDownloading(false) })
          }
          if (id === 'rename') dialogs.openRename()
          // Peer fork (derived-from sessionId itself), NOT the same face
          // method as the toolbar's sibling-fork button — see the module doc.
          if (id === 'forkPeer') dialogs.startFork('peer', selfRunning, selfForkReady)
          if (id === 'remove') dialogs.openRemove()
        }}
      />
      <CardActionDialogs
        sessionId={sessionId}
        title={title}
        childCount={childCount}
        // Same fact under both names: `canForkSibling` IS "an effective
        // parent exists" (see its doc), which is exactly what decides the
        // remove dialog's descendant-fate copy (C2).
        hasParent={canForkSibling}
        actions={actions}
        renameSession={renameSession}
        childTitles={childTitles}
        siblingTitles={siblingTitles}
        renameOpen={dialogs.renameOpen}
        onRenameClose={dialogs.closeRename}
        forkMode={dialogs.forkMode}
        onForkClose={dialogs.closeFork}
        removeOpen={dialogs.removeOpen}
        onRemoveClose={dialogs.closeRemove}
        t={t}
      />
      {downloadError && <Toast text={t('card.menu.downloadError')} onDone={() => { setDownloadError(false) }} />}
      {dialogs.blocked !== null && (
        <Toast
          key={dialogs.blocked.token}
          text={t(dialogs.blocked.reason === 'running' ? 'card.fork.blocked' : 'card.fork.notReady')}
          onDone={dialogs.clearBlocked}
        />
      )}
    </div>
  )
}

/** No placement overrides: a session's DSH-reported `parentId` is the sole parent signal. */
const EMPTY_PLACEMENTS: ReadonlyMap<string, string | null | undefined> = new Map()
/** Nothing archived — the honest default for a caller that has no workspace snapshot on hand. */
const NO_ARCHIVED: readonly string[] = []

// Re-exported from its new home so this seat's existing import sites keep
// working; the projection it feeds (`projectCarouselNodes`) is shared with
// AppFrame and `actions.ts` — see `nodes.ts`'s module doc (Ruling-20).
export { placementsBySessionOf }

/**
 * Every session as this seat sees it: the SHARED projection (`nodes.ts`), so
 * the official header's badge/name-check answers match the compact header's
 * and `actions.ts`'s to the row.
 * @param list - the standard `useSessions` snapshot.
 * @param placementsBySession - org-mirror overrides ({@link placementsBySessionOf}).
 * @param archivedIds - DSH's archived session ids (`useWorkspaces(s => s.archivedSessionIds)`).
 * @returns the projected nodes.
 */
function nodesOfList(
  list: SessionListState,
  placementsBySession: ReadonlyMap<string, string | null | undefined>,
  archivedIds: Iterable<string>,
): CarouselNode[] {
  return projectCarouselNodes({
    ids: list.ids,
    summaryOf: id => list.byId[id as SessionId],
    placementsBySession,
    archivedIds,
  })
}

/**
 * Direct children of `sessionId` as {@link CarouselNode}s, so callers can read
 * more than the id (`aggregateChildState` below reads their DSH status too).
 * Subagents (Ruling-4 parity — they surface in the S4 DAG, not this seat) and
 * archived sessions are both excluded by the shared projection.
 * @param list - the standard `useSessions` snapshot.
 * @param sessionId - the level's parent id.
 * @param placementsBySession - org-mirror overrides ({@link placementsBySessionOf}); defaults to none.
 * @param archivedIds - DSH's archived session ids; defaults to none.
 * @returns the ordered direct children.
 */
function directChildrenOf(
  list: SessionListState,
  sessionId: string | undefined,
  placementsBySession: ReadonlyMap<string, string | null | undefined> = EMPTY_PLACEMENTS,
  archivedIds: Iterable<string> = NO_ARCHIVED,
): CarouselNode[] {
  return childrenOfLevel(nodesOfList(list, placementsBySession, archivedIds), sessionId)
}

/**
 * Display titles of `parentId`'s direct children — the naming dialog's
 * "同层唯一" uniqueness check reads this for the layer a fork would land in.
 * `parentId` undefined selects the scene's root layer.
 * @param list - the standard `useSessions` snapshot.
 * @param parentId - the layer's parent id, or undefined for the root layer.
 * @param placementsBySession - org-mirror overrides ({@link placementsBySessionOf}); defaults to none.
 * @returns display titles, one per direct child.
 */
function childTitlesOf(
  list: SessionListState,
  parentId: string | undefined,
  placementsBySession: ReadonlyMap<string, string | null | undefined> = EMPTY_PLACEMENTS,
  archivedIds: Iterable<string> = NO_ARCHIVED,
): string[] {
  return directChildrenOf(list, parentId, placementsBySession, archivedIds)
    .map(node => list.byId[node.sessionId as SessionId]?.displayTitle ?? '')
}

/**
 * Direct children count for the header badge.
 * @param list - the standard `useSessions` snapshot.
 * @param sessionId - the card's session id.
 * @param placementsBySession - org-mirror overrides ({@link placementsBySessionOf}); defaults to none.
 * @param archivedIds - DSH's archived session ids; defaults to none.
 * @returns the count of direct, live (non-subagent, non-archived) children.
 */
export function directChildCount(
  list: SessionListState,
  sessionId: string,
  placementsBySession: ReadonlyMap<string, string | null | undefined> = EMPTY_PLACEMENTS,
  archivedIds: Iterable<string> = NO_ARCHIVED,
): number {
  return directChildrenOf(list, sessionId, placementsBySession, archivedIds).length
}

/**
 * `sessionId`'s effective parent as the SHARED projection resolves it — so a
 * parent that is archived (or a subagent) reads as "no parent" here exactly
 * as it does in the carousel's own layers, instead of offering a sibling-fork
 * whose source no longer exists.
 * @param list - the standard `useSessions` snapshot.
 * @param sessionId - the card's session id.
 * @param placementsBySession - org-mirror overrides ({@link placementsBySessionOf}); defaults to none.
 * @param archivedIds - DSH's archived session ids; defaults to none.
 * @returns the parent's session id, or undefined at the root layer.
 */
export function effectiveParentIdOf(
  list: SessionListState,
  sessionId: string,
  placementsBySession: ReadonlyMap<string, string | null | undefined> = EMPTY_PLACEMENTS,
  archivedIds: Iterable<string> = NO_ARCHIVED,
): string | undefined {
  return nodesOfList(list, placementsBySession, archivedIds)
    .find(node => node.sessionId === sessionId)?.parentId
}

/**
 * Whether `sessionId` has a valid effective parent — the "有有效父" half of
 * the header's sibling-fork gate (码头 never shows it for a root session).
 * The other half (whether that parent can itself be forked) is the
 * connector's `parentRunning`/`parentForkReady`; this function only ever
 * answers the half it can honestly compute.
 * @param list - the standard `useSessions` snapshot.
 * @param sessionId - the card's session id.
 * @param placementsBySession - org-mirror overrides ({@link placementsBySessionOf}); defaults to none.
 * @param archivedIds - DSH's archived session ids; defaults to none.
 * @returns whether an effective parent exists.
 */
export function hasEffectiveParent(
  list: SessionListState,
  sessionId: string,
  placementsBySession: ReadonlyMap<string, string | null | undefined> = EMPTY_PLACEMENTS,
  archivedIds: Iterable<string> = NO_ARCHIVED,
): boolean {
  return effectiveParentIdOf(list, sessionId, placementsBySession, archivedIds) !== undefined
}

/**
 * Whether a session with this `SessionSummary.blank` has at least one
 * completed turn to fork from — the "从未有过一轮完成的对话" half of D4's
 * (S3b Task 11d) fork-readiness gate (`selfForkReady`/`parentForkReady`
 * above), the other half being `running` (already gated pre-D4). Spec §4
 * only names "运行中" in its "未就绪" clause, but DSH's fork RPC actually
 * rejects ANY source with no completed turn at all — running or not
 * (`session/fork-unavailable: "…has no completed turn to fork from"`,
 * `packages/api/session-controller/src/commands.ts`'s `fork`) — so this
 * closes the gap the spec's prose left unnamed.
 *
 * NOT a perfect proxy for that precondition, and this is deliberate rather
 * than an oversight: `blank` is DSH's "has a `turn/start` ever fired" bit,
 * permanently false the instant one does
 * (`packages/api/session-controller/src/list.ts`'s
 * `applySessionListMetadata`: `blank = state.blank && event.type !==
 * 'turn/start'`), while fork actually requires a completed `turn/end`. The
 * gap is exactly the window between a turn STARTING and ENDING — but that
 * window only exists while the session is actively running, which the
 * separate `running` half of the gate already covers; DSH's persistence
 * layer also auto-closes any turn a NON-running session left open
 * (`packages/session/session-persistence/src/coordinator.ts`'s
 * `interruptedTurnClosers`/`prepareCore`), so a non-running session's real
 * completed-turn state and its `blank` bit agree in every case this client
 * can observe. `blank` is the closest signal `SessionSummary` exposes, and
 * combined with `running` it is the honest choice given that — not an exact
 * mirror of the backend's own check.
 * @param blank - `SessionSummary.blank`, or `undefined` when no summary is available.
 * @returns whether fork's completed-turn precondition should be treated as met.
 */
export function forkReadyFromBlank(blank: boolean | undefined): boolean {
  return blank !== true
}

/**
 * Highest-priority {@link StateDotState} among `sessionId`'s direct children
 * (码头 spec §4: warning > ongoing > done). Reuses `workbench/status.ts`'s
 * `sessionDotState` per child — `running`/`completed` come straight off
 * `SessionSummary`, "pending" (等待输入) off the framework-standard
 * `useSessionPendingInteraction` map (approval/question/plan-review already
 * fold into one bit there: "does this session have a pending interaction").
 *
 * Two of 码头's five priority levels have no DSH signal to compute honestly
 * and stay out rather than being guessed at: "starting" (nothing on
 * `SessionSummary` distinguishes "about to run" from plain `running`) and
 * "error" (no durable failure bit on the summary — `StateDotState`'s
 * `'error'` never appears here). A later pass can widen this once DSH
 * exposes those signals.
 * @param list - the standard `useSessions` snapshot.
 * @param sessionId - the card's session id.
 * @param placementsBySession - org-mirror overrides ({@link placementsBySessionOf}).
 * @param pendingSessionIds - session ids with a pending interaction (keys of `useSessionPendingInteraction`'s map).
 * @param archivedIds - DSH's archived session ids; defaults to none.
 * @returns the aggregated state, or `undefined` when no child carries one.
 */
export function aggregateChildState(
  list: SessionListState,
  sessionId: string,
  placementsBySession: ReadonlyMap<string, string | null | undefined>,
  pendingSessionIds: ReadonlySet<string>,
  archivedIds: Iterable<string> = NO_ARCHIVED,
): StateDotState | undefined {
  let best: StateDotState | undefined
  for (const child of directChildrenOf(list, sessionId, placementsBySession, archivedIds)) {
    const summary = list.byId[child.sessionId as SessionId]
    if (summary === undefined) continue
    const state = sessionDotState({
      running: summary.running,
      completed: summary.completed,
      pending: pendingSessionIds.has(child.sessionId),
    })
    if (state === undefined) continue
    if (best === undefined || CHILD_STATE_PRIORITY.indexOf(state) > CHILD_STATE_PRIORITY.indexOf(best)) best = state
  }
  return best
}

/** The seat's full injected face: the five new actions plus the already-shipped rename delegate and the org-mirror hook. */
export interface CardHeaderActionsInjected extends CardHeaderActionsFace {
  renameSession: (sessionId: string, title: string) => Promise<void>
  hooks: {
    /** Same organization mirror `WorkbenchInjected.hooks.org` already exposes — one store, two consumers. */
    readonly org: HostObservable<OrgMirrorState>
  }
}

/**
 * Registered entry's composed runtime + injected-face + locale props.
 * `InjectFace` is what turns `CardHeaderActionsInjected.hooks.org` into the
 * bound `useOrg: SnapshotSelectorHook<OrgMirrorState>` prop the connector
 * actually reads (same transformation `TaskSidebarSeatProps` already relies
 * on for `WorkbenchInjected.hooks.org`/`.nav`).
 */
export type CardHeaderActionsEntryProps =
  & PropsRuntime<'conversation.session.header.utilities'>
  & InjectFace<CardHeaderActionsInjected>
  & { t: TranslateNS<'matou'> }

/**
 * The connector actually registered into the seat: adapts DSH's standard
 * session props into {@link CardHeaderActionsProps}. `sessionId`,
 * `useSessions`, `useWorkspaces`, `useSessionPendingInteraction`, and `t`
 * arrive through the framework; `useOrg` arrives through the entry's `hooks`
 * compartment (bound from `CardHeaderActionsInjected.hooks.org`); the five
 * actions plus rename arrive through the rest of the entry's `inject` face
 * (below).
 */
export function CardHeaderActionsEntry(props: CardHeaderActionsEntryProps) {
  const {
    sessionId, useSessions, useOrg, useWorkspaces, useSessionPendingInteraction, t,
    drillTo, forkChild, forkSibling, forkPeer, removeCard, renameSession, newSessionNextTo, downloadSessionLog,
  } = props
  const placements = useOrg(state => placementsBySessionOf(state.org.placements))
  const pendingSessionIds = useSessionPendingInteraction(map => new Set(map.keys()))
  const list = useSessions(snapshot => snapshot)
  // I2: without this, the official header counted archived children the
  // carousel had already dropped — one card, two headers, two numbers — and
  // the badge drilled into a session no layer contains.
  const archivedIds = useWorkspaces(snapshot => snapshot.archivedSessionIds)
  const title = list.byId[sessionId]?.displayTitle ?? t('session.untitled')
  const childCount = directChildCount(list, sessionId, placements, archivedIds)
  const childState = aggregateChildState(list, sessionId, placements, pendingSessionIds, archivedIds)
  const parentId = effectiveParentIdOf(list, sessionId, placements, archivedIds)
  const canForkSibling = parentId !== undefined
  const selfRunning = list.byId[sessionId]?.running === true
  const parentRunning = parentId !== undefined && list.byId[parentId as SessionId]?.running === true
  const selfForkReady = forkReadyFromBlank(list.byId[sessionId]?.blank)
  const parentForkReady = parentId === undefined || forkReadyFromBlank(list.byId[parentId as SessionId]?.blank)
  const childTitles = childTitlesOf(list, sessionId, placements, archivedIds)
  const siblingTitles = childTitlesOf(list, parentId, placements, archivedIds)
  return (
    <CardHeaderActions
      sessionId={sessionId}
      title={title}
      childCount={childCount}
      childState={childState}
      canForkSibling={canForkSibling}
      actions={{ drillTo, forkChild, forkSibling, forkPeer, removeCard, ...(newSessionNextTo === undefined ? {} : { newSessionNextTo }), ...(downloadSessionLog === undefined ? {} : { downloadSessionLog }) }}
      renameSession={renameSession}
      selfRunning={selfRunning}
      parentRunning={parentRunning}
      selfForkReady={selfForkReady}
      parentForkReady={parentForkReady}
      childTitles={childTitles}
      siblingTitles={siblingTitles}
      t={t}
    />
  )
}

/**
 * Register 码头's card actions into DSH's official `conversation.session.header.utilities`
 * seat (`order: 30`, after the shipped agent-preset/schedule/agent-team/job
 * occupants — see the module doc). `drillTo`/`forkChild`/`forkSibling`/
 * `forkPeer`/`removeCard` delegate straight to the SAME `WorkbenchActions`
 * instance `apply()` builds for AppFrame/the sidebar (Task 10: this seat is
 * a thin adapter over the one real implementation, not a second copy of the
 * fork/drill resolution logic — see `actions.ts`'s `performFork`/`locationOf`).
 * `renameSession` keeps its own direct delegate (unchanged from Task 8:
 * `ctx.sessions.binding(id)?.session.rename`, no `WorkbenchActions`
 * equivalent exists); `canForkSibling`/`childCount`/`childState` read the
 * real organization mirror through `orgStore` (same store `apply()` already
 * seats as `ctx.matouOrg`, threaded here as a plain `hooks.org` value
 * exactly like `WorkbenchInjected.hooks.org`).
 * @param ctx - client root context (`sessions`, `workspaces`, `slots`, `locale` already declared by this plugin's `inject`).
 * @param orgStore - the organization mirror observable (`apply()`'s `orgStore`).
 * @param actions - the plugin's one `WorkbenchActions` instance (`apply()`'s `actions`).
 * @returns disposer removing the injected registration (mirrors `ctx.slots.inject`'s own return).
 */
export function registerHeaderSeats(
  ctx: ClientContext,
  orgStore: HostObservable<OrgMirrorState>,
  actions: WorkbenchActions,
): () => void {
  const renameSession = async (sessionId: string, title: string): Promise<void> => {
    const face = ctx.sessions.binding(sessionId as SessionId)?.session
    if (face === undefined) throw new Error('matou-layout: session is not available for renaming')
    const result = await face.rename(title)
    if (!result.ok) throw result.error
  }
  // Optional DSH service: reuse its download lifecycle and its already-mounted result dialog.
  // Read at injection time so the export plugin can register after this layout plugin.
  const exportActions = (): Pick<CardHeaderActionsFace, 'downloadSessionLog'> => {
    const controller = ctx.reflect.get('sessionLogDownload', false) as
      { download(sessionId: SessionId): Promise<void> } | undefined
    return controller === undefined ? {} : { downloadSessionLog: id => controller.download(id as SessionId) }
  }
  const cardActionsFace = (): CardHeaderActionsInjected => ({
    ...exportActions(),
    newSessionNextTo: sessionId => actions.newSessionNextTo(sessionId),
    drillTo: sessionId => { actions.drillTo(sessionId) },
    forkChild: (sessionId, name) => actions.forkChild(sessionId, name),
    forkSibling: (sessionId, name) => actions.forkSibling(sessionId, name),
    forkPeer: (sessionId, name) => actions.forkPeer(sessionId, name),
    removeCard: (sessionId, cascade) => { void actions.removeCard(sessionId, cascade) },
    renameSession,
    hooks: { org: orgStore },
  })
  return ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'matou-card-actions',
    // Right-aligned utilities, keeping the new-session control beside the more menu.
    order: 30,
    locale: 'matou',
    inject: cardActionsFace,
  }, CardHeaderActionsEntry))
}
