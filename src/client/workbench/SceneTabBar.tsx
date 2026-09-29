/**
 * Scene tabs of the active task. Click switches, double-click renames
 * (pinning the title), × closes (confirming when sessions live there; a
 * virtual default tab has nothing to close). Tabs the bar cannot fit fold
 * into a "more" menu; picking one scrolls it to the center.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives/src/Menu.tsx'
import { IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives/src/icons/index.tsx'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { MatouKey } from '../locales.ts'
import type { AgentNotification } from '../notifications/store.ts'
import { sessionHasUnread } from '../notifications/selectors.ts'
import type { MatouSceneView, MatouTaskView } from '../org/derive.ts'
import { nextNumberedName, sceneDeleteImpact, validateUniqueName } from '../org/naming.ts'
import type { WorkbenchActions } from './actions.ts'
import { ConfirmDialog, RenameDialog } from './dialogs.tsx'
import { sceneRefOf, taskRefOf } from './refs.ts'
import { DagIcon } from './DagIcon.tsx'
import css from './workbench.module.css'

export interface SceneTabBarProps {
  task: MatouTaskView | undefined
  activeSceneId: string | undefined
  /** The current carousel drill layer's parent, if any — new sessions from this bar land under it (spec §4). */
  currentParentId?: string | undefined
  /**
   * S5 Task 5: the live notification list, for the per-tab red dot. Omitted
   * (or empty) lights nothing — safe for every caller that predates S5.
   */
  notifications?: readonly AgentNotification[]
  t: Translate<MatouKey>
  actions: WorkbenchActions
}

export function sceneTitle(scene: MatouSceneView, t: Translate<MatouKey>): string {
  return scene.virtual ? t('task.default') : scene.name
}

/**
 * A scene's tab lights up when ANY session currently MOUNTED under it (its
 * own `MatouSceneView.sessions`, the org-derived placement set) has unread —
 * deliberately **not** `AgentNotificationStore.unreadForScene`, which keys
 * off a notification record's own recorded `sceneId`. Ported from 码头
 * `SceneTabBar.tsx:121-125`'s `sceneHasUnread`: the record's `sceneId` can go
 * stale (a session moved tabs after the notification fired) while the
 * mounted set is always current.
 */
function sceneHasUnread(scene: MatouSceneView, notifications: readonly AgentNotification[]): boolean {
  return scene.sessions.some(ref => sessionHasUnread(notifications, ref.sessionId))
}

/** 页签栏提示条的存活时长（毫秒）：读得完一句中文，又不会在屏幕上赖着不走。 */
const NOTICE_MS = 6000

/**
 * 把页签栏动作的失败翻译成用户读得懂的一句话——与 `card-actions.tsx` 的
 * {@link humanizeRemoveError} / {@link humanizeForkError} 同构，而且修的是同一类
 * 缺陷：那两处在首轮活体走查就补上了，页签栏这条当时漏掉了，于是 2026-09-14 的
 * 桌面端走查里，用户在一屏中文界面上看到的是
 * `matou-layout: organization changed elsewhere; please retry`——一句裸英文内部错误。
 *
 * 判据同样用错误文本的稳定片段而不是错误码：`actions.ts` 的 `apply` 抛的是普通
 * `Error`，本仓没有第二处产生这句话。原始错误照样进控制台备查。
 * @param error - `createScene` / `deleteScene` / `newSession` 抛出的原始错误。
 * @param t - matou 命名空间的翻译器。
 * @returns 一句用户可读的中文（或当前语言）提示。
 */
export function humanizeSceneActionError(error: unknown, t: Translate<MatouKey>): string {
  console.error('matou-layout: scene action failed', error)
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('changed elsewhere') ? t('scene.action.conflict') : t('scene.action.error')
}

