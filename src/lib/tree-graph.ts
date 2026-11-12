import type { Person, Relationship } from './types'

export type GraphPosition = { x: number; y: number }
export type RelationshipPath = { relationship: Relationship; fromId: string; toId: string }[]
export type RelationshipIndex = { neighbors: Map<string, { relationship: Relationship; personId: string }[]>; parents: Map<string, Relationship[]>; children: Map<string, Relationship[]> }

const isParent = (relationship: Relationship) => relationship.kind.endsWith('_parent')
const relationName = (relationship: Relationship, forward: boolean) => {
  if (relationship.kind === 'spouse' || relationship.kind === 'partner') return relationship.kind
  const prefix = relationship.kind.replace('_parent', '').replace('_', ' ')
  return forward ? `${prefix} child` : `${prefix} parent`
}

export function neighbors(personId: string, relationships: Relationship[]) {
  return relationships
    .filter(r => r.fromId === personId || r.toId === personId)
    .map(relationship => ({ relationship, personId: relationship.fromId === personId ? relationship.toId : relationship.fromId }))
}

export function relationshipIndex(relationships: Relationship[]): RelationshipIndex {
  const index: RelationshipIndex = { neighbors: new Map(), parents: new Map(), children: new Map() }
  const add = <T>(map: Map<string, T[]>, id: string, value: T) => {
    const values = map.get(id)
    if (values) values.push(value)
    else map.set(id, [value])
  }
  relationships.forEach(relationship => {
    const addNeighbor = (id: string, personId: string) => add(index.neighbors, id, { relationship, personId })
    addNeighbor(relationship.fromId, relationship.toId)
    addNeighbor(relationship.toId, relationship.fromId)
    if (isParent(relationship)) {
      add(index.parents, relationship.toId, relationship)
      add(index.children, relationship.fromId, relationship)
    }
  })
  return index
}

/** Returns the other documented children of any recorded parent of `personId`. */
export function siblingIds(personId: string, index: RelationshipIndex) {
  const siblings = new Set<string>()
  ;(index.parents.get(personId) || []).forEach(parent => {
    ;(index.children.get(parent.fromId) || []).forEach(child => {
      if (child.toId !== personId) siblings.add(child.toId)
    })
  })
  return [...siblings]
}

export function familyVisibility(baseIds: Set<string>, expandedParents: Set<string>, index: RelationshipIndex) {
  const visible = new Set([...baseIds, ...expandedParents])
  expandedParents.forEach(id => {
    ;(index.parents.get(id) || []).forEach(relationship => visible.add(relationship.fromId))
  })
  return visible
}

export function familyDepths(focusId: string, visibleIds: Set<string>, index: RelationshipIndex) {
  const depths = new Map([[focusId, 0]])
  const queue = [focusId]
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor]
    const depth = depths.get(id) || 0
    for (const { relationship, personId } of index.neighbors.get(id) || []) {
      if (!visibleIds.has(personId) || depths.has(personId)) continue
      const nextDepth = relationship.kind.endsWith('_parent')
        ? depth + (relationship.fromId === id ? 1 : -1)
        : depth
      depths.set(personId, nextDepth)
      queue.push(personId)
    }
  }
  return depths
}

export function nextFamilyLimit(ids: string[], visibleIds: Set<string>, limit: number) {
  let added = 0
  while (limit < ids.length && added < 12) {
    if (!visibleIds.has(ids[limit])) added++
    limit++
  }
  return limit
}

/**
 * Returns documented direct descendants keyed by their closest generation below
 * `rootId`. GEDCOM imports use `unknown_parent` for ordinary parent-child
 * connections when the relationship type was not explicitly supplied.
 */
export function directDescendants(rootId: string, relationships: Relationship[]) {
  const descendants = new Map<string, number>()
  if (!rootId) return descendants
  const children = new Map<string, string[]>()
  relationships.forEach(relationship => {
    if (relationship.kind !== 'biological_parent' && relationship.kind !== 'unknown_parent') return
    const current = children.get(relationship.fromId)
    if (current) current.push(relationship.toId)
    else children.set(relationship.fromId, [relationship.toId])
  })
  const queue: { id: string; generation: number }[] = [{ id: rootId, generation: 0 }]
  let cursor = 0
  const visited = new Set([rootId])
  while (cursor < queue.length) {
    const { id, generation } = queue[cursor++]
    ;(children.get(id) || []).forEach(childId => {
      if (visited.has(childId)) return
      visited.add(childId)
      descendants.set(childId, generation + 1)
      queue.push({ id: childId, generation: generation + 1 })
    })
  }
  return descendants
}

