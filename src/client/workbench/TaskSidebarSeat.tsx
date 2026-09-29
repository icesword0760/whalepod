/**
 * The Matou task tree seated in the official sidebar's "工作区" region
 * (registered into `sidebar.workspaces` under the stock browser's priority).
 * The DSH sidebar shell — brand, New Session, settings, collapse — stays
 * untouched; only this region's content changes. Wide renders the tree, the
 * rail renders one initial per workspace that expands the sidebar.
 */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { TaskSidebar } from './TaskSidebar.tsx'
import type { WorkbenchInjected } from './face.ts'
import { useWorkbenchActions, useWorkbenchView } from './useWorkbenchView.ts'
import css from './workbench.module.css'

export type TaskSidebarSeatProps =
  & PropsRuntime<'sidebar.workspaces'>
  & InjectFace<WorkbenchInjected>
  & PropsLocale<'matou'>

export function TaskSidebarSeat(props: TaskSidebarSeatProps) {
  const { wide, expandSidebar, t, useNotifications, markWorkspaceRead } = props
  const { view, active, org } = useWorkbenchView(props)
  const actions = useWorkbenchActions(props)
  // S5 Task 5: this seat's own read of the notification store, for the task
  // row's unread badge — a separate React subtree from AppFrame's (a
  // different framework seat), so it cannot share AppFrame's hook call; see
  // `notifications/selectors.ts`'s module doc for what this feeds.
  const notifications = useNotifications(s => s.notifications)
  // S5 Task 8 (码头 `TaskSidebar.tsx:223, 268`): the store's imperative write,
  // taken straight off the face — the narrow rail below deliberately does NOT
  // call it, because 码头's own read rule hangs on the group header and the
  // task row, neither of which the rail renders.
  if (!wide) {
    return (
      <div className={css.rail} aria-label={t('sidebar.workspaces')}>
        {view.map(workspace => (
          <button
            key={workspace.workspaceId}
            type="button"
            className={css.railItem}
            data-active={active.workspace?.workspaceId === workspace.workspaceId || undefined}
            title={workspace.title}
            onClick={() => {
              expandSidebar()
              actions.navigate({ workspaceId: workspace.workspaceId })
            }}
          >
            {workspace.title.slice(0, 1).toUpperCase()}
          </button>
        ))}
      </div>
    )
  }
  return (
    <TaskSidebar
      view={view}
      active={active}
      degraded={org.phase === 'error'}
      t={t}
      actions={actions}
      onAddWorkspace={() => { void actions.addWorkspace() }}
      notifications={notifications}
      markWorkspaceRead={markWorkspaceRead}
    />
  )
}
