import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, rename, rm, chmod } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { parseSkillBundle } from './bundle.ts'
import type { SkillBundle } from './bundle.ts'
import { conflictingProjects, capabilityIdentity } from './resolution.ts'
import { emptyDocument, documentSchema, publicDocument } from './model.ts'
import type { CapabilityDocument, CapabilityRequest, InstallPreview, ManagedCapability } from './model.ts'
export interface CapabilityStorage { get():CapabilityDocument|undefined; put(value:CapabilityDocument):Promise<void> }
export interface ProjectRef {id:string;title:string;path:string}
/** Immutable packages plus one atomic DSH metadata document; old packages remain available to history. */
export class CapabilityRepository {
  private tail:Promise<unknown>=Promise.resolve()
  private previews=new Map<string,{bundle:SkillBundle;time:number}>()
  constructor(private storage:CapabilityStorage,private root:string,private projects:()=>readonly ProjectRef[],private now=()=>Date.now()){}
  snapshot():CapabilityDocument{return structuredClone(this.storage.get()??emptyDocument())}
  publicSnapshot(){return publicDocument(this.storage.get()??emptyDocument())}
  runtimeSnapshot(){const doc=this.storage.get()??emptyDocument();return structuredClone({...doc,history:[]})}
  preview(files:Extract<CapabilityRequest,{action:'preview'}>['files']):InstallPreview {
    for(const [key,p] of this.previews)if(this.now()-p.time>600000)this.previews.delete(key)
    if(this.previews.size>=4)this.previews.delete(this.previews.keys().next().value!)
    const bundle=parseSkillBundle(files),token=randomUUID();this.previews.set(token,{bundle,time:this.now()})
    return{token,name:bundle.name,description:bundle.description,files:bundle.files.map(f=>f.path),warnings:bundle.warnings,digest:bundle.digest}
  }
  mutate(input:Exclude<CapabilityRequest,{action:'list'|'preview'|'read'|'test'}>):Promise<CapabilityDocument>{
    const operation=this.tail.then(()=>this.change(input));this.tail=operation.catch(()=>undefined);return operation
  }
  async drain(){await this.tail}
  private validateScope(entry:ManagedCapability){if(entry.scope.kind==='projects'){const ids=new Set(this.projects().map(p=>p.id));if(entry.scope.projectIds.some(p=>!ids.has(p)))throw new Error('所选项目已不存在，请刷新后重试');entry.scope.projectIds=[...new Set(entry.scope.projectIds)]}}
  private validateConflicts(entries:ManagedCapability[]){for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++){const overlap=conflictingProjects(entries[i]!,entries[j]!);if(overlap==='global'||overlap.length)throw new Error('相同标识已在所选范围安装，请明确选择替换已有配置')}}
  private async change(input:Exclude<CapabilityRequest,{action:'list'|'preview'|'read'|'test'}>):Promise<CapabilityDocument>{
    const before=this.snapshot();if(input.expectedRevision!==before.revision)throw new Error('配置已被其他操作更新，请刷新后重试')
    const next=structuredClone(before);let packagePath:string|undefined,label='修改配置',previewToken:string|undefined
    try{
      if(input.action==='install'){
        const pending=this.previews.get(input.token);if(!pending||this.now()-pending.time>600000)throw new Error('导入预览已过期，请重新选择文件')
        const b=pending.bundle,prior=input.replaceId?next.entries.find(e=>e.id===input.replaceId):undefined
        if(input.replaceId&&(!prior||prior.kind!=='skill'||prior.key!==b.name))throw new Error('替换目标不匹配，请重新确认')
        // Replacing one multi-project record must not silently change its other project assignments.
        if(prior&&JSON.stringify(prior.scope.kind==='projects'?{kind:'projects',projectIds:[...prior.scope.projectIds].sort()}:prior.scope)!==JSON.stringify(input.scope.kind==='projects'?{kind:'projects',projectIds:[...input.scope.projectIds].sort()}:input.scope))throw new Error('替换时请保留原生效范围，范围调整请单独操作')
        const id=prior?.id??randomUUID(),version=randomUUID()
        packagePath=join(this.root,'packages',version)
        const entry:ManagedCapability={id,kind:'skill',key:b.name,title:b.name,description:b.description,scope:input.scope,enabled:prior?.enabled??true,createdAt:prior?.createdAt??this.now(),updatedAt:this.now(),source:'local',path:join(packagePath,'SKILL.md'),content:b.content,digest:b.digest,invocation:b.invocation}
        this.validateScope(entry);next.entries=next.entries.filter(e=>e.id!==id);next.entries.push(entry);this.validateConflicts(next.entries)
        await mkdir(this.root,{recursive:true,mode:0o700});await chmod(this.root,0o700)
        const staging=join(this.root,`staging-${version}`)
        try{await mkdir(staging,{mode:0o700});for(const file of b.files){const target=join(staging,file.path);await mkdir(dirname(target),{recursive:true,mode:0o700});await writeFile(target,file.data,{flag:'wx',mode:0o600})}await mkdir(dirname(packagePath),{recursive:true,mode:0o700});await rename(staging,packagePath)}finally{await rm(staging,{recursive:true,force:true})}
        previewToken=input.token;label=prior?'替换技能':'安装技能'
      }else if(input.action==='save'){
        const data=input.entry,prior=next.entries.find(e=>e.id===data.id)
        if(!prior&&data.kind!=='mcp')throw new Error('请通过导入安装技能')
        if(prior&&(prior.key!==data.key||prior.kind!==data.kind))throw new Error('标识创建后保持不变，请另建配置')
        const entry:ManagedCapability=prior?{...prior,title:data.title,description:data.description,scope:data.scope,enabled:data.enabled,updatedAt:this.now()}: {...data,id:randomUUID(),createdAt:this.now(),updatedAt:this.now()}
        if(entry.kind==='mcp'){
          if(!data.mcp||!/^[A-Za-z0-9_-]{1,32}$/.test(data.key))throw new Error('连接器需要有效的连接标识和配置')
          if(data.mcp.transport==='streamable-http'){
            const url=new URL(data.mcp.url);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('连接地址需为 HTTP(S)，凭据请使用环境变量')
            if(Object.values(data.mcp.headerEnv).some(v=>!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)))throw new Error('凭据环境变量名称无效')
          }else if(data.mcp.envNames.some(v=>!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)))throw new Error('环境变量名称无效')
          entry.mcp=data.mcp;entry.source=data.mcp.transport==='stdio'?'external':'remote';delete entry.path;delete entry.content;delete entry.digest
        }
        this.validateScope(entry);next.entries=next.entries.filter(e=>e.id!==entry.id);next.entries.push(entry);this.validateConflicts(next.entries)
      }else if(input.action==='remove'){
        const entry=next.entries.find(e=>e.id===input.id);if(!entry)throw new Error('条目已不存在')
        next.entries=next.entries.filter(e=>e.id!==entry.id)
        if(input.disableInProject){if(!this.projects().some(p=>p.id===input.disableInProject))throw new Error('项目已不存在');next.overrides=next.overrides.filter(o=>!(o.projectId===input.disableInProject&&capabilityIdentity(o)===capabilityIdentity(entry)));next.overrides.push({kind:entry.kind,key:entry.key,projectId:input.disableInProject,mode:'disabled'})}
        label='移除配置（文件保留）'
      }else if(input.action==='override'){
        const override=input.override;if(!this.projects().some(p=>p.id===override.projectId))throw new Error('项目已不存在')
        next.overrides=next.overrides.filter(o=>!(o.projectId===override.projectId&&capabilityIdentity(o)===capabilityIdentity(override)));next.overrides.push(override);label='修改项目覆盖'
      }else{
        const history=before.history[input.index];if(!history)throw new Error('历史记录已不存在')
        // Configuration history never rolls installed skill code back. Resolve the latest retained
        // package for each identity even if that entry is currently removed.
        const latest=new Map<string,ManagedCapability>()
        for(const entry of [...before.entries,...before.history.flatMap(h=>h.config.entries)])if(!latest.has(entry.id))latest.set(entry.id,entry)
        next.entries=structuredClone(history.config.entries).map(entry=>{
          const installed=latest.get(entry.id)
          if(entry.kind!=='skill'||!installed)return entry
          return {...installed,title:entry.title,scope:entry.scope,enabled:entry.enabled,updatedAt:this.now()}
        });next.overrides=structuredClone(history.config.overrides);for(const entry of next.entries)this.validateScope(entry);label='恢复配置'
      }
      next.history=[{time:this.now(),label,config:{entries:before.entries,overrides:before.overrides}},...before.history].slice(0,30);next.revision++
      await this.storage.put(documentSchema.parse(next));if(previewToken)this.previews.delete(previewToken);return structuredClone(next)
    }catch(error){if(packagePath)await rm(packagePath,{recursive:true,force:true});throw error}
  }
}
