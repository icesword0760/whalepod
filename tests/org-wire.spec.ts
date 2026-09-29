/**
 * 第三轮活体走查（2026-09-07）之后加的闸门。
 *
 * `placement/interaction` 加进了 op 联合与 reducer，却漏加进 `matouOrgOpSchema`
 * ——那是**客户端→宿主 RPC 边界**上的校验。单元测试全部直接调 reducer，走不到这道
 * 校验，于是 1086 条全绿、功能在页面上却完全没生效，浏览器里只报一句
 * `client api: matouLayout/apply rejected "request"`，什么线索都不给。
 *
 * 这一组把「op 联合有几种 kind」和「wire schema 认识几种」钉在一起，让下次漏加当场
 * 变红，而不是等到真实浏览器里。同类的编译期闸门是 `ops.ts` 的
 * `MatouOrgOpKindsAreExhaustive`（联合新增而清单没跟上 → 类型报错）。
 */
import { describe, expect, it } from 'vitest'
import { MATOU_ORG_OP_KINDS } from '../src/org/ops.ts'
import { matouOrgOpSchema } from '../src/org/wire-schemas.ts'

/** zod 的 union 分支在 `.options` 上；每支的 `kind` 是 `z.literal`，字面量在 `.value`。 */
function kindsInSchema(): string[] {
  const branches = (matouOrgOpSchema as unknown as {
    options: { shape: { kind: { value: string } } }[]
  }).options
  return branches.map(branch => branch.shape.kind.value).sort()
}

describe('wire schema 与 op 联合必须同步（走查所获）', () => {
  it('schema 认识的 kind 集合 === MATOU_ORG_OP_KINDS', () => {
    expect(kindsInSchema()).toEqual([...MATOU_ORG_OP_KINDS].sort())
  })

  /** 反例：比对的不是空集合——清单本身得有内容，且拿真实 op 过一遍 schema。 */
  it('清单非空，且新增的 placement/interaction 真能通过 schema', () => {
    expect(MATOU_ORG_OP_KINDS.length).toBeGreaterThan(5)
    expect(matouOrgOpSchema.parse({ kind: 'placement/interaction', sessionId: 's-a', at: 42 }))
      .toEqual({ kind: 'placement/interaction', sessionId: 's-a', at: 42 })
  })

  it('at 为负数或小数时被 wire schema 拒绝（与 reducer 同口径）', () => {
    expect(() => matouOrgOpSchema.parse({ kind: 'placement/interaction', sessionId: 's-a', at: -1 })).toThrow()
    expect(() => matouOrgOpSchema.parse({ kind: 'placement/interaction', sessionId: 's-a', at: 1.5 })).toThrow()
  })
})
