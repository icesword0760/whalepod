/**
 * Per-scene DAG viewport persistence: remembers one workbench tab's pan and
 * zoom across closing and reopening the relationship overlay, so the user
 * comes back to the spot they were looking at instead of to the origin.
 *
 * 码头 stores the same thing in its SQLite geometry channel under
 * `dag-viewport:${sceneId}` (`dag/DagWindowApp.tsx:150-156` reads it,
 * `:187-196` writes `{ panX, panY, zoom }` back). DSH has no equivalent
 * geometry channel and `matouOrg` is a structural document synced to the
 * host — UI furniture does not belong in it — so this lands in
 * `localStorage`, mirroring this plugin's existing precedent
 * `carousel/geometry-store.ts:12,28`. The key granularity is 码头's:
 * **one entry per scene (workbench tab)**, not per window and not per
 * session.
 *
 * Every read and write is wrapped in try/catch — a missing key, malformed
 * JSON, or a storage access that throws (private browsing, quota exceeded,
 * storage disabled) all degrade to "no persisted viewport" rather than
 * surfacing an error to the caller.
 * @module dsh-plugin-matou-layout/src/client/dag/viewport-store
 */

import { clampDagScale } from './viewport.ts'
import type { DagTransform } from './viewport.ts'

/** The shared prefix of every persisted DAG viewport key. */
export const DAG_VIEWPORT_KEY_PREFIX = 'matou.dag.viewport'

/**
 * The `localStorage` key one scene's viewport is stored under.
 * @param sceneId - the scene (workbench tab) the viewport belongs to.
 * @returns a key of the form `matou.dag.viewport:<sceneId>`.
 */
export function dagViewportKey(sceneId: string): string {
  return `${DAG_VIEWPORT_KEY_PREFIX}:${sceneId}`
}

/**
 * Structural guard for a parsed viewport payload. Finiteness rather than a
 * bare `typeof === 'number'` on purpose: `JSON.parse('{"x":1e999}')` yields
 * `Infinity`, and an infinite pan offset produces a permanently blank canvas
 * with no way back short of clearing storage by hand.
 */
function isDagTransform(value: unknown): value is DagTransform {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  for (const key of ['x', 'y', 'scale'] as const) {
    if (typeof record[key] !== 'number' || !Number.isFinite(record[key])) return false
  }
  return true
}

/**
 * Read one scene's persisted viewport back. The stored `scale` is passed
 * through {@link clampDagScale} on the way out, so a hand-edited
 * `localStorage` entry cannot hand the canvas a zoom outside `[0.4, 2]`.
 * @param sceneId - the scene (workbench tab) the viewport belongs to.
 * @returns the stored transform, or `undefined` when nothing is stored, the
 *   value is malformed, or `localStorage` itself is unavailable.
 */
export function readDagViewport(sceneId: string): DagTransform | undefined {
  try {
    const raw = localStorage.getItem(dagViewportKey(sceneId))
    if (raw === null) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (!isDagTransform(parsed)) return undefined
    return { x: parsed.x, y: parsed.y, scale: clampDagScale(parsed.scale) }
  } catch {
    return undefined
  }
}

/**
 * Persist one scene's viewport. Debouncing frequent updates (the canvas
 * emits one per drag/zoom frame) is the caller's responsibility — this write
 * is unconditional, the same contract as `carousel/geometry-store.ts:63-66`.
 * @param sceneId - the scene (workbench tab) the viewport belongs to.
 * @param transform - the pan/zoom transform to store.
 */
export function writeDagViewport(sceneId: string, transform: DagTransform): void {
  try {
    const payload = { x: transform.x, y: transform.y, scale: transform.scale }
    localStorage.setItem(dagViewportKey(sceneId), JSON.stringify(payload))
  } catch {
    // Swallowed: private-browsing storage, quota exhaustion, or storage
    // disabled entirely must not take the DAG overlay down over a UX nicety.
  }
}
