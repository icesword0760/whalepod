import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-skill'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import type { Config as McpConfig } from '@deepseek-ai/dsh-mcp-client'
import process from 'node:process'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { runtimePlan } from './runtime-plan.ts'
import type { CapabilityDocument, ManagedCapability } from './model.ts'
import type { ProjectRef } from './repository.ts'
export function mcpConfig(entry:ManagedCapability,cwd:string):McpConfig {
  const config=entry.mcp;if(!config)throw new Error('连接器缺少连接配置')
  const env=process.env as Record<string,string|undefined>
  const read=(key:string)=>{const value=env[key];if(value===undefined)throw new Error(`缺少凭据环境变量：${key}`);return value}
  const base={serverName:entry.key,toolCallTimeoutMs:60000,failOnStartupError:true,reconnect:{enabled:true,initialDelayMs:1000,maxDelayMs:10000,maxAttempts:3}}
  return config.transport==='stdio'?{...base,transport:'stdio',command:config.command,args:config.args,cwd,env:Object.fromEntries(config.envNames.map(key=>[key,read(key)]))}:{...base,transport:'streamable-http',url:config.url,headers:Object.fromEntries(Object.entries(config.headerEnv).map(([key,value])=>[key,read(value)]))}
}
/** Each agent pins a document at its first assembly; startup is awaited before the first tools snapshot. */
export function registerCapabilityRuntime(ctx:Context,snapshot:()=>CapabilityDocument,projects:()=>readonly ProjectRef[]):void {
  const ready=new WeakMap<Agent,Promise<void>>()
  ctx.on('system-prompt/before-assemble',async context=>{
    const agent=context.agent;if(!agent)return
    let pending=ready.get(agent)
    if(!pending){
      pending=prepareAgent(ctx,agent,snapshot(),projects()).catch(e=>{ready.delete(agent);throw e})
      ready.set(agent,pending)
    }
    await pending
  })
}
async function prepareAgent(owner:Context,agent:Agent,document:CapabilityDocument,projects:readonly ProjectRef[]){
  const cwd=agent.session.header.cwd
  const project=cwd?projects.filter(p=>resolve(cwd)===resolve(p.path)).sort((a,b)=>a.id.localeCompare(b.id))[0]:undefined
  const plan=runtimePlan(document,project?.id??null)
  if(!plan.skills.length&&!plan.connectors.length&&!plan.blocked.length)return
  const handle=agent.ctx.plugin({name:'matou-managed-capabilities',inject:['skills','tools'],async apply(scope:Context){
    const definitions=plan.skills.map(entry=>({name:entry.key,description:entry.description,content:entry.content??'',path:entry.path,source:entry.scope.kind==='global'?'matou-global':'matou-project',provider:'matou-managed',invocation:entry.invocation??{modelInvocable:true,userInvocable:true},...(entry.path?{resourceBase:{kind:'directory' as const,path:dirname(entry.path)}}:{})}))
    const blocked=plan.blocked.filter(e=>e.kind==='skill').map(entry=>({name:entry.key,description:'此项目已停用',content:'',source:'matou-disabled',provider:'matou-managed',invocation:{modelInvocable:false,userInvocable:false}}))
    const all=[...definitions,...blocked]
    scope.skills.registerProvider(()=>({name:'matou-managed',list:async()=>all.map((d,index)=>({...d,rank:-100,locator:index})),get:async candidate=>{const d=all[candidate.locator as number];return d&&d.invocation.modelInvocable===false&&d.invocation.userInvocable===false?undefined:d}}))
    // Managed connectors are never registered globally: only one resolved instance enters this agent.
    // Reject native namespace collisions rather than leaking unmatched native tools through a partial shadow.
    const nativeNames=scope.tools.schemas(agent).map(t=>t.name)
    for(const entry of [...plan.connectors,...plan.blocked.filter(e=>e.kind==='mcp')])if(nativeNames.some(name=>name.startsWith(`mcp__${entry.key}__`)))throw new Error(`连接器 ${entry.key} 已由原生插件加载，请先在原插件中停用再交给此管理器，避免重复工具。`)
    for(const entry of plan.connectors){
      const plugin=scope.plugin(mcpClient,mcpConfig(entry,cwd??homedir()))
      let timer:ReturnType<typeof setTimeout>|undefined
      try{await Promise.race([plugin.await(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(`连接器 ${entry.title} 连接超时，请检查配置后重试`)),15000)})])}finally{clearTimeout(timer)}
    }
  }})
  // Ownership is dual: agent unload and layout-plugin unload both release the registrations.
  owner.effect(()=>()=>handle.dispose(),'matou-capabilities:agent')
  try{await handle.await()}catch(e){await handle.dispose();throw e}
}
/** Probe in a separate Cordis root: collects tools only, never exposes them to a real agent. */
export async function probeConnector(entry:ManagedCapability,cwd:string):Promise<string[]> {
  const {Context}=await import('@deepseek-ai/cordis');const probe=new Context(),names=new Set<string>()
  probe.provide('tools',{register:(definition:{name:string})=>{names.add(definition.name);return()=>{names.delete(definition.name)}}} as unknown as Context['tools'])
  const handle=probe.plugin(mcpClient,{...mcpConfig(entry,cwd),reconnect:{enabled:false}})
  let timer:ReturnType<typeof setTimeout>|undefined
  try{await Promise.race([handle.await(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('连接超时，请检查地址、启动命令或凭据')),12000)})]);return [...names]}finally{clearTimeout(timer);await handle.dispose()}
}
