import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives/src/Modal.tsx'
import type { ImportRequest, ImportResult, ImportSummary } from '../../import/wire.ts'
import css from './import.module.css'
export interface ImportPanelProps {
  state: { subscribe(fn: () => void): () => void; getSnapshot(): string | null }
  close(): void
  request(input: ImportRequest): Promise<ImportResult>
  completed(): void
}
const sourceName = (source: string) => source === 'claude' ? 'Claude Code' : 'Codex'
export function ImportPanel(props: ImportPanelProps) {
  const sessionId = useSyncExternalStore(props.state.subscribe, props.state.getSnapshot)
  return sessionId ? <OpenPanel key={sessionId} {...props} sessionId={sessionId} /> : null
}
function OpenPanel({ sessionId, request, close, completed }: ImportPanelProps & { sessionId: string }) {
  const [query, setQuery] = useState(''); const [search, setSearch] = useState('')
  const [source, setSource] = useState<'all' | 'claude' | 'codex'>('all')
  const [page, setPage] = useState(0); const [refresh, setRefresh] = useState(0)
  const [data, setData] = useState<ImportResult>(); const [selected, setSelected] = useState<ImportSummary>()
  const [previewPage, setPreviewPage] = useState<number>(); const previewVersion = useRef<string | undefined>(undefined)
  const [preview, setPreview] = useState<ImportResult>(); const [error, setError] = useState('')
  const [previewError, setPreviewError] = useState(''); const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false); const [commitError, setCommitError] = useState('')
  const panel = useRef<HTMLDivElement>(null); const searchBox = useRef<HTMLInputElement>(null)
  const busyRef = useRef(false); const firstRefresh = useRef(-1)
  useEffect(() => { const timer = setTimeout(() => { setSearch(query.trim()); setPage(0) }, 200); return () => clearTimeout(timer) }, [query])
  useEffect(() => {
    let alive = true; let timer: ReturnType<typeof setTimeout>
    setLoading(true); setError('')
    const scan = async (force = false) => {
      try {
        const rescan = firstRefresh.current !== refresh; firstRefresh.current = refresh
        const result = await request({ action: 'list', sessionId, query: search, source, page, refresh: force || rescan })
        if (!alive) return
        setData(result); setLoading(false)
        timer = setTimeout(() => { void scan(!result.scanning) }, result.scanning ? 700 : 15000)
      } catch (e) { if (alive) { setError(e instanceof Error ? e.message : '加载失败，请重试'); setLoading(false) } }
    }
    void scan()
    return () => { alive = false; clearTimeout(timer) }
  }, [request, sessionId, search, source, page, refresh])
  useEffect(() => {
    let alive = true; setPreview(undefined); setPreviewError('')
    if (selected) void request({ action: 'preview', sessionId, id: selected.id, previewPage, previewVersion: previewVersion.current }).then(result => { if (alive) { previewVersion.current = result.previewVersion; setPreview(result) } }, e => { if (alive) setPreviewError(e instanceof Error ? e.message : '预览读取失败') })
    return () => { alive = false }
  }, [request, sessionId, selected, refresh, previewPage])
  useEffect(() => {
    const root = document.getElementById('root'); const previouslyInert = root?.inert ?? false
    const previousFocus = document.activeElement as HTMLElement | null
    if (root) root.inert = true
    searchBox.current?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (!busyRef.current) close() }
      if (event.key === 'Tab') {
        const elements = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')
        const first = elements?.[0]; const last = elements?.[elements.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', keydown, true)
    return () => { if (root) root.inert = previouslyInert; document.removeEventListener('keydown', keydown, true); previousFocus?.focus() }
  }, [close])
  async function commit() {
    if (!selected || busyRef.current) return
    busyRef.current = true; setBusy(true); setCommitError('')
    try { await request({ action: 'import', sessionId, id: selected.id }); completed(); close() }
    catch (e) { setCommitError(e instanceof Error ? e.message : '导入失败，请重试') }
    finally { busyRef.current = false; setBusy(false) }
  }
  return <Modal open title="导入会话" headless className={css.modal ?? ''} onClose={() => { if (!busyRef.current) close() }}>
    <div ref={panel} className={css.panel}>
      <header><div><h2>导入会话</h2><p>把其他智能体的文字对话带入当前空白会话</p></div><button aria-label="关闭导入面板" disabled={busy} onClick={close}>×</button></header>
      <div className={css.workspace}><strong>▱ {data?.workspace ?? '当前项目'}</strong><span title={data?.path}>{data?.path ?? '正在读取项目空间…'}</span><small>仅当前项目</small></div>
      <div className={css.columns}>
        <section className={css.listPane} aria-label="来源会话">
          <input ref={searchBox} aria-label="搜索会话" placeholder="搜索标题或最新消息" maxLength={200} value={query} disabled={busy} onChange={e => setQuery(e.target.value)} />
          <div className={css.filters}>{(['all', 'claude', 'codex'] as const).map(value => <button key={value} aria-pressed={source === value} disabled={busy} onClick={() => { setSource(value); setPage(0) }}>{value === 'all' ? '全部' : sourceName(value)}</button>)}</div>
          <div className={css.listMeta}><span aria-live="polite">{data?.scanning ? '正在扫描…' : `${data?.total ?? 0} 个会话 · 最近更新`}</span><button disabled={busy || data?.scanning} onClick={() => { setPage(0); setPreviewPage(undefined); previewVersion.current = undefined; setRefresh(n => n + 1) }}>重新扫描</button></div>
          {error && <p role="alert" className={css.error}>{error}</p>}
          {data?.warning && <p className={css.warning}>{data.warning}</p>}
          <div className={css.list} aria-busy={loading}>
            {loading ? <p className={css.empty}>正在加载会话…</p> : !data?.items.length ? <p className={css.empty}>{data?.scanning ? '正在查找当前项目的记录…' : search ? '没有匹配的会话，试试其他关键词' : '当前项目暂无可导入的会话'}</p> : data.items.map(item => <button key={item.id} className={css.row} aria-pressed={selected?.id === item.id} disabled={busy} onClick={() => { setPreviewPage(undefined); previewVersion.current = undefined; setSelected(item); setCommitError('') }}>
              <span className={css.sourceIcon}>{item.source === 'claude' ? '✳' : '⌘'}</span><span className={css.rowText}><strong>{item.title}</strong><small>{sourceName(item.source)} · {new Date(item.updatedAt).toLocaleString()}</small><span>{item.snippet || '选择后查看文字记录'}</span></span><span>{selected?.id === item.id ? '●' : '○'}</span>
            </button>)}
          </div>
          <nav className={css.pagination} aria-label="会话分页"><button disabled={busy || loading || page === 0} onClick={() => setPage(n => n - 1)}>上一页</button><span>{page + 1} / {Math.max(1, Math.ceil((data?.total ?? 0) / 30))}</span><button disabled={busy || loading || (page + 1) * 30 >= (data?.total ?? 0)} onClick={() => setPage(n => n + 1)}>下一页</button></nav>
        </section>
        <section className={css.preview} aria-label="对话预览">
          {!selected ? <div className={css.empty}><h3>选择一个会话</h3><p>在这里预览对话，再导入当前卡片</p></div> : <><h3>{selected.title}</h3><p className={css.subtle}>{sourceName(selected.source)}{preview ? ` · ${preview.messageCount} 条文字消息` : ''}</p>
          {previewError ? <div><p role="alert" className={css.error}>{previewError}</p><button onClick={() => { setPreviewPage(undefined); previewVersion.current = undefined; setRefresh(n => n + 1) }}>重新读取最新记录</button></div> : !preview ? <p className={css.empty}>正在读取预览…</p> : <><nav className={css.pagination} aria-label="预览分页"><button disabled={busy || !preview.previewPage} onClick={() => setPreviewPage(0)}>最早</button><button disabled={busy || !preview.previewPage} onClick={() => setPreviewPage((preview.previewPage ?? 0) - 1)}>上一页</button><span>{(preview.previewPage ?? 0) + 1} / {preview.previewPages ?? 1}</span><button disabled={busy || (preview.previewPage ?? 0) + 1 >= (preview.previewPages ?? 1)} onClick={() => setPreviewPage((preview.previewPage ?? 0) + 1)}>下一页</button><button disabled={busy} onClick={() => { setPreviewPage(undefined); previewVersion.current = undefined; setRefresh(n => n + 1) }}>最新</button></nav>{data?.items.some(item => item.id === selected.id && item.version !== preview.previewVersion) && preview.previewVersion && <p className={css.warning}>来源记录有更新，点击“最新”查看；当前翻页位置保持不变。</p>}{preview.warning && <p className={css.warning}>{preview.warning}</p>}<div key={`${selected.id}:${preview.previewPage}:${preview.previewVersion}`} className={css.messages}>{preview.messages.map((message, index) => <article key={index} className={message.role === 'user' ? css.user : css.assistant}><small>{message.role === 'user' ? '你' : sourceName(selected.source)}{message.continuation ? ' · 接上段' : ''}</small><p>{message.text}</p></article>)}</div><p className={css.subtle}>全部文字可翻页查看，默认打开最新一页；长消息分段展示，不省略正文。</p></>}</>}
        </section>
      </div>
      <footer><div><p>导入后可继续对话，原始会话保持不变。</p><small>仅导入文字；不搬入图片、附件、工具结果或隐藏推理，不执行历史命令。</small>{commitError && <p role="alert" className={css.error}>{commitError}</p>}</div><button disabled={busy} onClick={close}>取消</button><button className={css.primary} disabled={busy || !preview || !!previewError} onClick={() => { void commit() }}>{busy ? '正在导入…' : commitError ? '重试导入' : '导入此会话'}</button></footer>
    </div>
  </Modal>
}