/**
 * Returns documented direct ancestors keyed by their closest generation above
 * `rootId`. This follows the same biological or unspecified GEDCOM parentage
 * rules as directDescendants, while preserving the inverse relationship
 * direction used by the stored graph.
 */
export function directAncestors(rootId: string, relationships: Relationship[]) {
  const ancestors = new Map<string, number>()
  if (!rootId) return ancestors
  const parents = new Map<string, string[]>()
  relationships.forEach(relationship => {
    if (relationship.kind !== 'biological_parent' && relationship.kind !== 'unknown_parent') return
    const current = parents.get(relationship.toId)
    if (current) current.push(relationship.fromId)
    else parents.set(relationship.toId, [relationship.fromId])
  })
  const queue: { id: string; generation: number }[] = [{ id: rootId, generation: 0 }]
  let cursor = 0
  const visited = new Set([rootId])
  while (cursor < queue.length) {
    const { id, generation } = queue[cursor++]
    ;(parents.get(id) || []).forEach(parentId => {
      if (visited.has(parentId)) return
      visited.add(parentId)
      ancestors.set(parentId, generation + 1)
      queue.push({ id: parentId, generation: generation + 1 })
    })
  }
  return ancestors
}

const indexedNeighbors = (personId: string, index?: RelationshipIndex, relationships?: Relationship[]) => index?.neighbors.get(personId) || neighbors(personId, relationships || [])

export function initialVisibleIds(focusId: string) {
  return new Set([focusId])
}

export function expandVisibleIds(visibleIds: Set<string>, personId: string, relationships: Relationship[]) {
  const next = new Set(visibleIds)
  next.add(personId)
  neighbors(personId, relationships).forEach(item => next.add(item.personId))
  return next
}

export function expandParents(visibleIds: Set<string>, personId: string, index: RelationshipIndex, siblingLimit = 24) {
  const next = new Set(visibleIds)
  const parents = index.parents.get(personId) || []
  const siblingIds = new Set<string>()
  parents.forEach(parent => {
    next.add(parent.fromId)
    ;(index.children.get(parent.fromId) || []).forEach(child => { if (child.toId !== personId) siblingIds.add(child.toId) })
  })
  const addedSiblings = [...siblingIds].filter(id => !next.has(id)).slice(0, siblingLimit)
  addedSiblings.forEach(id => next.add(id))
  return { visibleIds: next, parentCount: parents.filter(parent => !visibleIds.has(parent.fromId)).length, hiddenSiblingCount: Math.max(0, [...siblingIds].filter(id => !visibleIds.has(id)).length - addedSiblings.length) }
}

export function hiddenParentCount(personId: string, visibleIds: Set<string>, index: RelationshipIndex) {
  return (index.parents.get(personId) || []).filter(parent => !visibleIds.has(parent.fromId)).length
}

export function expandFamilyBranch(visibleIds: Set<string>, personId: string, relationships: Relationship[]) {
  const next = new Set(visibleIds)
  const queue = [personId]
  const visited = new Set<string>()
  while (queue.length) {
    const current = queue.shift()!
    if (visited.has(current)) continue
    visited.add(current)
    next.add(current)
    neighbors(current, relationships).forEach(({ personId: neighborId }) => {
      if (!visited.has(neighborId)) queue.push(neighborId)
    })
  }
  return next
}

export function hiddenFamilyCount(personId: string, visibleIds: Set<string>, relationships: Relationship[]) {
  return [...expandFamilyBranch(new Set<string>(), personId, relationships)].filter(id => !visibleIds.has(id)).length
}

export function hiddenNeighborCount(personId: string, visibleIds: Set<string>, relationships: Relationship[]) {
  return neighbors(personId, relationships).filter(item => !visibleIds.has(item.personId)).length
}

