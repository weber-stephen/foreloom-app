import { describe, expect, it } from 'vitest'
import { buildManualSearchHandoff } from './manual-search'

const query = { name: 'Ada Byron Lovelace', birthYear: '1815', place: 'London, England', relatives: 'Lord Byron' }

describe('manual research handoffs', () => {
  it('prefills a FamilySearch records search', () => {
    const url = new URL(buildManualSearchHandoff('familysearch', query).url)
    expect(url.pathname).toBe('/en/search/all-collections/results')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      'q.givenName': 'Ada Byron', 'q.surname': 'Lovelace',
      'q.birthLikeDate.from': '1815', 'q.birthLikePlace': 'London, England',
    })
  })
  it('builds an encoded Find a Grave people search', () => {
    const handoff = buildManualSearchHandoff('findagrave', query)
    expect(handoff.url).toContain('firstname=Ada+Byron')
    expect(handoff.url).toContain('lastname=Lovelace')
    expect(handoff.url).toContain('birthyear=1815')
    expect(handoff.url).toContain('location=London%2C+England')
  })

  it('treats a one-word name as a surname-only Find a Grave search', () => {
    expect(buildManualSearchHandoff('findagrave', { ...query, name: 'Lovelace' }).url).toContain('lastname=Lovelace')
  })

  it('requires a place for FamilySearch Research Wiki', () => {
    expect(buildManualSearchHandoff('familysearch_wiki', { ...query, place: '' }).unavailableReason).toMatch(/Add a place/)
    expect(buildManualSearchHandoff('familysearch_wiki', query).url).toContain('search=London%2C%20England')
  })
})
