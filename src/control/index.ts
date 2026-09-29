/**
 * Host-side control plane for the workbench: the sub-plugin that owns the
 * `matou_*` session-control tools and their approval policy.
 *
 * It is a child of {@link MatouLayoutService} rather than a service of its
 * own. The layout service constructs it and hands itself over, so the control
 * plane reads the organization document through the captured instance; it must
 * never inject `matouLayout`, which would make the child wait on a service
 * that is waiting on the child.
 *
 * Every DSH reference here is type-only on purpose — `declare module` merges
 * that put `ctx.tools`, `ctx.sessionController`, `ctx.workspaceRegistry` and
 * `ctx.sessionQuery` on the context type, erased at compile time. The one
 * host-side value dependency is `@deepseek-ai/dsh-tools` (`defineTool`), which
 * stays external in the bundle so the tool records this plugin builds are
 * validated by the same registry the host executes them in.
 * @module dsh-plugin-matou-layout/control
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-session-query'
import type { MatouLayoutService } from '../index.ts'
import { registerControlApprovalPolicy } from './approval.ts'
import { registerControlTools } from './tools.ts'

/** Fiber and registry display name of the control plane sub-plugin. */
export const CONTROL_PLUGIN_NAME = 'matou-layout-control'

/**
 * Host services the control plane reads. Tool registration and the approval
 * policy need `tools`; addressing and delivery need the other three.
 */
export const CONTROL_INJECT: readonly string[] = Object.freeze([
  'tools',
  'sessionController',
  'workspaceRegistry',
  'sessionQuery',
])

/** The cordis object plugin returned by {@link createMatouControlPlugin}. */
export interface MatouControlPlugin {
  readonly name: typeof CONTROL_PLUGIN_NAME
  readonly inject: readonly string[]
  apply(ctx: Context): void
}

/**
 * Build the control plane sub-plugin bound to one organization document.
 * @param service - the layout service to read the workbench structure from.
 * @returns a cordis object plugin, loaded by the service that owns it.
 */
export function createMatouControlPlugin(service: MatouLayoutService): MatouControlPlugin {
  return {
    name: CONTROL_PLUGIN_NAME,
    inject: CONTROL_INJECT,
    apply(ctx: Context): void {
      // The six `matou_*` tools, registered once on the host plane rather than
      // per session (D-S7-1): every fact they read — the session list, the
      // workspace registry, this plugin's own organization document — resolves
      // before any session exists, and the agent scope is exactly where a
      // same-named registration would be silently shadowed. Registration is a
      // cordis effect of this context, so it unwinds with the plugin.
      registerControlTools(ctx, service)
      // The approval gate for the two tools that change something (D-1).
      // Registered AFTER the tools and on the same context, so the pair loads
      // and unloads together: a listener outliving its tools would gate names
      // nothing answers to, and tools outliving the listener would run
      // unattended — the one failure mode that leaves no trace, because DSH
      // gates a tool only through this waterfall
      // (`packages/core/tools/src/index.ts:214-280`).
      registerControlApprovalPolicy(ctx)
    },
  }
}
