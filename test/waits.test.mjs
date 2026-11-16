/**
 * Gate ① unit tests: the pure wait_agent account state machine, no Cordis
 * environment needed. Run: `npm test` (builds first, then node --test).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyWaitEvent, isWaitActive } from '../lib/waits.js'

/** Empty account plus one session id for concise cases. */
const account = () => {
  const waits = new Map()
  waits.set('s1', new Set())
  return waits
}

test('tool/call with name wait_agent opens the account', () => {
  const waits = account()
  applyWaitEvent(waits, 's1', 'tool/call', { callId: 'c1', name: 'wait_agent', arguments: '{}' })
  assert.equal(isWaitActive(waits, 's1'), true)
})

test('tool/call for any other tool leaves the account inactive', () => {
  const waits = account()
  applyWaitEvent(waits, 's1', 'tool/call', { callId: 'c1', name: 'pwsh', arguments: '{}' })
  applyWaitEvent(waits, 's1', 'tool/call', { callId: 'c2', name: 'send_message', arguments: '{}' })
  assert.equal(isWaitActive(waits, 's1'), false)
})

test('tool/call without a usable callId is ignored', () => {
  const waits = account()
  applyWaitEvent(waits, 's1', 'tool/call', { name: 'wait_agent' })
  applyWaitEvent(waits, 's1', 'tool/call', { callId: 42, name: 'wait_agent' })
  applyWaitEvent(waits, 's1', 'tool/call', null)
  assert.equal(isWaitActive(waits, 's1'), false)
})

test('tool/result settles by message.toolCallId, including error payloads', () => {
  const waits = account()
  applyWaitEvent(waits, 's1', 'tool/call', { callId: 'c1', name: 'wait_agent', arguments: '{}' })
  assert.equal(isWaitActive(waits, 's1'), true)
  applyWaitEvent(waits, 's1', 'tool/result', {
    message: { toolCallId: 'c1', content: [] },
    error: { name: 'AgentWaitError', code: 'WAIT_UNAVAILABLE' },
  })
  assert.equal(isWaitActive(waits, 's1'), false)
})

test('tool/result with malformed payload does not throw and changes nothing', () => {
  const waits = account()
  applyWaitEvent(waits, 's1', 'tool/call', { callId: 'c1', name: 'wait_agent', arguments: '{}' })
  applyWaitEvent(waits, 's1', 'tool/result', null)
  applyWaitEvent(waits, 's1', 'tool/result', { message: 'x' })
  applyWaitEvent(waits, 's1', 'tool/result', {})
  assert.equal(isWaitActive(waits, 's1'), true)
})

test('turn/end clears every open id as the catch-all', () => {
  const waits = account()
  applyWaitEvent(waits, 's1', 'tool/call', { callId: 'c1', name: 'wait_agent', arguments: '{}' })
  applyWaitEvent(waits, 's1', 'tool/call', { callId: 'c2', name: 'wait_agent', arguments: '{}' })
  applyWaitEvent(waits, 's1', 'turn/end', { turn: 3, reason: 'completed' })
  assert.equal(isWaitActive(waits, 's1'), false)
})

test('PTC dispatch pair opens by subCallId and settles by subCallId', () => {
  const waits = account()
  applyWaitEvent(waits, 's1', 'tool/ptc-dispatch-start', {
    rootCallId: 'r1', parentCallId: 'r1', subCallId: 'r1:ptc:1', name: 'wait_agent', arguments: '{}',
  })
  assert.equal(isWaitActive(waits, 's1'), true)
  applyWaitEvent(waits, 's1', 'tool/ptc-dispatch', {
    rootCallId: 'r1', parentCallId: 'r1', subCallId: 'r1:ptc:1', name: 'wait_agent', isError: false, content: [],
  })
  assert.equal(isWaitActive(waits, 's1'), false)
})

test('PTC dispatch-start for another tool name is ignored', () => {
  const waits = account()
  applyWaitEvent(waits, 's1', 'tool/ptc-dispatch-start', {
    rootCallId: 'r1', parentCallId: 'r1', subCallId: 'r1:ptc:1', name: 'pwsh', arguments: '{}',
  })
  assert.equal(isWaitActive(waits, 's1'), false)
})

test('parallel waits settle independently; the last one closes the account', () => {
  const waits = account()
  applyWaitEvent(waits, 's1', 'tool/call', { callId: 'c1', name: 'wait_agent', arguments: '{}' })
  applyWaitEvent(waits, 's1', 'tool/call', { callId: 'c2', name: 'wait_agent', arguments: '{}' })
  applyWaitEvent(waits, 's1', 'tool/result', { message: { toolCallId: 'c1', content: [] } })
  assert.equal(isWaitActive(waits, 's1'), true)
  applyWaitEvent(waits, 's1', 'tool/result', { message: { toolCallId: 'c2', content: [] } })
  assert.equal(isWaitActive(waits, 's1'), false)
})

test('settlement for an unknown id is a harmless no-op', () => {
  const waits = account()
  applyWaitEvent(waits, 's1', 'tool/result', { message: { toolCallId: 'ghost', content: [] } })
  applyWaitEvent(waits, 's1', 'tool/ptc-dispatch', { subCallId: 'ghost' })
  assert.equal(isWaitActive(waits, 's1'), false)
})

test('unknown event types and sessions are ignored', () => {
  const waits = account()
  applyWaitEvent(waits, 's1', 'step/start', { turn: 1, step: 1 })
  applyWaitEvent(waits, 's1', 'agent/inbox/spliced', { target: 'next-step', inserted: [] })
  applyWaitEvent(waits, 's-other', 'tool/call', { callId: 'c1', name: 'wait_agent', arguments: '{}' })
  assert.equal(isWaitActive(waits, 's1'), false)
  assert.equal(isWaitActive(waits, 's-other'), true)
  assert.equal(isWaitActive(waits, 's-missing'), false)
})

test('lazy accounts are created on first open and kept empty after turn/end', () => {
  const waits = new Map()
  assert.equal(isWaitActive(waits, 'fresh'), false)
  applyWaitEvent(waits, 'fresh', 'tool/call', { callId: 'c1', name: 'wait_agent', arguments: '{}' })
  assert.equal(waits.has('fresh'), true)
  applyWaitEvent(waits, 'fresh', 'turn/end', { turn: 1, reason: 'completed' })
  assert.equal(isWaitActive(waits, 'fresh'), false)
  assert.equal(waits.has('fresh'), true)
})
