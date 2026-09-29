import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import MatouLayoutService from '../src/index.ts'
import { MATOU_LAYOUT_REMOTE, MATOU_PLUGIN_REMOTE } from '../src/client/org/remote-contribution.ts'
import { createMatouControlPlugin } from '../src/control/index.ts'

/** Fiber/registry display name of the host-side control plane sub-plugin. */
const CONTROL_PLUGIN_NAME = 'matou-layout-control'

/**
 * The host services the control plane reads. `matouLayout` is deliberately
 * absent: the sub-plugin captures its parent service through the closure, so
 * injecting the parent back would close a service cycle.
 */
const CONTROL_INJECT = ['tools', 'sessionController', 'workspaceRegistry', 'sessionQuery']

const HOST_EXTERNALS_BLOCK = /const HOST_EXTERNALS = new Set\(\[([^\]]*)\]\)/

async function readManifest(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(resolve('package.json'), 'utf8'))
}

/** The bundler's never-bundle list, read from the config source. */
async function readHostExternals(): Promise<string[]> {
  const source = await readFile(resolve('tsdown.config.mjs'), 'utf8')
  const block = HOST_EXTERNALS_BLOCK.exec(source)
  expect(block, 'tsdown.config.mjs must keep a literal HOST_EXTERNALS set').not.toBeNull()
  return [...block![1]!.matchAll(/'([^']+)'/g)].map(match => match[1]!)
}

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/**
 * A host context carrying the durable storage stack the layout service needs,
 * optionally plus stubs for the four services the control plane injects.
 */
async function hostScaffold(options: { sessionPlane: boolean }): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'matou-contract-test-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  if (options.sessionPlane) {
    ctx.provide('tools', { register: () => () => {} })
    ctx.provide('sessionController', { list: async () => [] })
    ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] })
    ctx.provide('sessionQuery', { observeSession: () => { throw new Error('not used here') } })
  }
  await ctx.plugin(MatouLayoutService)
  cleanups.push(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return ctx
}

/** The registry record of the control sub-plugin, or undefined once torn down. */
function controlRuntime(ctx: Context) {
  return [...ctx.registry.values()].find(runtime => runtime.name === CONTROL_PLUGIN_NAME)
}

describe('publishable plugin shell', () => {
  it('declares both client and bundle faces', async () => {
    const manifest = await readManifest()
    expect(manifest.name).toBe('dsh-plugin-matou-layout')
    expect(manifest.dsh.client.platform).toBe('web')
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
  })

  it('replaces the official ui-layout row through the bundle patch', async () => {
    // The include patch algorithm treats `name` as an identity assertion, so a
    // same-id name change is skipped. Replacement therefore reads as: disable
    // the official row (identity asserted) and insert this plugin as a new row.
    const patch = parseYaml(await readFile(resolve('cordis.patch.yml'), 'utf8')) as Array<
      Record<string, unknown> & { insert?: Array<Record<string, unknown>> }
    >
    const disable = patch.find(op => op.id === 'ui-layout')
    expect(disable).toMatchObject({
      name: '@deepseek-ai/dsh-client-ui-layout',
      disabled: true,
    })
    const inserted = patch.flatMap(op => op.insert ?? [])
    expect(inserted).toContainEqual(
      expect.objectContaining({ name: 'dsh-plugin-matou-layout' }),
    )
  })

  it('keeps the hand-written client contribution aligned with the host @Remote methods', () => {
    // The typert generator cannot run outside the monorepo, so the client
    // contribution is authored by hand; this guards it against drift from the
    // service's actual endpoints (gateway SRC dispatch reads those markers).
    const hostMethods = Object.getOwnPropertyNames(MatouLayoutService.prototype)
      .filter(name => name === 'snapshot' || name === 'apply')
      .sort()
    const contributionMethods = MATOU_LAYOUT_REMOTE.descriptors
      .map(descriptor => descriptor.method)
      .sort()
    expect(contributionMethods).toEqual(hostMethods)
    expect(MATOU_LAYOUT_REMOTE.descriptors.every(d => d.namespace === 'matouLayout')).toBe(true)
  })
})

