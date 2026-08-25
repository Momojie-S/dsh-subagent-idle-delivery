/**
 * Subagent idle delivery (hold-and-release): while a parent agent is busy,
 * continuable-subagent settlement notices (`subagent-settled`) and explicit
 * reports (`subagent-report`) are removed from the parent's inbox and held
 * in memory; when the parent becomes fully idle (or the release valve
 * deadline passes), they are re-delivered with `followup()` so each lands
 * as a fresh turn after — never inside — the work in flight.
 *
 * Motivation: the native busy-path delivery is `steer()` — the notice joins
 * the parent's next step batch, which both extends the running turn by one
 * model request and hijacks the model's attention mid-task (observed
 * 2026-08-25: a report arriving right after two edits derailed the parent's
 * stated plan). This plugin restores "receive when stopped" semantics
 * without touching the runtime: it intercepts at the public inbox-splice
 * event seam. The turn that would have been extended closes normally, so
 * the extra steering step disappears too.
 *
 * Loss semantics match the native notice (best effort, in-memory only): a
 * DSH restart or plugin stop releases held messages best-effort, and a
 * parent that died while holding drops them — the child session log
 * remains the durable record either way. See docs/design/overview.md.
 *
 * @module @momojie-s/dsh-subagent-idle-delivery
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { selectNotices } from './select.js'

export const name = 'dsh-subagent-idle-delivery'
// `agents` resolves the splice's session to its live Agent; `timer` powers
// the maxHoldMs release valve. Both are hard dependencies: without them the
// plugin's purpose is void, and waiting-for-service is the correct posture.
export const inject = ['agents', 'timer']

/** Config: which message kinds to hold, and the busy-hold release valve. */
export interface Config {
  /**
   * `UserMessage.source.kind` values held while the parent is busy (default
   * `['subagent-settled', 'subagent-report']`). Extending this list catches
   * every matching source kind — `plugin`, for instance, includes approval
   * and job-completion notices; only add kinds you fully understand.
   */
  heldKinds?: string[]
  /**
   * Release valve in milliseconds (default 600000 = 10 minutes; 0 disables
   * it). When a held batch has waited this long because the parent never
   * went idle (e.g. a continuously driven goal session), it is released as
   * queued next turns — still after the current turn, never steering into
   * it. Bounds unbounded holding without breaking the no-interruption rule.
   */
  maxHoldMs?: number
}

export const Config: z<Config> = z.object({
  heldKinds: z.array(z.string()).default(['subagent-settled', 'subagent-report']),
  maxHoldMs: z.number().min(0).default(600_000),
})

/** One parent's held batch, process-local by design. */
interface HeldEntry {
  /** The exact live Agent the batch belongs to; identity-checked on release. */
  readonly agent: Agent
  readonly messages: UserMessage[]
  /** Whether the whenIdle() watcher is already armed for this entry. */
  armed: boolean
  /** Active valve timer disposer, cleared on release. */
  valve: (() => void) | undefined
}

