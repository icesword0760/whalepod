import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImportCatalog, messagesOf, parseRows } from '../src/import/catalog.ts'
import { appendImported, MatouImportService } from '../src/import/service.ts'
import { Session } from '@deepseek-ai/dsh-session'
import { Context } from '@deepseek-ai/cordis'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'matou-import-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'project'); const other = join(root, 'other'); const claude = join(root, 'claude'); const codex = join(root, 'codex')
  const folder = join(claude, cwd.replace(/[^A-Za-z0-9]/g, '-'))
  await Promise.all([cwd, other, folder, codex].map(p => mkdir(p, { recursive: true })))
  const catalog = new ImportCatalog({ claude, codex })
  return { root, cwd, other, folder, codex, catalog }
}
const claudeRow = (cwd: string, text = 'hello') => ({ type: 'user', cwd, uuid: 'u1', message: { role: 'user', content: text } })
async function ready(catalog: ImportCatalog, cwd: string) {
  for (let i = 0; i < 500; i++) { const state = await catalog.list(cwd); if (!state.scanning) return state; await new Promise(r => setTimeout(r, 5)) }
  throw new Error('scan timed out')
}
describe('local import catalog', () => {
  it('returns initial state immediately and isolates the exact workspace', async () => {
    const f = await fixture()
    await writeFile(join(f.folder, 'one.jsonl'), JSON.stringify(claudeRow(f.cwd)))
    await writeFile(join(f.folder, 'other.jsonl'), JSON.stringify(claudeRow(f.other)))
    expect((await f.catalog.list(f.cwd)).scanning).toBe(true)
    const index = await ready(f.catalog, f.cwd)
    expect(index.entries).toHaveLength(1)
    expect(index.entries[0]!.summary.title).toBe('hello')
    expect(index.entries[0]!.summary.id).toMatch(/^[a-f0-9]{64}$/)
    expect((await f.catalog.detail(f.cwd, index.entries[0]!.summary.id)).messages).toEqual([{ role: 'user', text: 'hello' }])
    await expect(f.catalog.detail(f.other, index.entries[0]!.summary.id)).rejects.toThrow('记录已变化')
  })
  it('reads Codex response items once, ignores event duplicates and system/tool content', async () => {
    const rows = [
      { type: 'event_msg', payload: { type: 'user_message', message: 'hello' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] } },
      { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: 'echo test' } },
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: 'hidden' } },
    ]
    expect(messagesOf(rows, 'codex')).toEqual([{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'answer' }])
    const f = await fixture(); await writeFile(join(f.codex, 'rollout.jsonl'), [{ type: 'session_meta', payload: { cwd: f.cwd } }, ...rows].map(r => JSON.stringify(r)).join('\n'))
    const index = await ready(f.catalog, f.cwd); expect(index.entries).toHaveLength(1)
    expect((await f.catalog.detail(f.cwd, index.entries[0]!.summary.id)).messages).toHaveLength(2)
  })
  it('skips symlinks, nested sidechain and duplicate Claude events', async () => {
    const f = await fixture(); const external = join(f.root, 'external.jsonl'); await writeFile(external, JSON.stringify(claudeRow(f.cwd)))
    await symlink(external, join(f.folder, 'link.jsonl'))
    expect((await ready(f.catalog, f.cwd)).entries).toHaveLength(0)
    expect(messagesOf([claudeRow(f.cwd), claudeRow(f.cwd), { ...claudeRow(f.cwd), uuid: 'u2', isSidechain: true }], 'claude')).toHaveLength(1)
  })
  it('invalidates changed summaries and rejects incomplete import without silently trimming it', async () => {
    const f = await fixture(); const file = join(f.folder, 'one.jsonl')
    await writeFile(file, JSON.stringify(claudeRow(f.cwd)))
    let index = await ready(f.catalog, f.cwd)
    const id = index.entries[0]!.summary.id
    await writeFile(file, JSON.stringify(claudeRow(f.cwd, 'updated title')) + '\n{broken')
    await f.catalog.list(f.cwd, true); index = await ready(f.catalog, f.cwd)
    expect(index.entries[0]!.summary.title).toBe('updated title')
    await expect(f.catalog.detail(f.cwd, id)).rejects.toThrow('来源记录不完整')
    expect(parseRows('{broken\n{}')).toEqual([{}])
  })
  it('prepares replayable positive closed-turn history, not runnable tools or pending input', () => {
    const session = Session.create('test' as never)
    appendImported(session, [{ role: 'user', text: 'Hi' }, { role: 'assistant', text: 'Hello' }], 'codex', 'source')
    const events = session.snapshotEvents()
    expect(events.filter(e => e.type === 'assistant/message')[0]!.data).toMatchObject({ turn: 1, step: 1 })
    expect(events[0]?.type).toBe('turn/start')
    expect(events.at(-1)?.type).toBe('turn/end')
    expect(() => Session.create('restored' as never, events)).not.toThrow()
  })
  it('retries a failed durability checkpoint without appending duplicate messages', async () => {
    const f = await fixture(); await writeFile(join(f.folder, 'one.jsonl'), JSON.stringify(claudeRow(f.cwd)))
    const index = await ready(f.catalog, f.cwd)
    const session = Session.create('target' as never, undefined, { ...Session.create('target' as never).header, cwd: f.cwd })
    let flushes = 0
    const ctx = new Context(); cleanup.push(() => ctx.fiber.dispose())
    ctx.provide('sessions', { flush: async () => { if (++flushes === 1) throw new Error('disk busy'); return true } })
    ctx.provide('workspaceRegistry', { list: () => [{ title: 'project', path: f.cwd, sessionIds: ['target'] }] })
    const agent = { session, inbox: { nextTurn: [], nextStep: [] }, runMaintenance: (job: (signal: AbortSignal) => unknown) => job(new AbortController().signal) }
    ctx.provide('sessionController', { inspect: async () => ({ meta: session.header, events: session.snapshotEvents() }), resolveAgent: async () => ({ agent }), rename: async ({ title }: { title: string }) => { session.append('session/title', { title, messageSeqs: [], source: { kind: 'user' } }); return { title, seq: 1 } } })
    await ctx.plugin(MatouImportService)
    ;(ctx.matouImport as any).catalog = f.catalog
    const request = { action: 'import' as const, sessionId: 'target', id: index.entries[0]!.summary.id }
    await expect(ctx.matouImport.request(request)).rejects.toThrow('disk busy')
    expect((await ctx.matouImport.request(request)).imported).toBe(true)
    expect(session.snapshotEvents().filter(e => e.type === 'user/message')).toHaveLength(1)
    expect(session.snapshotEvents().find(e => e.type === 'session/title')?.data).toMatchObject({ title: 'hello' })
    await expect(ctx.matouImport.request(request)).rejects.toThrow('已有对话内容')
  })
  it('keeps a 600-file catalog warm and retains only metadata between reads', async () => {
    const f = await fixture()
    for (let start = 0; start < 600; start += 30) await Promise.all(Array.from({ length: 30 }, (_, n) => writeFile(join(f.folder, `load-${start + n}.jsonl`), JSON.stringify(claudeRow(f.cwd, `load ${start + n}`)))))
    const large = join(f.folder, 'large.jsonl'); await writeFile(large, JSON.stringify(claudeRow(f.cwd, 'large record')) + '\n')
    const handle = await open(large, 'a'); await handle.truncate(40 * 1024 * 1024); await handle.close()
    const started = performance.now(); const index = await ready(f.catalog, f.cwd); const coldMs = performance.now() - started
    expect(index.entries).toHaveLength(601)
    const warmStarted = performance.now()
    for (let i = 0; i < 100; i++) expect((await f.catalog.list(f.cwd)).entries).toBe(index.entries)
    console.log(JSON.stringify({ benchmark: '601 files / 100 warm reads', coldMs: Math.round(coldMs), warm100Ms: Math.round(performance.now() - warmStarted) }))
    const entry = index.entries.find(e => e.summary.title === 'large record')!
    await expect(f.catalog.detail(f.cwd, entry.summary.id)).rejects.toThrow('来源记录不完整')
  })

})

