import { z } from 'zod'
export const scopeSchema = z.discriminatedUnion('kind', [z.object({kind:z.literal('global')}),z.object({kind:z.literal('projects'),projectIds:z.array(z.string().min(1)).min(1).max(100)})])
export const recordSchema = z.object({
  id:z.string(),kind:z.enum(['skill','mcp']),key:z.string().min(1).max(64),title:z.string().min(1).max(128),
  description:z.string().max(4096),scope:scopeSchema,enabled:z.boolean(),createdAt:z.number(),updatedAt:z.number(),
  source:z.enum(['local','remote','external']),path:z.string().optional(),content:z.string().optional(),digest:z.string().optional(),
  invocation:z.object({modelInvocable:z.boolean(),userInvocable:z.boolean()}).optional(),
  mcp:z.discriminatedUnion('transport',[
    z.object({transport:z.literal('streamable-http'),url:z.string().url(),headerEnv:z.record(z.string(),z.string())}),
    z.object({transport:z.literal('stdio'),command:z.string().min(1).max(1000),args:z.array(z.string().max(4096)).max(100),envNames:z.array(z.string()).max(100)}),
  ]).optional(),
})
export type ManagedCapability = z.infer<typeof recordSchema>
export const overrideSchema=z.object({kind:z.enum(['skill','mcp']),key:z.string(),projectId:z.string(),mode:z.enum(['disabled','inherit','project','enabled'])})
export const configSchema=z.object({entries:z.array(recordSchema),overrides:z.array(overrideSchema)})
export const documentSchema=configSchema.extend({revision:z.number().int().nonnegative(),history:z.array(z.object({time:z.number(),label:z.string(),config:configSchema})).max(30)})
export type CapabilityDocument=z.infer<typeof documentSchema>
export const emptyDocument=():CapabilityDocument=>({revision:0,entries:[],overrides:[],history:[]})
export const uploadSchema=z.array(z.object({path:z.string().max(1024),data:z.string().max(12*1024*1024)})).min(1).max(256).refine(files=>files.reduce((n,f)=>n+f.data.length,0)<=12*1024*1024,'技能包超过 8 MB')
export type UploadFile=z.infer<typeof uploadSchema>[number]
export const previewSchema=z.object({token:z.string(),name:z.string(),description:z.string(),files:z.array(z.string()),warnings:z.array(z.string()),digest:z.string()})
export type InstallPreview=z.infer<typeof previewSchema>
export const requestSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('list')}),
  z.object({action:z.literal('read'),id:z.string()}),
  z.object({action:z.literal('test'),id:z.string()}),
  z.object({action:z.literal('preview'),files:uploadSchema}),
  z.object({action:z.literal('install'),token:z.string(),scope:scopeSchema,expectedRevision:z.number(),replaceId:z.string().optional()}),
  z.object({action:z.literal('save'),entry:recordSchema,expectedRevision:z.number()}),
  z.object({action:z.literal('remove'),id:z.string(),expectedRevision:z.number(),disableInProject:z.string().optional()}),
  z.object({action:z.literal('override'),override:overrideSchema,expectedRevision:z.number()}),
  z.object({action:z.literal('restore'),index:z.number().int().min(0),expectedRevision:z.number()}),
])
export type CapabilityRequest=z.infer<typeof requestSchema>
export const publicDocumentSchema=z.object({revision:z.number(),entries:z.array(recordSchema.omit({content:true})),overrides:z.array(overrideSchema),history:z.array(z.object({time:z.number(),label:z.string()}))})
export function publicDocument(document:CapabilityDocument):z.infer<typeof publicDocumentSchema>{return publicDocumentSchema.parse(document)}
export const resultSchema=z.object({document:publicDocumentSchema,projects:z.array(z.object({id:z.string(),title:z.string(),path:z.string()})),preview:previewSchema.optional(),text:z.string().optional(),tools:z.array(z.string()).optional()})
export type CapabilityResult=z.infer<typeof resultSchema>
