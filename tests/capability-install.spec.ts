import {afterEach,describe,expect,it} from 'vitest'
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {parseSkillBundle,safeRelativePath,unzipSkill} from '../src/capabilities/bundle.ts'
import {CapabilityRepository} from '../src/capabilities/repository.ts'
import {emptyDocument} from '../src/capabilities/model.ts'
import type {CapabilityDocument} from '../src/capabilities/model.ts'
const md='---\nname: review\ndescription: Review code\n---\nCheck changes.'
const file=(path='SKILL.md',text=md)=>({path,data:Buffer.from(text).toString('base64')})
const clean:string[]=[];afterEach(async()=>{for(const p of clean.splice(0))await rm(p,{recursive:true,force:true})})
async function fixture(){const root=await mkdtemp(join(tmpdir(),'matou-cap-'));clean.push(root);let doc:CapabilityDocument|undefined;let fail=false;const repo=new CapabilityRepository({get:()=>doc,put:async next=>{if(fail)throw Error('disk full');doc=next}},root,()=>[{id:'p',title:'Project',path:'/project'}]);return{repo,root,fail:()=>{fail=true}}}
describe('skill bundle validation',()=>{
  it('reads YAML and preserves resources beneath one root',()=>{const b=parseSkillBundle([file('folder/SKILL.md'),file('folder/references/tips.md','hello')]);expect(b.name).toBe('review');expect(b.content).toBe('Check changes.');expect(b.files.map(f=>f.path)).toEqual(['references/tips.md','SKILL.md'].sort((a,b)=>a.localeCompare(b)));expect(b.digest).toHaveLength(64)})
  it('normalizes one flat Markdown file',()=>expect(parseSkillBundle([file('review.md')]).files[0]?.path).toBe('SKILL.md'))
  it.each(['../oops','x/../oops','/etc/foo','C:/foo','a\\b','a//b','a/./b'])('rejects path %s',p=>expect(()=>safeRelativePath(p)).toThrow())
  it('rejects duplicate and case-colliding paths',()=>expect(()=>parseSkillBundle([file(),file('skill.md')])).toThrow('重复'))
  it('rejects missing metadata, invalid identity and malformed YAML',()=>{for(const content of ['text','---\nname: Bad Name\ndescription: ok\n---\ntext','---\nname: review\nname: other\ndescription: ok\n---\ntext'])expect(()=>parseSkillBundle([file('SKILL.md',content)])).toThrow()})
  it('supports multiline YAML descriptions and invocation controls',()=>{const b=parseSkillBundle([file('SKILL.md','---\nname: review\ndescription: |\n  First line\n  Second line\ndisable-model-invocation: true\nuser-invocable: false\n---\nBody')]);expect(b.description).toContain('Second line');expect(b.invocation).toEqual({modelInvocable:false,userInvocable:false})})
  it('rejects directory/file collisions and outer files',()=>{expect(()=>parseSkillBundle([file(),file('a','text'),file('a/b','text')])).toThrow('重名');expect(()=>parseSkillBundle([file('folder/SKILL.md'),file('outside.txt','text')])).toThrow('之外')})
  it('rejects malformed archive and base64',()=>{expect(()=>unzipSkill(Buffer.from('bad'))).toThrow();expect(()=>parseSkillBundle([{path:'SKILL.md',data:'!!!'}])).toThrow('编码')})
})
describe('durable capability mutations',()=>{
  it('installs immutable files and restores configuration without deleting package files',async()=>{const {repo}=await fixture();const p=repo.preview([file()]);const first=await repo.mutate({action:'install',token:p.token,scope:{kind:'global'},expectedRevision:0});const e=first.entries[0]!;expect(await readFile(e.path!,'utf8')).toBe(md);expect(first.revision).toBe(1);await repo.mutate({action:'remove',id:e.id,expectedRevision:1});const restored=await repo.mutate({action:'restore',index:0,expectedRevision:2});expect(restored.entries[0]?.id).toBe(e.id);expect(await readFile(e.path!,'utf8')).toBe(md)})
  it('serializes simultaneous writers and rejects a stale revision',async()=>{const {repo}=await fixture();const a=repo.preview([file()]),b=repo.preview([file()]);const results=await Promise.allSettled([a,b].map(p=>repo.mutate({action:'install',token:p.token,scope:{kind:'global'},expectedRevision:0})));expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(repo.snapshot().entries).toHaveLength(1)})
  it('preserves global and project entries with the same identity',async()=>{const {repo}=await fixture();for(const [index,scope] of [{kind:'global' as const},{kind:'projects' as const,projectIds:['p']}].entries()){const p=repo.preview([file()]);await repo.mutate({action:'install',token:p.token,scope,expectedRevision:index})}expect(repo.snapshot().entries).toHaveLength(2)})
  it('blocks silent replacement and unknown projects',async()=>{const {repo}=await fixture();const p=repo.preview([file()]);await repo.mutate({action:'install',token:p.token,scope:{kind:'global'},expectedRevision:0});const other=repo.preview([file()]);await expect(repo.mutate({action:'install',token:other.token,scope:{kind:'global'},expectedRevision:1})).rejects.toThrow('替换');await expect(repo.mutate({action:'install',token:other.token,scope:{kind:'projects',projectIds:['missing']},expectedRevision:1})).rejects.toThrow('不存在')})
  it('replaces after confirmation and retains old version for restore',async()=>{const {repo}=await fixture();const p=repo.preview([file()]);const first=await repo.mutate({action:'install',token:p.token,scope:{kind:'global'},expectedRevision:0});const p2=repo.preview([file('SKILL.md',md+'\nnew')]);const next=await repo.mutate({action:'install',token:p2.token,scope:{kind:'global'},replaceId:first.entries[0]!.id,expectedRevision:1});expect(next.entries[0]?.path).not.toBe(first.entries[0]?.path);expect(await readFile(first.entries[0]!.path!,'utf8')).toBe(md);const restored=await repo.mutate({action:'restore',index:0,expectedRevision:2});expect(restored.entries[0]?.path).toBe(next.entries[0]?.path)})
  it('cleans files and keeps state on a failed durable write',async()=>{const {repo,root,fail}=await fixture();const p=repo.preview([file()]);fail();await expect(repo.mutate({action:'install',token:p.token,scope:{kind:'global'},expectedRevision:0})).rejects.toThrow('disk full');expect(repo.snapshot()).toEqual(emptyDocument());expect(await readdir(join(root,'packages'))).toEqual([])})
  it('does not accept client-supplied skill paths or create skills through save',async()=>{const {repo}=await fixture();await expect(repo.mutate({action:'save',expectedRevision:0,entry:{id:'x',kind:'skill',key:'review',title:'x',description:'x',scope:{kind:'global'},enabled:true,createdAt:0,updatedAt:0,source:'local',path:'/etc/passwd'}})).rejects.toThrow('导入')})
})

