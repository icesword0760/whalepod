/**
 * S7 Task 9 — the approval gate in front of the two side-effecting tools (D-1).
 *
 * **The one decision this file exists to pin.** A tool in DSH is gated only by
 * a `tools/pre-execute` listener — `ToolDefinition` carries no declarative
 * approval field (`packages/core/tools/src/index.ts:214-280`) — so without the
 * listener under test, sending into another session and interrupting one would
 * execute silently, with no prompt and no audit pair. With it, the DEFAULT
 * permission preset asks through DSH's own approval UI. But the FULL-ACCESS
 * preset (`danger-full-access`, `approval: 'never'` —
 * `packages/interaction/permission-presets/src/index.ts:175-178`) must be let
 * THROUGH rather than asked, because `'never'` in DSH means *deterministic
 * rejection*, not *silent grant*: `ApprovalService.decide` returns `'rejected'`
 * before dispatching to any listener
 * (`packages/interaction/user-approval/src/index.ts:266`) and the registry maps
 * that to `{kind:'deny'}` (`packages/core/tools/src/index.ts:1705-1708`). An
 * `ask` there would make both tools fail forever in the permission preset the
 * user picked to make things EASIER. The `'never'` case below carries that
 * reasoning in a comment and must not be "simplified" into symmetry with `ask`.
 *
 * **Why a real cordis context and not a stub.** Two of the properties asserted
 * here are properties of cordis itself, not of a function: the listener
 * composes as a waterfall (returning `ask` without calling `next()` vetoes the
 * rest of the chain), and it is an effect of the fiber that registered it, so
 * unloading the plugin unbinds it. A hand-written `ctx` would assert neither.
 */
import { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTROL_APPROVAL_REASON, registerControlApprovalPolicy } from '../src/control/approval.ts'
import { CONTROL_SIDE_EFFECT_TOOL_NAMES, CONTROL_TOOL_NAMES } from '../src/control/tools.ts'

/** The two DSH approval policies (`packages/interaction/user-approval/src/index.ts:59`). */
type Policy = 'ask' | 'never'

/** The four tools that only read; the gate must never delay any of them. */
const READ_ONLY_TOOL_NAMES = CONTROL_TOOL_NAMES
  .filter(name => !(CONTROL_SIDE_EFFECT_TOOL_NAMES as readonly string[]).includes(name))

/**
 * Names from outside this plugin, including the two officially registered ones
 * this plugin renamed away from (`packages/subagent/tool-subagent-control/src/index.ts:29`,
 * `:77`). If the gate ever matched on a suffix or a substring it would start
 * gating those, which is the worst outcome this file can catch.
 */
const FOREIGN_TOOL_NAMES: readonly string[] = [
  'bash',
  'read_file',
  'send_message',
  'interrupt_agent',
  'run_code',
  'matou_',
  'matou_send_message_extra',
  'x_matou_send_message',
  // Inherited `Object.prototype` keys: a name-keyed lookup that skips a
  // `hasOwn` check answers these with a function and gates a foreign tool.
  'toString',
  'constructor',
]

interface ApprovalStub {
  /** Every read of the approval service, in call order; empty means it was never consulted. */
  readonly reads: string[]
  readonly service: unknown
}

/**
 * An approval service narrowed to the two members D-1 reads.
 * @param options - the session override and the deployment default to report.
 * @returns the stub plus its read log.
 */
function approvalStub(options: { override?: Policy; policy?: Policy } = {}): ApprovalStub {
  const reads: string[] = []
  return {
    reads,
    service: {
      overrideOf(session: unknown): Policy | undefined {
        reads.push(`overrideOf:${String((session as { id?: string } | undefined)?.id)}`)
        return options.override
      },
      get config(): { policy?: Policy } {
        reads.push('config')
        return options.policy === undefined ? {} : { policy: options.policy }
      },
    },
  }
}

interface ExecOptions {
  /** DSH types `exec.agent` as optional (`packages/core/tools/src/index.ts:318`); this drops it. */
  readonly withoutAgent?: true
  /** Mark the call as a PTC transport sub-dispatch (`packages/core/tools/src/index.ts:319-328`). */
  readonly asSubDispatch?: true
}

/**
 * One pending tool call, narrowed to what the gate looks at.
 * @param name - the tool being called.
 * @param options - agent presence and PTC framing.
 * @returns an execution the waterfall accepts.
 */
function execOf(name: string, options: ExecOptions = {}): ToolExecution {
  const agent = { id: 'caller', session: { id: 'caller', header: { id: 'caller' } } }
  return {
    ...(options.withoutAgent === true ? {} : { agent }),
    ...(options.asSubDispatch === true ? { parent: Symbol('outer run_code execution') } : {}),
    callId: 'call-1',
    rootCallId: 'call-1',
    name,
    arguments: { target: 'right' },
    token: Symbol('exec'),
    signal: new AbortController().signal,
  } as unknown as ToolExecution
}

