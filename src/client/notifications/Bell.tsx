/**
 * Sidebar-footer bell (`sidebar.header.action` seat, S5 Task 6): the
 * notification center's entry point. Reuses the plugin's shared
 * `WorkbenchInjected` face — the same one `sidebar.workspaces`
 * (`TaskSidebarSeat.tsx`) already receives — rather than a bespoke local
 * face like `header-seats.tsx`'s `CardHeaderActionsFace`: that decoupling
 * served a historical testability need (Task 10's fork/drill actions weren't
 * built yet when it was written) that does not apply here, and
 * `hooks.notifications` is already wired end to end.
 *
 * DSH's icon set has no bell glyph (confirmed against
 * `@deepseek-ai/dsh-client-ui-primitives`'s icon index), so `BellIcon` stays
 * a local inline SVG — the same call `SceneTabBar.tsx`'s `DagIcon` makes for
 * its own DSH-less glyph, and drawn in that icon's stroke family (16x16,
 * `currentColor`, 1.5 stroke) rather than DSH's solid-fill `Icon*Outline*`
 * components.
 *
 * Wide renders a full sidebar row (icon + "通知" label): the same
 * 42px/12px-radius shape as ui-settings-general's own trigger row
 * (`bell.module.css`'s header comment has the exact precedent). Narrow
 * (56px rail) renders only the 18px icon in a 36px circle, wrapped in a
 * `Tooltip` — the DSH rail convention (`SidebarRoot.tsx`'s toggle/new-session
 * buttons both wrap their rail icon the same way, `disabled={wide}` so the
 * bubble never fights the wide row's own visible label).
 *
 * The unread dot is a boolean presence check (`unreadCount > 0`), never a
 * number — 码头's own `TaskSidebar.tsx:196-197` draws the identical bare dot.
 *
 * The panel's open/closed state lives in `panel-store.ts`, a module-level
 * store `index.ts` instantiates once (Ruling-S5-1: the bell and the S5 Task
 * 7 panel are different seats in different React subtrees, so local
 * `useState` cannot bridge them). This file only calls the injected
 * `togglePanel`; it never touches the store directly.
 * @module dsh-plugin-matou-layout/src/client/notifications/Bell
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives/src/Tooltip.tsx'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import clsx from 'clsx'
import type { WorkbenchInjected } from '../workbench/face.ts'
import css from './bell.module.css'

/** The registered seat id — stable across HMR/reload (matches `header-seats.tsx`'s `'matou-card-actions'` convention). */
export const BELL_SEAT_ID = 'matou-notifications-bell'

/**
 * DOM anchor stamped on the bell's own root button, read by
 * `NotificationCenter.tsx`'s outside-click detector so a click on the bell
 * is never treated as "outside the panel" (S5 Task 7 review finding: without
 * this exclusion, a click on the bell while the panel is open closes it on
 * `pointerdown` and the bell's own `onClick` immediately reopens it on the
 * following `click` — see that file's module doc for the full sequence).
 *
 * The bell (`sidebar.header.action`) and the panel (`shell.overlay`) are
 * different seats in different React subtrees (Ruling-S5-1), so neither
 * side has a ref reaching the other — unlike DSH's own `Menu.tsx`, which
 * keeps its anchor and list under one shared `rootRef` and simply checks
 * both. A plain DOM attribute is the contract that bridges two subtrees
 * with no shared ref, and it is DSH's own answer to exactly this shape:
 * `ui-input-trigger`'s `MenuView.tsx:60-72` exempts a region another package
 * owns from its outside-pointerdown check the same way
 * (`closest('[data-composer-card]')`), and stamps its own root with the same
 * empty-string form this file uses (`data-trigger-menu=""`, `MenuView.tsx:77`).
 *
 * Kept in sync BY HAND with the literal `data-matou-notification-bell`
 * attribute on the button below (both live in this one file, a few lines
 * apart) — `NotificationCenter.tsx` imports this constant rather than
 * repeating the literal a third time. No separate guard test asserts that
 * pairing: `bell-panel-combined.client.spec.tsx` renders the REAL `Bell`, so
 * a typo in either half already turns it red (verified by review, which
 * introduced one).
 */
export const BELL_ANCHOR_ATTR = 'data-matou-notification-bell'

export type BellProps =
  & PropsRuntime<'sidebar.header.action'>
  & InjectFace<WorkbenchInjected>
  & PropsLocale<'matou'>

/** Local inline bell glyph — see the module doc for why DSH's own icon set has nothing to reuse here. */
function BellIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2.75c-.48 0-.87.39-.87.87v.35C5.1 4.51 3.7 6.2 3.7 8.2v2.4c0 .58-.2 1.14-.58 1.58l-.6.7c-.33.38-.06.96.44.96h10.08c.5 0 .77-.58.44-.96l-.6-.7a2.4 2.4 0 0 1-.58-1.58V8.2c0-2-1.4-3.69-3.43-4.23v-.35c0-.48-.39-.87-.87-.87Z" />
      <path d="M6.5 13.1a1.5 1.5 0 0 0 3 0" />
    </svg>
  )
}

/**
 * Render the sidebar-footer bell.
 * @param props - composed slot props (runtime share + shared workbench face + locale seat).
 * @returns the bell button, tooltip-wrapped in the rail.
 */
export function Bell({ wide, t, useNotifications, usePanel, togglePanel }: BellProps) {
  const hasUnread = useNotifications(snapshot => snapshot.unreadCount > 0)
  // S5 Task 7 leftover (flagged in Task 6's review): now that Task 7 gives
  // `hooks.panel` a real reader, the bell can report its own open/closed
  // state — 码头's `flat-sidebar__notify` carries the same `aria-expanded`.
  const open = usePanel(snapshot => snapshot.open)
  const label = t('notification.bell')
  return (
    <Tooltip label={label} delayMs={500} disabled={wide}>
      <button
        type="button"
        className={clsx(css.trigger, !wide && css.rail)}
        aria-label={label}
        aria-expanded={open}
        data-matou-notification-bell=""
        onClick={() => { togglePanel() }}
      >
        <span className={css.iconWrap}>
          <BellIcon size={wide ? 16 : 18} />
          {hasUnread && <span className={css.dot} data-testid="bell-unread-dot" aria-hidden="true" />}
        </span>
        {wide && <span className={css.label}>{label}</span>}
      </button>
    </Tooltip>
  )
}

/**
 * Register the bell into `sidebar.header.action`. Extracted from `apply()`
 * (mirrors `header-seats.tsx`'s `registerHeaderSeats`) so the registration
 * itself — name, id, locale, and which face factory it wires — is testable
 * without standing up the plugin's full service graph.
 * @param ctx - client root context.
 * @param workbenchFace - the SAME face factory `apply()` hands `sidebar.workspaces`
 * and `root` (already carrying `hooks.notifications` and `togglePanel`).
 * @returns disposer removing the injected registration (mirrors `ctx.slots.inject`'s own return).
 */
export function registerBellSeat(
  ctx: ClientContext,
  workbenchFace: () => WorkbenchInjected,
): () => void {
  return ctx.slots.inject('sidebar.header.action', () => ctx.slots.register({
    name: 'sidebar.header.action',
    id: BELL_SEAT_ID,
    locale: 'matou',
    inject: workbenchFace,
  }, HeaderBell))
}

/** Icon-only entry beside the collapse control; rail keeps a separate row. */
export function HeaderBell(props: BellProps) {
  return <span data-matou-header-bell="" className={css.headerBell}><Bell {...props} wide={false} /></span>
}
