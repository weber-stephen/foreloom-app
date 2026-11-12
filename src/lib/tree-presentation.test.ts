import { describe, expect, it } from 'vitest'
import type { Person } from './types'
import { possessiveFirstName, treeAvatarVariant, treeLifeLabel } from './tree-presentation'

const person = (overrides: Partial<Person> = {}): Person => ({
  id: 'person', name: 'Ada Lovelace', variants: [], notes: '', livingStatus: 'unknown', sex: '', version: 1, facts: [], ...overrides,
})

describe('tree presentation helpers', () => {
  it('creates compact life labels without implying a death date', () => {
    expect(treeLifeLabel(person({ livingStatus: 'living', facts: [{ id: 'birth', personId: 'person', kind: 'birth', dateText: '12 DEC 1984', place: '', detail: '', provenance: 'user', sourceId: null }] }))).toBe('1984–Living')
    expect(treeLifeLabel(person({ facts: [{ id: 'birth', personId: 'person', kind: 'birth', dateText: '1815', place: '', detail: '', provenance: 'user', sourceId: null }, { id: 'death', personId: 'person', kind: 'death', dateText: '1852', place: '', detail: '', provenance: 'user', sourceId: null }] }))).toBe('1815–1852')
    expect(treeLifeLabel(person())).toBe('Dates unknown')
  })

  it('uses a neutral avatar unless sex is explicitly recorded', () => {
    expect(treeAvatarVariant(person({ sex: 'F' }))).toBe('woman')
    expect(treeAvatarVariant(person({ sex: 'male' }))).toBe('man')
    expect(treeAvatarVariant(person())).toBe('neutral')
  })

  it('creates readable possessive branch labels', () => {
    expect(possessiveFirstName('Mara N Vale')).toBe("Mara's")
    expect(possessiveFirstName('Chris')).toBe("Chris'")
  })
})
