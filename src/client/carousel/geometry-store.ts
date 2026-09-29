/**
 * Per-level carousel geometry persistence: remembers one level's scroll
 * position, focus, and hover anchor across navigation so returning to it
 * restores where the user left off. Backed by `localStorage`, keyed per
 * scene and parent level. Every read and write is wrapped in try/catch —
 * a missing key, malformed JSON, or a storage write that throws (private
 * browsing, quota exceeded, storage disabled) all degrade to "no persisted
 * geometry" rather than surfacing an error to the caller.
 * @module dsh-plugin-matou-layout/src/client/carousel/geometry-store
 */

const STORAGE_KEY_PREFIX = 'matou.carousel.geom'

/** One level's persisted geometry: scroll position plus focus/hover anchors. */
export interface LevelGeometry {
  readonly scrollLeft: number
  readonly focusedSessionId?: string
  readonly anchorSessionId?: string
  readonly anchorViewportOffset?: number
}

/**
 * The `localStorage` key one level's geometry is stored under.
 * @param sceneId - the scene (workbench tab) the level belongs to.
 * @param parentId - the level's parent session id; `undefined` selects the scene's root level.
 * @returns a key of the form `matou.carousel.geom:<sceneId>:<parentId ?? 'root'>`.
 */
export function geometryKey(sceneId: string, parentId: string | undefined): string {
  return `${STORAGE_KEY_PREFIX}:${sceneId}:${parentId ?? 'root'}`
}

function isLevelGeometry(value: unknown): value is LevelGeometry {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record.scrollLeft !== 'number') return false
  for (const key of ['focusedSessionId', 'anchorSessionId'] as const) {
    if (key in record && record[key] !== undefined && typeof record[key] !== 'string') return false
  }
  if ('anchorViewportOffset' in record && record.anchorViewportOffset !== undefined
    && typeof record.anchorViewportOffset !== 'number') return false
  return true
}

/**
 * Read one level's persisted geometry back.
 * @param sceneId - the scene (workbench tab) the level belongs to.
 * @param parentId - the level's parent session id; `undefined` selects the scene's root level.
 * @returns the stored geometry, or `undefined` when nothing is stored, the value is malformed,
 *   or `localStorage` itself is unavailable.
 */
export function readLevelGeometry(sceneId: string, parentId: string | undefined): LevelGeometry | undefined {
  try {
    const raw = localStorage.getItem(geometryKey(sceneId, parentId))
    if (raw === null) return undefined
    const parsed: unknown = JSON.parse(raw)
    return isLevelGeometry(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Persist one level's geometry. Debouncing frequent updates (e.g. during a
 * scroll) is the caller's responsibility — this write is unconditional.
 * @param sceneId - the scene (workbench tab) the level belongs to.
 * @param parentId - the level's parent session id; `undefined` selects the scene's root level.
 * @param geom - the geometry to store.
 */
export function writeLevelGeometry(sceneId: string, parentId: string | undefined, geom: LevelGeometry): void {
  try {
    localStorage.setItem(geometryKey(sceneId, parentId), JSON.stringify(geom))
  } catch {
    // Swallowed: private-browsing storage, quota exhaustion, or storage
    // disabled entirely must not take the carousel down over a UX nicety.
  }
}
