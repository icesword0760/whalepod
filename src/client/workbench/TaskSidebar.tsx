/**
 * The Matou task sidebar: workspaces as collapsible groups, tasks as rows.
 * Clicking the active group folds it; clicking another group activates and
 * unfolds it. Rows expose pin / rename / delete through a menu; the default
 * task materializes on its first write. Sessions counts sit in the row's one
 * right-hand slot (the unread badge takes it over in S5).
 */
import { useCallback, useMemo, useState } from 'react'
import type { MouseEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives/src/Menu.tsx'
import {
  IconChevronDownOutline14, IconEllipsisOutline16, IconFolderClose16, IconPlusOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives/src/icons/index.tsx'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives/src/Menu.tsx'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { MatouKey } from '../locales.ts'
import type { ActiveSelection } from '../nav/navigation.ts'
import type { AgentNotification } from '../notifications/store.ts'
import { unreadForTask } from '../notifications/selectors.ts'
import type { MatouTaskView, MatouWorkspaceOrgView } from '../org/derive.ts'
import { nextNumberedName, taskDeleteImpact, validateUniqueName } from '../org/naming.ts'
import type { WorkbenchActions } from './actions.ts'
import { IconPin, IconTaskLines } from './icons.tsx'
import { ConfirmDialog, RenameDialog } from './dialogs.tsx'
import { taskRefOf } from './refs.ts'
import { DagIcon } from './DagIcon.tsx'
import css from './workbench.module.css'

/** Display cap for the task row's unread badge (spec §5): 99, then "99+". */
const UNREAD_BADGE_CAP = 99

export interface TaskSidebarProps {
  view: readonly MatouWorkspaceOrgView[]
  active: ActiveSelection
  degraded: boolean
  t: Translate<MatouKey>
  actions: WorkbenchActions
  /** Shown as the header's ＋ when the host can pick a directory. */
  onAddWorkspace?: (() => void) | undefined
  /**
   * S5 Task 5: the live notification list, for the row's unread badge.
   * Omitted (or empty) keeps every row's pre-S5 behavior (session count,
   * "…" menu button) exactly as it was. The workspace/group header row is
   * deliberately never lit from this — see `notifications/selectors.ts`'s
   * module doc; do not add one here.
   */
  notifications?: readonly AgentNotification[]
  /**
   * S5 Task 8: 「点事项行或工作区头 = 整个工作区已读」(spec §5 已读规则),
   * ported from 码头 `hierarchy/TaskSidebar.tsx:223, 268` where
   * `notificationStore.markWorkspaceRead(workspace.id)` is the FIRST statement
   * of both the group toggle's and the task row's `onClick`. Workspace-scoped
   * even from a task row — the store has no `markTaskRead` and 码头 never asks
   * for one. Omitted keeps every pre-S5 caller's behavior unchanged.
   */
  markWorkspaceRead?: (workspaceId: string) => void
}

/** Display title: the virtual default row is localized, stored rows are literal. */
export function taskTitle(task: MatouTaskView, t: Translate<MatouKey>): string {
  return task.virtual ? t('task.default') : task.title
}

function TaskRow(props: {
  task: MatouTaskView
  active: boolean
  sessionCount: number
  /** S5 Task 5: this task's unread notification count (uncapped — this row applies the 99+ cap itself). */
  unreadCount: number
  t: Translate<MatouKey>
  onOpenDag: () => void
  onActivate: () => void
  /**
   * S5 Task 8: 码头 `TaskSidebar.tsx:268` runs `markWorkspaceRead` as the
   * first statement of the row's `onClick` and — verified in source — does
   * NOT run it from `onKeyDown`, which only calls `activateTask`. Keeping it
   * a separate callback from {@link onActivate} is what preserves that
   * asymmetry: the two paths would otherwise share one closure and the
   * keyboard would silently mark read too.
   */
  onMarkRead: () => void
  onRename: () => void
  onDelete: () => void
  onTogglePin: () => void
}) {
  const { task, t } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const items = useMemo<MenuEntry[]>(() => [
    { id: 'pin', label: task.isPinned ? t('task.menu.unpin') : t('task.menu.pin') },
    { id: 'rename', label: t('task.menu.rename') },
    { type: 'separator', id: 'sep' },
    { id: 'delete', label: t('task.menu.delete'), danger: true },
  ], [task.isPinned, t])
  // Fix round 1 (review): while the row has unread the "…" menu doesn't
  // render at all (see below), but `menuOpen` is a `useState` that survives
  // across renders on this `key`-stable row — an unconditional `setMenuOpen`
  // here would arm it silently, then pop the dropdown open with no click the
  // instant `unreadCount` later drops to 0 (e.g. the user opens that task's
  // one unread session in the carousel; Task 1's "focus reads it" zeroes the
  // count on the very next render). Gating on the same `unreadCount === 0`
  // condition the render below uses keeps a right-click on an unread row a
  // true no-op instead of a silently armed one.
  const onContextMenu = useCallback((event: MouseEvent) => {
    event.preventDefault()
    if (props.unreadCount === 0) setMenuOpen(true)
  }, [props.unreadCount])
  return (
    <div
      className={css.taskRow}
      data-active={props.active || undefined}
      data-task-id={task.id}
      role="button"
      tabIndex={0}
      onClick={() => { props.onMarkRead(); props.onActivate() }}
      onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) props.onActivate() }}
      onContextMenu={onContextMenu}
    >
      {/* 码头 `TaskSidebar.tsx:282` 的 `workbench-item__icon`：每行事项前面都有的
          四线字形。此前本行没有这个字形，只有一串纯文字。 */}
      <IconTaskLines className={css.rowGlyph} />
      <span className={css.taskTitle}>{taskTitle(task, t)}</span>
      {task.isPinned && <IconPin className={css.pin} />}
      {/* S5 Task 5: the unread badge takes over this row's one right-hand
          text slot (码头 has no session-count element at all here) — the
          session count is this port's own pre-S5 addition, shown only while
          the task has nothing unread. */}
      {props.unreadCount > 0
        ? (
          <span className={css.taskBadge}>
            {props.unreadCount > UNREAD_BADGE_CAP ? '99+' : props.unreadCount}
          </span>
        )
        : props.sessionCount > 0 && (
          <span className={css.taskSlot}>{t('task.sessions', { n: props.sessionCount })}</span>
        )}
      <button
        type="button"
        className={css.rowDag}
        aria-label={t('scene.dag')}
        title={t('scene.dag')}
        onClick={(event) => { event.stopPropagation(); props.onOpenDag() }}
      >
        <DagIcon />
      </button>
      {/* 码头 `TaskSidebar.tsx:286-288`: the "…" menu hides while the row has
          unread — the badge takes over its spot instead of doubling up. */}
      {props.unreadCount === 0 && (
        <span className={css.rowMenu} data-open={menuOpen || undefined} onClick={(event) => { event.stopPropagation() }}>
          <Menu
            open={menuOpen}
            onClose={() => { setMenuOpen(false) }}
            items={items}
            portal
            align="end"
            onSelect={(id) => {
              setMenuOpen(false)
              if (id === 'pin') props.onTogglePin()
              if (id === 'rename') props.onRename()
              if (id === 'delete') props.onDelete()
            }}
            anchor={(
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('task.menu')}
                icon={<IconEllipsisOutline16 size={16} />}
                onClick={() => { setMenuOpen(open => !open) }}
              />
            )}
          />
        </span>
      )}
    </div>
  )
}

