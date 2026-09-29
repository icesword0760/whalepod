import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'
import ts from 'typescript'

const PACKAGE_NAME = 'dsh-plugin-matou-layout'

// Standard decorators (@Remote) are not lowered by the bundler itself; mirror
// the official typert tsdown plugin's transform (typescript transpileModule)
// without its workspace-bound artifact emission. Gateway SRC dispatch reads
// parameter names from function source, so the host bundle must never minify.
const DECORATOR_SYNTAX = /^\s*@[A-Za-z_$][\w$]*/m
const decoratorLowering = {
  name: 'matou-layout-decorator-lowering',
  transform(code, id) {
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

// Host-side runtime dependencies. `defineTool` is a value import: a bundled
// copy would carry its own reserved-name and JSON-schema validation, so the
// tool records this plugin builds would be checked by a different registry
// than the one that executes them. Every entry here is also a peerDependency;
// tests/package-contract.spec.ts holds the two lists to each other.
const HOST_EXTERNALS = new Set([
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/dsh-storage-domain',
])
const CSS_PREFIX = '\0matou-layout-css:'
const CSS_SUFFIX = '.mjs'
const CLIENT_EXTERNALS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
])

export default defineConfig([
  {
    name: PACKAGE_NAME,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: true,
    sourcemap: true,
    deps: {
      neverBundle: (id) => HOST_EXTERNALS.has(id),
    },
    plugins: [decoratorLowering],
  },
  {
    name: `${PACKAGE_NAME}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      'process.env.DSH_CLIENT_TITLE': 'undefined',
    },
    deps: {
      neverBundle: (id) => CLIENT_EXTERNALS.has(id),
      alwaysBundle: (id) => !CLIENT_EXTERNALS.has(id),
    },
    plugins: [{
      name: 'matou-layout-css-modules',
      resolveId(source, importer) {
        if (!source.endsWith('.module.css') || importer === undefined) return null
        return CSS_PREFIX + resolve(dirname(importer), source) + CSS_SUFFIX
      },
      async load(id) {
        if (!id.startsWith(CSS_PREFIX)) return null
        const filename = id.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
        const result = transform({
          filename,
          code: await readFile(filename),
          cssModules: { pattern: 'matou_[local]_[hash]' },
          minify: true,
        })
        const classes = Object.fromEntries(
          Object.entries(result.exports ?? {}).map(([name, value]) => [name, value.name]),
        )
        const css = Buffer.from(result.code).toString('utf8')
        const styleId = `${PACKAGE_NAME}/${filename.split('/').at(-1)}`
        return [
          `const css = ${JSON.stringify(css)};`,
          `const styleId = ${JSON.stringify(styleId)};`,
          "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(styleId) + ']') === null) {",
          "  const tag = document.createElement('style');",
          `  tag.dataset.plugin = ${JSON.stringify(PACKAGE_NAME)};`,
          '  tag.dataset.pluginCss = styleId;',
          '  tag.textContent = css;',
          '  document.head.appendChild(tag);',
          '}',
          `export default ${JSON.stringify(classes)};`,
        ].join('\n')
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
