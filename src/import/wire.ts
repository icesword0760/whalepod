import { z } from 'zod'
export const importRequestSchema = z.object({
  action: z.enum(['list', 'preview', 'import']), sessionId: z.string().min(1).max(200),
  id: z.string().max(100).optional(), query: z.string().max(200).optional(),
  source: z.enum(['all', 'claude', 'codex']).optional(), page: z.number().int().min(0).max(1000).optional(),
  refresh: z.boolean().optional(), previewPage: z.number().int().min(0).optional(), previewVersion: z.string().max(100).optional(),
})
export const messageSchema = z.object({ role: z.enum(['user', 'assistant']), text: z.string(), continuation: z.boolean().optional() })
export const summarySchema = z.object({ id: z.string(), source: z.enum(['claude', 'codex']), title: z.string(), snippet: z.string(), updatedAt: z.number(), version: z.string() })
export const importResultSchema = z.object({
  workspace: z.string(), path: z.string(), items: z.array(summarySchema), total: z.number(),
  scanning: z.boolean(), warning: z.string(), messages: z.array(messageSchema),
  messageCount: z.number(), imported: z.boolean(),
  previewPage: z.number().optional(), previewPages: z.number().optional(), previewVersion: z.string().optional(),
})
export type ImportRequest = z.infer<typeof importRequestSchema>
export type ImportResult = z.infer<typeof importResultSchema>
export type ImportSummary = z.infer<typeof summarySchema>
export type ImportMessage = z.infer<typeof messageSchema>