export function TaskSidebar({
  view, active, degraded, t, actions, onAddWorkspace, notifications = [], markWorkspaceRead,
}: TaskSidebarProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [renameTarget, setRenameTarget] = useState<{ task: MatouTaskView; siblings: string[] } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<MatouTaskView | null>(null)

  const run = useCallback((work: Promise<unknown>) => {
    work.then(() => { setNotice(undefined) }, (reason: unknown) => {
      setNotice(reason instanceof Error ? reason.message : String(reason))
    })
  }, [])

  const onGroupClick = useCallback((workspace: MatouWorkspaceOrgView) => {
    // S5 Task 8 — 码头 `TaskSidebar.tsx:223` opens this handler with exactly
    // this call, BEFORE the collapse/activate branch below, so a click that
    // merely folds an already-active group still marks its workspace read.
    markWorkspaceRead?.(workspace.workspaceId)
    const isActive = active.workspace?.workspaceId === workspace.workspaceId
    if (isActive) {
      setCollapsed((previous) => {
        const next = new Set(previous)
        if (next.has(workspace.workspaceId)) next.delete(workspace.workspaceId)
        else next.add(workspace.workspaceId)
        return next
      })
      return
    }
    setCollapsed((previous) => {
      if (!previous.has(workspace.workspaceId)) return previous
      const next = new Set(previous)
      next.delete(workspace.workspaceId)
      return next
    })
    actions.navigate({ workspaceId: workspace.workspaceId })
  }, [active.workspace?.workspaceId, actions, markWorkspaceRead])

  /**
   * 顶部整行的「新建工作区」——对齐码头的 `flat-sidebar__new-workspace`
   * （`TaskSidebar.tsx:191-196`：侧栏顶栏第一个按钮就是它，码头那里**没有**
   * 「新会话」按钮）。DSH 自己在同一位置放的是「新会话」，在本布局里是多余的：
   * 新会话是在某个页签的带子里建的，卡片归属由事项/页签决定，侧栏顶部一个不知道
   * 该落到哪个页签的「新会话」只会制造歧义。那颗按钮由 `AppFrame.module.css`
   * 隐藏，位置让给这一个。
   *
   * 区块头上原来那颗小 `＋` 一并去掉：它跟这个按钮是同一个动作，码头也没有它。
   * 每个工作区行上的 `＋`（新建事项）保留——那是另一个动作，码头同样有。
   */
  const header = (
    <div className={css.sectionHead}>
      {onAddWorkspace !== undefined && (
        <Button
          variant="outline"
          className={css.newWorkspace}
          aria-label={t('workspace.new')}
          onClick={onAddWorkspace}
        >
          {t('workspace.new')}
        </Button>
      )}
      <div className={css.sectionHeader}>
        <span className={css.sectionLabel}>{t('sidebar.workspaces')}</span>
      </div>
    </div>
  )

  if (view.length === 0) {
    return (
      <div className={css.seatRoot} aria-label={t('sidebar.workspaces')}>
        {header}
        <div className={css.emptyBlock} role="status">
          <div className={css.emptyTitle}>{t('workspace.empty.title')}</div>
          <div className={css.emptyHint}>{t('workspace.empty.hint')}</div>
        </div>
      </div>
    )
  }

  return (
    <div className={css.seatRoot} aria-label={t('sidebar.workspaces')}>
      {header}
      {degraded && <div className={css.notice} role="status">{t('sidebar.orgDegraded')}</div>}
      {notice !== undefined && <div className={`${css.notice} ${css.noticeError}`} role="alert">{notice}</div>}
      <div className={css.sidebarBody}>
        {view.map((workspace) => {
          const isActive = active.workspace?.workspaceId === workspace.workspaceId
          const isCollapsed = collapsed.has(workspace.workspaceId)
          const titles = workspace.tasks.map(task => taskTitle(task, t))
          return (
            <section key={workspace.workspaceId} className={css.group} data-active={isActive || undefined}>
              <div className={css.groupHeader}>
                <button
                  type="button"
                  className={css.groupToggle}
                  aria-expanded={!isCollapsed}
                  onClick={() => { onGroupClick(workspace) }}
                >
                  {/* 码头 `TaskSidebar.tsx:236`：折叠箭头 + 文件夹图标 + 名称。
                      箭头此前是文本「▾」，字重与同排图标对不齐；文件夹图标本来没有。 */}
                  <span className={css.chevron} data-collapsed={isCollapsed || undefined} aria-hidden="true">
                    <IconChevronDownOutline14 size={14} />
                  </span>
                  <IconFolderClose16 size={16} className={css.folder} />
                  <span className={css.groupTitle}>{workspace.title}</span>
                  {notifications.some(n => !n.read && n.workspaceId === workspace.workspaceId) && <span role="status" aria-label={t('notification.workspaceUnread')} className={css.workspaceUnread} />}
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('task.add')}
                  title={t('task.add')}
                  icon={<IconPlusOutline16 size={16} />}
                  onClick={() => {
                    run(actions.createTask(workspace.workspaceId, nextNumberedName(titles, t('task.new'))))
                  }}
                />
              </div>
              {!isCollapsed && (workspace.tasks.length === 0
                ? <div className={css.emptyRow}>{t('task.empty')}</div>
                : workspace.tasks.map(task => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    active={isActive && active.task?.id === task.id}
                    sessionCount={task.scenes.reduce((sum, scene) => sum + scene.sessions.length, 0)}
                    unreadCount={unreadForTask(notifications, task.id)}
                    t={t}
                    onActivate={() => { actions.navigate({ workspaceId: workspace.workspaceId, taskId: task.id }) }}
                    // Workspace-scoped, not task-scoped — 码头 `TaskSidebar.tsx:268`.
                    onOpenDag={() => {
                      actions.navigate({ workspaceId: workspace.workspaceId, taskId: task.id })
                      actions.openDag()
                    }}
                    onMarkRead={() => { markWorkspaceRead?.(workspace.workspaceId) }}
                    onRename={() => {
                      setRenameTarget({
                        task,
                        siblings: workspace.tasks.filter(other => other.id !== task.id).map(other => taskTitle(other, t)),
                      })
                    }}
                    onDelete={() => { setDeleteTarget(task) }}
                    onTogglePin={() => { run(actions.setTaskPinned(taskRefOf(task), !task.isPinned)) }}
                  />
                )))}
            </section>
          )
        })}
      </div>
      <RenameDialog
        open={renameTarget !== null}
        title={t('task.rename.title')}
        initial={renameTarget === null ? '' : taskTitle(renameTarget.task, t)}
        fieldLabel={t('dialog.name')}
        cancelLabel={t('dialog.cancel')}
        confirmLabel={t('dialog.confirm')}
        closeLabel={t('dialog.close')}
        validate={draft => validateUniqueName(draft, renameTarget?.siblings ?? [], {
          empty: t('validation.empty'),
          duplicate: t('validation.duplicate.task'),
        })}
        onSubmit={async (name) => {
          if (renameTarget === null) return
          await actions.renameTask(taskRefOf(renameTarget.task), name)
        }}
        onClose={() => { setRenameTarget(null) }}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('task.delete.title')}
        body={deleteTarget === null ? '' : t('task.delete.body', {
          scenes: taskDeleteImpact(deleteTarget).sceneCount,
          sessions: taskDeleteImpact(deleteTarget).sessionCount,
        }) + (view.find(workspace => workspace.workspaceId === deleteTarget.workspaceId)?.tasks.length === 1
          ? ` ${t('task.delete.last')}` : '')}
        cancelLabel={t('dialog.cancel')}
        confirmLabel={t('task.delete.confirm')}
        closeLabel={t('dialog.close')}
        onConfirm={async () => {
          if (deleteTarget === null) return
          await actions.deleteTask(taskRefOf(deleteTarget))
        }}
        onClose={() => { setDeleteTarget(null) }}
      />
    </div>
  )
}
