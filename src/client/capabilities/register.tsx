import type {Context} from '@deepseek-ai/cordis'
import type {PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import {CapabilityPanel} from './Panel.tsx'
import type {PanelProps} from './Panel.tsx'
import type {} from './remote.ts'
import css from './panel.module.css'
export function CapabilityIcon(){return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/></svg>}
export function registerCapabilities(ctx:Context){
  ctx.inject(['remote.matouCapabilities'],scope=>{
    let open=false;const listeners=new Set<()=>void>()
    const set=(value:boolean)=>{open=value;listeners.forEach(fn=>fn())}
    const face:PanelProps={state:{getSnapshot:()=>open,subscribe:fn=>{listeners.add(fn);return()=>{listeners.delete(fn)}}},close:()=>set(false),request:async input=>{const r=await scope.remote.matouCapabilities.request(input);if(!r.ok)throw new Error(r.error.message);return r.value}}
    function Entry({wide}:PropsRuntime<'sidebar.footer.action'>){return <button className={css.entry} aria-label="技能和连接器" title="技能和连接器" onClick={()=>set(true)}><CapabilityIcon/>{wide&&<span>技能和连接器</span>}</button>}
    scope.slots.inject('sidebar.footer.action',()=>scope.slots.register({name:'sidebar.footer.action',id:'matou-capabilities-entry',order:-100},Entry))
    scope.slots.inject('shell.overlay',()=>scope.slots.register({name:'shell.overlay',id:'matou-capabilities-panel',order:45,inject:()=>face},CapabilityPanel))
    scope.effect(()=>()=>{set(false);listeners.clear()},'matou-capabilities:panel')
  })
}