describe('host runtime dependency face', () => {
  it('never bundles a host-side runtime dependency and declares each one as a peer', async () => {
    // `defineTool` is a value import. A bundled copy would carry its own
    // reserved-name and JSON-schema validation, diverging from the registry
    // the host actually executes against, so the tool package must stay
    // external. Peer range and bundler externals are two halves of the same
    // statement ("the host provides this at runtime"); they must agree.
    const externals = await readHostExternals()
    expect(externals).toContain('@deepseek-ai/dsh-tools')
    const manifest = await readManifest()
    expect([...externals].sort()).toEqual(Object.keys(manifest.peerDependencies).sort())
  })

  it('resolves the host tool registry as a real module in this workspace', async () => {
    // Guards the dev link plus the vitest alias: without both, every later
    // control-plane test would fail on module resolution rather than on the
    // behaviour it means to assert. The specifier is held in a variable so a
    // missing dependency fails this one test instead of the whole file.
    const specifier = '@deepseek-ai/dsh-tools'
    const tools = await import(/* @vite-ignore */ specifier) as { defineTool?: unknown }
    expect(typeof tools.defineTool).toBe('function')
  })
})

describe('host control plane skeleton', () => {
  it('injects the four host services it reads, and never its own parent service', () => {
    const plugin = createMatouControlPlugin({} as MatouLayoutService)
    expect(plugin.name).toBe(CONTROL_PLUGIN_NAME)
    expect(plugin.inject).toEqual(CONTROL_INJECT)
    // Stated separately because it is the failure mode, not a detail: the
    // parent service constructs this plugin, so injecting `matouLayout` would
    // make the child wait on a service that waits on the child.
    expect(plugin.inject).not.toContain('matouLayout')
  })

  it('loads under the layout service against exactly the services it names', async () => {
    const ctx = await hostScaffold({ sessionPlane: true })
    const runtime = controlRuntime(ctx)
    expect(runtime, 'the layout service must plug in the control plane').toBeDefined()
    const fibers = [...runtime!.fibers]
    expect(fibers).toHaveLength(1)
    // `store` is the snapshot of resolved dependencies a fiber holds only
    // while loaded, so this asserts activation, not merely registration: a
    // mistyped or extra inject name leaves the fiber pending with no store.
    expect(Object.keys(fibers[0]!.store ?? {}).sort()).toEqual([...CONTROL_INJECT].sort())
    await ctx.fiber.dispose()
    // cordis drops the registry record once the last fiber unloads, so a
    // surviving record would mean a leaked fiber.
    expect(controlRuntime(ctx)).toBeUndefined()
  })

  it('keeps the layout service usable in a deployment with no session plane', async () => {
    // The control plane's injections are unmet here (no tools/sessionController
    // /workspaceRegistry/sessionQuery). That must leave the sub-plugin pending
    // and the organization document fully serviceable — the layout service
    // itself must never inherit the control plane's dependencies.
    const ctx = await hostScaffold({ sessionPlane: false })
    const service = ctx.get('matouLayout') as MatouLayoutService
    expect(await service.snapshot()).toEqual({
      revision: 0,
      state: { tasks: [], scenes: [], placements: [] },
    })
    const fibers = [...(controlRuntime(ctx)?.fibers ?? [])]
    expect(fibers).toHaveLength(1)
    expect(fibers[0]!.store, 'the control plane must stay pending, not fail').toBeUndefined()
    await expect(ctx.fiber.dispose()).resolves.toBeUndefined()
  })
})


describe('session import remote integration', () => {
  it('registers organization and import namespaces in a single package contribution', () => {
    expect(MATOU_PLUGIN_REMOTE.package).toBe('dsh-plugin-matou-layout')
    expect(MATOU_PLUGIN_REMOTE.descriptors.map(d => `${d.namespace}/${d.method}`).sort()).toEqual(['matouCapabilities/request', 'matouImport/request', 'matouLayout/apply', 'matouLayout/snapshot'])
  })
})
