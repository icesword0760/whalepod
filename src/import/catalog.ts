/** Read-only, bounded local history catalog. No source record is ever executed. */
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { join, sep, basename, dirname } from 'node:path'
import { records } from './records.ts'
import { env } from 'node:process'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { ClaudeTitle, matouTitles, codexTitles, isUserTopic } from './titles.ts'
import type { ImportMessage, ImportSummary } from './wire.ts'
const HEADER_BYTES = 256 * 1024
const PAGE_SIZE = 20
const TEXT_CHUNK = 12000
interface Transcript { version: string; refs: { start: number; length: number; chars: number; role: ImportMessage['role'] }[]; broken: boolean; title: ClaudeTitle; latest: string; updatedAt: number; cwd?: string | undefined }
const MAX_FILES = 10000
interface Entry { summary: ImportSummary; file: string; root: string; cwd: string; providerId?:string }
interface Index { entries: Entry[]; scanning: boolean; warning: string; at: number }
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export function parseRows(text: string): Record<string, unknown>[] {
  return text.split('\n').flatMap(line => { try { return [record(JSON.parse(line))] } catch { return [] } })
}
/** Codex response_item is authoritative; event_msg duplicates are intentionally excluded. */
export function messagesOf(rows: Record<string, unknown>[], source: 'claude' | 'codex'): ImportMessage[] {
  const result: ImportMessage[] = []; const seen = new Set<string>()
  for (const row of rows) {
    if (source === 'claude' && (row.isSidechain === true || row.isMeta === true || row.isApiErrorMessage === true)) continue
    if (source === 'codex' && row.type !== 'response_item') continue
    const msg = record(source === 'claude' ? row.message : row.payload)
    if (source === 'codex' && msg.type !== 'message') continue
    if (msg.role !== 'user' && msg.role !== 'assistant') continue
    const id = source === 'claude' ? row.uuid : msg.id
    if (typeof id === 'string') { if (seen.has(id)) continue; seen.add(id) }
    const text = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content)
      ? msg.content.flatMap(block => { const b = record(block); return ['text', 'input_text', 'output_text'].includes(String(b.type)) && typeof b.text === 'string' ? [b.text] : [] }).join('\n') : ''
    if (isUserTopic(text)) result.push({ role: msg.role, text })
  }
  return result
}
function cwdOf(rows: Record<string, unknown>[], source: 'claude' | 'codex'): string | undefined {
  for (const row of rows) {
    const cwd = source === 'claude' ? row.cwd : row.type === 'session_meta' ? record(row.payload).cwd : undefined
    if (typeof cwd === 'string' && cwd.startsWith('/')) return cwd
  }
  return undefined
}
export class ImportCatalog {
  private transcripts = new Map<string, Transcript>()
  private indexes = new Map<string, Index>()
  private cache = new Map<string, Entry>()
  private foreignHeaders = new Map<string, { version: string; cwd: string }>()
  private scanTail: Promise<void> = Promise.resolve()
  private detailTail: Promise<unknown> = Promise.resolve()
  constructor(private roots = { claude: join((env as NodeJS.ProcessEnv)['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude'), 'projects'), codex: join((env as NodeJS.ProcessEnv)['CODEX_HOME'] ?? join(homedir(), '.codex'), 'sessions') }, private titleDatabase:string|null=join((env as NodeJS.ProcessEnv)['MATOU_DATA_DIR']??join(homedir(),'.matou'),'matou.sqlite')) {}
  async list(cwd: string, refresh = false): Promise<Index> {
    cwd = await realpath(cwd)
    let index = this.indexes.get(cwd)
    if (!index || (!index.scanning && (refresh || Date.now() - index.at > 60000))) {
      index = { entries: index?.entries ?? [], scanning: true, warning: '', at: Date.now() }
      this.indexes.set(cwd, index)
      // One scan per workspace; bound concurrent workspaces and retained summaries.
      if (this.indexes.size > 8) { const stale = [...this.indexes].find(([key, value]) => key !== cwd && !value.scanning); if (stale) this.indexes.delete(stale[0]) }
      const target = index
      this.scanTail = this.scanTail.then(() => this.scan(cwd, target))
    }
    return index
  }
  private async *files(root: string, depth = 0, maxDepth = 4): AsyncGenerator<string> {
    if (depth > maxDepth) return
    let entries
    try { entries = await readdir(root, { withFileTypes: true }) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e }
    for (const entry of entries) {
      if (entry.isDirectory()) yield* this.files(join(root, entry.name), depth + 1, maxDepth)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield join(root, entry.name)
    }
  }
  private async scan(cwd: string, index: Index): Promise<void> {
    const found: Entry[] = []; let count = 0; let skipped = 0
    try {
      const names=await matouTitles(this.titleDatabase,cwd)
      const codexNames=await codexTitles(dirname(this.roots.codex),cwd)
      for (const source of ['claude', 'codex'] as const) {
        const root = this.roots[source]
        const folder = root
        for await (const file of this.files(folder, 0, source === 'claude' ? 1 : 4)) {
          if (++count > MAX_FILES) { index.warning = '记录较多，本次扫描上限为 10000 个文件。'; break }
          try {
            const actual = await realpath(file); const canonicalRoot = await realpath(root)
            if (!actual.startsWith(canonicalRoot + sep)) continue
            const info = await stat(actual); const version = `${info.size}:${info.mtimeMs}`
            const foreign = this.foreignHeaders.get(actual)
            if (foreign?.version === version && foreign.cwd !== cwd) continue
            let entry = this.cache.get(actual)
            if (entry?.summary.version !== version) {
              const rows = parseRows(await this.read(actual, canonicalRoot, HEADER_BYTES))
              const recordCwd = cwdOf(rows, source)
              const canonicalCwd = recordCwd ? await realpath(recordCwd).catch(() => '') : ''
              if (canonicalCwd !== cwd) {
                this.foreignHeaders.set(actual, { version, cwd: canonicalCwd })
                if (this.foreignHeaders.size > 10000) this.foreignHeaders.delete(this.foreignHeaders.keys().next().value!)
                continue
              }
              const messages = messagesOf(rows, source)
              const transcript = await this.transcript(actual, canonicalRoot, source, version)
              const metadata = source === 'claude' ? transcript.title : undefined
              const first = metadata?.first ?? messages.find(m => m.role === 'user' && isUserTopic(m.text))?.text ?? ''
              const titleRow = rows.findLast(r => typeof r.customTitle === 'string' || typeof r.summary === 'string')
              const title = metadata?.title ?? String(titleRow?.customTitle ?? titleRow?.summary ?? first.trim().split('\n')[0] ?? '')
              entry = { file: actual, root: canonicalRoot, cwd, providerId:String(record(rows.find(r=>r.type==='session_meta')?.payload).id??''), summary: {
                id: createHash('sha256').update(actual).digest('hex'), source, title: title.slice(0, 160) || '未命名会话',
                snippet: transcript.latest, updatedAt: transcript.updatedAt || info.mtimeMs, version,
              } }
              this.cache.set(actual, entry)
              if (this.cache.size > 2048) this.cache.delete(this.cache.keys().next().value!)
            }
            if (entry.cwd === cwd) {
              const displayName=source==='claude'?names.get(basename(actual,'.jsonl')):codexNames.get(entry.providerId??'')
              found.push(displayName?{...entry,summary:{...entry.summary,title:displayName}}:entry)
            }
          } catch { skipped++ }
          // Publish partial results without retaining transcript bodies.
          if (count % 20 === 0) index.entries = [...found].sort((a, b) => b.summary.updatedAt - a.summary.updatedAt)
        }
      }
    } catch { index.warning = '部分记录目录读取失败，请检查访问权限后重新扫描。' }
    finally {
      index.entries = found.sort((a, b) => b.summary.updatedAt - a.summary.updatedAt)
      if (skipped) index.warning += ` ${skipped} 个文件读取失败，重新扫描可重试。`
      index.scanning = false; index.at = Date.now()
    }
  }
  private async transcript(file: string, root: string, source: 'claude' | 'codex', version: string): Promise<Transcript> {
    const cached = this.transcripts.get(file)
    if (cached?.version === version) return cached
    const result: Transcript = { version, refs: [], broken: false, title: new ClaudeTitle(), latest: '', updatedAt: 0 }
    const seen = new Set<string>()
    for await (const { row, start, length, blank } of records(file, root)) {
      if (!row) { if (!blank) result.broken = true; continue }
      result.title.accept(row)
      result.cwd ??= cwdOf([row], source)
      const message = messagesOf([row], source)[0]
      if (!message) continue
      const msg = record(source === 'claude' ? row.message : row.payload)
      const id = source === 'claude' ? row.uuid : msg.id
      if (typeof id === 'string') { if (seen.has(id)) continue; seen.add(id) }
      result.refs.push({ start, length, chars: message.text.length, role: message.role })
      if (isUserTopic(message.text)) {
        result.latest = message.text.replace(/\s+/g, ' ').slice(0, 160)
        const timestamp = Date.parse(String(row.timestamp ?? msg.timestamp ?? ''))
        if (Number.isFinite(timestamp)) result.updatedAt = Math.max(result.updatedAt, timestamp)
      }
    }
    const after = await stat(file)
    if (`${after.size}:${after.mtimeMs}` !== version) throw new Error('来源会话正在变化，请重新扫描后重试')
    this.transcripts.set(file, result)
    if (this.transcripts.size > 128) this.transcripts.delete(this.transcripts.keys().next().value!)
    return result
  }
  private async source(cwd: string, id: string) {
    const entry = (await this.list(cwd)).entries.find(e => e.summary.id === id)
    if (!entry) throw new Error('记录已变化，请重新扫描并选择会话')
    const info = await stat(entry.file)
    const transcript = await this.transcript(entry.file, entry.root, entry.summary.source, `${info.size}:${info.mtimeMs}`)
    if (!transcript.cwd || await realpath(transcript.cwd) !== await realpath(cwd)) throw new Error('来源不属于当前项目')
    return { entry, transcript }
  }
  private async texts(entry: Entry, transcript: Transcript, refs: Transcript['refs']) {
    const actual = await realpath(entry.file)
    if (!actual.startsWith(entry.root + sep)) throw new Error('记录路径已变化，请重新扫描')
    const handle = await open(actual, 'r')
    try {
      const check = async () => { const info = await handle.stat(); if (`${info.size}:${info.mtimeMs}` !== transcript.version) throw new Error('来源会话已更新，请重新扫描后查看') }
      await check()
      const messages: ImportMessage[] = []
      for (const ref of refs) {
        const bytes = Buffer.alloc(ref.length); let offset = 0
        while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, ref.start + offset); if (!read.bytesRead) throw new Error('记录已变化，请重新扫描'); offset += read.bytesRead }
        const message = messagesOf([record(JSON.parse(bytes.toString('utf8')))], entry.summary.source)[0]
        if (message) messages.push(message)
      }
      await check()
      return messages
    } finally { await handle.close() }
  }
  async preview(cwd: string, id: string, page?: number, version?: string) {
    const { entry, transcript } = await this.source(cwd, id)
    if (version && version !== transcript.version) throw new Error('来源会话已更新，请重新扫描后查看最新记录')
    const total = transcript.refs.reduce((sum, ref) => sum + Math.ceil(ref.chars / TEXT_CHUNK), 0)
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
    const current = Math.min(page ?? pages - 1, pages - 1)
    const messages: (ImportMessage & { continuation?: boolean })[] = []
    let segment = 0
    for (const ref of transcript.refs) {
      const count = Math.ceil(ref.chars / TEXT_CHUNK)
      if (segment < (current + 1) * PAGE_SIZE && segment + count > current * PAGE_SIZE) {
        const message = (await this.texts(entry, transcript, [ref]))[0]!
        for (let part = Math.max(0, current * PAGE_SIZE - segment); part < Math.min(count, (current + 1) * PAGE_SIZE - segment); part++) messages.push({ role: message.role, text: message.text.slice(part * TEXT_CHUNK, (part + 1) * TEXT_CHUNK), continuation: part > 0 })
      }
      segment += count
    }
    return { messages, messageCount: transcript.refs.length, previewPage: current, previewPages: pages, previewVersion: transcript.version, warning: transcript.broken ? '部分记录尚未写完整，已展示其余文字；稍后重新扫描可重试。' : '' }
  }
  private async read(file: string, root: string, limit: number): Promise<string> {
    const actual = await realpath(file)
    if (!actual.startsWith(root + sep)) throw new Error('记录路径已变化，请重新扫描')
    const handle = await open(actual, 'r')
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw new Error('来源记录不是文件')
      const buffer = Buffer.alloc(Math.min(info.size, limit)); let offset = 0
      while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) break; offset += bytesRead }
      return buffer.subarray(0, offset).toString('utf8')
    } finally { await handle.close() }
  }
  detail(cwd: string, id: string): Promise<{ entry: Entry; messages: ImportMessage[] }> {
    const task = this.detailTail.then(() => this.readDetail(cwd, id))
    this.detailTail = task.catch(() => {})
    return task
  }
  private async readDetail(cwd: string, id: string): Promise<{ entry: Entry; messages: ImportMessage[] }> {
    const { entry, transcript } = await this.source(cwd, id)
    if (transcript.broken) throw new Error('来源记录不完整，请等待写入结束后重试')
    if (!transcript.refs.length) throw new Error('这条记录没有可导入的文字对话')
    if (transcript.refs.length > 5000 || transcript.refs.reduce((sum, ref) => sum + ref.chars, 0) > 8 * 1024 * 1024) throw new Error('全文可分页查看；本次文字量超过导入上限（5000 条或 8 MB）')
    const messages = await this.texts(entry, transcript, transcript.refs)
    return { entry, messages }
  }
}
