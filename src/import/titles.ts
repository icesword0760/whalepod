import { join } from 'node:path'
/** Optional, read-only Matou display-name overlay. Never adopts its session storage. */
import { realpath, stat, readdir, readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
export async function matouTitles(database:string|null,cwd:string):Promise<Map<string,string>>{
  const result=new Map<string,string>();if(!database)return result
  let db:DatabaseSync|undefined
  try{
    if(!(await stat(database)).isFile())return result
    db=new DatabaseSync(database,{readOnly:true})
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 100;')
    const workspaces=db.prepare('SELECT id, root_directory FROM workspaces WHERE archived_at IS NULL LIMIT 1000').all()
    for(const workspace of workspaces){
      if(typeof workspace.root_directory!=='string'||await realpath(workspace.root_directory).catch(()=>null)!==cwd)continue
      const rows=db.prepare(`SELECT b.provider_session_id, s.title FROM provider_bindings b
        JOIN sessions s ON s.id=b.session_id JOIN tasks t ON t.id=s.task_id
        WHERE t.workspace_id=? AND b.provider='claude-code' AND s.kind='claude-code'
          AND s.archived_at IS NULL AND t.archived_at IS NULL AND b.invalidated_at IS NULL
          AND b.resume_state IN ('unknown','available','resuming','resumed')
        ORDER BY s.updated_at DESC, s.id LIMIT 10000`).all(workspace.id!)
      for(const row of rows)if(typeof row.provider_session_id==='string'&&typeof row.title==='string'&&row.title.trim()&&!result.has(row.provider_session_id))result.set(row.provider_session_id,row.title.trim().slice(0,160))
    }
  }catch{/* Optional source absent, locked or a new schema: retain provider titles. */}
  finally{db?.close()}
  return result
}
export class ClaudeTitle {
  static from(rows:Record<string,unknown>[]){const value=new ClaudeTitle();for(const row of rows)value.accept(row);return value}
  private custom='';private auto='';private summary='';first=''
  accept(row:Record<string,unknown>){
    if(row.isSidechain===true)return
    const text=(value:unknown)=>typeof value==='string'?value.replace(/\s+/g,' ').trim().slice(0,160):''
    if(text(row.customTitle))this.custom=text(row.customTitle)
    if(row.type==='ai-title'&&text(row.aiTitle))this.auto=text(row.aiTitle)
    if(row.type==='summary'&&text(row.summary))this.summary=text(row.summary)
    if(this.first||row.isMeta===true)return
    const msg=row.message as Record<string,unknown>|undefined
    if(!msg||msg.role!=='user')return
    const content=typeof msg.content==='string'?msg.content:Array.isArray(msg.content)?msg.content.flatMap(b=>b?.type==='text'&&typeof b.text==='string'?[b.text]:[]).join('\n'):''
    // These are CLI control records, not the user's topic. Do not alter the imported transcript.
    if(!isUserTopic(content))return
    this.first=text(content)
  }
  get title(){return this.custom||this.auto||this.summary||this.first||'未命名会话'}
}

export function isUserTopic(text:string):boolean{
  return !!text.trim()&&!/^\s*(?:\[Request interrupted by user|<command-name>|<local-command|<system-reminder>|<task-notification>|<environment_context>|<recommended_plugins>|<ide_|<teammate-message>|# AGENTS\.md instructions|This session is being continued from a previous conversation|\/(?:model|clear|compact|login|logout|help)(?:\s|$))/.test(text)
}
/** Codex's current thread titles, with its lightweight JSONL index as fallback. */
export async function codexTitles(home:string,cwd:string):Promise<Map<string,string>>{
  const result=new Map<string,string>()
  try{
    const index=join(home,'session_index.jsonl')
    if((await stat(index)).size<=16*1024*1024)for(const line of (await readFile(index,'utf8')).split('\n')){
      try{const row=JSON.parse(line);if(typeof row.id==='string'&&typeof row.thread_name==='string'&&isUserTopic(row.thread_name))result.set(row.id,row.thread_name.trim().slice(0,160))}catch{}
    }
  }catch{}
  let db:DatabaseSync|undefined
  try{
    const name=(await readdir(home)).filter(n=>/^state_\d+\.sqlite$/.test(n)).sort((a,b)=>Number(b.match(/\d+/)![0])-Number(a.match(/\d+/)![0]))[0]
    if(!name)return result
    db=new DatabaseSync(join(home,name),{readOnly:true});db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 100;')
    const hasName=db.prepare('PRAGMA table_info(threads)').all().some(column=>column.name==='name')
    for(const row of db.prepare(`SELECT id, title, ${hasName?'name':"NULL AS name"} FROM threads WHERE cwd=? ORDER BY updated_at DESC LIMIT 10000`).all(cwd)){
      if(typeof row.id!=='string')continue
      const title=typeof row.name==='string'&&isUserTopic(row.name)?row.name:result.get(row.id)??row.title
      if(typeof title==='string'&&isUserTopic(title))result.set(row.id,title.replace(/\s+/g,' ').trim().slice(0,160))
    }
  }catch{}finally{db?.close()}
  return result
}
