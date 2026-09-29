import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session, SessionId, UserMessage, SessionEventMap } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { ImportCatalog } from './catalog.ts'
import { importRequestSchema } from './wire.ts'
import type { ImportRequest, ImportResult, ImportMessage } from './wire.ts'

declare module '@deepseek-ai/cordis' { interface Context { matouImport: MatouImportService } }
/** Replay closed historical turns; no model call, tool or inbox work is scheduled. */
export function appendImported(session: Session, messages: ImportMessage[], source: string, id: string): void {
  const messageId = () => randomUUID() as UserMessage['id']
  let turn = session.snapshotEvents().reduce((max, event) => event.type === 'turn/start' ? Math.max(max, event.data.turn) : max, 0)
  let step = 0, openTurn = false, openStep = false
  const closeStep = () => { if (openStep) { session.append('step/end', { turn, step }); openStep = false } }
  const closeTurn = () => { if (openTurn) { closeStep(); session.append('turn/end', { turn, reason: { kind: 'completed' } }); openTurn = false } }
  for (const message of messages) {
    if (message.role === 'user') closeTurn()
    if (!openTurn) { turn++; step = 0; session.append('turn/start', { turn }); openTurn = true }
    if (!openStep) { step++; session.append('step/start', { turn, step }); openStep = true }
    if (!session.snapshotEvents().some(e => e.type === 'system/message')) session.append('system/message', { turn, step, message: { id: messageId(), role: 'system', content: [{ type: 'text', text: '' }], source: { kind: 'plugin', plugin: 'dsh-plugin-matou-layout' } } }, { surfaceOp: 'append' })
    const content = [{ type: 'text' as const, text: message.text }]
    if (message.role === 'user') session.append('user/message', { id: messageId(), role: 'user', source: { kind: 'user' }, content }, { surfaceOp: 'append' })
    else {
      const data: SessionEventMap['assistant/message'] = { turn, step, message: { id: messageId(), role: 'assistant', content, source: { kind: 'model', provider: `import:${source}`, model: id } }, stream: [] }
      session.append('assistant/message', data, { surfaceOp: 'append' })
      closeStep()
    }
  }
  closeTurn()
}
export class MatouImportService extends TypertRemoteService {
  static inject = ['sessionController', 'workspaceRegistry', 'sessions']
  private catalog = new ImportCatalog()
  // Pending durability retries only; successful operations release retained state.
  private pending = new Map<string, { id: string; count: number }>()
  constructor(ctx: Context) { super(ctx, 'matouImport') }
  @Remote('request')
  async request(input: ImportRequest): Promise<ImportResult> {
    try { return await this.execute(importRequestSchema.parse(input)) }
    catch (e) { throw new RemoteError('gateway/bad-request', e instanceof Error ? e.message : '导入失败，请重试', {}) }
  }
  private async execute(input: ImportRequest): Promise<ImportResult> {
    const sessionId = input.sessionId as SessionId
    const inspection = await this.ctx.sessionController.inspect(sessionId)
    const workspace = this.ctx.workspaceRegistry.list().find(w => w.sessionIds.includes(sessionId))
    if (!workspace || !inspection.meta.cwd || await realpath(workspace.path) !== await realpath(inspection.meta.cwd)) throw new Error('当前会话未关联到有效项目空间')
    const result: ImportResult = { workspace: workspace.title, path: workspace.path, items: [], total: 0, scanning: false, warning: '', messages: [], messageCount: 0, imported: false }
    const pending = this.pending.get(sessionId)
    if (!pending && inspection.events.some(e => e.type === 'user/message' || e.type === 'assistant/message')) throw new Error('当前会话已有对话内容，请使用空白会话导入')
    if (input.action === 'list') {
      const index = await this.catalog.list(workspace.path, input.refresh)
      const q = (input.query ?? '').trim().toLocaleLowerCase()
      const entries = index.entries.filter(e => (!input.source || input.source === 'all' || e.summary.source === input.source) && (!q || `${e.summary.title}\n${e.summary.snippet}`.toLocaleLowerCase().includes(q)))
      result.items = entries.slice((input.page ?? 0) * 30, ((input.page ?? 0) + 1) * 30).map(e => e.summary)
      result.total = entries.length; result.scanning = index.scanning; result.warning = index.warning
      return result
    }
    if (!input.id) throw new Error('请先选择来源会话')
    if (input.action === 'preview') {
      Object.assign(result, await this.catalog.preview(workspace.path, input.id, input.previewPage, input.previewVersion))
      return result
    }
    const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw resolved.error
    const agent = resolved.agent
    return agent.runMaintenance(async signal => {
      if (pending) {
        if (pending.id !== input.id) throw new Error('上次导入等待保存，请重试同一条记录')
        if (!await this.ctx.sessions.flush(agent.session)) throw new Error('会话存储未就绪，请重试保存')
        this.pending.delete(sessionId)
        return { ...result, imported: true, messageCount: pending.count }
      }
      const detail = await this.catalog.detail(workspace.path, input.id!)
      signal.throwIfAborted()
      if (agent.inbox.nextTurn.length || agent.inbox.nextStep.length || agent.session.snapshotEvents().some(e => e.type === 'user/message' || e.type === 'assistant/message')) throw new Error('当前会话已有内容或待发送消息，请使用空白会话导入')
      // Validate the complete batch on a detached copy before publishing anything.
      const Constructor = agent.session.constructor as typeof Session
      const detached = Constructor.create(sessionId, agent.session.snapshotEvents())
      appendImported(detached, detail.messages, detail.entry.summary.source, input.id!)
      await this.ctx.sessionController.rename({ sessionId, title: detail.entry.summary.title })
      appendImported(agent.session, detail.messages, detail.entry.summary.source, input.id!)
      this.pending.set(sessionId, { id: input.id!, count: detail.messages.length })
      if (!await this.ctx.sessions.flush(agent.session)) throw new Error('导入记录等待保存，请点击重试')
      this.pending.delete(sessionId)
      return { ...result, imported: true, messageCount: detail.messages.length }
    })
  }
}