export function apply(ctx: Context, config: Config): void {
  const heldKinds = new Set(config.heldKinds ?? ['subagent-settled', 'subagent-report'])
  const maxHoldMs = config.maxHoldMs ?? 600_000
  const held = new Map<SessionId, HeldEntry>()

  /**
   * Re-deliver one held batch as fresh turns. `followup()` on an idle agent
   * opens a turn; on a busy one it queues behind the CURRENT turn (valve
   * path) — either way the notice never steers into a running step.
   */
  const release = (sessionId: SessionId, entry: HeldEntry, reason: 'idle' | 'valve' | 'teardown'): void => {
    if (held.get(sessionId) !== entry) return
    held.delete(sessionId)
    if (entry.valve !== undefined) {
      try {
        entry.valve()
      } catch { /* a disposed timer disposer is a no-op */ }
      entry.valve = undefined
    }
    const live = ctx.agents.get(sessionId)
    if (live === undefined || live !== entry.agent) {
      ctx.logger.warn(
        `dsh-subagent-idle-delivery: dropped ${entry.messages.length} held notice(s) for "${String(sessionId)}" `
        + '— agent no longer live (same best-effort loss semantics as the native notice)',
      )
      return
    }
    let delivered = 0
    for (const message of entry.messages) {
      try {
        entry.agent.followup(message)
        delivered += 1
      } catch (error) {
        ctx.logger.warn(
          `dsh-subagent-idle-delivery: one notice for "${String(sessionId)}" could not be re-delivered: ${String(error)}`,
        )
      }
    }
    ctx.logger.info(
      `dsh-subagent-idle-delivery: released ${delivered}/${entry.messages.length} notice(s) to "${String(sessionId)}" (${reason})`,
    )
  }

  /** Arm/extend the release valve for one entry; first hold starts it, a later batch extends it. */
  const armValve = (sessionId: SessionId, entry: HeldEntry): void => {
    if (maxHoldMs <= 0) return
    if (entry.valve !== undefined) {
      try {
        entry.valve()
      } catch { /* stale valve */ }
    }
    entry.valve = ctx.timeout(() => {
      entry.valve = undefined
      release(sessionId, entry, 'valve')
    }, maxHoldMs)
  }

  /** Record one batch and arm the idle watcher plus valve. */
  const hold = (agent: Agent, sessionId: SessionId, messages: readonly UserMessage[]): void => {
    let entry = held.get(sessionId)
    if (entry === undefined || entry.agent !== agent) {
      entry = { agent, messages: [], armed: false, valve: undefined }
      held.set(sessionId, entry)
    }
    entry.messages.push(...messages)
    armValve(sessionId, entry)
    if (entry.armed) return
    entry.armed = true
    agent.whenIdle().then(() => {
      release(sessionId, entry, 'idle')
    }, () => {
      // Disposal rejects nothing today, but a rejected whenIdle means the
      // agent object is done: drop the batch (native loss semantics).
      if (held.get(sessionId) === entry) held.delete(sessionId)
    })
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (event.type !== 'agent/inbox/spliced') return
      const data = event.data as { target?: string; inserted?: readonly UserMessage[] }
      // Both targets are intercepted: the busy settlement path steers into
      // `next-step`, and a wakeup report against a busy parent lands in
      // `next-turn` — both interrupt the in-flight dialogue from the
      // parent model's perspective.
      if (data.target !== 'next-step' && data.target !== 'next-turn') return
      const inserted = data.inserted
      if (inserted === undefined || inserted.length === 0) return
      const notices = selectNotices(inserted, heldKinds) as UserMessage[]
      if (notices.length === 0) return
      const agent = ctx.agents.get(session.id)
      if (agent === undefined || agent.session !== session) return
      // An idle parent already receives these as a fresh turn natively;
      // maintenance windows also report idle and latch their own wake.
      if (agent.status === 'idle') return
      // The durable splice commits BEFORE the live inbox projection mutates
      // (inbox.ts mutate()), so inbox.remove() cannot see these messages
      // inside this synchronous listener. Defer exactly one microtask: any
      // step-boundary claim is at least one macrotask away, so removal wins
      // the race deterministically.
      void Promise.resolve().then(() => {
        const removed: UserMessage[] = []
        try {
          for (const message of notices) {
            if (agent.inbox.remove(message.id)) removed.push(message)
          }
        } catch (error) {
          // Fence: put back what was taken and stand down — the native
          // steering delivery is always an acceptable fallback.
          for (const message of removed) {
            try {
              agent.inject(message)
            } catch { /* drop: native loss semantics */ }
          }
          ctx.logger.warn(`dsh-subagent-idle-delivery: hold failed for "${String(session.id)}", restored native delivery: ${String(error)}`)
          return
        }
        if (removed.length === 0) return
        ctx.logger.info(
          `dsh-subagent-idle-delivery: holding ${removed.length} notice(s) for "${String(session.id)}" until idle`
          + (maxHoldMs > 0 ? ` (valve ${maxHoldMs}ms)` : ''),
        )
        hold(agent, session.id, removed)
      }).catch(() => {
        // Absolute backstop: a plugin error must never reach the host.
      })
    } catch {
      // Synchronous guards must not escape into the session append path.
    }
  })

  // Teardown hands every held batch back as queued turns — followup() is
  // correct whether the parent is idle or busy (see release()).
  ctx.effect(() => () => {
    for (const [sessionId, entry] of Array.from(held.entries())) {
      release(sessionId, entry, 'teardown')
    }
  })

  ctx.logger.info(
    `dsh-subagent-idle-delivery: active (kinds [${[...heldKinds].join(', ')}], valve ${maxHoldMs > 0 ? `${maxHoldMs}ms` : 'off'})`,
  )
}
