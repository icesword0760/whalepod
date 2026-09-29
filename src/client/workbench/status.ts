/**
 * Session status for the strip's state dot: one shared mapping so the copy
 * and colors never drift between surfaces (spec §4.3). Idle shows nothing —
 * "有事才亮".
 */
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives/src/StateDot.tsx'

export interface SessionStatusInput {
  readonly running: boolean
  readonly completed?: boolean | undefined
  readonly pending: boolean
}

export function sessionDotState(input: SessionStatusInput): StateDotState | undefined {
  if (input.pending) return 'warning'
  if (input.running) return 'ongoing'
  if (input.completed === true) return 'done'
  return undefined
}

/**
 * Ascending priority: the highest-ranked state among a set of candidates
 * wins (码头 spec §4: 出错 > 等待输入 > 运行中 > 启动中 > 空闲). Two of 码头's
 * five levels have no DSH signal to compute honestly and stay out — "启动中"
 * (nothing on `SessionSummary` distinguishes "about to run" from plain
 * `running`) and "出错" (no durable failure bit on the summary) — so this is
 * the three-level subset DSH can honestly support. Shared by the card
 * header's child badge (`header-seats.tsx#aggregateChildState`) and
 * `drillTo`'s "focus the first active child" (`workbench/actions.ts`) so the
 * two stay in agreement about what "active" means.
 */
export const CHILD_STATE_PRIORITY: readonly StateDotState[] = ['done', 'ongoing', 'warning']
