/** Browser chat activity-group plugin: flow folding and the summary row. */
export { apply, inject } from './apply.ts'
export { foldNodes, formatDuration, isFoldableNode, summarizeActivity } from './flow-group.ts'
export type { ActivitySummary, ActivityToolCount } from './flow-group.ts'
export { ActivityGroupRow } from './ActivityGroupRow.tsx'
