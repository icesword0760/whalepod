import {act,cleanup,fireEvent,render,screen} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import {CapabilityPanel} from '../src/client/capabilities/Panel.tsx'
import type {CapabilityResult,ManagedCapability} from '../src/capabilities/model.ts'
afterEach(()=>{cleanup();vi.useRealTimers()})
const state={getSnapshot:()=>true,subscribe:()=>()=>{}}
const entry=(id:string,local=false):ManagedCapability=>({id,kind:'skill',key:'review',title:local?'项目审查':'全局审查',description:'Review code',scope:local?{kind:'projects',projectIds:['p']}:{kind:'global'},enabled:true,source:'local',createdAt:1,updatedAt:1})
const result=(entries:ManagedCapability[]=[]):CapabilityResult=>({document:{revision:3,entries,overrides:[],history:[]},projects:[{id:'p',title:'演示项目',path:'/fixture'}]})
async function mount(data=result()){
 const request=vi.fn().mockResolvedValue(data),close=vi.fn()
 render(<CapabilityPanel state={state} request={request} close={close}/>)
 await act(async()=>{})
 return {request,close}
}
it('loads only metadata initially, recovers from an error, and opens simple import',async()=>{
 const request=vi.fn().mockRejectedValueOnce(new Error('暂时离线')).mockResolvedValue(result())
 render(<CapabilityPanel state={state} request={request} close={()=>{}}/>)
 await act(async()=>{})
 expect(screen.getByRole('alert').textContent).toContain('暂时离线')
 fireEvent.click(screen.getByText('刷新配置'));await act(async()=>{})
 expect(screen.queryByRole('alert')).toBeNull()
 fireEvent.click(screen.getByText('＋ 导入技能'))
 expect(screen.getByText('拖拽文件或点击上传')).toBeTruthy()
 expect(screen.getByLabelText('全局')).toBeTruthy()
 fireEvent.click(screen.getByLabelText('指定项目'))
 expect(screen.getByText('演示项目')).toBeTruthy()
})
it('project view shows one winning row and disables only this project',async()=>{
 const {request}=await mount(result([entry('g'),entry('p',true)]))
 fireEvent.change(screen.getByLabelText('查看生效范围'),{target:{value:'p'}})
 expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
 fireEvent.click(screen.getByRole('switch'));await act(async()=>{})
 expect(request).toHaveBeenLastCalledWith({action:'override',override:{kind:'skill',key:'review',projectId:'p',mode:'disabled'},expectedRevision:3})
})
it('allows an explicitly disabled baseline to be enabled only in a selected project',async()=>{
 const {request}=await mount(result([{...entry('g'),enabled:false}]))
 fireEvent.change(screen.getByLabelText('查看生效范围'),{target:{value:'p'}})
 fireEvent.click(screen.getByRole('switch'));await act(async()=>{})
 expect(request.mock.calls.at(-1)?.[0].override.mode).toBe('enabled')
})
it('loads a skill body on demand, not during listing',async()=>{
 const {request}=await mount(result([entry('g')]))
 expect(request).toHaveBeenCalledTimes(1)
 request.mockResolvedValueOnce({...result([entry('g')]),text:'BODY'})
 fireEvent.click(screen.getByText('查看技能说明'));await act(async()=>{})
 expect(screen.getByText('BODY')).toBeTruthy()
 expect(request).toHaveBeenLastCalledWith({action:'read',id:'g'})
})
it('debounces search and paginates instead of mounting every row',async()=>{
 vi.useFakeTimers()
 await mount(result(Array.from({length:85},(_,i)=>({...entry(String(i)),key:'skill-'+i,title:'Skill '+i}))))
 expect(screen.getByText('1 / 3')).toBeTruthy()
 expect(screen.queryByRole('button',{name:/Skill 84/})).toBeNull()
 fireEvent.change(screen.getByLabelText('搜索技能或连接器'),{target:{value:'Skill 84'}})
 await act(async()=>{vi.advanceTimersByTime(150)})
 expect(screen.getByRole('button',{name:/Skill 84/})).toBeTruthy()
 expect(screen.queryByText('1 / 3')).toBeNull()
})
it('keeps a removal pending until explicit confirmation',async()=>{
 const {request}=await mount(result([entry('g'),entry('p',true)]))
 fireEvent.change(screen.getByLabelText('查看生效范围'),{target:{value:'p'}})
 fireEvent.click(screen.getByText('移除…'))
 expect(request).toHaveBeenCalledTimes(1)
 expect(screen.getByText('确认移除，恢复全局')).toBeTruthy()
 fireEvent.click(screen.getByText('移除并在此项目停用'));await act(async()=>{})
 expect(request).toHaveBeenLastCalledWith({action:'remove',id:'p',expectedRevision:3,disableInProject:'p'})
})
it('presents version history as configuration restoration with explicit inline confirmation',async()=>{
 const data=result();data.document.history=[{time:1,label:'修改范围'}]
 const {request}=await mount(data)
 fireEvent.click(screen.getByText('配置历史'))
 fireEvent.click(screen.getByText('恢复此配置'))
 expect(request).toHaveBeenCalledTimes(1)
 fireEvent.click(screen.getByText('确认恢复'));await act(async()=>{})
 expect(request).toHaveBeenLastCalledWith({action:'restore',index:0,expectedRevision:3})
})
it('clears the previous tool-success result before a failed reconnect',async()=>{
 const connector={...entry('mcp'),kind:'mcp' as const,mcp:{transport:'streamable-http' as const,url:'http://localhost/mcp',headerEnv:{}}}
 const {request}=await mount(result([connector]))
 fireEvent.click(screen.getByText('连接器 MCP'))
 request.mockResolvedValueOnce({...result([connector]),tools:['mcp__fixture__echo']})
 fireEvent.click(screen.getByText('测试连接'));await act(async()=>{})
 expect(screen.getByText('mcp__fixture__echo')).toBeTruthy()
 request.mockRejectedValueOnce(new Error('连接测试失败'))
 fireEvent.click(screen.getByText('测试连接'));await act(async()=>{})
 expect(screen.queryByText('mcp__fixture__echo')).toBeNull()
 expect(screen.getByRole('alert').textContent).toContain('连接测试失败')
})
