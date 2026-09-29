/**
 * One notification-center row: workspace/task breadcrumb, headline, optional
 * category subtitle and body copy, an `HH:MM` timestamp, and a per-row
 * dismiss control. Ported from 码头's `NotificationCenter.tsx`'s inline
 * `.notification-item` markup, minus the team-role/status badges (码头 fields
 * this plugin's own `AgentNotification` never carries — see `store.ts`'s
 * module doc: this plugin has no team feature to badge).
 *
 * S5 Task 8 made the row body a real `<button>`, exactly as 码头 has it
 * (`.notification-item__body` is a button carrying
 * `aria-label={`打开通知：${notification.body || notification.title}`}` and
 * `onClick={() => onNavigate(notification)}`). A button, not a click handler
 * on the `<article>`: the row is a genuine control, and the "×" dismiss must
 * stay a sibling rather than a nested button, which is why 码头 splits the
 * card into body + dismiss in the first place. The owner decides what a
 * click MEANS — see `NotificationCenter.tsx`'s `onNavigate`.
 *
 * The dismiss control follows `SceneTabBar.tsx`'s own close-affordance
 * convention (a "×" glyph plus a separate `aria-label`, not 码头's SVG
 * icon), rather than importing an SVG for a single glyph.
 * @module dsh-plugin-matou-layout/src/client/notifications/NotificationItem
 */
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { MatouKey } from '../locales.ts'
import type { AgentNotification } from './store.ts'
import css from './notifications.module.css'

export interface NotificationItemProps {
  notification: AgentNotification
  /** Resolved breadcrumb text — the caller has already applied the "未知工作区"/"未知事项" fallback. */
  workspaceName: string
  taskName: string
  onRemove: (id: string) => void
  /** S5 Task 8: the row body was clicked; the owner resolves the jump (码头's `onNavigate`). */
  onNavigate: (notification: AgentNotification) => void
  t: Translate<MatouKey>
}

/** `HH:MM`, local wall-clock time — 码头's own `formatTime`. */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * Render one notification row.
 * @param props - the record, its resolved breadcrumb names, the remove callback, and `t`.
 * @returns the row element.
 */
export function NotificationItem({
  notification, workspaceName, taskName, onRemove, onNavigate, t,
}: NotificationItemProps) {
  return (
    <article className={css.item}>
      <button
        type="button"
        className={css.itemBody}
        // 码头's own label copy: the body line when there is one, else the
        // headline — whichever actually tells the user which notification
        // this is (this plugin's rows often carry only a title, since DSH
        // has no hook-event body to quote).
        aria-label={t('notification.item.open', {
          title: notification.body === '' ? notification.title : notification.body,
        })}
        onClick={() => { onNavigate(notification) }}
      >
        <span className={css.breadcrumb}>
          <span className={css.breadcrumbPart}>{workspaceName}</span>
          <span className={css.breadcrumbSep} aria-hidden="true">/</span>
          <span className={css.breadcrumbPart}>{taskName}</span>
        </span>
        <strong className={css.itemTitle}>{notification.title}</strong>
        {notification.subtitle !== '' && <span className={css.itemSubtitle}>{notification.subtitle}</span>}
        {notification.body !== '' && <span className={css.itemContent}>{notification.body}</span>}
        <time className={css.itemTime} dateTime={new Date(notification.timestamp).toISOString()}>
          {formatTime(notification.timestamp)}
        </time>
      </button>
      <button
        type="button"
        className={css.itemDismiss}
        aria-label={t('notification.item.dismiss')}
        onClick={() => { onRemove(notification.id) }}
      >
        ×
      </button>
    </article>
  )
}
