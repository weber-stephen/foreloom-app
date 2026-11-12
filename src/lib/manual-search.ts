export type ManualSearchProvider = 'findagrave' | 'familysearch' | 'familysearch_wiki'

export type ManualSearchQuery = {
  name: string
  birthYear: string
  place: string
  relatives: string
}

export type ManualSearchHandoff = {
  url: string
  unavailableReason?: string
}

const clean = (value: string) => value.trim()

export function buildManualSearchHandoff(provider: ManualSearchProvider, query: ManualSearchQuery): ManualSearchHandoff {
  if (provider === 'familysearch_wiki') {
    const place = clean(query.place)
    if (!place) return { url: '', unavailableReason: 'Add a place to search FamilySearch Research Wiki guides.' }
    return { url: `https://www.familysearch.org/en/wiki/Special:Search?search=${encodeURIComponent(place)}` }
  }

  const parts = clean(query.name).split(/\s+/).filter(Boolean)
  const surname = parts.pop() || ''
  const params = new URLSearchParams()
  if (provider === 'familysearch') {
    if (parts.length) params.set('q.givenName', parts.join(' '))
    if (surname) params.set('q.surname', surname)
    if (clean(query.birthYear)) params.set('q.birthLikeDate.from', clean(query.birthYear))
    if (clean(query.place)) params.set('q.birthLikePlace', clean(query.place))
    return { url: `https://www.familysearch.org/en/search/all-collections/results${params.size ? `?${params}` : ''}` }
  }
  if (parts.length) params.set('firstname', parts.join(' '))
  if (surname) params.set('lastname', surname)
  if (clean(query.birthYear)) params.set('birthyear', clean(query.birthYear))
  if (clean(query.place)) params.set('location', clean(query.place))
  return { url: `https://www.findagrave.com/memorial/search?${params}` }
}
