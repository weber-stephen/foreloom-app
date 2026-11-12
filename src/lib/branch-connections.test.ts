import { describe, expect, it } from 'vitest'
import { branchCandidates } from './branch-connections'
import type { Person } from './types'

const person = (id: string, name: string, place = '', dateText = ''): Person => ({ id, name, variants: [], notes: '', livingStatus: 'unknown', sex: '', version: 1, facts: [{ id: `${id}-birth`, personId: id, kind: 'birth', dateText, place, detail: '', provenance: 'user', sourceId: null }] })

describe('branch connection leads', () => {
  it('shows recorded clues and leaves weak pairs out', () => {
    const leads = branchCandidates([person('a', 'Ada Miller', 'Boston', '1890')], [person('b', 'Beth Miller', 'Boston', '1910'), person('c', 'Cole Smith', '', '1912')])
    expect(leads).toEqual([{ fromId: 'a', toId: 'b', fromName: 'Ada Miller', toName: 'Beth Miller', clues: ['Shared surname: miller', 'Shared recorded place: boston', 'Birth years: 1890 and 1910'] }])
  })
})
