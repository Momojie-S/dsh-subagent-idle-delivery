/**
 * Gate ① unit tests: the pure hold-selection predicate, no Cordis
 * environment needed. Run: `npm test` (builds first, then node --test).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isHoldableSource, selectNotices } from '../lib/select.js'

const kinds = new Set(['subagent-settled', 'subagent-report'])

test('isHoldableSource matches configured kinds on object sources', () => {
  assert.equal(isHoldableSource({ kind: 'subagent-settled' }, kinds), true)
  assert.equal(isHoldableSource({ kind: 'subagent-report' }, kinds), true)
})

test('isHoldableSource rejects non-object, kindless, and foreign sources', () => {
  assert.equal(isHoldableSource(null, kinds), false)
  assert.equal(isHoldableSource(undefined, kinds), false)
  assert.equal(isHoldableSource('subagent-settled', kinds), false)
  assert.equal(isHoldableSource({}, kinds), false)
  assert.equal(isHoldableSource({ kind: 'user' }, kinds), false)
  assert.equal(isHoldableSource({ kind: 42 }, kinds), false)
  assert.equal(isHoldableSource({ kind: 'plugin' }, kinds), false)
})

test('isHoldableSource honors a custom configured kind set', () => {
  const custom = new Set(['custom-kind'])
  assert.equal(isHoldableSource({ kind: 'custom-kind' }, custom), true)
  assert.equal(isHoldableSource({ kind: 'subagent-settled' }, custom), false)
})

test('selectNotices keeps order and skips non-messages without a holdable source', () => {
  const settled = { id: 'm1', source: { kind: 'subagent-settled' } }
  const user = { id: 'm2', source: { kind: 'user' } }
  const report = { id: 'm3', source: { kind: 'subagent-report' } }
  const picked = selectNotices([settled, user, report, null, 'x', { id: 'm4' }], kinds)
  assert.deepEqual(picked, [settled, report])
})

test('selectNotices returns empty for an empty insertion', () => {
  assert.deepEqual(selectNotices([], kinds), [])
})
