/**
 * The 42px header a non-focused card shows in place of DSH's official
 * session header (mockup `compactHeader`): status dot, title, an optional
 * "new notice" pill, an optional child-session badge (click drills in), and
 * a "more" button. Ruling-6 (S3b plan ledger) hides the official header on
 * compact cards via CSS (`carousel.module.css`), which also hides Task 8's
 * card actions registered inside it — Ruling-9 gives this "⋯" button the
 * same actions (create child/sibling branch, ⑂ Fork 会话, remove) through
 * its own dropdown, reusing `card-actions.tsx`'s dialogs (the SAME naming +
 * uniqueness + running-gate + archive-confirm machinery the focused card's
 * official header uses via `header-seats.tsx`'s `CardHeaderActions`). The
 * `menu` prop is optional: omitted, the "⋯" renders as static chrome (the
 * card-shell test fixture's original behavior).
 * @module dsh-plugin-matou-layout/src/client/carousel/CompactCardHeader
 */
import { useCallback, useState } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives/src/StateDot.tsx'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives/src/StateDot.tsx'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives/src/Menu.tsx'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives/src/Menu.tsx'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives/src/Toast.tsx'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { MatouKey } from '../locales.ts'
import { CardActionDialogs, useCardActionState } from './card-actions.tsx'
import type { CardForkActionsFace } from './card-actions.tsx'
import { NewSessionButton } from './NewSessionButton.tsx'
import css from './carousel.module.css'

/** Everything the compact card's "⋯" menu needs beyond what `CompactCardHeaderProps` already carries. */
export interface CompactCardMenuProps {
  actions: CardForkActionsFace & { drillTo(sessionId: string): void; newSessionNextTo?: (sessionId: string) => Promise<void> }
  renameSession: (sessionId: string, title: string) => Promise<void>
  canForkSibling: boolean
  selfRunning: boolean
  parentRunning: boolean
  /**
   * Whether the card's own session has at least one completed turn to fork
   * from — D4's (S3b Task 11d) other readiness gate besides `selfRunning`.
   * See `header-seats.tsx`'s `forkReadyFromBlank` doc for the honest
   * `blank`-based signal and its known gap.
   */
  selfForkReady: boolean
  /** Same gate for "兄弟分支": whether the card's effective PARENT has a completed turn to fork from. */
  parentForkReady: boolean
  childTitles: readonly string[]
  siblingTitles: readonly string[]
}

export interface CompactCardHeaderProps {
  /** Needed by `menu`'s actions (drillTo/fork/remove all take the card's own session id). */
  sessionId: string
  title: string
  state?: StateDotState | undefined
  hasNotice: boolean
  childCount: number
  childState?: StateDotState | undefined
  /** Omitted: the "⋯" is static chrome and the child badge is inert (unused outside a live carousel). */
  menu?: CompactCardMenuProps
  t: Translate<MatouKey>
}

export function CompactCardHeader({
  sessionId, title, state, hasNotice, childCount, childState, menu, t,
}: CompactCardHeaderProps) {
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

  const menuItems: MenuEntry[] = menu === undefined
    ? []
    : [
      { id: 'rename', label: t('card.menu.rename') },
      { id: 'forkChild', label: t('card.forkChild') },
      ...(menu.canForkSibling ? [{ id: 'forkSibling', label: t('card.forkSibling') } satisfies MenuEntry] : []),
      { id: 'forkPeer', label: t('card.menu.forkPeer'), icon: '⑂' },
      { id: 'remove', label: t('card.remove'), danger: true },
    ]

  return (
    <div className={css.compactHeader} data-card-header>
      {state !== undefined && <StateDot state={state} />}
      <span className={css.compactTitle}>{title}</span>
      {hasNotice && <span className={css.noticeBadge}>{t('card.notice')}</span>}
      {childCount > 0 && (
        <button
          type="button"
          className={css.childBadge}
          onClick={() => { menu?.actions.drillTo(sessionId) }}
        >
          {childState !== undefined && <StateDot state={childState} size={8} />}
          {t('card.children', { n: childCount })}
        </button>
      )}
      {menu?.actions.newSessionNextTo !== undefined && (
        <NewSessionButton sessionId={sessionId} create={menu.actions.newSessionNextTo} t={t} />
      )}
      {menu === undefined
        ? <span className={css.moreButton} aria-hidden="true">⋯</span>
        : (
          <button
            type="button"
            className={css.moreButton}
            aria-label={t('card.menu.more')}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              setMenuAnchor({ x: rect.left, y: rect.bottom })
            }}
          >
            ⋯
          </button>
        )}
      {menu !== undefined && (
        <>
          <Menu
            open={menuAnchor !== null}
            anchor={<></>}
            portal
            getAnchorRect={getAnchorRect}
            items={menuItems}
            onClose={() => { setMenuAnchor(null) }}
            onSelect={(id) => {
              setMenuAnchor(null)
              if (id === 'rename') dialogs.openRename()
              if (id === 'forkChild') dialogs.startFork('child', menu.selfRunning, menu.selfForkReady)
              if (id === 'forkSibling') dialogs.startFork('sibling', menu.parentRunning, menu.parentForkReady)
              if (id === 'forkPeer') dialogs.startFork('peer', menu.selfRunning, menu.selfForkReady)
              if (id === 'remove') dialogs.openRemove()
            }}
          />
          <CardActionDialogs
            sessionId={sessionId}
            title={title}
            childCount={childCount}
            // `canForkSibling` IS "an effective parent exists" — the same
            // fact the remove dialog needs to say where descendants go (C2).
            hasParent={menu.canForkSibling}
            actions={menu.actions}
            renameSession={menu.renameSession}
            childTitles={menu.childTitles}
            siblingTitles={menu.siblingTitles}
            renameOpen={dialogs.renameOpen}
            onRenameClose={dialogs.closeRename}
            forkMode={dialogs.forkMode}
            onForkClose={dialogs.closeFork}
            removeOpen={dialogs.removeOpen}
            onRemoveClose={dialogs.closeRemove}
            t={t}
          />
          {dialogs.blocked !== null && (
            <Toast
              key={dialogs.blocked.token}
              text={t(dialogs.blocked.reason === 'running' ? 'card.fork.blocked' : 'card.fork.notReady')}
              onDone={dialogs.clearBlocked}
            />
          )}
        </>
      )}
    </div>
  )
}
