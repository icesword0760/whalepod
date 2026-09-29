import { IconDownloadOutline16 } from '@deepseek-ai/dsh-client-ui-primitives/src/icons/index.tsx'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ImportPanel } from './ImportPanel.tsx'
import type {} from './remote.ts'
import type { ImportPanelProps } from './ImportPanel.tsx'
/** Optional command service binding: never hold up the primary layout. */
export function registerImport(ctx: Context): void {
  ctx.inject(['commandUi', 'remote.matouImport'], scope => {
    let target: string | null = null
    const listeners = new Set<() => void>()
    const close = () => { target = null; listeners.forEach(fn => fn()) }
    const face: ImportPanelProps = {
      state: { getSnapshot: () => target, subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn) } } }, close,
      request: async input => { const result = await scope.remote.matouImport.request(input); if (!result.ok) throw new Error(result.error.message); return result.value },
      completed: () => { void ctx.sessions.refresh() },
    }
    const commands = scope.get('commandUi') as { register(contribution: { name: string; icon: typeof IconDownloadOutline16; label(): string; description(): string; available(session: { sessionId: SessionId }): boolean; ui: { kind: 'action'; run(session: { sessionId: SessionId }): void } }): () => void }
    scope.effect(() => commands.register({
      name: 'import', icon: IconDownloadOutline16, label: () => '导入会话', description: () => '导入当前项目的 Claude Code / Codex 文字对话',
      available: ({ sessionId }) => { const row = ctx.sessions.list.getSnapshot().byId[sessionId]; return row?.blank === true && !row.running },
      ui: { kind: 'action', run: ({ sessionId }) => { target = sessionId; listeners.forEach(fn => fn()) } },
    }), 'matou-import: command')
    scope.slots.inject('shell.overlay', () => scope.slots.register({ name: 'shell.overlay', id: 'matou-session-import', order: 40, inject: () => face }, ImportPanel))
    scope.effect(() => () => { close(); listeners.clear() }, 'matou-import: dispose')
  })
}
