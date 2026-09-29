import { expect, it } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import { appendImported } from '../src/import/service.ts'
import { messagesOf } from '../src/import/catalog.ts'
import { releasedV3SessionFormatCodec as codec } from '../../deepseek-harness/packages/session/session-format-v2-to-v3/src/index.ts'
import { SessionFormatEventCollector } from '../../deepseek-harness/packages/session/session-format/src/index.ts'
it('round-trips imported human and assistant text through the actual DSH 0.1.5 durable codec', () => {
  const session = Session.create('import-codec' as never)
  appendImported(session, [{ role: 'user', text: 'question' }, { role: 'assistant', text: 'answer' }, { role: 'assistant', text: 'continued answer' }, { role: 'user', text: 'next question' }], 'claude', 'original')
  const events = session.snapshotEvents()
  const header = { version: 3, id: session.id, createdAt: 1, isSeeded: false, delegationDepth: 0 }
  const decoder = codec.createDecoder(codec.encodeHeader(header, 0), 'strict')
  const collector = new SessionFormatEventCollector()
  for (const event of events) decoder.decodeRow(codec.encodeEvent(event as any), collector)
  decoder.finish(collector)
  const reopened = Session.create(session.id, collector.values as any)
  expect(reopened.snapshotEvents().slice(0, events.length)).toEqual(events)
  expect(events.filter(e => e.type === 'assistant/message')).toHaveLength(2)
  expect(events.filter(e => e.type === 'turn/start').map(e => e.data)).toEqual([{ turn: 1 }, { turn: 2 }])
  expect(events.at(-1)?.type).toBe('turn/end')
})
it('excludes CLI, background notifications, bootstrap summaries and API error placeholders from dialogue', () => {
  const user = (text: string) => ({ type: 'user', message: { role: 'user', content: text } })
  const rows = [user('<command-name>/model</command-name>'), user('<task-notification>background tool output</task-notification>'), user('This session is being continued from a previous conversation that ran out of context.'), user('# AGENTS.md instructions for /project'), { isApiErrorMessage: true, message: { role: 'assistant', content: 'subscription error' } }, user('真实问题'), { message: { role: 'assistant', content: [{ type: 'text', text: '真实回答' }, { type: 'thinking', thinking: 'hidden' }] } }]
  expect(messagesOf(rows, 'claude')).toEqual([{ role: 'user', text: '真实问题' }, { role: 'assistant', text: '真实回答' }])
})
