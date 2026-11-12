import type { Person } from './types'

export type BranchCandidate = { fromId: string; toId: string; fromName: string; toName: string; clues: string[] }

const year = (person: Person) => {
  const date = person.facts.find(fact => fact.kind === 'birth')?.dateText || ''
  return Number(date.match(/(?:^|\D)(\d{4})(?:\D|$)/)?.[1]) || null
}
const surname = (person: Person) => person.name.trim().split(/\s+/).at(-1)?.toLowerCase() || ''
const places = (person: Person) => new Set(person.facts.map(fact => fact.place.trim().toLowerCase()).filter(Boolean))

export function branchCandidates(members: Person[], others: Person[]): BranchCandidate[] {
  const ranked: { candidate: BranchCandidate; score: number }[] = []
  const bySurname = new Map<string, Person[]>(), byPlace = new Map<string, Person[]>()
  for (const person of others) {
    const name = surname(person)
    if (name.length > 2 && name !== '?') bySurname.set(name, [...(bySurname.get(name) || []), person])
    for (const place of places(person)) byPlace.set(place, [...(byPlace.get(place) || []), person])
  }
  for (const from of members) {
    const fromSurname = surname(from), fromPlaces = places(from)
    const matches = new Map<string, Person>()
    for (const person of bySurname.get(fromSurname) || []) matches.set(person.id, person)
    for (const place of fromPlaces) for (const person of byPlace.get(place) || []) matches.set(person.id, person)
    for (const to of matches.values()) {
      const clues: string[] = []
      let score = 0
      if (fromSurname.length > 2 && fromSurname !== '?' && fromSurname === surname(to)) { clues.push(`Shared surname: ${fromSurname}`); score += 3 }
      const toPlaces = places(to)
      const sharedPlace = [...fromPlaces].find(place => toPlaces.has(place))
      if (sharedPlace) { clues.push(`Shared recorded place: ${sharedPlace}`); score += 2 }
      const fromYear = year(from), toYear = year(to)
      if (fromYear && toYear && Math.abs(fromYear - toYear) <= 55) { clues.push(`Birth years: ${fromYear} and ${toYear}`); score += 1 }
      if (score >= 2) ranked.push({ candidate: { fromId: from.id, toId: to.id, fromName: from.name, toName: to.name, clues }, score })
    }
  }
  return ranked.sort((a, b) => b.score - a.score || a.candidate.fromName.localeCompare(b.candidate.fromName) || a.candidate.toName.localeCompare(b.candidate.toName)).slice(0, 12).map(item => item.candidate)
}
