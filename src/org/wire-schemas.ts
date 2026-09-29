/**
 * Runtime zod codecs for the `matouLayout` wire vocabulary, consumed by the
 * hand-written client contribution (the typert generator cannot run outside
 * the DSH monorepo, so these stand in for its emitted schemas).
 * @module dsh-plugin-matou-layout/src/org/wire-schemas
 */

import { z } from 'zod'
import {
  matouOrgStateSchema,
  matouTaskStatusSchema,
} from './model.ts'
import type { MatouOrgOp } from './ops.ts'
import type {
  MatouOrgApplyRequest,
  MatouOrgApplyResult,
  MatouOrgSnapshotValue,
} from './wire.ts'

const identifier = z.string().min(1)
const safeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const anchor = z.union([identifier, z.literal(null)])

export const matouOrgOpSchema: z.ZodType<MatouOrgOp> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('task/create'),
    id: identifier,
    workspaceId: identifier,
    title: z.string(),
    status: matouTaskStatusSchema.optional(),
  }),
  z.object({
    kind: z.literal('task/update'),
    id: identifier,
    patch: z.object({
      title: z.string().optional(),
      status: matouTaskStatusSchema.optional(),
      isPinned: z.boolean().optional(),
    }),
  }),
  z.object({ kind: z.literal('task/move'), id: identifier, beforeTaskId: anchor.optional() }),
  z.object({ kind: z.literal('task/delete'), id: identifier }),
  z.object({
    kind: z.literal('scene/create'),
    id: identifier,
    taskId: identifier,
    name: z.string(),
    titlePinned: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('scene/update'),
    id: identifier,
    patch: z.object({
      name: z.string().optional(),
      titlePinned: z.boolean().optional(),
    }),
  }),
  z.object({ kind: z.literal('scene/move'), id: identifier, beforeSceneId: anchor.optional() }),
  z.object({ kind: z.literal('scene/delete'), id: identifier }),
  z.object({
    kind: z.literal('placement/set'),
    sessionId: identifier,
    taskId: identifier,
    sceneId: identifier,
    beforeSessionId: anchor.optional(),
    parentSessionId: z.union([identifier, z.null()]).optional(),
    relationKind: z.enum(['forked-from', 'derived-from']).optional(),
  }),
  z.object({ kind: z.literal('placement/remove'), sessionId: identifier }),
  z.object({ kind: z.literal('placement/order'), sessionId: identifier, order: safeCount }),
  z.object({ kind: z.literal('placement/interaction'), sessionId: identifier, at: safeCount }),
]) as unknown as z.ZodType<MatouOrgOp>

export const matouOrgSnapshotValueSchema: z.ZodType<MatouOrgSnapshotValue> = z.object({
  revision: safeCount,
  state: matouOrgStateSchema,
}) as unknown as z.ZodType<MatouOrgSnapshotValue>

export const matouOrgApplyRequestSchema: z.ZodType<MatouOrgApplyRequest> = z.object({
  expectedRevision: safeCount,
  ops: z.array(matouOrgOpSchema),
}) as unknown as z.ZodType<MatouOrgApplyRequest>

export const matouOrgApplyResultSchema: z.ZodType<MatouOrgApplyResult> = z.union([
  z.object({ ok: z.literal(true), value: matouOrgSnapshotValueSchema }),
  z.object({
    ok: z.literal(false),
    error: z.union([
      z.object({
        code: z.literal('revision-conflict'),
        revision: safeCount,
        state: matouOrgStateSchema,
      }),
      z.object({
        code: z.literal('invalid-op'),
        index: safeCount,
        reason: z.string(),
      }),
    ]),
  }),
]) as unknown as z.ZodType<MatouOrgApplyResult>
