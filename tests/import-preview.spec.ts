import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImportCatalog } from '../src/import/catalog.ts'
const cleanup: string[] = []
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }) })
async function fixture(source: 'claude' | 'codex' = 'claude') {
  const root = await mkdtemp(join(tmpdir(), 'import-preview-')); cleanup.push(root)
  const cwd = join(root, 'project'), claude = join(root, 'claude'), codex = join(root, 'codex')
  await Promise.all([cwd, claude, codex].map(p => mkdir(p)))
  const file = join(source === 'claude' ? claude : codex, 'history.jsonl')
  return { cwd, file, catalog: new ImportCatalog({ claude, codex }, null) }
}
async function ready(catalog: ImportCatalog, cwd: string) {
  for (let i = 0; i < 1000; i++) { const value = await catalog.list(cwd); if (!value.scanning) return value; await new Promise(r => setTimeout(r, 5)) }
  throw Error('scan timeout')
}
const row = (cwd: string, n: number, text: string, timestamp = '2026-09-25T09:00:00Z') => ({ cwd, uuid: String(n), timestamp, message: { role: n % 2 ? 'assistant' : 'user', content: text } })
it('views and imports a >32MB transcript containing image data without sending the image to the UI', async () => {
  const f = await fixture()
  await writeFile(f.file, JSON.stringify(row(f.cwd, 0, 'first')) + '\n')
  for (let n = 1; n <= 34; n++) await appendFile(f.file, JSON.stringify({ type: 'attachment', data: 'x'.repeat(1024 * 1024) }) + '\n')
  await appendFile(f.file, JSON.stringify(row(f.cwd, 1, 'latest answer')) + '\n')
  const id = (await ready(f.catalog, f.cwd)).entries[0]!.summary.id
  const preview = await f.catalog.preview(f.cwd, id)
  expect(preview.messages.map(m => m.text)).toEqual(['first', 'latest answer'])
  expect((await f.catalog.detail(f.cwd, id)).messages).toHaveLength(2)
})
it('pages every character of long messages, defaults to latest, and detects a changed snapshot', async () => {
  const f = await fixture(), long = '长🙂'.repeat(100000)
  await writeFile(f.file, [row(f.cwd, 0, 'old'), row(f.cwd, 1, long), row(f.cwd, 2, 'new')].map(r => JSON.stringify(r)).join('\n'))
  const id = (await ready(f.catalog, f.cwd)).entries[0]!.summary.id
  const latest = await f.catalog.preview(f.cwd, id)
  expect(latest.previewPage).toBe(latest.previewPages - 1)
  expect(latest.messages.at(-1)?.text).toBe('new')
  let text = ''
  for (let page = 0; page < latest.previewPages; page++) {
    const result = await f.catalog.preview(f.cwd, id, page, latest.previewVersion)
    expect(result.messages.length).toBeLessThanOrEqual(20)
    expect(result.messages.every(m => m.text.length <= 12000)).toBe(true)
    text += result.messages.map(m => m.text).join('')
  }
  expect(text).toBe('old' + long + 'new')
  await appendFile(f.file, '\n' + JSON.stringify(row(f.cwd, 3, 'appended')))
  await expect(f.catalog.preview(f.cwd, id, 0, latest.previewVersion)).rejects.toThrow('已更新')
  expect((await f.catalog.preview(f.cwd, id)).messages.at(-1)?.text).toBe('appended')
})
it.each(['claude', 'codex'] as const)('uses latest actual conversation and message time for %s, not title or file modification time', async source => {
  const f = await fixture(source)
  const rows = [row(f.cwd, 0, 'first', '2026-09-24T08:00:00Z'), row(f.cwd, 1, 'latest', '2026-09-25T09:00:00Z'), row(f.cwd, 2, '<command-name>/model</command-name>', '2026-09-25T10:00:00Z')]
  const records = source === 'claude' ? [...rows, { type: 'ai-title', aiTitle: 'new title', timestamp: '2026-09-26T10:00:00Z' }] : [{ type: 'session_meta', payload: { cwd: f.cwd } }, ...rows.map(r => ({ type: 'response_item', timestamp: r.timestamp, payload: { type: 'message', ...r.message } }))]
  await writeFile(f.file, records.map(r => JSON.stringify(r)).join('\n'))
  expect((await ready(f.catalog, f.cwd)).entries[0]?.summary).toMatchObject({ snippet: 'latest', updatedAt: Date.parse('2026-09-25T09:00:00Z') })
})
it('shows complete valid text with a warning while a trailing record is unfinished', async () => {
  const f = await fixture(); await writeFile(f.file, JSON.stringify(row(f.cwd, 0, 'complete')) + '\n{"partial":')
  const id = (await ready(f.catalog, f.cwd)).entries[0]!.summary.id
  expect(await f.catalog.preview(f.cwd, id)).toMatchObject({ messages: [{ text: 'complete' }], messageCount: 1, warning: expect.stringContaining('尚未写完整') })
  await expect(f.catalog.detail(f.cwd, id)).rejects.toThrow('记录不完整')
})
