/**
 * Pure hold-selection helpers, isolated so they are unit-testable without a
 * Cordis environment (gate ① of the four-gate verification flow).
 *
 * @module @momojie-s/dsh-subagent-idle-delivery/select
 */

/**
 * Whether one message's `source` object names a kind this deployment holds.
 * Duck-typed on purpose: the source-kind map is open for extension upstream
 * (`MessageSourceMap` is module-augmented by several packages), so this
 * plugin must never enumerate it statically.
 *
 * @param source - the `UserMessage.source` value of one inserted message.
 * @param heldKinds - configured kinds (default: `subagent-settled`,
 *   `subagent-report`).
 * @returns whether the source names a holdable kind.
 */
export function isHoldableSource(source: unknown, heldKinds: ReadonlySet<string>): boolean {
  if (source === null || typeof source !== 'object') return false
  const kind = (source as { kind?: unknown }).kind
  return typeof kind === 'string' && heldKinds.has(kind)
}

/**
 * Select the holdable notices from one inbox splice's inserted list, keeping
 * order. Non-object entries and messages without a holdable source pass
 * through untouched (they are not this plugin's business).
 *
 * @param inserted - the splice's `inserted` messages.
 * @param heldKinds - configured kinds.
 * @returns the subset to consider for holding.
 */
export function selectNotices(inserted: readonly unknown[], heldKinds: ReadonlySet<string>): unknown[] {
  const notices: unknown[] = []
  for (const message of inserted) {
    if (message === null || typeof message !== 'object') continue
    if (isHoldableSource((message as { source?: unknown }).source, heldKinds)) notices.push(message)
  }
  return notices
}