// Tiny ZIP writer keeps archive tests independent of the production reader.
function zip(path:string,body:Buffer,mode=0o100644):Buffer {
  const name=Buffer.from(path);let crc=0xffffffff;for(const b of body){crc^=b;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}crc=(crc^0xffffffff)>>>0
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(body.length,18);local.writeUInt32LE(body.length,22);local.writeUInt16LE(name.length,26)
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(0x0314,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);central.writeUInt32LE(body.length,20);central.writeUInt32LE(body.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE((mode<<16)>>>0,38)
  const offset=local.length+name.length+body.length,end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+name.length,12);end.writeUInt32LE(offset,16)
  return Buffer.concat([local,name,body,central,name,end])
}
describe('ZIP boundary checks',()=>{
  it('imports a valid archive and verifies contents',()=>{const b=parseSkillBundle([{path:'skill.zip',data:zip('review/SKILL.md',Buffer.from(md)).toString('base64')}]);expect(b.name).toBe('review');expect(b.files[0]?.path).toBe('SKILL.md')})
  it('rejects traversal and symbolic links before extracting',()=>{expect(()=>unzipSkill(zip('../SKILL.md',Buffer.from(md)))).toThrow('路径');expect(()=>unzipSkill(zip('SKILL.md',Buffer.from(md),0o120777))).toThrow('链接')})
  it('rejects corrupt file data',()=>{const archive=zip('SKILL.md',Buffer.from(md));archive[40]=archive[40]!^1;expect(()=>unzipSkill(archive)).toThrow('校验')})
  it('rejects declared decompression bombs',()=>{const archive=zip('SKILL.md',Buffer.from(md));const central=30+8+Buffer.byteLength(md);archive.writeUInt32LE(9*1024*1024,central+24);expect(()=>unzipSkill(archive)).toThrow('大小')})
  it('rejects duplicate local and central names',()=>{const archive=zip('SKILL.md',Buffer.from(md));archive[30]='X'.charCodeAt(0);expect(()=>unzipSkill(archive)).toThrow('不一致')})
})