it('finds the latest Claude ai-title beyond the header and after a giant attachment line',async()=>{
  const f=await fixture();const file=join(f.folder,'title.jsonl')
  const rows=[claudeRow(f.cwd,'<command-name>/model</command-name>'),{type:'ai-title',aiTitle:'旧标题'},
    {type:'attachment',data:'x'.repeat(900000)},
    {...claudeRow(f.cwd,'真正的用户问题'),uuid:'u2'},
    {type:'ai-title',aiTitle:'视频选题和播放量分析'}]
  await writeFile(file,rows.map(r=>JSON.stringify(r)).join('\n'))
  const state=await ready(f.catalog,f.cwd)
  expect(state.entries[0]?.summary).toMatchObject({title:'视频选题和播放量分析',snippet:'真正的用户问题'})
  await writeFile(file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n'+JSON.stringify({type:'ai-title',aiTitle:'新标题'}))
  await f.catalog.list(f.cwd,true)
  expect((await ready(f.catalog,f.cwd)).entries[0]?.summary.title).toBe('新标题')
})
it('uses an explicit Claude custom title ahead of an AI title and excludes CLI records from fallback',async()=>{
  const f=await fixture()
  await writeFile(join(f.folder,'custom.jsonl'),[claudeRow(f.cwd,'/model'),{type:'custom-title',customTitle:'手动命名'}, {type:'ai-title',aiTitle:'自动命名'}].map(r=>JSON.stringify(r)).join('\n'))
  await writeFile(join(f.folder,'fallback.jsonl'),[claudeRow(f.cwd,'<local-command-stdout>ok</local-command-stdout>'), {...claudeRow(f.cwd,'编写发布检查清单'),uuid:'real'}].map(r=>JSON.stringify(r)).join('\n'))
  expect((await ready(f.catalog,f.cwd)).entries.map(e=>e.summary.title).sort()).toEqual(['手动命名','编写发布检查清单'].sort())
})

it('uses Codex session-index names and skips injected bootstrap messages in title fallback',async()=>{
 const f=await fixture()
 const rows=[{type:'session_meta',payload:{cwd:f.cwd,id:'codex-session'}},
  {type:'response_item',payload:{type:'message',role:'user',content:'# AGENTS.md instructions for /project'}},
  {type:'response_item',payload:{type:'message',role:'user',content:'处理第六集配音'}}]
 await writeFile(join(f.codex,'rollout.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n'))
 await writeFile(join(f.root,'session_index.jsonl'),JSON.stringify({id:'codex-session',thread_name:'第六集配音制作'})+'\n')
 const index=await ready(f.catalog,f.cwd)
 expect(index.entries[0]?.summary).toMatchObject({title:'第六集配音制作',snippet:'处理第六集配音'})
})
