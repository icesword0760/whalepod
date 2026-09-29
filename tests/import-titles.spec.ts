import {expect,it} from 'vitest'
import {DatabaseSync} from 'node:sqlite'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {matouTitles} from '../src/import/titles.ts'
it('reads only active same-project Matou names, without changing its database',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'matou-names-'));const file=join(dir,'matou.sqlite')
 try{
  const db=new DatabaseSync(file)
  db.exec(`CREATE TABLE workspaces(id TEXT,root_directory TEXT,archived_at INTEGER);
   CREATE TABLE tasks(id TEXT,workspace_id TEXT,archived_at INTEGER);
   CREATE TABLE sessions(id TEXT,task_id TEXT,title TEXT,kind TEXT,archived_at INTEGER,updated_at INTEGER);
   CREATE TABLE provider_bindings(session_id TEXT,provider TEXT,provider_session_id TEXT,invalidated_at INTEGER,resume_state TEXT);
   INSERT INTO tasks VALUES('t','w',NULL),('other','elsewhere',NULL);
   INSERT INTO sessions VALUES('s','t','视频制作','claude-code',NULL,1),('old','t','归档名称','claude-code',1,2),('foreign','other','外部项目','claude-code',NULL,3);
   INSERT INTO provider_bindings VALUES('s','claude-code','provider-id',NULL,'resumed'),('old','claude-code','provider-id',NULL,'resumed'),('foreign','claude-code','foreign-id',NULL,'resumed');`)
  db.prepare('INSERT INTO workspaces VALUES(?,?,NULL)').run('w',dir)
  db.close()
  expect(await matouTitles(file,await realpath(dir))).toEqual(new Map([['provider-id','视频制作']]))
  expect(await matouTitles(file,'/another-project')).toEqual(new Map())
  expect(await matouTitles(join(dir,'absent.sqlite'),dir)).toEqual(new Map())
 }finally{await rm(dir,{recursive:true,force:true})}
})
it('uses Codex display name before its raw first-prompt title',async()=>{
 const {codexTitles}=await import('../src/import/titles.ts')
 const dir=await mkdtemp(join(tmpdir(),'codex-names-'))
 try{
  const db=new DatabaseSync(join(dir,'state_5.sqlite'))
  db.exec("CREATE TABLE threads(id TEXT,title TEXT,name TEXT,cwd TEXT,updated_at INTEGER); INSERT INTO threads VALUES('id','raw first prompt','确认视频生成能力','/project',1)")
  db.close()
  expect(await codexTitles(dir,'/project')).toEqual(new Map([['id','确认视频生成能力']]))
 }finally{await rm(dir,{recursive:true,force:true})}
})
