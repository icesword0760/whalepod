/**
 * Pure shaping and bounding for what the control plane reads out of another
 * workbench card: the recent-turn previews behind `matou_read_recent` and the
 * message window behind `matou_read_history`. No cordis, no IO, no DSH runtime
 * import — every function here eats data the host layer already fetched.
 *
 * Two rules drive the whole module:
 *
 * 1. **Read DSH's own structured records, never a screen.** 码头 reads a PTY
 *    screen (`apps/runtime/src/control/runtime-control-backend.ts:110-135`)
 *    because in 码头 a session IS a terminal. DSH's universal representation is
 *    the event log plus projections, so reading here means the `turnOutline`
 *    projection and the three message-bearing event types — provider-agnostic,
 *    and cold sessions answer without being woken.
 * 2. **Bound the result here, not in `spill-policy`.** The official
 *    `tool-session-query` never truncates and lets `spill-policy` hand the model
 *    a spill handle instead; a control-plane read has to be retold to the user
 *    inside the same turn, so a handle is useless. {@link TOTAL_CHARS} therefore
 *    sits well under that policy's `maxInlineBytes: 50000`
 *    (`packages/bundle/base/cordis.patch.yml:392`).
 *
 * Every bound is either DSH's own number (cited on the constant) or explicitly
 * this plugin's own choice.
 * @module dsh-plugin-matou-layout/src/control/read
 */

/** Default recent turns returned by `matou_read_recent`; this plugin's own number. */
export const DEFAULT_RECENT_TURNS = 3
/** Ceiling on recent turns; this plugin's own number, kept small because each entry is already a bounded preview. */
export const MAX_RECENT_TURNS = 20
/** Default history page size — DSH's own `DEFAULT_MAX_MESSAGES` (`packages/api/session-controller/src/history.ts:36`). */
export const DEFAULT_MAX_MESSAGES = 50
/**
 * Ceiling on one history page — DSH's own `SESSION_QUERY_SQLITE_MAX_LIMIT`
 * (`packages/session-query/session-query-sqlite/src/index.ts:85`).
 */
export const MAX_MAX_MESSAGES = 100
/** Per-message character cap before tail truncation; this plugin's own number. */
export const PER_MESSAGE_CHARS = 2000
/**
 * Whole-result character budget; this plugin's own number, deliberately far
 * below `spill-policy`'s `maxInlineBytes: 50000`
 * (`packages/bundle/base/cordis.patch.yml:389-392`) so a read comes back as
 * readable text with a `truncated` flag instead of a spill handle. Measured on
 * message text only — the JSON envelope adds a small constant per message, which
 * the gap to 50000 absorbs.
 */
export const TOTAL_CHARS = 20_000

/**
 * The message-bearing event types and the role each reports. This is DSH's own
 * `SurfaceEventType` subset (`packages/core/session/src/types.ts:373-376`), not
 * a hand-picked list. Note it is wider than the Session Controller's own history
 * pager, which keeps only user/assistant (`history.ts:37`): a control-plane
 * reader asking "what is that card doing" needs tool output too.
 *
 * `tool/result` carries a `role: 'user'` message (that is how tool output is fed
 * back to a model); the control plane reports it as `'tool'` so the reading
 * model cannot mistake it for something the human said.
 */
const ROLE_OF: Readonly<Record<string, HistoryRole>> = {
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'tool',
}

/** Model-facing role of one history message. */
export type HistoryRole = 'user' | 'assistant' | 'tool'

/**
 * One `turnOutline` projection entry, structurally matching DSH's
 * `TurnOutlineEntry` (`packages/session/session-turn-outline/src/types.ts:14-24`).
 */
export interface TurnOutlineEntryLike {
  /** Host-assigned turn number. */
  readonly turn: number
  /** The turn's `turn/start` seq — paging history back through it loads the whole turn. */
  readonly seq: number
  /** Bounded first-human-prompt preview; `''` until an eligible prompt lands. */
  readonly prompt: string
  /** Bounded final-response preview (up to three lines); `''` until the turn ends with assistant text. */
  readonly response: string
}

