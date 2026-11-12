import { describe, expect, it } from 'vitest'
import { buildCleanupData, disconnectedGroupFingerprint } from './cleanup'
import type { Person, Relationship } from './types'

const person = (id: string, name = id): Person => ({ id, name, variants: [], notes: '', livingStatus: 'unknown', sex: '', version: 1, facts: [] })
const link = (fromId: string, toId: string): Relationship => ({ id: `${fromId}-${toId}`, fromId, toId, kind: 'spouse', provenance: 'user', sourceId: null })

describe('cleanup connectivity', () => {
  it('returns one deterministic card for each separate multi-person branch', () => {
    const data = buildCleanupData([person('a'), person('b'), person('c'), person('d'), person('e')], [link('a', 'b'), link('c', 'd')], [], [])
    expect(data.groups.map(group => group.memberIds)).toEqual([['a', 'b'], ['c', 'd']])
    expect(data.records.find(record => record.person.id === 'e')?.categories).toContain('isolated')
  })
  it('acknowledges only an unchanged membership fingerprint', () => {
    const fingerprint = disconnectedGroupFingerprint(['b', 'a'])
    expect(buildCleanupData([person('a'), person('b'), person('c')], [link('a', 'b')], [], [fingerprint]).groups[0].acknowledged).toBe(true)
    expect(buildCleanupData([person('a'), person('b'), person('c'), person('d')], [link('a', 'b'), link('b', 'd')], [], [fingerprint]).groups[0].acknowledged).toBe(false)
  })
})
