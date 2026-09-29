// Task 3: 信号派生 — 码头没有对应源码可抄（码头由 Claude Code 钩子事件推送通知，
// DSH 只有状态），这七条规则和用例是本插件的原创设计，逐条对照
// `.superpowers/sdd/2026-09-05-s5-notifications/task-3-brief.md`。
import { describe, expect, it } from 'vitest'
import {
  deriveNotificationEvents,
  type LocateSession,
  type NotificationSnapshot,
  type SessionLocation,
} from '../src/client/notifications/derive.ts'

const NOWHERE: SessionLocation = { workspaceId: null, taskId: null, sceneId: null }

/** Default `locate`: every session lives nowhere unless a test overrides a specific id. */
function locateStub(overrides: Readonly<Record<string, SessionLocation>> = {}): LocateSession {
  return (sessionId) => overrides[sessionId] ?? NOWHERE
}

function snapshot(partial: Partial<NotificationSnapshot> = {}): NotificationSnapshot {
  return { pending: new Map(), sessions: {}, ...partial }
}

describe('deriveNotificationEvents', () => {
  it('produces nothing when prev is undefined (the caller\'s explicit first-call signal, rule 7)', () => {
    const next = snapshot({
      pending: new Map([['session-1', { key: 'k1', kind: 'approval', sessionId: 'session-1' }]]),
      sessions: { 'session-2': { running: false, completed: true } },
    })

    expect(deriveNotificationEvents(undefined, next, undefined, locateStub())).toEqual([])
  })

  it('diffs normally when prev is a real but genuinely empty snapshot (Ruling-S5-6 guard, NOT rule 7)', () => {
    // Every session just got archived, or the workspace emptied out: `prev`
    // is empty in SHAPE but is a real observation, not "no observation yet".
    // The very next transition must still produce its notification — this is
    // exactly the case the old shape-based inference used to swallow.
    const prev = snapshot()
    const next = snapshot({
      pending: new Map([['session-1', { key: 'k1', kind: 'approval', sessionId: 'session-1' }]]),
    })

    const events = deriveNotificationEvents(prev, next, undefined, locateStub())

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ eventType: 'permission', sessionId: 'session-1' })
  })

  it('produces a permission event when an approval interaction newly appears (rule 1)', () => {
    // `seeded` carries an unrelated session so it is not the "empty first snapshot" case (rule 7).
    const seeded = snapshot({ sessions: { 'unrelated': { running: true } } })
    const next = snapshot({
      pending: new Map([['session-1', { key: 'k1', kind: 'approval', sessionId: 'session-1' }]]),
    })

    const events = deriveNotificationEvents(seeded, next, undefined, locateStub())

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      eventType: 'permission',
      title: '等待审批',
      sessionId: 'session-1',
      cooldownKey: 'approval',
    })
  })

  it('maps question and plan-review kinds to a waiting event, each cooling down independently (rule 1)', () => {
    const seeded = snapshot({ sessions: { 'unrelated': { running: true } } })
    const next = snapshot({
      pending: new Map([
        ['session-question', { key: 'k1', kind: 'question', sessionId: 'session-question' }],
        ['session-plan', { key: 'k1', kind: 'plan-review', sessionId: 'session-plan' }],
      ]),
    })

    const events = deriveNotificationEvents(seeded, next, undefined, locateStub())

    expect(events).toHaveLength(2)
    const byKind = new Map(events.map((event) => [event.sessionId, event]))
    expect(byKind.get('session-question')).toMatchObject({
      eventType: 'waiting', title: '等待输入', cooldownKey: 'question',
    })
    expect(byKind.get('session-plan')).toMatchObject({
      eventType: 'waiting', title: '等待输入', cooldownKey: 'plan-review',
    })
  })

  it('renders an unknown pending kind as "waiting for input" rather than dropping it (project rule, Ruling-S5-4)', () => {
    const seeded = snapshot({ sessions: { 'unrelated': { running: true } } })
    const next = snapshot({
      pending: new Map([
        ['session-1', { key: 'k1', kind: 'my-custom-kind', sessionId: 'session-1' }],
      ]),
    })

    const events = deriveNotificationEvents(seeded, next, undefined, locateStub())

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      eventType: 'waiting',
      title: '等待输入',
      cooldownKey: 'my-custom-kind',
    })
  })

  it('produces nothing when a pending interaction disappears (rule 2)', () => {
    const prev = snapshot({
      pending: new Map([['session-1', { key: 'k1', kind: 'approval', sessionId: 'session-1' }]]),
    })
    const next = snapshot()

    expect(deriveNotificationEvents(prev, next, undefined, locateStub())).toEqual([])
  })

  it('treats a changed key on the same session as a new interaction (rule 1 / disambiguation)', () => {
    const prev = snapshot({
      pending: new Map([['session-1', { key: 'k1', kind: 'approval', sessionId: 'session-1' }]]),
    })
    const next = snapshot({
      pending: new Map([['session-1', { key: 'k2', kind: 'approval', sessionId: 'session-1' }]]),
    })

    const events = deriveNotificationEvents(prev, next, undefined, locateStub())

    expect(events).toHaveLength(1)
    expect(events[0]?.sessionId).toBe('session-1')
  })

  it('produces nothing when the same session keeps the exact same pending key (no-op diff)', () => {
    const same = new Map([['session-1', { key: 'k1', kind: 'approval', sessionId: 'session-1' }]])
    const prev = snapshot({ pending: same })
    const next = snapshot({ pending: same })

    expect(deriveNotificationEvents(prev, next, undefined, locateStub())).toEqual([])
  })

  it('produces a completed event only on the false-to-true edge, never true-to-true (rule 3)', () => {
    const prev = snapshot({
      sessions: {
        'session-a': { running: false, completed: false },
        'session-b': { running: false, completed: true },
      },
    })
    const next = snapshot({
      sessions: {
        'session-a': { running: false, completed: true },
        'session-b': { running: false, completed: true },
      },
    })

    const events = deriveNotificationEvents(prev, next, undefined, locateStub())

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ eventType: 'completed', title: '已完成', sessionId: 'session-a' })
  })

  it('fires completed for a session absent from prev.sessions entirely, as long as prev is not the empty first snapshot', () => {
    const prev = snapshot({ sessions: { 'unrelated': { running: true } } })
    const next = snapshot({
      sessions: {
        'unrelated': { running: true },
        'session-new': { running: false, completed: true },
      },
    })

    const events = deriveNotificationEvents(prev, next, undefined, locateStub())

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ eventType: 'completed', sessionId: 'session-new' })
  })

  it('marks isFocusedSession per event, comparing each sessionId against the focused session (rule 4)', () => {
    const seeded = snapshot({ sessions: { 'unrelated': { running: true } } })
    const next = snapshot({
      pending: new Map([
        ['session-focused', { key: 'k1', kind: 'approval', sessionId: 'session-focused' }],
        ['session-other', { key: 'k1', kind: 'approval', sessionId: 'session-other' }],
      ]),
    })

    const events = deriveNotificationEvents(seeded, next, 'session-focused', locateStub())
    const byId = new Map(events.map((event) => [event.sessionId, event]))

    expect(byId.get('session-focused')?.isFocusedSession).toBe(true)
    expect(byId.get('session-other')?.isFocusedSession).toBe(false)
  })

  it('fills workspace/task/scene from locate(), and nulls when locate cannot place the session (rule 5)', () => {
    const seeded = snapshot({ sessions: { 'unrelated': { running: true } } })
    const next = snapshot({
      pending: new Map([
        ['session-known', { key: 'k1', kind: 'approval', sessionId: 'session-known' }],
        ['session-unknown', { key: 'k1', kind: 'approval', sessionId: 'session-unknown' }],
      ]),
    })
    const locate = locateStub({
      'session-known': { workspaceId: 'ws-1', taskId: 'task-1', sceneId: 'scene-1' },
    })

    const events = deriveNotificationEvents(seeded, next, undefined, locate)
    const byId = new Map(events.map((event) => [event.sessionId, event]))

    expect(byId.get('session-known')).toMatchObject({
      workspaceId: 'ws-1', taskId: 'task-1', sceneId: 'scene-1',
    })
    expect(byId.get('session-unknown')).toMatchObject({
      workspaceId: null, taskId: null, sceneId: null,
    })
  })

  it('derives a stable, deterministic eventId for the same transition across repeated calls (rule 6)', () => {
    const seeded = snapshot({ sessions: { 'unrelated': { running: true } } })
    const next = snapshot({
      pending: new Map([['session-1', { key: 'k1', kind: 'approval', sessionId: 'session-1' }]]),
    })

    const first = deriveNotificationEvents(seeded, next, undefined, locateStub())
    const second = deriveNotificationEvents(seeded, next, undefined, locateStub())

    expect(first).toHaveLength(1)
    expect(first[0]?.eventId).toBe(second[0]?.eventId)
    expect(first[0]?.eventId).toBe('session-1:approval:k1')
  })

  it('derives a stable eventId for a completed transition across repeated calls (rule 6)', () => {
    const prev = snapshot({ sessions: { 'session-1': { running: false, completed: false } } })
    const next = snapshot({ sessions: { 'session-1': { running: false, completed: true } } })

    const first = deriveNotificationEvents(prev, next, undefined, locateStub())
    const second = deriveNotificationEvents(prev, next, undefined, locateStub())

    expect(first[0]?.eventId).toBe(second[0]?.eventId)
  })
})

