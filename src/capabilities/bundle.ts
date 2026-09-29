import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { parseDocument } from 'yaml'
import type { UploadFile } from './model.ts'
export const MAX_BUNDLE_BYTES=8*1024*1024
const MAX_FILES=256
export interface SkillBundle {
  name:string; description:string; content:string; digest:string
  invocation:{modelInvocable:boolean;userInvocable:boolean}
  files:Array<{path:string;data:Buffer}>; warnings:string[]
}
export function safeRelativePath(path:string):string {
  if(!path||path.length>1024||/^[\\/]|^[A-Za-z]:|[\x00-\x1f\\]/.test(path)||path.split('/').some(p=>p==='..'||p==='.'||!p))throw new Error('技能包包含无效文件路径')
  return path.normalize('NFC')
}
/** Decode ZIP ourselves to inspect paths/mode/declared and actual sizes before any writes. No code runs. */
export function unzipSkill(data:Buffer):Array<{path:string;data:Buffer}> {
  let end=-1
  for(let p=data.length-22;p>=Math.max(0,data.length-65557);p--)if(data.readUInt32LE(p)===0x06054b50&&p+22+data.readUInt16LE(p+20)===data.length){end=p;break}
  if(end<0)throw new Error('ZIP 文件不完整')
  const count=data.readUInt16LE(end+10),offset=data.readUInt32LE(end+16),size=data.readUInt32LE(end+12)
  if(data.readUInt16LE(end+4)||data.readUInt16LE(end+6)||data.readUInt16LE(end+8)!==count||count>MAX_FILES||offset+size!==end)throw new Error('ZIP 分卷、超大归档或目录格式不受支持')
  const files:Array<{path:string;data:Buffer}>=[];let p=offset,total=0
  for(let n=0;n<count;n++) {
    if(p+46>end||data.readUInt32LE(p)!==0x02014b50)throw new Error('ZIP 目录损坏')
    const flags=data.readUInt16LE(p+8),method=data.readUInt16LE(p+10),compressed=data.readUInt32LE(p+20),length=data.readUInt32LE(p+24),nameLen=data.readUInt16LE(p+28),extra=data.readUInt16LE(p+30),comment=data.readUInt16LE(p+32),mode=data.readUInt32LE(p+38)>>>16,local=data.readUInt32LE(p+42)
    if(p+46+nameLen+extra+comment>end)throw new Error('ZIP 目录损坏')
    const name=data.subarray(p+46,p+46+nameLen).toString('utf8');p+=46+nameLen+extra+comment
    if((mode&0xf000)===0xa000||((mode&0xf000)!==0&& ![0x4000,0x8000].includes(mode&0xf000)))throw new Error('技能包中含有链接或特殊文件')
    if(name.endsWith('/')){safeRelativePath(name.slice(0,-1));continue}
    const path=safeRelativePath(name)
    if(flags&1||![0,8].includes(method))throw new Error('ZIP 加密或压缩方式不受支持')
    total+=length
    if(total>MAX_BUNDLE_BYTES||local+30>offset||data.readUInt32LE(local)!==0x04034b50)throw new Error('技能包超出大小限制或文件头损坏')
    const localNameLen=data.readUInt16LE(local+26),localExtra=data.readUInt16LE(local+28),start=local+30+localNameLen+localExtra
    if(start+compressed>offset||data.subarray(local+30,local+30+localNameLen).toString('utf8')!==name||data.readUInt16LE(local+8)!==method)throw new Error('ZIP 文件头与目录不一致')
    const raw=data.subarray(start,start+compressed)
    const body=method===0?Buffer.from(raw):inflateRawSync(raw,{maxOutputLength:Math.max(1,length)})
    if(body.length!==length||crc32(body)!==data.readUInt32LE(p-(46+nameLen+extra+comment)+16))throw new Error('ZIP 文件校验失败')
    files.push({path,data:body})
  }
  if(p!==end)throw new Error('ZIP 目录长度不一致')
  return files
}
function crc32(data:Buffer):number {let c=0xffffffff;for(const b of data){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0)}return(c^0xffffffff)>>>0}
export function parseSkillBundle(input:UploadFile[]):SkillBundle {
  if(!input.length||input.length>MAX_FILES)throw new Error('请选择技能文件，最多 256 个文件')
  let total=0
  let files:Array<{path:string;data:Buffer}>=input.map(f=>{safeRelativePath(f.path);if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.data))throw new Error('文件编码无效');const data=Buffer.from(f.data,'base64');total+=data.length;if(total>MAX_BUNDLE_BYTES)throw new Error('技能包超过 8 MB');return{path:f.path,data}})
  if(files.length===1&&files[0]!.path.toLowerCase().endsWith('.zip'))files=unzipSkill(files[0]!.data)
  if(!files.length)throw new Error('技能包为空')
  const instructions=files.filter(f=>f.path.split('/').at(-1)==='SKILL.md')
  let main=instructions[0]
  if(instructions.length>1)throw new Error('一次只导入一个技能，请分别选择含 SKILL.md 的目录')
  if(!main&&files.length===1&&files[0]!.path.toLowerCase().endsWith('.md')){main={...files[0]!,path:'SKILL.md'};files=[main]}
  if(!main)throw new Error('技能包缺少 SKILL.md')
  const prefix=main.path.slice(0,-'SKILL.md'.length)
  if(files.some(f=>!f.path.startsWith(prefix)))throw new Error('技能根目录之外还有文件，请只打包技能目录')
  files=files.map(f=>({path:safeRelativePath(f.path.slice(prefix.length)),data:f.data})).sort((a,b)=>a.path.localeCompare(b.path))
  if(new Set(files.map(f=>f.path.toLowerCase())).size!==files.length)throw new Error('技能包包含重复文件名')
  const paths=new Set(files.map(f=>f.path.toLowerCase()))
  for(const f of files){const parts=f.path.toLowerCase().split('/');parts.pop();while(parts.length){if(paths.has(parts.join('/')))throw new Error('技能包的文件和目录重名');parts.pop()}}
  if(main.data.length>512*1024)throw new Error('SKILL.md 超过 512 KB')
  const raw=new TextDecoder('utf-8',{fatal:true}).decode(main.data).replace(/^\uFEFF/,'')
  const front=raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if(!front)throw new Error('SKILL.md 需要 YAML 文件头')
  const doc=parseDocument(front[1]!,{uniqueKeys:true});if(doc.errors.length)throw new Error('技能 YAML 格式错误')
  const meta=doc.toJS({maxAliasCount:10}) as Record<string,unknown>|null
  if(!meta||typeof meta!=='object'||Array.isArray(meta))throw new Error('技能 YAML 文件头需要对象')
  const name=meta.name,description=meta.description
  if(typeof name!=='string'||name.length>64||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))throw new Error('技能 name 需为小写字母、数字和连字符，最长 64 字符')
  if(typeof description!=='string'||!description.trim()||description.length>4096)throw new Error('技能需要有效的 description，最长 4096 字符')
  for(const key of ['disable-model-invocation','user-invocable'])if(meta[key]!==undefined&&typeof meta[key]!=='boolean')throw new Error(`${key} 必须为布尔值`)
  const warnings:string[]=[]
  if(files.some(f=>f.path!=='SKILL.md'))warnings.push('包含附加文件，请检查脚本、依赖和引用内容。安装不会执行这些文件。')
  warnings.push('技能指令会影响 Agent 行为，请仅安装信任的来源。')
  const hash=createHash('sha256');for(const f of files){hash.update(f.path);hash.update('\0');hash.update(f.data);hash.update('\0')}
  return{name,description:description.trim(),content:raw.slice(front[0].length).trim(),files,digest:hash.digest('hex'),warnings,invocation:{modelInvocable:meta['disable-model-invocation']!==true,userInvocable:meta['user-invocable']!==false}}
}
