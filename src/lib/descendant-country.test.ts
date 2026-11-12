import { describe, expect, it } from 'vitest'
import { descendantCountryDistribution } from './descendant-country'
import type { PlaceMap } from './types'

const map = (countries: PlaceMap['countries']): PlaceMap => ({ places: [], countries, unresolved: [], mappedPeopleCount: 0, totalPeopleCount: 0 })
const country = (code: string, name: string, personIds: string[]) => ({ id: `country:${code}`, name, level: 'country', countryCode: code, regionCode: null, longitude: 0, latitude: 0, peopleCount: personIds.length, personIds, eventKinds: ['birth'] })
const place = (id: string, countryCode: string, regionCode: string | null, personIds: string[]) => ({ id, name: id, level: 'locality', countryCode, regionCode, longitude: 0, latitude: 0, peopleCount: personIds.length, personIds, eventKinds: ['birth'] })

describe('descendant country distribution', () => {
  it('assigns each descendant to one mapped country or Not mapped', () => {
    const result = descendantCountryDistribution(['one', 'two', 'three', 'four'], map([country('US', 'United States', ['one', 'two']), country('CA', 'Canada', ['three']), country('GB', 'United Kingdom', ['three'])]))
    expect(result.total).toBe(4)
    expect(result.mapped).toBe(2)
    expect(result.slices).toEqual([{ key: 'US', label: 'United States', count: 2, fraction: .5, unmapped: false }, { key: 'unmapped', label: 'Not mapped', count: 2, fraction: .5, unmapped: true }])
  })

  it('returns no slices when there are no descendants', () => {
    expect(descendantCountryDistribution([], map([]))).toEqual({ total: 0, mapped: 0, slices: [] })
  })

  it('separates recorded United Kingdom nations without guessing incomplete places', () => {
    const placeMap = map([country('GB', 'United Kingdom', ['england', 'scotland', 'unspecified'])])
    placeMap.places = [place('york', 'GB', 'ENG', ['england']), place('edinburgh', 'GB', 'SCT', ['scotland']), place('unknown', 'GB', null, ['unspecified'])]
    expect(descendantCountryDistribution(['england', 'scotland', 'unspecified'], placeMap, { splitUnitedKingdom: true }).slices).toEqual([
      { key: 'GB:ENG', label: 'England', count: 1, fraction: 1 / 3, unmapped: false },
      { key: 'GB:SCT', label: 'Scotland', count: 1, fraction: 1 / 3, unmapped: false },
      { key: 'GB', label: 'United Kingdom', count: 1, fraction: 1 / 3, unmapped: false },
    ])
  })
})
