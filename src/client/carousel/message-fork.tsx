import { useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { OrgMirrorState } from '../org/store.ts'
import type { WorkbenchActions } from '../workbench/actions.ts'
import { RenameDialog } from '../workbench/dialogs.tsx'
import { validateUniqueName } from '../org/naming.ts'
import { placementsBySessionOf, projectCarouselNodes } from './nodes.ts'

export const MESSAGE_FORK_EVENT = 'dsh:conversation-fork-request'
export interface MessageForkTarget { sessionId: string; atSeq: number }
export function messageForkTarget(value: unknown): MessageForkTarget | undefined {
  if (typeof value !== 'object' || value === null) return
  const target = value as Partial<MessageForkTarget>
  if (typeof target.sessionId !== 'string' || !target.sessionId || !Number.isSafeInteger(target.atSeq) || target.atSeq! < 0) return
  return { sessionId: target.sessionId, atSeq: target.atSeq! }
}
interface PanelProps {
  state: HostObservable<MessageForkTarget | null>
  close(): void
  validate(target: MessageForkTarget, name: string): string | undefined
  submit(target: MessageForkTarget, name: string): Promise<void>
}
export function MessageForkPanel(props: PanelProps) {
  const target = useSyncExternalStore(props.state.subscribe, props.state.getSnapshot)
  return <RenameDialog key={target ? `${target.sessionId}:${target.atSeq}` : 'closed'}
    open={target !== null} title="从这条回答创建子分支" initial="" fieldLabel="分支名称"
    cancelLabel="取消" confirmLabel="创建子分支" closeLabel="关闭"
    validate={name => target ? props.validate(target, name) : '请选择一条回答'}
    onSubmit={async name => { if (target) await props.submit(target, name) }} onClose={props.close} />
}

/** The stock message entry delegates only while this layout is active. */
export function registerMessageFork(ctx: Context, org: HostObservable<OrgMirrorState>, actions: WorkbenchActions): void {
  let target: MessageForkTarget | null = null
  let pending = false
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }
  const close = () => { if (!pending) { target = null; notify() } }
  const validate = (request: MessageForkTarget, name: string): string | undefined => {
    const list = ctx.sessions.list.getSnapshot()
    const source = list.byId[request.sessionId as SessionId]
    if (!source || source.blank) return '源会话尚未就绪，请稍后再试'
    if (source.running) return '源会话运行中，请结束后再创建分支'
    const nodes = projectCarouselNodes({ ids: list.ids, summaryOf: id => list.byId[id as SessionId],
      placementsBySession: placementsBySessionOf(org.getSnapshot().org.placements), archivedIds: ctx.workspaces.list.getSnapshot().archivedSessionIds })
    const titles = nodes.filter(node => node.parentId === request.sessionId).map(node => list.byId[node.sessionId as SessionId]?.displayTitle ?? '')
    return validateUniqueName(name, titles, { empty: '请输入分支名称', duplicate: '同一层级内已有同名会话' })
      ?? (name.trim().length > 64 ? '名称请控制在 64 个字符以内' : undefined)
  }
  const face: PanelProps = {
    state: { getSnapshot: () => target, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } }, close, validate,
    submit: async (request, name) => {
      if (pending) return
      const error = validate(request, name)
      if (error) throw new Error(error)
      pending = true
      try { await actions.forkChild(request.sessionId, name, request.atSeq) }
      catch (error) { console.error('matou message fork failed', error); throw new Error('创建分支失败，请重试') }
      finally { pending = false }
    },
  }
  ctx.effect(() => {
    const listener = (event: Event) => {
      const request = messageForkTarget((event as CustomEvent<unknown>).detail)
      if (!request || !event.cancelable) return
      event.preventDefault()
      if (pending || target !== null) return
      target = request; notify()
    }
    window.addEventListener(MESSAGE_FORK_EVENT, listener)
    return () => { window.removeEventListener(MESSAGE_FORK_EVENT, listener); target = null; notify(); listeners.clear() }
  }, 'matou: message fork entry')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'matou-message-fork', order: 45, inject: () => face }, MessageForkPanel))
}