/** Shaped result of `matou_read_recent`. */
export interface RecentTurnsResult {
  /** The newest turns, oldest first. */
  readonly turns: readonly TurnOutlineEntryLike[]
  /** How many turns the session has in total, so the model can tell "3 of 3" from "3 of 90". */
  readonly total_turns: number
  /** Present only when the deployment cannot answer at all; never an error. */
  readonly note?: string
}

/** One session-log event as the shaper needs to see it; `data` stays `unknown` and is probed defensively. */
export interface HistoryEvent {
  readonly seq: number
  readonly type: string
  readonly data: unknown
}

/** One shaped, bounded history message. */
export interface HistoryMessage {
  readonly seq: number
  readonly role: HistoryRole
  /** Visible text only — reasoning and tool-call blocks are left out. */
  readonly text: string
  /** Present only when this message's own text was cut at {@link PER_MESSAGE_CHARS}. */
  readonly truncated?: true
}

/** Shaped result of `matou_read_history`. */
export interface HistoryResult {
  /** The newest messages inside the window, oldest first. */
  readonly messages: readonly HistoryMessage[]
  /** Whether older messages exist before the returned window. */
  readonly has_more: boolean
  /** Exclusive upper bound for the next backwards page; absent when there is nothing older. */
  readonly next_before_seq?: number
  /** Whether anything was cut — a per-message tail cut, a budget drop, or both. */
  readonly truncated: boolean
}

/** Window and budget knobs; each falls back to this module's constant when absent or out of range. */
export interface ShapeHistoryOptions {
  /** Newest messages to keep; clamped to {@link MAX_MAX_MESSAGES}. */
  readonly maxMessages?: number
  /**
   * Exclusive upper bound on `seq`, the same sense as DSH's
   * `SessionPageRequest.beforeSeq` (`packages/api/session-controller/src/history.ts:318-343`).
   */
  readonly beforeSeq?: number
  /** Per-message character cap. */
  readonly perMessageChars?: number
  /** Whole-result character budget. */
  readonly totalChars?: number
}

/** Said when the deployment has no `session-turn-outline` mounted, so the projection key is simply absent. */
const NO_TURN_OUTLINE_NOTE
  = 'this deployment has no turn-outline projection, so recent-turn previews are unavailable; '
    + 'read the session with matou_read_history instead.'

/**
 * Clamp one caller-supplied count into range, falling back rather than failing:
 * a bad number from a model should degrade to the default, not cost it a turn.
 * @param value - caller-supplied count, possibly absent or nonsense.
 * @param fallback - value used when absent, non-integer, or below 1.
 * @param max - inclusive ceiling.
 * @returns a safe integer in `1..max`.
 */
function bounded(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) return fallback
  return Math.min(value, max)
}

/**
 * Narrow one unknown log payload to an indexable object.
 * @param value - anything the log carried.
 * @returns whether it can be probed by key.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Collect visible text out of a content-block array, walking into `tool-result`
 * blocks (that nesting is where tool output actually lives —
 * `packages/llm/llm/src/types.ts:87-92`). `reasoning`, `image`, and `tool-call`
 * blocks are deliberately skipped: the control plane reports what a card SAID,
 * and reasoning in particular is both private-feeling and unbounded.
 * @param blocks - the message's `content`, of unverified shape.
 * @returns each text block's text, in order.
 */
function textBlocksOf(blocks: unknown): string[] {
  if (!Array.isArray(blocks)) return []
  const out: string[] = []
  for (const block of blocks as readonly unknown[]) {
    if (!isRecord(block)) continue
    if (block['type'] === 'text' && typeof block['text'] === 'string') out.push(block['text'])
    else if (block['type'] === 'tool-result') out.push(...textBlocksOf(block['content']))
  }
  return out
}

/**
 * Extract one event's visible text. `user/message` data IS the message
 * (`packages/core/session/src/types.ts:287`); `assistant/message` and
 * `tool/result` wrap theirs one level down beside `turn`/`step` (`:301`, `:317-324`).
 * @param type - the event type, already known to be message-bearing.
 * @param data - the event payload, of unverified shape.
 * @returns the joined visible text, or `''` when the payload carries none.
 */
