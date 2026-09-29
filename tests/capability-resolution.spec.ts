import { describe, expect, it } from 'vitest'
import { resolveCapabilities, conflictingProjects } from '../src/capabilities/resolution.ts'
import type { CapabilityEntry } from '../src/capabilities/resolution.ts'
const global: CapabilityEntry = { id:'g', kind:'skill', key:'review', title:'审查', scope:{kind:'global'}, enabled:true }
const local: CapabilityEntry = {...global,id:'p',scope:{kind:'projects',projectIds:['p1']}}
describe('capability project/global resolution',()=>{
  it('uses stable identity, not display labels',()=>{
    expect(resolveCapabilities([global,{...local,key:'other'}],'p1')).toHaveLength(2)
    expect(resolveCapabilities([global,{...local,title:'不同名称'}],'p1')[0]?.effective?.id).toBe('p')
  })
  it('project wins and global remains inspectable',()=>{
    const [result]=resolveCapabilities([global,local],'p1')
    expect(result?.effective?.id).toBe('p');expect(result?.shadowed).toEqual([global])
  })
  it('does not leak project capability into other projects or global view',()=>{
    for(const project of ['p2',null])expect(resolveCapabilities([global,local],project)[0]?.effective?.id).toBe('g')
  })
  it('disabled project entry blocks fallback to global',()=>{
    const [r]=resolveCapabilities([global,{...local,enabled:false}],'p1')
    expect(r?.status).toBe('disabled');expect(r?.effective?.id).toBe('p')
  })
  it('project-only disable of an inherited global entry does not affect other projects',()=>{
    const overrides=[{kind:'skill' as const,key:'review',projectId:'p1',mode:'disabled' as const}]
    expect(resolveCapabilities([global],'p1',overrides)[0]?.effective).toBeNull()
    expect(resolveCapabilities([global],'p2',overrides)[0]?.status).toBe('enabled')
  })
  it('explicit inherit uses global while retaining project copy',()=>{
    const [r]=resolveCapabilities([global,local],'p1',[{kind:'skill',key:'review',projectId:'p1',mode:'inherit'}])
    expect(r?.effective?.id).toBe('g');expect(r?.shadowed).toEqual([local])
  })
  it('removing project configuration restores global, removing global keeps project',()=>{
    expect(resolveCapabilities([global],'p1')[0]?.effective?.id).toBe('g')
    expect(resolveCapabilities([local],'p1')[0]?.effective?.id).toBe('p')
  })
  it('fails closed for same-scope duplicate identities',()=>{
    for(const entries of [[local,{...local,id:'p3'}],[global,{...global,id:'g3'}]]) {
      const [r]=resolveCapabilities(entries,'p1');expect(r?.status).toBe('conflict');expect(r?.effective).toBeNull()
    }
  })
  it('separates skill and mcp namespaces',()=>expect(resolveCapabilities([global,{...global,id:'m',kind:'mcp'}],'p1')).toHaveLength(2))
  it('finds overlap for multi-project installation, not project/global inheritance',()=>{
    expect(conflictingProjects(local,{...local,id:'x',scope:{kind:'projects',projectIds:['p1','p2']}})).toEqual(['p1'])
    expect(conflictingProjects(local,global)).toEqual([])
    expect(conflictingProjects(global,{...global,id:'g2'})).toBe('global')
  })
})