export function findRelationshipPath(homeId: string, targetId: string, relationships: Relationship[], index?: RelationshipIndex): RelationshipPath {
  if (!homeId || homeId === targetId) return []
  const queue = [homeId]
  let cursor = 0
  const visited = new Set([homeId])
  const previous = new Map<string, { id: string; relationship: Relationship }>()
  while (cursor < queue.length) {
    const currentId = queue[cursor++]
    const next = [...indexedNeighbors(currentId, index, relationships)]
      .sort((a, b) => a.relationship.kind.localeCompare(b.relationship.kind) || a.personId.localeCompare(b.personId))
    for (const item of next) {
      if (visited.has(item.personId)) continue
      visited.add(item.personId)
      previous.set(item.personId, { id: currentId, relationship: item.relationship })
      if (item.personId === targetId) {
        const path: RelationshipPath = []
        let current = targetId
        while (current !== homeId) {
          const step = previous.get(current)!
          path.unshift({ relationship: step.relationship, fromId: step.id, toId: current })
          current = step.id
        }
        return path
      }
      queue.push(item.personId)
    }
  }
  return []
}

export function relationshipLabel(homeName: string, path: RelationshipPath) {
  if (!path.length) return 'Home person'
  // Parent relationships are stored parent -> child. A direct lineage can be
  // described once even when GEDCOM does not specify the type of parentage.
  const direction = (step: RelationshipPath[number]) => {
    if (!isParent(step.relationship)) return null
    if (step.fromId === step.relationship.toId && step.toId === step.relationship.fromId) return 'up'
    if (step.fromId === step.relationship.fromId && step.toId === step.relationship.toId) return 'down'
    return null
  }
  const directions = path.map(direction)
  const linealDirection = directions.every(item => item === 'up') ? 'up' : directions.every(item => item === 'down') ? 'down' : null
  if (linealDirection) {
    const relation = (count: number) => {
      const root = linealDirection === 'up' ? ['parent', 'grandparent'] : ['child', 'grandchild']
      return root[count - 1] || `${'great-'.repeat(count - 2)}${root[1]}`
    }
    const kinds = new Set(path.map(step => step.relationship.kind))
    const kind = [...kinds][0]
    const qualifier = kinds.size > 1
      ? { prefix: '', suffix: ' (mixed parentage types)' }
      : kind === 'unknown_parent'
        ? { prefix: '', suffix: ' (parentage type unknown)' }
        : { prefix: `${kind.replace('_parent', '').replace('_', ' ')} `, suffix: '' }
    return `${homeName}'s ${qualifier.prefix}${relation(path.length)}${qualifier.suffix}`
  }
  return `${homeName}'s ${path.map(step => relationName(step.relationship, step.fromId === step.relationship.fromId)).join(' → ')}`
}

export function layoutTreeGraph(people: Person[], relationships: Relationship[], visibleIds: Set<string>, focusId: string, index?: RelationshipIndex) {
  const visible = people.filter(person => visibleIds.has(person.id))
  const rank = new Map<string, number>([[focusId, 0]])
  const queue = [focusId]
  let cursor = 0
  while (cursor < queue.length) {
    const currentId = queue[cursor++]
    const currentRank = rank.get(currentId) || 0
    for (const { relationship, personId } of indexedNeighbors(currentId, index, relationships)) {
      if (!visibleIds.has(personId) || rank.has(personId)) continue
      let nextRank = currentRank
      if (isParent(relationship)) nextRank += relationship.fromId === currentId ? 1 : -1
      rank.set(personId, nextRank)
      queue.push(personId)
    }
  }
  visible.forEach(person => { if (!rank.has(person.id)) rank.set(person.id, 0) })
  const rows = new Map<number, Person[]>()
  visible.forEach(person => {
    const row = rank.get(person.id) || 0
    rows.set(row, [...(rows.get(row) || []), person])
  })
  const positions = new Map<string, GraphPosition>()
  ;[...rows.entries()].sort(([a], [b]) => a - b).forEach(([row, rowPeople]) => {
    const ordered = [...rowPeople].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    ordered.forEach((person, index) => positions.set(person.id, { x: index * 250, y: row * 190 }))
  })
  const minX = Math.min(...[...positions.values()].map(position => position.x), 0)
  const maxX = Math.max(...[...positions.values()].map(position => position.x), 0)
  for (const position of positions.values()) position.x -= (minX + maxX) / 2
  return positions
}
