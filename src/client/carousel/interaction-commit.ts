/**
 * When a card's sort position is allowed to move — the deferral half of spec
 * §7.1 step 5's 「焦点离开后卡片按最近交互重排，**正在操作的卡不跳位**」.
 *
 * ## What the third live walkthrough found (2026-09-07)
 *
 * Focus the fifth card, send it a message, and it jumped to position 1 the
 * instant the message went out — the whole strip re-ordering under the user
 * mid-conversation.
 *
 * ## What 码头 does (from its source, which outranks its docs)
 *
 * Siblings are ordered by `membership.last_user_interaction_seq DESC`
 * (`session-graph-repository.ts:318-322`), and that column is written through a
 * pending/commit pair (`session-interaction-service.ts:76-96`):
 *
 * - the interacting session **is the focused one** → the new sequence goes to
 *   `pending_user_interaction_seq`; the sort key is untouched, so the card
 *   stays where it is;
 * - it is **not** focused → `last_user_interaction_seq` is written directly and
 *   the card rises;
 * - **focus leaves it** → `SET last_user_interaction_seq = pending_user_interaction_seq`
 *   (`hierarchy-application-service.ts:2295-2303`) and the card rises then.
 *
 * DSH's `updatedAt` is `max(createdAt, lastPromptAt)`, i.e. already "the last
 * time the user prompted this session" — the right *value*. What was missing is
 * the deferral, so this plugin took the second branch always.
 *
 * ## How the port works
 *
 * The committed sort key lives on the placement (`MatouPlacement.interactionAt`),
 * i.e. in the plugin's own document — the same place 码头 keeps its column, and
 * the reason the control plane needs no notion of focus: both the carousel and
 * `control/topology.ts` read one committed number, so 「AI 说的第 3 张」 and
 * 「用户看到的第 3 张」 cannot drift apart.
 *
 * 码头's `pending` column has no counterpart here and needs none: the live value
 * (`updatedAt`) keeps advancing on its own, so "pending" is simply "live is
 * ahead of committed", and the commit-on-focus-leave falls out of re-running
 * this function once the session is no longer focused.
 * @module dsh-plugin-matou-layout/src/client/carousel/interaction-commit
 */

/** One session's live and committed interaction times. */
export interface InteractionCandidate {
  readonly sessionId: string
  /**
   * What the sort key WOULD be if nothing were deferred: `0` for a blank
   * session, else DSH's `updatedAt`. Same expression the projection falls back
   * to when no committed value exists.
   */
  readonly liveInteractionAt: number
  /** The committed sort key, or `undefined` for a placement that has never had one. */
  readonly committedAt: number | undefined
  /**
   * Whether this session actually HAS a placement in the org document.
   *
   * 未落位的会话必须排除，否则会烧穿一条无限写循环：宿主的 `placement/interaction`
   * 对没有落位行的会话**静默忽略**（`org/ops.ts` 有意为之，免得一次时序竞争拒掉
   * 整批），但那次 apply 仍然把 revision 加一。于是客户端看到文档变了 →
   * 重新求值 → 发现该会话**依然**没有已提交的排序键 → 再写一次 → 再加一……
   *
   * 后果不只是空转：这条循环会把**所有别的写入挤掉**。2026-09-14 桌面端走查里，
   * 用户点「新会话」永远建不出来——它的 `placement/set` 每一次（含重试）都撞上
   * 这条循环抢先提交的版本号。修 1 是不发这种写不进去的请求；修 2 在
   * `src/index.ts`：批次没改变任何状态时不推进 revision，从结构上掐死这一类循环。
   */
  readonly placed: boolean
}

export interface InteractionCommitInput {
  /** The card the user is working in right now, if any. */
  readonly focusedSessionId: string | undefined
  /** Every placed session of the scene being maintained. */
  readonly sessions: readonly InteractionCandidate[]
}

/** One `placement/interaction` write to issue. */
export interface InteractionCommit {
  readonly sessionId: string
  readonly at: number
}

/**
 * Decide which sessions should have their sort key committed to the live value.
 * @param input - the focused session and every candidate's live/committed pair.
 * @returns the writes to issue; empty when nothing would change.
 */
export function interactionCommits(input: InteractionCommitInput): InteractionCommit[] {
  const commits: InteractionCommit[] = []
  for (const candidate of input.sessions) {
    // 没有落位行就没有可写之处——见 `InteractionCandidate.placed` 的文档。
    if (!candidate.placed) continue
    // A placement with no key yet always gets one, focused or not: without it
    // the projection has to fall back to the live value, and the very next
    // message would move the focused card — the defect this module exists for.
    if (candidate.committedAt === undefined) {
      commits.push({ sessionId: candidate.sessionId, at: candidate.liveInteractionAt })
      continue
    }
    // The focused card holds its position however far the live value runs
    // ahead; the moment focus moves elsewhere this same check commits it.
    if (candidate.sessionId === input.focusedSessionId) continue
    // Monotonic: a sort key never walks backwards.
    if (candidate.liveInteractionAt <= candidate.committedAt) continue
    commits.push({ sessionId: candidate.sessionId, at: candidate.liveInteractionAt })
  }
  return commits
}
