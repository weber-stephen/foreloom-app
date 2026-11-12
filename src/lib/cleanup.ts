import type { Person, Relationship } from './types'

export type CleanupCategory = 'unknown' | 'missingName' | 'isolated' | 'minimal'
export type CleanupRecord = { person: Person; categories: CleanupCategory[]; evidence: string; intentional: boolean }
export type DisconnectedGroup = { fingerprint: string; memberIds: string[]; members: Person[]; acknowledged: boolean }

export function disconnectedGroupFingerprint(memberIds: string[]) {
  return memberIds.slice().sort().join('|')
}

export function buildCleanupData(people: Person[], relationships: Relationship[], intentionalIds: string[], acknowledgedGroups: string[]) {
  const linked = new Map(people.map(person => [person.id, new Set<string>()]))
  relationships.forEach(link => { linked.get(link.fromId)?.add(link.toId); linked.get(link.toId)?.add(link.fromId) })
  const componentSizes = new Map<string, number>()
  const groups: DisconnectedGroup[] = []
  for (const id of linked.keys()) {
    if (componentSizes.has(id)) continue
    const memberIds: string[] = [], seen = new Set([id]), queue = [id]
    while (queue.length) {
      const current = queue.pop()!
      memberIds.push(current)
      for (const next of linked.get(current) || []) if (!seen.has(next)) { seen.add(next); queue.push(next) }
    }
    memberIds.forEach(member => componentSizes.set(member, memberIds.length))
    if (memberIds.length > 1 && memberIds.length < people.length) {
      const fingerprint = disconnectedGroupFingerprint(memberIds)
      groups.push({ fingerprint, memberIds: memberIds.slice().sort(), members: memberIds.map(member => people.find(person => person.id === member)!).sort((a, b) => a.name.localeCompare(b.name)), acknowledged: acknowledgedGroups.includes(fingerprint) })
    }
  }
  const records = people.map(person => {
    const words = person.name.trim().split(/\s+/).filter(Boolean)
    const connections = linked.get(person.id)?.size || 0
    const categories: CleanupCategory[] = []
    if (person.name.trim() === '?') categories.push('unknown')
    if (!person.name.trim() || words.length < 2 || words.some(word => word === '?')) categories.push('missingName')
    if (connections === 0) categories.push('isolated')
    if (person.facts.length === 0 && !person.notes.trim() && person.variants.length === 0) categories.push('minimal')
    const evidence = connections === 0 ? 'No relationships recorded; this person is truly isolated.' : `Connected through ${connections} recorded relationship${connections === 1 ? '' : 's'}.`
    return { person, categories, evidence, intentional: intentionalIds.includes(person.id) }
  }).filter(record => record.categories.length).sort((a, b) => b.categories.length - a.categories.length || a.person.name.localeCompare(b.person.name))
  return { records, groups: groups.sort((a, b) => a.members[0].name.localeCompare(b.members[0].name)) }
}
