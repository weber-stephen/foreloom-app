import type { Person, Relationship } from './types'

export function personConnections(personId: string, people: Person[], relationships: Relationship[]) {
  const names = new Map(people.map(person => [person.id, person.name]))
  const resolve = (ids: string[]) => [...new Set(ids)].map(id => names.get(id)).filter((name): name is string => !!name)
  return {
    parents: resolve(relationships.filter(r => r.toId === personId && r.kind.endsWith('_parent')).map(r => r.fromId)),
    partners: resolve(relationships.filter(r => (r.fromId === personId || r.toId === personId) && ['spouse', 'partner'].includes(r.kind)).map(r => r.fromId === personId ? r.toId : r.fromId)),
    children: resolve(relationships.filter(r => r.fromId === personId && r.kind.endsWith('_parent')).map(r => r.toId)),
  }
}

const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

function near(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 3) return false
  let i = 0, j = 0, edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue }
    if (++edits > 1) return false
    if (a.length > b.length) i++
    else if (b.length > a.length) j++
    else { i++; j++ }
  }
  return true
}

export function matchPeople(people: Person[], query: string) {
  const words = normalize(query).split(' ').filter(Boolean)
  if (!words.length) return people
  return people.map(person => {
    const names = [person.name, ...person.variants].map(normalize)
    const scores = names.map(name => {
      const tokens = name.split(' ')
      if (name === words.join(' ')) return 0
      if (name.includes(words.join(' '))) return 1
      if (words.every(word => tokens.some(token => token.startsWith(word)))) return 2
      if (words.every(word => tokens.some(token => near(word, token)))) return 3
      return Infinity
    })
    return { person, score: Math.min(...scores) }
  }).filter(item => Number.isFinite(item.score)).sort((a, b) => a.score - b.score || a.person.name.localeCompare(b.person.name)).map(item => item.person)
}

function exactDate(value: string) {
  const trimmed = value.trim()
  const match = trimmed.match(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/)
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match && !iso) return null
  const month = match ? ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'].indexOf(match[2].toUpperCase()) : Number(iso![2]) - 1
  if (month < 0) return null
  const year = Number(match ? match[3] : iso![1])
  const day = Number(match ? match[1] : iso![3])
  const date = new Date(year, month, day)
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day ? date : null
}

export function personSummary(person: Person, today = new Date()) {
  const birth = person.facts.find(fact => fact.kind === 'birth')?.dateText || ''
  const death = person.facts.find(fact => fact.kind === 'death')?.dateText || ''
  const start = exactDate(birth)
  const end = death ? exactDate(death) : person.livingStatus === 'living' ? today : null
  const age = start && end && end >= start ? end.getFullYear() - start.getFullYear() - (end.getMonth() < start.getMonth() || end.getMonth() === start.getMonth() && end.getDate() < start.getDate() ? 1 : 0) : null
  return `Age ${age ?? 'unknown'} · Born ${birth || 'unknown'} · Died ${death || 'unknown'}`
}