interface Gate {
  readonly approval: ApprovalStub
  /** Dispatch one call through the waterfall, with an innermost `next` that allows. */
  run(exec: ToolExecution): Promise<{ decision: PreToolDecision; nextCalls: number }>
  /** Unload only the plugin that registered the listener; the root context stays up. */
  unload(): Promise<void>
}

const disposals: (() => Promise<void>)[] = []

afterEach(async () => {
  while (disposals.length > 0) await disposals.pop()!()
})

/**
 * Stand up a root context with the gate registered inside a child plugin.
 * @param options - the policy to report, or `withoutApproval` to compose none.
 * @returns the harness.
 */
async function gate(
  options: { override?: Policy; policy?: Policy; withoutApproval?: true } = {},
): Promise<Gate> {
  const ctx = new Context()
  const approval = approvalStub(options)
  if (options.withoutApproval !== true) ctx.provide('approval', approval.service)
  const fiber = await ctx.plugin({
    name: 'matou-approval-test-host',
    apply(inner: Context): void {
      registerControlApprovalPolicy(inner)
    },
  })
  disposals.push(async () => { await ctx.fiber.dispose() })
  return {
    approval,
    async run(exec: ToolExecution) {
      let nextCalls = 0
      const decision = await ctx.waterfall('tools/pre-execute', exec, () => {
        nextCalls += 1
        return Promise.resolve<PreToolDecision>({ kind: 'allow' })
      })
      return { decision, nextCalls }
    },
    async unload() {
      await fiber.dispose()
    },
  }
}

describe('control approval gate — scope', () => {
  it('carries a reason for exactly the two side-effecting tools', () => {
    expect([...CONTROL_SIDE_EFFECT_TOOL_NAMES]).toEqual(['matou_send_message', 'matou_interrupt_session'])
    expect(Object.keys(CONTROL_APPROVAL_REASON).sort()).toEqual([...CONTROL_SIDE_EFFECT_TOOL_NAMES].sort())
    expect(READ_ONLY_TOOL_NAMES).toHaveLength(4)
  })

  it('delegates every tool outside this plugin without consulting the approval service', async () => {
    // The failure this guards is not "a wrong answer" but "a gate on the whole
    // host": a listener registered on the host plane sees EVERY tool call in
    // the process, so a missing or sloppy name test would put this plugin in
    // front of bash, file writes and every first-party tool.
    const harness = await gate({ policy: 'ask' })
    for (const name of FOREIGN_TOOL_NAMES) {
      const { decision, nextCalls } = await harness.run(execOf(name))
      expect(decision, name).toEqual({ kind: 'allow' })
      expect(nextCalls, name).toBe(1)
    }
    expect(harness.approval.reads).toEqual([])
  })

  it('never gates the four read-only tools', async () => {
    const harness = await gate({ policy: 'ask' })
    for (const name of READ_ONLY_TOOL_NAMES) {
      const { decision, nextCalls } = await harness.run(execOf(name))
      expect(decision, name).toEqual({ kind: 'allow' })
      expect(nextCalls, name).toBe(1)
    }
    // Reading a card is not an effect, so the policy is not even a question.
    expect(harness.approval.reads).toEqual([])
  })
})

describe('control approval gate — default permission preset', () => {
  it('asks the user before a message or an interrupt', async () => {
    const harness = await gate()
    for (const name of CONTROL_SIDE_EFFECT_TOOL_NAMES) {
      const { decision, nextCalls } = await harness.run(execOf(name))
      expect(decision.kind, name).toBe('ask')
      // Not calling `next()` is the point: the ask vetoes the rest of the
      // waterfall and hands the decision to DSH's own approval service.
      expect(nextCalls, name).toBe(0)
    }
    // No configured policy and no session override is the default preset:
    // `overrideOf(session) ?? config.policy ?? 'ask'`.
    expect(harness.approval.reads).toEqual(['overrideOf:caller', 'config', 'overrideOf:caller', 'config'])
  })

  it('states the effect in a sentence the approval UI can show', async () => {
    const harness = await gate({ policy: 'ask' })
    const reasons: string[] = []
    for (const name of CONTROL_SIDE_EFFECT_TOOL_NAMES) {
      const { decision } = await harness.run(execOf(name))
      const reason = (decision as { reason?: string }).reason
      expect(reason, name).toBeTypeOf('string')
      // A sentence, not a code: this string is what the human sees on the
      // approval card, and it is also what the `approval/asked` audit event
      // records (`packages/interaction/user-approval/src/index.ts:207-226`).
      expect(reason, name).toMatch(/\.$/)
      expect(reason!.length, name).toBeGreaterThan(30)
      expect(reason, name).not.toMatch(/^[A-Z_]{3,}:/)
      reasons.push(reason!)
    }
    // Sending and interrupting are different acts; one shared blurb would make
    // the approval card useless for telling them apart.
    expect(new Set(reasons).size).toBe(2)
  })

  it('lets a session override reinstate asking over a permissive deployment default', async () => {
    const harness = await gate({ override: 'ask', policy: 'never' })
    const { decision, nextCalls } = await harness.run(execOf('matou_send_message'))
    expect(decision.kind).toBe('ask')
    expect(nextCalls).toBe(0)
  })
})

