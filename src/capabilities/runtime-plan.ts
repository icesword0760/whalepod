import { resolveCapabilities, capabilityIdentity } from './resolution.ts'
import type { CapabilityDocument, ManagedCapability } from './model.ts'
export interface RuntimePlan {
  /** Snapshot revision stays fixed for the lifetime of the prepared agent. */
  revision:number
  skills:ManagedCapability[]
  connectors:ManagedCapability[]
  /** Tombstones are active restrictions, not an empty candidate list. */
  blocked:Array<{kind:'skill'|'mcp';key:string}>
}
/** Shared plan consumed by registry adapters; ambiguity rejects activation rather than choosing accidentally. */
export function runtimePlan(document:CapabilityDocument,projectId:string|null):RuntimePlan {
  const resolved=resolveCapabilities(document.entries,projectId,document.overrides)
  const conflict=resolved.find(r=>r.status==='conflict')
  if(conflict)throw new Error(`配置存在重复标识，请在管理页处理：${conflict.identity}`)
  const plan:RuntimePlan={revision:document.revision,skills:[],connectors:[],blocked:[]}
  for(const r of resolved){
    if(r.status==='enabled'&&r.effective){(r.effective.kind==='skill'?plan.skills:plan.connectors).push(structuredClone(r.effective))}
    else {const entry=r.entries[0]!;plan.blocked.push({kind:entry.kind,key:entry.key})}
  }
  // Keep explicit exclusions even if the provider is currently absent. A later native/provider
  // discovery must not turn a missing row into an accidentally enabled global resource.
  for(const override of document.overrides){
    if(override.projectId===projectId&&override.mode==='disabled'&&!plan.blocked.some(e=>capabilityIdentity(e)===capabilityIdentity(override)))plan.blocked.push({kind:override.kind,key:override.key})
  }
  return plan
}