function messageTextOf(type: string, data: unknown): string {
  if (!isRecord(data)) return ''
  const message = type === 'user/message' ? data : data['message']
  if (!isRecord(message)) return ''
  return textBlocksOf(message['content']).join('\n')
}

/**
 * Shape the newest turns of one session's `turnOutline` projection.
 *
 * The projection is host-side and cold-safe, so this never wakes the target and
 * never depends on which provider drives it.
 * @param entries - the projection's entries in ascending turn order, or `undefined` when the projection is not mounted.
 * @param turns - how many of the newest turns to keep; out-of-range values fall back to {@link DEFAULT_RECENT_TURNS}.
 * @returns the kept turns oldest-first, the total turn count, and a note only when the projection was absent.
 */
export function shapeRecentTurns(entries: readonly TurnOutlineEntryLike[] | undefined, turns?: number): RecentTurnsResult {
  if (entries === undefined) return { turns: [], total_turns: 0, note: NO_TURN_OUTLINE_NOTE }
  const count = bounded(turns, DEFAULT_RECENT_TURNS, MAX_RECENT_TURNS)
  const kept = entries.slice(Math.max(0, entries.length - count))
  // Project field by field: the model-facing payload stays exactly these four
  // keys even if the projection grows others later.
  return {
    turns: kept.map(item => ({ turn: item.turn, seq: item.seq, prompt: item.prompt, response: item.response })),
    total_turns: entries.length,
  }
}

/**
 * Window and bound one session's message history.
 *
 * Order of operations, and why: filter to message-bearing events → cut at
 * `beforeSeq` → keep the newest `maxMessages` → extract text and tail-cut each
 * at `perMessageChars` → drop WHOLE oldest messages until the total fits
 * `totalChars`. Dropping whole messages (rather than shaving the oldest one)
 * mirrors 码头's `tailText`, which keeps the tail intact and reports
 * `truncated` (`apps/runtime/src/control/runtime-control-backend.ts:249-262`);
 * half a message is worse than one fewer message for a model that has to retell
 * it. At least one message always survives the budget pass.
 * @param events - the session's events in ascending seq order; anything not message-bearing is ignored.
 * @param options - window and budget knobs; see {@link ShapeHistoryOptions}.
 * @returns the bounded window, whether older messages exist, and the cursor to continue from.
 */
export function shapeHistory(events: readonly HistoryEvent[], options: ShapeHistoryOptions = {}): HistoryResult {
  const limit = bounded(options.maxMessages, DEFAULT_MAX_MESSAGES, MAX_MAX_MESSAGES)
  const perMessage = bounded(options.perMessageChars, PER_MESSAGE_CHARS, Number.MAX_SAFE_INTEGER)
  const budget = bounded(options.totalChars, TOTAL_CHARS, Number.MAX_SAFE_INTEGER)
  const { beforeSeq } = options

  const matched: { readonly event: HistoryEvent; readonly role: HistoryRole }[] = []
  for (const event of events) {
    const role = ROLE_OF[event.type]
    if (role === undefined) continue
    if (beforeSeq !== undefined && event.seq >= beforeSeq) continue
    matched.push({ event, role })
  }

  const droppedOlder = matched.length > limit
  const messages: HistoryMessage[] = []
  let cutInsideMessage = false
  let total = 0
  for (const { event, role } of matched.slice(Math.max(0, matched.length - limit))) {
    const full = messageTextOf(event.type, event.data)
    const text = full.length > perMessage ? full.slice(0, perMessage) : full
    const truncated = text.length < full.length
    if (truncated) cutInsideMessage = true
    total += text.length
    messages.push({ seq: event.seq, role, text, ...truncated ? { truncated: true } as const : {} })
  }

  let droppedForBudget = false
  while (total > budget && messages.length > 1) {
    const removed = messages.shift()
    if (removed === undefined) break
    total -= removed.text.length
    droppedForBudget = true
  }

  const hasMore = droppedOlder || droppedForBudget
  const oldest = messages[0]
  return {
    messages,
    has_more: hasMore,
    ...hasMore && oldest !== undefined ? { next_before_seq: oldest.seq } : {},
    truncated: cutInsideMessage || droppedForBudget,
  }
}
