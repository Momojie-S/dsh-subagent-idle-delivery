/**
 * Pure `wait_agent` account state machine, isolated so it is unit-testable
 * without a Cordis environment (gate ① of the four-gate verification flow).
 *
 * The account answers one question per session: is a `wait_agent` tool call
 * executing right now? Opening follows the session events that precede
 * execution (`tool/call`, or `tool/ptc-dispatch-start` for a call inside a
 * run-code program); closing follows the settlement events
 * (`tool/result` with `message.toolCallId`, or `tool/ptc-dispatch` with
 * `subCallId` — error, abort, and repair settlements use the same shapes)
 * and, as a catch-all, `turn/end`: a wait never outlives its turn. Unknown
 * event types and malformed payloads are ignored; nothing here may throw.
 *
 * @module @momojie-s/dsh-subagent-idle-delivery/waits
 */

/** Per-session set of `wait_agent` call ids currently believed executing. */
export type WaitAccount = Map<string, Set<string>>

/** Whether `data` is a plain record worth reading string fields from. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Read one string field off an event payload, or undefined. */
function stringField(data: unknown, field: string): string | undefined {
  const value = isRecord(data) ? data[field] : undefined
  return typeof value === 'string' ? value : undefined
}

/**
 * Fold one session event into the wait account.
 * @param waits - the shared account map (mutated in place).
 * @param sessionId - session whose log produced the event.
 * @param type - session event type.
 * @param data - session event payload.
 */
export function applyWaitEvent(waits: WaitAccount, sessionId: string, type: string, data: unknown): void {
  switch (type) {
    case 'tool/call':
    case 'tool/ptc-dispatch-start': {
      if (stringField(data, 'name') !== 'wait_agent') return
      const callId = stringField(data, type === 'tool/call' ? 'callId' : 'subCallId')
      if (callId === undefined) return
      let active = waits.get(sessionId)
      if (active === undefined) {
        active = new Set()
        waits.set(sessionId, active)
      }
      active.add(callId)
      return
    }
    case 'tool/result': {
      // Settlement carries the call id on the result message (all outcomes:
      // success, error, abort, and the TOOL_NOT_STARTED / TOOL_OUTCOME_UNKNOWN
      // repair events share this shape).
      const message = isRecord(data) ? data['message'] : undefined
      const callId = stringField(message, 'toolCallId')
      if (callId === undefined) return
      waits.get(sessionId)?.delete(callId)
      return
    }
    case 'tool/ptc-dispatch': {
      const callId = stringField(data, 'subCallId')
      if (callId === undefined) return
      waits.get(sessionId)?.delete(callId)
      return
    }
    case 'turn/end': {
      // A wait executes inside one turn's step; whatever interrupted it, the
      // turn's unconditional ending clears any leaked ids.
      waits.get(sessionId)?.clear()
      return
    }
    default:
      return
  }
}

/**
 * Whether at least one `wait_agent` call is currently believed executing.
 * @param waits - the shared account map.
 * @param sessionId - session to inspect.
 * @returns true when the session has a non-empty active-wait set.
 */
export function isWaitActive(waits: WaitAccount, sessionId: string): boolean {
  const active = waits.get(sessionId)
  return active !== undefined && active.size > 0
}
