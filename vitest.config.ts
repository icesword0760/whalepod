import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { defineConfig } from 'vitest/config'

const dshRoot = realpathSync(fileURLToPath(new URL('../deepseek-harness/', import.meta.url)))

// Standard decorators (@Remote) predate the oxc transform pipeline; lower them
// with typescript before vite parses the module, mirroring tsdown.config.mjs.
const DECORATOR_SYNTAX = /^\s*@[A-Za-z_$][\w$]*/m
const decoratorLowering = {
  name: 'matou-layout-decorator-lowering',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    const file = id.split('?', 1)[0] ?? id
    if (!/\.[cm]?tsx?$/.test(file) || !DECORATOR_SYNTAX.test(code)) return
    const result = ts.transpileModule(code, {
      fileName: file,
      compilerOptions: {
        target: ts.ScriptTarget.ES2024,
        module: ts.ModuleKind.ESNext,
        ...(file.endsWith('x') ? { jsx: ts.JsxEmit.ReactJSX } : {}),
        sourceMap: true,
      },
    })
    return {
      code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
      map: result.sourceMapText,
    }
  },
}

export default defineConfig({
  plugins: [decoratorLowering],
  server: {
    fs: { allow: [dshRoot] },
  },
  resolve: {
    tsconfigPaths: true,
    dedupe: ['react', 'react-dom', 'use-sync-external-store'],
    alias: [
      { find: /^@deepseek-ai\/dsh-scope$/, replacement: resolve(dshRoot, 'packages/core/scope/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-system-prompt$/, replacement: resolve(dshRoot, 'packages/core/system-prompt/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-skill$/, replacement: resolve(dshRoot, 'packages/skill/skill/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-mcp-client$/, replacement: resolve(dshRoot, 'packages/mcp/mcp-client/src/index.ts') },
      { find: /^@deepseek-ai\/cordis$/, replacement: resolve(dshRoot, 'vendor/cordis/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-typert-protocol$/, replacement: resolve(dshRoot, 'packages/typert/protocol/src/index.ts') },
      // Host-side value dependency (defineTool). Aliased to source for the same
      // reason as the others: tests must exercise the registry the host builds
      // from, not a possibly stale lib/ output.
      { find: /^@deepseek-ai\/dsh-tools$/, replacement: resolve(dshRoot, 'packages/core/tools/src/index.ts') },
      // 宿主侧 titleOf 与 DSH 客户端的 displayTitle 共用同一份 basename 实现
      // （S7 审查 E13：两份实现必然漂移，而漂移的症状是「模型看到的卡片名字
      // 与用户屏幕上的不一样」——功能不坏，但 AI 认不出用户说的是哪张卡）。
      { find: /^@deepseek-ai\/dsh-util-workspace-path$/, replacement: resolve(dshRoot, 'packages/util/workspace-path/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-storage-domain$/, replacement: resolve(dshRoot, 'packages/storage/storage-domain/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-storage-json$/, replacement: resolve(dshRoot, 'packages/storage/storage-json/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-storage$/, replacement: resolve(dshRoot, 'packages/storage/storage/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-test-runtime$/, replacement: resolve(dshRoot, 'packages/test-support/client-runtime/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-store$/, replacement: resolve(dshRoot, 'packages/client/store/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-ui-slots$/, replacement: resolve(dshRoot, 'packages/client/ui-slots/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-locale\/client$/, replacement: resolve(dshRoot, 'packages/client/locale/src/client/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-ui-renderer\/client$/, replacement: resolve(dshRoot, 'packages/client/ui-renderer/src/client/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-ui-session\/client$/, replacement: resolve(dshRoot, 'packages/client/ui-session/src/client/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-ui-theme\/client$/, replacement: resolve(dshRoot, 'packages/client/ui-theme/src/client/index.ts') },
      {
        find: /^dsh-plugin-matou-layout\/client$/,
        replacement: fileURLToPath(new URL('./src/client/index.ts', import.meta.url)),
      },
      {
        find: /^dsh-plugin-matou-layout$/,
        replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.spec.{ts,tsx}'],
    restoreMocks: true,
    setupFiles: ['./tests/setup.ts'],
  },
})