describe('control approval gate — full-access permission preset', () => {
  it('lets the call through instead of asking, because an ask there is a guaranteed rejection', async () => {
    // THE D-1 DECISION, PINNED. This is a product decision the user made:
    // "the more permission you grant, the smoother it gets". It is also the
    // only thing that WORKS. Under `approval: 'never'` (the `danger-full-access`
    // preset, `packages/interaction/permission-presets/src/index.ts:175-178`),
    // `ApprovalService.decide` short-circuits to `'rejected'` BEFORE any
    // answerer or listener runs (`packages/interaction/user-approval/src/index.ts:266`),
    // and `ToolRuntime.serviceAsk` turns that into
    // `{kind:'deny', reason:'the user rejected tool "…"'}`
    // (`packages/core/tools/src/index.ts:1705-1708`). So returning `ask` here
    // would not surface a prompt — it would make `matou_send_message` and
    // `matou_interrupt_session` fail 100% of the time, silently, in exactly the
    // preset the user chose to remove friction. Do not "restore symmetry" with
    // the ask branch above: `'never'` means *decided*, not *unattended*.
    const harness = await gate({ policy: 'never' })
    for (const name of CONTROL_SIDE_EFFECT_TOOL_NAMES) {
      const { decision, nextCalls } = await harness.run(execOf(name))
      expect(decision, name).toEqual({ kind: 'allow' })
      expect(nextCalls, name).toBe(1)
    }
  })

  it('honours a session override of never over an asking deployment default', async () => {
    const harness = await gate({ override: 'never', policy: 'ask' })
    const { decision, nextCalls } = await harness.run(execOf('matou_interrupt_session'))
    expect(decision).toEqual({ kind: 'allow' })
    expect(nextCalls).toBe(1)
  })
})

describe('control approval gate — degraded compositions', () => {
  it('delegates when the deployment composes no approval service', async () => {
    // `ask` without an ApprovalService is a hard deny
    // (`packages/core/tools/src/index.ts:1674-1680`), so asking here would
    // break the tools in a deployment that simply has no approval UI.
    const harness = await gate({ withoutApproval: true })
    for (const name of CONTROL_SIDE_EFFECT_TOOL_NAMES) {
      const { decision, nextCalls } = await harness.run(execOf(name))
      expect(decision, name).toEqual({ kind: 'allow' })
      expect(nextCalls, name).toBe(1)
    }
  })

  it('delegates a call with no calling agent, leaving the tool to say so itself', async () => {
    // Same reason (`packages/core/tools/src/index.ts:1690-1695`): an
    // agent-less ask denies with a reason about routing, which tells the model
    // nothing. The tool body already raises "requires a calling agent".
    const harness = await gate({ policy: 'ask' })
    const { decision, nextCalls } = await harness.run(execOf('matou_send_message', { withoutAgent: true }))
    expect(decision).toEqual({ kind: 'allow' })
    expect(nextCalls).toBe(1)
    // There is no session to read a policy from, so the service is not touched.
    expect(harness.approval.reads).toEqual([])
  })
})

describe('control approval gate — call framing and lifetime', () => {
  it('treats a PTC sub-dispatch exactly like a model-direct call', async () => {
    // Under `DSH_TOOLS_MODE=ptc` the model only sees `run_code`, and these
    // tools arrive as sub-dispatches carrying `exec.parent`. A side effect is a
    // side effect either way; the transport must not become a way around the
    // gate.
    const asking = await gate({ policy: 'ask' })
    const asked = await asking.run(execOf('matou_send_message', { asSubDispatch: true }))
    expect(asked.decision.kind).toBe('ask')
    expect(asked.nextCalls).toBe(0)

    const permissive = await gate({ policy: 'never' })
    const allowed = await permissive.run(execOf('matou_send_message', { asSubDispatch: true }))
    expect(allowed.decision).toEqual({ kind: 'allow' })
    expect(allowed.nextCalls).toBe(1)
  })

  it('unbinds when the plugin that registered it unloads', async () => {
    const harness = await gate({ policy: 'ask' })
    expect((await harness.run(execOf('matou_send_message'))).decision.kind).toBe('ask')
    await harness.unload()
    // The tools unload with the same fiber, so a surviving listener would gate
    // a name nothing answers to — and would keep this plugin's opinion alive
    // in a process that no longer contains it.
    const after = await harness.run(execOf('matou_send_message'))
    expect(after.decision).toEqual({ kind: 'allow' })
    expect(after.nextCalls).toBe(1)
  })
})
