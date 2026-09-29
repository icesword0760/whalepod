import {describe,it,expect} from 'vitest'
import {runtimePlan} from '../src/capabilities/runtime-plan.ts'
import {emptyDocument,publicDocument} from '../src/capabilities/model.ts'
import type {ManagedCapability} from '../src/capabilities/model.ts'
const global:ManagedCapability={id:'g',kind:'skill',key:'review',title:'Review',description:'Review changes',enabled:true,source:'local',scope:{kind:'global'},content:'PRIVATE LARGE BODY',createdAt:0,updatedAt:0}
const local:ManagedCapability={...global,id:'p',scope:{kind:'projects',projectIds:['project']}}
describe('agent activation plans',()=>{
  it('shares project/global resolution with the UI and detaches the pinned snapshot',()=>{const doc=structuredClone({...emptyDocument(),revision:4,entries:[global,local]});const plan=runtimePlan(doc,'project');expect(plan.skills.map(e=>e.id)).toEqual(['p']);doc.entries[1]!.enabled=false;expect(plan.skills[0]?.enabled).toBe(true);expect(plan.revision).toBe(4)})
  it('returns active tombstones instead of an empty provider that allows fallback',()=>{const plan=runtimePlan({...emptyDocument(),entries:[global,{...local,enabled:false}]},'project');expect(plan.skills).toEqual([]);expect(plan.blocked).toEqual([{kind:'skill',key:'review'}])})
  it('uses the same policy for MCP namespaces and excludes other projects',()=>{const entries=[{...global,kind:'mcp' as const},{...local,kind:'mcp' as const}];expect(runtimePlan({...emptyDocument(),entries},'project').connectors[0]?.id).toBe('p');expect(runtimePlan({...emptyDocument(),entries},'other').connectors[0]?.id).toBe('g')})
  it('retains project exclusions for currently absent providers',()=>{expect(runtimePlan({...emptyDocument(),overrides:[{kind:'mcp',key:'github',projectId:'project',mode:'disabled'}]},'project').blocked).toEqual([{kind:'mcp',key:'github'}])})
  it('rejects ambiguous same-scope activation',()=>{expect(()=>runtimePlan({...emptyDocument(),entries:[global,{...global,id:'g2'}]},null)).toThrow('重复')})
  it('keeps skill bodies and full historical configurations out of list responses',()=>{const doc={...emptyDocument(),entries:[global],history:[{time:1,label:'Install',config:{entries:[global],overrides:[]}}]};const result=publicDocument(doc);expect(result.entries).toHaveLength(1);expect(JSON.stringify(result)).not.toContain('PRIVATE LARGE BODY');expect(result.history).toEqual([{time:1,label:'Install'}])})
})
