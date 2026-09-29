import { open, realpath } from 'node:fs/promises'
import { sep } from 'node:path'
/** Keep only one JSONL record in memory, never the complete transcript. Byte ranges
 * let preview pages read just their records after the initial metadata scan. */
export async function* records(file: string, root: string) {
  const actual = await realpath(file)
  if (!actual.startsWith(root + sep)) throw new Error('记录路径已变化，请重新扫描')
  const handle = await open(actual, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile() || !before.size) return
    const stream = handle.createReadStream({ start: 0, end: before.size - 1, highWaterMark: 64 * 1024, autoClose: false })
    let parts: Buffer[] = [], size = 0, offset = 0
    const finish = (end: Buffer) => {
      const length = size + end.length
      const text = (parts.length ? Buffer.concat([...parts, end], length) : end).toString('utf8')
      const start = offset; offset += length + 1; parts = []; size = 0
      let row: Record<string, unknown> | undefined
      try { const value: unknown = JSON.parse(text); if (value && typeof value === 'object' && !Array.isArray(value)) row = value as Record<string, unknown> } catch { /* report incomplete lines to the caller */ }
      return { row, start, length, blank: !text.trim() }
    }
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); let start = 0
      for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
        yield finish(bytes.subarray(start, end)); start = end + 1
      }
      if (start < bytes.length) { const rest = Buffer.from(bytes.subarray(start)); parts.push(rest); size += rest.length }
    }
    if (size) yield finish(Buffer.alloc(0))
    const after = await handle.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('来源会话正在变化，请重新扫描后重试')
  } finally { await handle.close() }
}
