import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import {requestSchema,resultSchema} from '../../capabilities/model.ts'
import type {CapabilityRequest,CapabilityResult} from '../../capabilities/model.ts'
export interface CapabilityRemote{request(input:CapabilityRequest):Promise<RemoteResult<CapabilityResult>>}
declare module '@deepseek-ai/dsh-typert-protocol'{interface TypertRemoteMap{'matouCapabilities/request':CapabilityRemote['request']}interface TypertRemoteNamespaceMap{matouCapabilities:CapabilityRemote}}
const PACKAGE='dsh-plugin-matou-layout'
export const CAPABILITY_REMOTE:TypertRemoteContribution={package:PACKAGE,descriptors:[{id:`${PACKAGE}#matouCapabilities/request`,service:'matouCapabilities',namespace:'matouCapabilities',method:'request',invocation:{kind:'direct'},parameters:[{name:'input',wire:'input',source:'json',codec:{mode:'strict',typeSymbol:`${PACKAGE}/src/capabilities/model#CapabilityRequest`,schema:requestSchema}}],result:{mode:'strict',typeSymbol:`${PACKAGE}/src/capabilities/model#CapabilityResult`,schema:resultSchema}}]}
