/**
 * The topology revision: the token that tells a model whether an ordinal it is
 * about to use still points at the card it saw. Pure computation — no cordis,
 * no IO, no DSH runtime import.
 *
 * **Why a revision exists at all (D-S7-3).** The only selectors that can go
 * wrong silently are the ones addressed BY POSITION: `sibling:N` and `child:N`.
 * `self` / `left` / `right` / `parent` are single-valued relations with no
 * number in them — re-solving them against the current layout is precisely what
 * the user meant — and `session:<id>` is identity addressing, which a reorder
 * cannot misdirect. So this value guards exactly two sets, and the tools that
 * hand out ordinals (`matou_identify_self`, `matou_list_sessions`) hand it out
 * with them.
 *
 * **Why it hashes two ref sequences and nothing else.** 码头 hashes the whole
 * scope: an ordered array of `{ref, workspaceId, taskId, sessionId, mountId,
 * parentRef, childRefs}` per target (`apps/runtime/src/control/host-target-revision.ts:6-17`),
 * computed per scope because a selector's scope decides how much of the tree it
 * can reach (`host-control-server.ts:490-496`: ref/session → `'all'`, everything
 * else → `'current-level'`). It needs that because it carries cross-layer fields
 * — `mountId`, and above them a window dimension — that can shift a position
 * without changing any one layer. DSH has none of those, and this plugin only
 * ever exposes ordinals inside 「调用者所在层」 and 「调用者的子会话」. Hashing
 * exactly those two sequences is therefore both sufficient and strictly more
 * precise than 码头's: a message sent in another workspace, a card renamed, a
 * turn starting or ending — none of them can invalidate an ordinal here, so
 * none of them produces a spurious `STALE_TOPOLOGY`. One number covers both
 * sets, so there is no scope split either.
 *
 * **Position sensitive, content insensitive.** Only the refs and their order go
 * in. Titles, running state, cwd, `updatedAt` — everything that moves without
 * moving a card — is deliberately excluded; a revision that churned on those
 * would train the model to re-list after every read, which is the same as
 * having no revision at all. Contrariwise `updatedAt` DOES bear on the order
 * (it is `orderSiblings`' first key), and when it reorders a layer the ref
 * sequence itself changes — which is the change this value is here to catch.
 * @module dsh-plugin-matou-layout/src/control/revision
 */

import { createHash } from 'node:crypto'

/**
 * Compute the revision covering the two ordinal-indexed sets.
 *
 * The two arguments are kept as separate JSON array members rather than
 * concatenated, so `([a, b], [])` and `([a], [b])` — a two-card layer with no
 * children versus a one-card layer with one child — cannot collide. JSON
 * escaping likewise keeps a ref that contains the separator character from
 * impersonating two refs.
 * @param levelRefs - the caller's own layer, in the order the user sees it; the sequence `sibling:N` indexes.
 * @param childRefs - the caller's direct children, in their own layer's order; the sequence `child:N` indexes.
 * @returns the sha256 hex digest of the two sequences.
 */
export function topologyRevision(levelRefs: readonly string[], childRefs: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([levelRefs, childRefs]))
    .digest('hex')
}
