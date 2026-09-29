/** User-sized cards use a stable minimum, independent of hover and focus. */
export const DEFAULT_CARD_WIDTH = 470
const WIDTH_KEY = 'matou.card-widths.v1'
export function readCardWidths(): Record<string, number> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(WIDTH_KEY) ?? '{}')
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([, width]) =>
      typeof width === 'number' && Number.isFinite(width) && width >= DEFAULT_CARD_WIDTH))
  } catch { return {} }
}
/** Report persistence failures rather than claiming the resize was saved. */
export function saveCardWidths(widths: Readonly<Record<string, number>>): void {
  localStorage.setItem(WIDTH_KEY, JSON.stringify(widths))
}
export function moveCard(ids: readonly string[], id: string, target: number): string[] {
  const next = ids.filter(item => item !== id)
  next.splice(Math.max(0, Math.min(next.length, target)), 0, id)
  return next
}
export function cardIndexAt(widths: readonly number[], offset: number): number {
  let left = 0
  for (let i = 0; i < widths.length; i++) {
    if (offset < left + widths[i]!) return i
    left += widths[i]! + 12
  }
  return Math.max(0, widths.length - 1)
}
