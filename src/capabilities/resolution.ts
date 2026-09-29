/** Resolve capability identity and project overrides before either rendering or activation. */
export interface CapabilityEntry {
  id: string
  kind: 'skill' | 'mcp'
  /** Skill frontmatter name / MCP server namespace, never the display label. */
  key: string
  title: string
  scope: { kind: 'global' } | { kind: 'projects'; projectIds: readonly string[] }
  enabled: boolean
}
export interface CapabilityOverride {
  kind: CapabilityEntry['kind']
  key: string
  projectId: string
  /** Disable is a tombstone, not deletion of the project entry. */
  mode: 'disabled' | 'inherit' | 'project' | 'enabled'
}
export interface CapabilityResolution<T extends CapabilityEntry = CapabilityEntry> {
  identity: string
  entries: readonly T[]
  effective: T | null
  status: 'enabled' | 'disabled' | 'conflict'
  reason: 'project' | 'global' | 'project-disabled' | 'explicit-inherit' | 'duplicate-scope'
  shadowed: readonly T[]
}
export function capabilityIdentity(entry: Pick<CapabilityEntry, 'kind' | 'key'>): string {
  return `${entry.kind}:${entry.key}`
}
/** Ambiguous same-scope duplicates are surfaced, never selected by incidental array order. */
export function resolveCapabilities<T extends CapabilityEntry>(
  entries: readonly T[], projectId: string | null, overrides: readonly CapabilityOverride[] = [],
): CapabilityResolution<T>[] {
  const groups = new Map<string, T[]>()
  for (const entry of entries) {
    if (entry.scope.kind === 'projects' && (!projectId || !entry.scope.projectIds.includes(projectId))) continue
    const identity = capabilityIdentity(entry)
    const group = groups.get(identity) ?? []
    group.push(entry); groups.set(identity, group)
  }
  return [...groups].map(([identity, group]) => {
    const local = group.filter(e => e.scope.kind === 'projects')
    const global = group.filter(e => e.scope.kind === 'global')
    const override = projectId ? overrides.find(o => o.projectId === projectId && capabilityIdentity(o) === identity) : undefined
    if (override?.mode === 'disabled') return { identity, entries: group, effective: null, status: 'disabled', reason: 'project-disabled', shadowed: group } as CapabilityResolution<T>
    const pool = override?.mode === 'inherit' || !local.length ? global : local
    if (pool.length > 1) return { identity, entries: group, effective: null, status: 'conflict', reason: 'duplicate-scope', shadowed: group } as CapabilityResolution<T>
    const winner = pool[0] ?? null
    return {
      identity, entries: group, effective: winner,
      status: winner && (winner.enabled || override?.mode === 'enabled') ? 'enabled' : 'disabled',
      reason: override?.mode === 'inherit' ? 'explicit-inherit' : local.length ? 'project' : 'global',
      shadowed: group.filter(e => e !== winner),
    } as CapabilityResolution<T>
  }).sort((a,b) => a.identity.localeCompare(b.identity))
}
/** A multi-project scope clashes only on its intersecting projects. */
export function conflictingProjects(a: CapabilityEntry, b: CapabilityEntry): readonly string[] | 'global' {
  if (a.id === b.id || capabilityIdentity(a) !== capabilityIdentity(b)) return []
  if (a.scope.kind === 'global' && b.scope.kind === 'global') return 'global'
  if (a.scope.kind !== 'projects' || b.scope.kind !== 'projects') return []
  const other = new Set(b.scope.projectIds)
  return a.scope.projectIds.filter(p => other.has(p))
}
