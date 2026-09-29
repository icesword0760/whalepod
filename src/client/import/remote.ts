import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { importRequestSchema, importResultSchema } from '../../import/wire.ts'
import type { ImportRequest, ImportResult } from '../../import/wire.ts'
export interface ImportRemote { request(input: ImportRequest): Promise<RemoteResult<ImportResult>> }
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap { 'matouImport/request': ImportRemote['request'] }
  interface TypertRemoteNamespaceMap { matouImport: ImportRemote }
}
const PACKAGE = 'dsh-plugin-matou-layout'
export const IMPORT_REMOTE: TypertRemoteContribution = { package: PACKAGE, descriptors: [{
  id: `${PACKAGE}#matouImport/request`, service: 'matouImport', namespace: 'matouImport', method: 'request', invocation: { kind: 'direct' },
  parameters: [{ name: 'input', wire: 'input', source: 'json', codec: { mode: 'strict', typeSymbol: `${PACKAGE}/src/import/wire#ImportRequest`, schema: importRequestSchema } }],
  result: { mode: 'strict', typeSymbol: `${PACKAGE}/src/import/wire#ImportResult`, schema: importResultSchema },
}] }
