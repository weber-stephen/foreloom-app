import { describe, expect, it } from 'vitest'
import { matchPeople, personConnections, personSummary } from './person-selector'
import type { Person, Relationship } from './types'

const person = (name: string, birth = '', death = '', livingStatus: Person['livingStatus'] = 'unknown', variants: string[] = []): Person => ({
  id: name, name, variants, notes: '', livingStatus, sex: '', version: 1,
  facts: [birth && { id: 'birth', personId: name, kind: 'birth', dateText: birth, place: '', detail: '', provenance: '', sourceId: null }, death && { id: 'death', personId: name, kind: 'death', dateText: death, place: '', detail: '', provenance: '', sourceId: null }].filter(Boolean) as Person['facts'],
})

describe('person selector', () => {
  const people = [person('Mary Johnson', '', '', 'unknown', ['Mary Smith']), person('Martha Jones'), person('Marie Johns')]
  it('ranks partial names and aliases ahead of typos', () => {
    expect(matchPeople(people, 'mary jo').map(p => p.name)).toEqual(['Mary Johnson'])
    expect(matchPeople(people, 'mary smith').map(p => p.name)).toEqual(['Mary Johnson'])
    expect(matchPeople(people, 'mery johnson').map(p => p.name)).toEqual(['Mary Johnson'])
    expect(matchPeople(people, 'nobody')).toEqual([])
  })
  it('shows age only when exact dates support it', () => {
    expect(personSummary(person('A', '12 DEC 1984', '11 DEC 2024'))).toContain('Age 39')
    expect(personSummary(person('B', '12 DEC 1984', '', 'living'), new Date(2024, 11, 12))).toContain('Age 40')
    expect(personSummary(person('C', 'ABT 1984', '2024'))).toContain('Age unknown')
    expect(personSummary(person('D', '12 DEC 1984'))).toContain('Age unknown')
  })
  it('groups the selected person’s recorded family connections', () => {
    const people = ['Parent', 'Selected', 'Spouse', 'Child'].map(name => person(name))
    const link = (fromId: string, toId: string, kind: string): Relationship => ({ id: `${fromId}-${toId}`, fromId, toId, kind, provenance: 'user', sourceId: null })
    expect(personConnections('Selected', people, [link('Parent', 'Selected', 'biological_parent'), link('Selected', 'Spouse', 'spouse'), link('Selected', 'Child', 'adoptive_parent')])).toEqual({ parents: ['Parent'], partners: ['Spouse'], children: ['Child'] })
  })
})
