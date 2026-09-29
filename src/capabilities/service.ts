import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-workspace'
import process from 'node:process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { documentSchema, requestSchema, publicDocument } from './model.ts'
import type { CapabilityDocument, CapabilityRequest, CapabilityResult } from './model.ts'
import { registerCapabilityRuntime, probeConnector } from './runtime.ts'
import { CapabilityRepository } from './repository.ts'
const domain=defineDomain({name:'matou_capabilities',version:1,tables:{config:domainTable<string,CapabilityDocument>(documentSchema)}})
declare module '@deepseek-ai/cordis'{interface Context{matouCapabilities:MatouCapabilityService}}
export class MatouCapabilityService extends TypertRemoteService {
  static inject=['storageDomain','workspaceRegistry']
  private repository?:CapabilityRepository
  constructor(ctx:Context){super(ctx,'matouCapabilities')}
  private projects(){return this.ctx.workspaceRegistry.list().map(p=>({id:String(p.id),title:p.title,path:p.path}))}
  protected async [Service.init](){
    const storage=await this.ctx.storageDomain.open(domain),table=storage.table('config')
    const repo=new CapabilityRepository({get:()=>table.get('root'),put:async value=>{await table.put('root',value)}},join((process.env as Record<string,string|undefined>)['DSH_HOME']??join(homedir(),'.dsh'),'matou-capabilities'),()=>this.projects())
    this.repository=repo
    this.ctx.inject(['skills','tools','systemPrompt'],scope=>registerCapabilityRuntime(scope,()=>repo.runtimeSnapshot(),()=>this.projects()))
    this.ctx.effect(()=>async()=>{await repo.drain();await storage.close()},'matou-capabilities:close')
  }
  snapshot(){if(!this.repository)throw new Error('管理服务正在加载');return this.repository.snapshot()}
  @Remote('request')
  async request(input:CapabilityRequest):Promise<CapabilityResult>{
    try{
      const request=requestSchema.parse(input);if(!this.repository)throw new Error('管理服务正在加载，请稍后重试')
      const projects=this.projects()
      if(request.action==='list')return{document:this.repository.publicSnapshot(),projects}
      if(request.action==='read'||request.action==='test'){
        const entry=this.repository.snapshot().entries.find(e=>e.id===request.id);if(!entry)throw new Error('条目已不存在，请刷新')
        if(request.action==='read')return{document:this.repository.publicSnapshot(),projects,text:entry.content??'此条目没有技能说明'}
        if(entry.kind!=='mcp')throw new Error('请选择连接器')
        const project=entry.scope.kind==='projects'?projects.find(p=>entry.scope.kind==='projects'&&entry.scope.projectIds.includes(p.id)):undefined
        return{document:this.repository.publicSnapshot(),projects,tools:await probeConnector(entry,project?.path??homedir())}
      }
      if(request.action==='preview')return{document:this.repository.publicSnapshot(),projects,preview:this.repository.preview(request.files)}
      return{document:publicDocument(await this.repository.mutate(request)),projects}
    }catch(e){
      const message=input.action==='test'
        ? '连接测试失败，请检查服务是否运行、地址和环境变量。确认后可再次测试。'
        : e instanceof Error?e.message:'保存失败，请重试'
      throw new RemoteError('gateway/bad-request',message,{})
    }
  }
}
