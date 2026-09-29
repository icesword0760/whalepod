/** Capture entries during drop, then read directories in bounded batches. */
export interface SkillFile { file: File; path: string }
const LIMIT_BYTES = 8 * 1024 * 1024
export async function collectSkillDrop(data: Pick<DataTransfer, 'items' | 'files'>): Promise<SkillFile[]> {
  // DataTransfer becomes protected after the event; capture everything before awaiting.
  const entries = Array.from(data.items ?? []).filter(item => item.kind === 'file').map(item => ({
    entry: item.webkitGetAsEntry?.(), file: item.getAsFile(),
  }))
  const fallback = Array.from(data.files)
  const result: SkillFile[] = []
  let bytes = 0
  const add = (file: File, path: string) => {
    bytes += file.size
    if (result.length >= 256 || bytes > LIMIT_BYTES) throw new Error('技能包最多 256 个文件，总大小 8 MB')
    result.push({ file, path })
  }
  const walk = async (entry: FileSystemEntry, parent: string, depth: number): Promise<void> => {
    if (depth > 32) throw new Error('技能文件夹层级过深')
    const path = parent + entry.name
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
      add(file, path)
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      // Chromium can return only 100 entries per batch. Read through the empty batch.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
        if (!batch.length) break
        for (const child of batch) await walk(child, path + '/', depth + 1)
      }
    }
  }
  try {
    if (entries.length) {
      for (const item of entries) {
        if (item.entry) await walk(item.entry, '', 0)
        else if (item.file) add(item.file, item.file.webkitRelativePath || item.file.name)
      }
    } else for (const file of fallback) add(file, file.webkitRelativePath || file.name)
  } catch (error) {
    if (error instanceof DOMException) throw new Error('读取技能文件夹失败，请确认文件仍在原位置且可读取，然后重新拖入或点击“选择文件夹”。')
    throw error
  }
  if (!result.length) throw new Error('文件夹为空，请选择包含 SKILL.md 的技能文件夹')
  return result
}
