import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

/**
 * The copy gate for S4. Every `dag.*` view file was written against a key set
 * held as a local double inside its own spec (`dag-overlay.client.spec.tsx:55`
 * and friends), so those specs stay green whatever wording lands here. Nothing
 * in them proves the real dictionary ever got the keys — that is this spec's
 * job, and without it a missing key ships as a literal `dag.node.children`
 * rendered on the card.
 */

/** The 32 `dag.*` keys the S4 plan enumerates (Task 13), plus nothing else. */
const DAG_KEYS: readonly string[] = [
  'dag.label', 'dag.close', 'dag.empty',
  'dag.search.label', 'dag.search.placeholder', 'dag.search.results', 'dag.search.empty',
  'dag.zoom.label', 'dag.zoom.in', 'dag.zoom.out', 'dag.zoom.reset', 'dag.zoom.focus',
  'dag.legend.label', 'dag.legend.fork', 'dag.legend.derived',
  'dag.node.open', 'dag.node.children', 'dag.node.activity', 'dag.node.noActivity',
  'dag.node.emptyPreview', 'dag.node.notice',
  'dag.status.idle',
  'dag.aggregate.branch', 'dag.aggregate.layer', 'dag.aggregate.count', 'dag.aggregate.range',
  'dag.aggregate.running', 'dag.aggregate.waiting', 'dag.aggregate.done', 'dag.aggregate.label',
  'dag.missing', 'dag.subagentRedirect',
]

/**
 * The params each key is actually called with, read off the call sites:
 * `DagNodeCard.tsx:96,115,119,142`, `DagAggregateCard.tsx:63-89`,
 * `DagOverlay.tsx:236`. A key whose copy names a param the caller never passes
 * renders an empty hole; a key whose copy omits one silently drops the number.
 */
const REQUIRED_PARAMS: Readonly<Record<string, readonly string[]>> = {
  'dag.node.open': ['title'],
  'dag.node.notice': ['title'],
  'dag.node.children': ['n'],
  'dag.node.activity': ['time'],
  'dag.aggregate.count': ['n'],
  'dag.aggregate.range': ['from', 'to'],
  'dag.aggregate.running': ['n'],
  'dag.aggregate.waiting': ['n'],
  'dag.aggregate.done': ['n'],
  'dag.aggregate.label': ['done', 'n', 'running', 'waiting'],
  'dag.subagentRedirect': ['title'],
}

const zhDict: Record<string, string> = zh
const enDict: Record<string, string> = en

/** The `{name}` placeholders a string interpolates, sorted, duplicates dropped. */
function placeholders(text: string): readonly string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map(match => match[1] as string))].sort()
}

/** Every `dag.*` key literally reached by a `t(...)` call under `src/client/dag/`. */
function keysUsedInSource(): readonly string[] {
  // `dirname(fileURLToPath(import.meta.url))`, not `new URL(..., import.meta.url)`:
  // under jsdom the global `URL` is whatwg-url, which `node:url` refuses.
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), '../src/client/dag')
  const used = new Set<string>()
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue
    const source = readFileSync(join(directory, name), 'utf8')
    for (const match of source.matchAll(/\bt\(\s*'(dag\.[\w.]+)'/g)) used.add(match[1] as string)
  }
  return [...used].sort()
}

describe('matou 文案字典', () => {
  it('zh 与 en 的键集合逐字相同（`satisfies` 的运行时复述）', () => {
    expect(Object.keys(enDict).sort()).toEqual(Object.keys(zhDict).sort())
  })

  it('计划列出的每个 dag.* 键在 zh 与 en 两侧都有非空文案', () => {
    const missingZh = DAG_KEYS.filter(key => (zhDict[key] ?? '').trim() === '')
    const missingEn = DAG_KEYS.filter(key => (enDict[key] ?? '').trim() === '')
    expect({ missingZh, missingEn }).toEqual({ missingZh: [], missingEn: [] })
  })

  it('没有多出计划之外的 dag.* 键（键集合就是这 32 个）', () => {
    expect(Object.keys(zhDict).filter(key => key.startsWith('dag.')).sort()).toEqual([...DAG_KEYS].sort())
  })

  it('每个 dag.* 键的插值占位在 zh 与 en 两侧完全一致', () => {
    const drifted = DAG_KEYS
      .map(key => ({ key, zh: placeholders(zhDict[key] ?? ''), en: placeholders(enDict[key] ?? '') }))
      .filter(row => row.zh.join(',') !== row.en.join(','))
    expect(drifted).toEqual([])
  })

  it('带参数的键带齐调用点传入的参数，不带参数的键一个占位都没有', () => {
    const wrong = DAG_KEYS
      .map(key => ({ key, expected: REQUIRED_PARAMS[key] ?? [], actual: placeholders(zhDict[key] ?? '') }))
      .filter(row => row.actual.join(',') !== [...row.expected].sort().join(','))
    expect(wrong).toEqual([])
  })

  it('en 侧的 dag.* 文案没有一条是中文原样照抄', () => {
    expect(DAG_KEYS.filter(key => /[一-鿿]/.test(enDict[key] ?? ''))).toEqual([])
  })

  it('zh 侧的 dag.* 文案都写了中文（不是把英文当中文用）', () => {
    expect(DAG_KEYS.filter(key => !/[一-鿿]/.test(zhDict[key] ?? ''))).toEqual([])
  })

  it('src/client/dag/ 里 t() 用到的每个 dag.* 键都在字典里', () => {
    const used = keysUsedInSource()
    // A regex that matched nothing would make the assertion below vacuous.
    expect(used.length).toBeGreaterThanOrEqual(20)
    expect(used.filter(key => zhDict[key] === undefined)).toEqual([])
  })
})
