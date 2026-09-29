/**
 * The DAG overlay's node search box — 码头's `dag/DagSearch.tsx:1-38`, ported
 * with the scoring lifted out into `dag/search.ts` (Task 5) and four
 * deliberate changes:
 *
 * - **The subtitle is the working directory alone.** 码头 prints
 *   `Claude Code · cwd` off a four-way `currentMode` enum
 *   (`DagSearch.tsx:36`). DSH sessions carry no provider dimension at all, so
 *   `DagNodeView` has no field to branch on and this box must never invent
 *   one; a row with no `cwd` renders no subtitle rather than a stray 「·」.
 * - **Focus on mount.** D-4 cancelled every keyboard shortcut this overlay
 *   might have had, Cmd+F included — 码头 has no auto-focus because it has the
 *   shortcut. Opening the overlay therefore has to leave the caret here, which
 *   is done with a ref in an effect rather than React's `autoFocus` attribute:
 *   the overlay portals its subtree into `document.body`, and `autoFocus` is
 *   applied at DOM-attach time, which portals make unreliable.
 * - **The 12-hit cap is applied BEFORE the arrow keys see the list.** 码头
 *   cycles the selection over every hit (`:23-27` uses `results.length`) but
 *   renders only the first twelve (`:33`), so on a broad query `↑` selects a
 *   row that is not on screen and `Enter` then navigates somewhere the user
 *   never saw. Capping once, here, keeps 「选中的」 and 「看得见的」 the same set.
 * - **The query may be lifted.** Pass `query` + `onQueryChange` to control it
 *   (T-4: the overlay's first Esc clears the query instead of closing, which
 *   it cannot do if the text lives in this component's state); omit `query`
 *   and the box owns it exactly as 码头's does. `onQueryChange` fires either
 *   way, so an uncontrolled owner can still watch for 「查询非空」.
 *
 * The 「先 onPreview、下一帧 onChoose」 commit is 码头's, unchanged
 * (`:15-18`): previewing pans the canvas onto the chosen card, and deferring
 * the commit by a frame lets the user actually see which card they landed on
 * before the overlay closes over it. Both handlers come from the canvas
 * (`DagCanvas.tsx`'s `DagCanvasSearchHandlers`).
 *
 * No shortcut is registered anywhere: `↑`/`↓`/`Enter` are handled on the input
 * itself, which spec §4 asks for and D-4 explicitly exempts — they are
 * in-field navigation, not global key bindings. `Esc` is deliberately NOT
 * handled here; the overlay owns it in the capture phase (T-4), and its
 * `preventDefault` also suppresses the browser's native 「Esc 清空 type=search」
 * so the two never disagree.
 * @module dsh-plugin-matou-layout/src/client/dag/DagSearch
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import clsx from 'clsx'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { MatouKey } from '../locales.ts'
import type { DagNodeView } from './graph.ts'
import { searchGraph } from './search.ts'
import css from './dag.module.css'

/** How many hits the panel ever shows — 码头 `DagSearch.tsx:33`. */
const MAX_RESULTS = 12

export interface DagSearchProps {
  /** The graph's nodes; the same projections the cards render, so a hit's card always contains the query. */
  nodes: readonly DagNodeView[]
  /** Pan the canvas onto a hit WITHOUT navigating (`DagCanvasSearchHandlers.onPreview`). */
  onPreview: (sessionId: string) => void
  /** Commit a hit: the same effect as clicking its card (`DagCanvasSearchHandlers.onChoose`). */
  onChoose: (sessionId: string) => void
  /** Controlled query. Omit to let the box own it; see the module doc's T-4 note. */
  query?: string | undefined
  /** Fired on every keystroke, controlled or not. */
  onQueryChange?: ((query: string) => void) | undefined
  t: Translate<MatouKey>
}

/**
 * Render the search box and its result panel.
 * @param props - the nodes, the two navigation callbacks, the optional controlled query and `t`.
 * @returns the box.
 */
export function DagSearch({ nodes, onPreview, onChoose, query: controlledQuery, onQueryChange, t }: DagSearchProps) {
  const [ownQuery, setOwnQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const query = controlledQuery ?? ownQuery
  const results = useMemo(() => searchGraph(nodes, query).slice(0, MAX_RESULTS), [nodes, query])
  // A live session list can shrink the hit list under a selection the user
  // already moved (a session gets archived while the panel is open), which
  // would otherwise leave nothing selected and Enter doing nothing.
  const activeIndex = results.length === 0 ? -1 : Math.min(selected, results.length - 1)

  useEffect(() => { inputRef.current?.focus() }, [])

  const changeQuery = (value: string): void => {
    if (controlledQuery === undefined) setOwnQuery(value)
    setSelected(0)
    onQueryChange?.(value)
  }

  const choose = (sessionId: string): void => {
    onPreview(sessionId)
    requestAnimationFrame(() => { onChoose(sessionId) })
  }

  const keyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' && results.length > 0) {
      event.preventDefault()
      setSelected((activeIndex + 1) % results.length)
    } else if (event.key === 'ArrowUp' && results.length > 0) {
      event.preventDefault()
      setSelected((activeIndex - 1 + results.length) % results.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const hit = results[activeIndex]
      if (hit !== undefined) choose(hit.sessionId)
    }
  }

  return (
    <div className={css.search}>
      <input
        ref={inputRef}
        type="search"
        role="searchbox"
        className={css.searchInput}
        aria-label={t('dag.search.label')}
        placeholder={t('dag.search.placeholder')}
        value={query}
        onChange={(event) => { changeQuery(event.currentTarget.value) }}
        onKeyDown={keyDown}
      />
      {/* Trimmed, not raw as 码头 `:31`: a box holding only spaces is 「没在搜」,
          and showing 「没有匹配的会话」 for it reports a miss that never happened. */}
      {query.trim() !== '' && (
        <div className={css.results} role="listbox" aria-label={t('dag.search.results')}>
          {results.length === 0 && <p className={css.searchEmpty}>{t('dag.search.empty')}</p>}
          {results.map((node, index) => (
            <button
              key={node.sessionId}
              type="button"
              role="option"
              className={clsx(css.option, index === activeIndex && css.isActive)}
              aria-selected={index === activeIndex}
              data-session-id={node.sessionId}
              onPointerEnter={() => { setSelected(index) }}
              onClick={() => { choose(node.sessionId) }}
            >
              <strong className={css.optionTitle}>{node.title}</strong>
              {node.cwd !== '' && <span className={css.optionPath}>{node.cwd}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
