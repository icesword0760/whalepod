import type { ReactNode } from 'react'

/** Matou's AppIcon geometry; DSH supplies the button colors and hover treatment. */
export type ActionIconName = 'graph-ring' | 'panel-right-open' | 'layers-plus' | 'copy-plus' | 'circle-minus'

export function ActionIcon({ name, size = 16 }: { name: ActionIconName; size?: number }) {
  return <svg data-icon={name} aria-hidden="true" focusable="false"
    width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    {paths[name]}
  </svg>
}

const paths: Record<ActionIconName, ReactNode> = {
  'graph-ring': <><path d="M13.8 5.6a8.2 8.2 0 0 1 4.5 7.8M16.5 17.5a8.2 8.2 0 0 1-9 0M5.7 13.4a8.2 8.2 0 0 1 4.5-7.8"/><circle cx="12" cy="4.5" r="2.15" fill="currentColor" stroke="none"/><circle cx="18.5" cy="16" r="2.15" fill="currentColor" stroke="none"/><circle cx="5.5" cy="16" r="2.15" fill="currentColor" stroke="none"/></>,
  'panel-right-open': <><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M14 4v16M17.5 9v6M20.5 12h-6"/></>,
  'layers-plus': <><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 .83.18a2 2 0 0 0 .83-.18l8.58-3.9a1 1 0 0 0 0-1.831zM16 17h6m-3-3v6M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 .825.178M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l2.116-.962"/></>,
  'copy-plus': <><path d="M15 12v6m-3-3h6"/><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></>,
  'circle-minus': <><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/></>,
}
