import {afterEach,expect,it} from 'vitest'
import {Context} from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {createScope} from '@deepseek-ai/dsh-scope'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {registerCapabilityRuntime,probeConnector,mcpConfig} from '../src/capabilities/runtime.ts'
import {emptyDocument} from '../src/capabilities/model.ts'
import type {ManagedCapability} from '../src/capabilities/model.ts'
const roots:Context[]=[]
afterEach(async()=>{await Promise.all(roots.flatMap(ctx=>[...ctx.registry.values()].flatMap(r=>[...r.fibers].map(f=>f.dispose()))));roots.length=0})
const skill=(id:string,local=false):ManagedCapability=>({id,kind:'skill',key:'review',title:'Review',description:'Review code',scope:local?{kind:'projects',projectIds:['project']}:{kind:'global'},enabled:true,source:'local',content:id,createdAt:1,updatedAt:1})
async function setup(entries:ManagedCapability[]){
 const ctx=new Context();roots.push(ctx)
 await ctx.plugin(SystemPrompt,{});await ctx.plugin(ToolRuntime);await ctx.plugin(SkillRegistry,{})
 const document={...emptyDocument(),entries}
 await ctx.plugin({name:'managed-test',inject:['skills','tools','systemPrompt'],apply(c:Context){registerCapabilityRuntime(c,()=>structuredClone(document),()=>[{id:'project',title:'Project',path:'/fixture/project'}])}})
 async function agent(cwd='/fixture/project'){
  const agent={session:{header:{cwd}}} as Agent
  await ctx.plugin({name:'agent-test',inject:['skills','tools','systemPrompt'],apply(c:Context){Object.assign(agent,{ctx:createScope(c,agent).ctx})}})
  return agent
 }
 return {ctx,document,agent}
}
it('loads the project winner before the very first assembly and pins active agents',async()=>{
 const {ctx,document,agent}=await setup([skill('global'),skill('project',true)])
 const a=await agent()
 await ctx.systemPrompt.assemble({scope:a,agent:a})
 expect((await ctx.skills.get('review',{scope:a}))?.content).toBe('project')
 expect(await ctx.skills.get('review')).toBeUndefined()
 document.entries[1]!.enabled=false
 await ctx.systemPrompt.assemble({scope:a,agent:a})
 expect((await ctx.skills.get('review',{scope:a}))?.content).toBe('project')
 const b=await agent();await ctx.systemPrompt.assemble({scope:b,agent:b})
 expect((await ctx.skills.list({scope:b}))[0]?.invocation.modelInvocable).toBe(false)
 expect(await ctx.skills.get('review',{scope:b})).toBeUndefined()
 const c=await agent('/other');await ctx.systemPrompt.assemble({scope:c,agent:c})
 expect((await ctx.skills.get('review',{scope:c}))?.content).toBe('global')
})
it('awaits asynchronous pre-assembly registrations and propagates startup failures',async()=>{
 const {ctx}=await setup([])
 let calls=0
 ctx.on('system-prompt/before-assemble',async()=>{await Promise.resolve();if(++calls===1)ctx.systemPrompt.section({name:'late',order:12,text:'READY'});else throw new Error('startup failed')})
 expect((await ctx.systemPrompt.assemble()).sections.some(s=>s.text==='READY')).toBe(true)
 await expect(ctx.systemPrompt.assemble()).rejects.toThrow('startup failed')
})
it('rejects missing credentials without exposing environment values',()=>{
 const entry={...skill('x'),kind:'mcp' as const,mcp:{transport:'stdio' as const,command:'node',args:[],envNames:['MATOU_MISSING_TEST_TOKEN']}}
 expect(()=>mcpConfig(entry,'/tmp')).toThrow('MATOU_MISSING_TEST_TOKEN')
})
it('probes a real stdio MCP process in isolation and returns tool names',async()=>{
 const script=`let buffer='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line)continue;const r=JSON.parse(line);if(r.id===undefined)continue;let result={};if(r.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1.0'}};if(r.method==='tools/list')result={tools:[{name:'echo',description:'Fixture',inputSchema:{type:'object',properties:{}}}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n')}})`
 const entry:ManagedCapability={...skill('mcp'),kind:'mcp',key:'fixture',source:'external',mcp:{transport:'stdio',command:process.execPath,args:['-e',script],envNames:[]}}
 expect(await probeConnector(entry,'/tmp')).toEqual(['mcp__fixture__echo'])
},20000)
it('allows project-only enable without changing the globally disabled entry',async()=>{
 const {ctx,document,agent}=await setup([{...skill('global'),enabled:false}])
 document.overrides=[{kind:'skill',key:'review',projectId:'project',mode:'enabled'}]
 const a=await agent();await ctx.systemPrompt.assemble({scope:a,agent:a})
 expect((await ctx.skills.get('review',{scope:a}))?.content).toBe('global')
 const b=await agent('/other');await ctx.systemPrompt.assemble({scope:b,agent:b})
 expect(await ctx.skills.get('review',{scope:b})).toBeUndefined()
 expect(document.entries[0]?.enabled).toBe(false)
})
it('releases agent registrations when the layout runtime is unloaded',async()=>{
 const {ctx,agent}=await setup([skill('global')])
 const a=await agent();await ctx.systemPrompt.assemble({scope:a,agent:a})
 expect(await ctx.skills.get('review',{scope:a})).toBeDefined()
 const runtime=[...ctx.registry.values()].find(r=>[...r.fibers].some(f=>f.name==='managed-test'))
 if(!runtime)throw new Error('test runtime missing')
 await Promise.all([...runtime.fibers].map(f=>f.dispose()))
 expect(await ctx.skills.get('review',{scope:a})).toBeUndefined()
})
