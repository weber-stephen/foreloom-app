import type { PlaceMap } from './types'

export type CountrySlice = { key: string; label: string; count: number; fraction: number; unmapped: boolean }
export type DescendantCountryDistribution = { total: number; mapped: number; slices: CountrySlice[] }
export type CountryDistributionOptions = { splitUnitedKingdom?: boolean }

const ukNations: Record<string, string> = { ENG: 'England', NIR: 'Northern Ireland', SCT: 'Scotland', WLS: 'Wales' }

/** Assigns every descendant to exactly one country, or the explicit Not mapped slice. */
export function descendantCountryDistribution(descendantIds: Iterable<string>, placeMap: PlaceMap, options: CountryDistributionOptions = {}): DescendantCountryDistribution {
  const ids = [...new Set(descendantIds)]
  const countriesByPerson = new Map<string, Map<string, string>>()
  const ukNationsByPerson = new Map<string, Set<string>>()
  placeMap.countries.forEach(country => country.personIds.forEach(personId => {
    const matches = countriesByPerson.get(personId) || new Map<string, string>()
    matches.set(country.countryCode, country.name)
    countriesByPerson.set(personId, matches)
  }))
  if (options.splitUnitedKingdom) {
    placeMap.places
      .filter(place => place.countryCode === 'GB' && place.regionCode && ukNations[place.regionCode])
      .forEach(place => place.personIds.forEach(personId => {
        const nations = ukNationsByPerson.get(personId) || new Set<string>()
        nations.add(place.regionCode!)
        ukNationsByPerson.set(personId, nations)
      }))
  }
  const counts = new Map<string, { label: string; count: number }>()
  let mapped = 0
  let unmapped = 0
  ids.forEach(personId => {
    const countries = countriesByPerson.get(personId)
    if (!countries || countries.size !== 1) { unmapped += 1; return }
    const [countryCode, countryLabel] = countries.entries().next().value as [string, string]
    const nations = ukNationsByPerson.get(personId)
    const nationCode = countryCode === 'GB' && nations?.size === 1 ? [...nations][0] : null
    const code = nationCode ? `GB:${nationCode}` : countryCode
    const label = nationCode ? ukNations[nationCode] : countryLabel
    const current = counts.get(code)
    if (current) current.count += 1
    else counts.set(code, { label, count: 1 })
    mapped += 1
  })
  const slices = [...counts.entries()].map(([key, value]) => ({ key, label: value.label, count: value.count, fraction: value.count / ids.length, unmapped: false }))
  if (unmapped) slices.push({ key: 'unmapped', label: 'Not mapped', count: unmapped, fraction: unmapped / ids.length, unmapped: true })
  return { total: ids.length, mapped, slices: slices.sort((left, right) => Number(left.unmapped) - Number(right.unmapped) || right.count - left.count || left.label.localeCompare(right.label)) }
}
