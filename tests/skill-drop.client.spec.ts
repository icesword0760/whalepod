// @vitest-environment jsdom
import {describe,it,expect,vi} from 'vitest'
import {collectSkillDrop} from '../src/client/capabilities/skill-drop.ts'
function file(name:string,size=1){return {name,size,webkitRelativePath:''} as File}
function leaf(name:string,size=1):FileSystemEntry{return {name,isFile:true,isDirectory:false,file:(ok:(f:File)=>void)=>ok(file(name,size))} as unknown as FileSystemEntry}
function dir(name:string,batches:FileSystemEntry[][]):FileSystemEntry{return {name,isFile:false,isDirectory:true,createReader:()=>{let i=0;return{readEntries:(ok:(x:FileSystemEntry[])=>void)=>ok(batches[i++]??[])}}} as unknown as FileSystemEntry}
function drop(entry:FileSystemEntry){const fake=file(entry.name);return {files:[fake],items:[{kind:'file',webkitGetAsEntry:()=>entry,getAsFile:()=>fake}]} as unknown as DataTransfer}
describe('skill folder drop',()=>{
 it('reads files inside directory instead of the directory File placeholder, preserving nested paths',async()=>{
 const results=await collectSkillDrop(drop(dir('my-skill',[[leaf('SKILL.md'),dir('references',[[leaf('guide.md')]])]])))
 expect(results.map(x=>x.path)).toEqual(['my-skill/SKILL.md','my-skill/references/guide.md'])
 })
 it('drains every directory batch, not only the first 100 entries',async()=>{
 const results=await collectSkillDrop(drop(dir('skill',[Array.from({length:100},(_,i)=>leaf(`${i}.md`)),[leaf('SKILL.md')]])))
 expect(results).toHaveLength(101)
 })
 it('captures drag entries before awaiting and accepts ordinary files',async()=>{
 const data=drop(leaf('SKILL.md'));const promise=collectSkillDrop(data);Object.defineProperty(data,'items',{get:()=>{throw Error('expired')}})
 expect((await promise)[0]?.path).toBe('SKILL.md')
 })
 it('limits counts and bytes before content buffering',async()=>{
 await expect(collectSkillDrop(drop(dir('skill',[Array.from({length:257},(_,i)=>leaf(`${i}`))])))).rejects.toThrow('256')
 await expect(collectSkillDrop(drop(leaf('large',8*1024*1024+1)))).rejects.toThrow('8 MB')
 })
 it('reports empty and missing folders with retry instructions',async()=>{
 await expect(collectSkillDrop(drop(dir('empty',[])))).rejects.toThrow('文件夹为空')
 const broken={name:'gone',isFile:true,file:(_ok:unknown,fail:(e:DOMException)=>void)=>fail(new DOMException('missing','NotFoundError'))} as unknown as FileSystemEntry
 await expect(collectSkillDrop(drop(broken))).rejects.toThrow('重新拖入')
 })
})