export function SceneTabBar({ task, activeSceneId, currentParentId, notifications = [], t, actions }: SceneTabBarProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const [hidden, setHidden] = useState<readonly string[]>([])
  const [moreOpen, setMoreOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<MatouSceneView | null>(null)
  const [closeTarget, setCloseTarget] = useState<MatouSceneView | null>(null)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  /**
   * 提示条只活 {@link NOTICE_MS}。原实现只在「下一次同类操作成功」时才清，于是
   * 一条早已不成立的提示会一直挂在页签栏上——2026-09-14 桌面端走查亲眼看到：落位
   * 文档早已重新同步（客户端与磁盘同为 revision 91），横幅还在让用户「retry」，
   * 而且没有任何关掉它的地方。
   */
  const showNotice = useCallback((text: string | undefined) => {
    if (noticeTimerRef.current !== undefined) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = undefined
    setNotice(text)
    if (text === undefined) return
    noticeTimerRef.current = setTimeout(() => {
      noticeTimerRef.current = undefined
      setNotice(undefined)
    }, NOTICE_MS)
  }, [])
  useEffect(() => () => {
    if (noticeTimerRef.current !== undefined) clearTimeout(noticeTimerRef.current)
  }, [])

  const run = useCallback((work: Promise<unknown>) => {
    work.then(() => { showNotice(undefined) }, (reason: unknown) => {
      showNotice(humanizeSceneActionError(reason, t))
    })
  }, [showNotice, t])

  const scenes = task?.scenes ?? []

  const measure = useCallback(() => {
    const list = listRef.current
    if (list === null) return
    const box = list.getBoundingClientRect()
    if (box.width === 0) return
    const clipped: string[] = []
    for (const child of Array.from(list.children)) {
      const id = (child as HTMLElement).dataset.sceneId
      if (id === undefined) continue
      const rect = child.getBoundingClientRect()
      if (rect.right > box.right + 1 || rect.left < box.left - 1) clipped.push(id)
    }
    setHidden(previous => (previous.length === clipped.length && previous.every((id, i) => id === clipped[i])
      ? previous
      : clipped))
  }, [])

  useLayoutEffect(measure, [measure, scenes])
  useEffect(() => {
    const list = listRef.current
    if (list === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => { measure() })
    observer.observe(list)
    return () => { observer.disconnect() }
  }, [measure])

  const activate = useCallback((scene: MatouSceneView) => {
    if (task === undefined) return
    actions.navigate({ workspaceId: task.workspaceId, taskId: task.id, sceneId: scene.id })
  }, [task, actions])

  const reveal = useCallback((sceneId: string) => {
    const list = listRef.current
    const tab = list?.querySelector<HTMLElement>(`[data-scene-id="${CSS.escape(sceneId)}"]`)
    tab?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
  }, [])

  if (task === undefined) return null

  const names = scenes.map(scene => sceneTitle(scene, t))
  const activeScene = scenes.find(scene => scene.id === activeSceneId)

  return (
    <div className={css.tabBar} role="tablist" aria-label={t('scene.list')}>
      <div className={css.tabList} ref={listRef}>
        {scenes.map((scene) => {
          const isActive = scene.id === activeSceneId
          return (
            <button
              key={scene.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={css.tab}
              data-active={isActive || undefined}
              data-scene-id={scene.id}
              onClick={() => { activate(scene) }}
              onDoubleClick={() => { setRenameTarget(scene) }}
            >
              <span>{sceneTitle(scene, t)}</span>
              {sceneHasUnread(scene, notifications) && (
                <span className={css.tabUnreadDot} aria-hidden="true" data-testid={`scene-unread-${scene.id}`} />
              )}
              {!scene.virtual && (
                <span
                  role="button"
                  aria-label={t('scene.close')}
                  className={css.tabClose}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (scene.sessions.length === 0) run(actions.deleteScene(sceneRefOf(task, scene)))
                    else setCloseTarget(scene)
                  }}
                >
                  ×
                </span>
              )}
            </button>
          )
        })}
      </div>
      <div className={css.tabTools}>
        {hidden.length > 0 && (
          <Menu
            open={moreOpen}
            onClose={() => { setMoreOpen(false) }}
            items={scenes.filter(scene => hidden.includes(scene.id)).map(scene => ({ id: scene.id, label: sceneTitle(scene, t) }))}
            portal
            align="end"
            onSelect={(id) => {
              setMoreOpen(false)
              const scene = scenes.find(candidate => candidate.id === id)
              if (scene === undefined) return
              activate(scene)
              reveal(scene.id)
            }}
            anchor={(
              <Button variant="ghost" size="sm" aria-label={t('scene.more')} onClick={() => { setMoreOpen(open => !open) }}>
                …
              </Button>
            )}
          />
        )}
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('scene.add')}
          title={t('scene.add')}
          onClick={() => { run(actions.createScene(taskRefOf(task), nextNumberedName(names, t('scene.new')))) }}
        >
          ＋
        </Button>
      </div>
      <div className={css.tabActions}>
        <Button
          variant="outline"
          size="sm"
          icon={<DagIcon />}
          onClick={() => { actions.openDag() }}
        >
          {t('scene.dag')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon={<IconPlusOutline16 size={16} />}
          disabled={activeScene === undefined}
          onClick={() => {
            if (activeScene !== undefined) run(actions.newSession(sceneRefOf(task, activeScene), currentParentId))
          }}
        >
          {t('session.add')}
        </Button>
      </div>
      {notice !== undefined && <span className={css.fieldError} role="alert">{notice}</span>}
      <RenameDialog
        open={renameTarget !== null}
        title={t('scene.rename.title')}
        initial={renameTarget === null ? '' : sceneTitle(renameTarget, t)}
        fieldLabel={t('dialog.name')}
        cancelLabel={t('dialog.cancel')}
        confirmLabel={t('dialog.confirm')}
        closeLabel={t('dialog.close')}
        validate={draft => validateUniqueName(
          draft,
          scenes.filter(scene => scene.id !== renameTarget?.id).map(scene => sceneTitle(scene, t)),
          { empty: t('validation.empty'), duplicate: t('validation.duplicate.scene') },
        )}
        onSubmit={async (name) => {
          if (renameTarget === null) return
          await actions.renameScene(sceneRefOf(task, renameTarget), name)
        }}
        onClose={() => { setRenameTarget(null) }}
      />
      <ConfirmDialog
        open={closeTarget !== null}
        title={t('scene.close')}
        body={closeTarget === null ? '' : t('scene.close.body', { sessions: sceneDeleteImpact(closeTarget).sessionCount })}
        cancelLabel={t('dialog.cancel')}
        confirmLabel={t('scene.close.confirm')}
        closeLabel={t('dialog.close')}
        onConfirm={async () => {
          if (closeTarget === null) return
          await actions.deleteScene(sceneRefOf(task, closeTarget))
        }}
        onClose={() => { setCloseTarget(null) }}
      />
    </div>
  )
}