/**
 * 第三轮活体走查（2026-09-07）抓到的：**子代理跑完会在通知中心里多出一条**，
 * 面包屑还是「未知工作区 / 未知事项」——因为 `AppFrame` 建快照时遍历的是
 * `sessions.ids` 全集，没有套用轮播那道 `origin === 'subagent'` 过滤
 * （`workbench/known-sessions.ts:24`）。
 *
 * 产品上这是错的两层：子代理不是工作台的卡，用户没法点开它、也不需要为它分心
 * （它的父卡跑完自己会响）；退一步说，就算要响，也不该显示成「未知/未知」。
 */
describe('规则 8：子代理不产生通知（走查所获）', () => {
  const base = { running: true }
  it('子代理从运行变完成，不产生任何事件', () => {
    const events = deriveNotificationEvents(
      { pending: new Map(), sessions: { sub: { ...base, origin: 'subagent' } } },
      { pending: new Map(), sessions: { sub: { running: false, completed: true, origin: 'subagent' } } },
      undefined,
      () => ({ workspaceId: null, taskId: null, sceneId: null }),
    )
    expect(events).toEqual([])
  })

  it('子代理请求审批，也不产生事件', () => {
    const events = deriveNotificationEvents(
      { pending: new Map(), sessions: { sub: { ...base, origin: 'subagent' } } },
      {
        pending: new Map([['sub', { kind: 'approval', key: 'k1' }]]),
        sessions: { sub: { ...base, origin: 'subagent' } },
      },
      undefined,
      () => ({ workspaceId: null, taskId: null, sceneId: null }),
    )
    expect(events).toEqual([])
  })

  /** 反例：同一个转换，不是子代理时必须照常产生事件——否则上面两条可能只是「什么都不产生」。 */
  it('同样的转换发生在普通会话上，照常产生一条完成事件', () => {
    const events = deriveNotificationEvents(
      { pending: new Map(), sessions: { card: { ...base } } },
      { pending: new Map(), sessions: { card: { running: false, completed: true } } },
      undefined,
      () => ({ workspaceId: 'w', taskId: 't', sceneId: 's' }),
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.eventType).toBe('completed')
  })
})
