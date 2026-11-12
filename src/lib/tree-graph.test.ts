import { describe, expect, it } from 'vitest'
import type { Person, Relationship } from './types'
import { directAncestors, directDescendants, expandFamilyBranch, expandParents, expandVisibleIds, familyDepths, familyVisibility, findRelationshipPath, initialVisibleIds, nextFamilyLimit, relationshipIndex, relationshipLabel, siblingIds } from './tree-graph'

const person = (id: string, name = id): Person => ({ id, name, variants: [], notes: '', livingStatus: 'unknown', sex: '', version: 1, facts: [] })
const relationship = (id: string, fromId: string, toId: string, kind: string): Relationship => ({ id, fromId, toId, kind, provenance: 'user', sourceId: null })

describe('tree graph helpers', () => {
  const relationships = [relationship('parent', 'parent', 'home', 'biological_parent'), relationship('child', 'home', 'child', 'biological_parent'), relationship('partner', 'home', 'partner', 'spouse'), relationship('grandchild', 'child', 'grandchild', 'biological_parent')]

  it('seeds a large graph with only the focus person and expands direct neighbors on demand', () => {
    expect([...initialVisibleIds('home')]).toEqual(['home'])
    expect([...expandVisibleIds(initialVisibleIds('home'), 'child', relationships)].sort()).toEqual(['child', 'grandchild', 'home'])
  })

  it('bounds a nine-thousand-person sibling branch to the requested window', () => {
    const branch = [relationship('parent', 'parent', 'home', 'biological_parent')]
    for (let number = 0; number < 9760; number += 1) branch.push(relationship(`sibling-${number}`, 'parent', `sibling-${number}`, 'biological_parent'))
    const expanded = expandParents(initialVisibleIds('home'), 'home', relationshipIndex(branch))
    expect(expanded.visibleIds).toContain('parent')
    expect([...expanded.visibleIds].filter(id => id.startsWith('sibling-'))).toHaveLength(24)
    expect(expanded.hiddenSiblingCount).toBe(9736)
  })

  it('finds each documented sibling once and ignores non-parent relationships', () => {
    const branch = [
      relationship('first-parent-home', 'first-parent', 'home', 'biological_parent'),
      relationship('second-parent-home', 'second-parent', 'home', 'biological_parent'),
      relationship('first-parent-full', 'first-parent', 'full-sibling', 'biological_parent'),
      relationship('second-parent-full', 'second-parent', 'full-sibling', 'biological_parent'),
      relationship('first-parent-half', 'first-parent', 'half-sibling', 'unknown_parent'),
      relationship('partner', 'home', 'partner', 'spouse'),
    ]
    expect(siblingIds('home', relationshipIndex(branch)).sort()).toEqual(['full-sibling', 'half-sibling'])
  })

  it('expands a whole connected family branch, including siblings behind visible parents', () => {
    const branch = [
      relationship('parent', 'parent', 'home', 'biological_parent'),
      relationship('sibling', 'parent', 'sibling', 'biological_parent'),
      relationship('partner', 'sibling', 'partner', 'spouse'),
      relationship('child', 'sibling', 'child', 'biological_parent'),
    ]
    expect([...expandFamilyBranch(initialVisibleIds('home'), 'home', branch)].sort()).toEqual(['child', 'home', 'parent', 'partner', 'sibling'])
  })

  it('reveals parents without removing children or other visible people', () => {
    const branch = [
      relationship('home-child', 'home', 'child', 'biological_parent'),
      relationship('other-child', 'other-parent', 'child', 'biological_parent'),
      relationship('child-grandchild', 'child', 'grandchild', 'biological_parent'),
    ]
    const index = relationshipIndex(branch)
    const base = new Set(['home', 'child', 'grandchild'])
    expect([...familyVisibility(base, new Set(['child']), index)].sort()).toEqual(['child', 'grandchild', 'home', 'other-parent'])
    expect([...familyVisibility(base, new Set(), index)].sort()).toEqual(['child', 'grandchild', 'home'])
    expect(familyDepths('home', familyVisibility(base, new Set(['child']), index), index).get('grandchild')).toBe(2)
  })

  it('advances show more past relatives already revealed by another family', () => {
    expect(nextFamilyLimit(['a', 'b', 'c', 'd'], new Set(['a', 'b', 'c']), 1)).toBe(4)
  })

  it('handles an empty family and circular relationships', () => {
    const empty = relationshipIndex([])
    expect([...familyVisibility(new Set(['home']), new Set(['home']), empty)]).toEqual(['home'])
    const circular = relationshipIndex([
      relationship('one', 'home', 'child', 'biological_parent'),
      relationship('two', 'child', 'home', 'unknown_parent'),
    ])
    expect([...familyDepths('home', familyVisibility(new Set(['home']), new Set(['home']), circular), circular)]).toHaveLength(2)
  })

  it('uses a conservative precise path for non-biological relationships', () => {
    const path = findRelationshipPath('home', 'partner', relationships)
    expect(relationshipLabel('Ada', path)).toBe("Ada's spouse")
  })

  it('describes direct biological ancestors without inferring mixed kinship', () => {
    const path = findRelationshipPath('home', 'parent', relationships)
    expect(relationshipLabel('Ada', path)).toBe("Ada's biological parent")
    const adopted = [relationship('adopted', 'adopted-parent', 'home', 'adoptive_parent')]
    expect(relationshipLabel('Ada', findRelationshipPath('home', 'adopted-parent', adopted))).toBe("Ada's adoptive parent")
  })

  it('summarizes unknown GEDCOM parentage across generations', () => {
    const lineage = [
      relationship('one', 'parent-1', 'home', 'unknown_parent'),
      relationship('two', 'parent-2', 'parent-1', 'unknown_parent'),
      relationship('three', 'parent-3', 'parent-2', 'unknown_parent'),
      relationship('four', 'parent-4', 'parent-3', 'unknown_parent'),
      relationship('five', 'parent-5', 'parent-4', 'unknown_parent'),
      relationship('six', 'parent-6', 'parent-5', 'unknown_parent'),
    ]
    expect(relationshipLabel('Mara Vale', findRelationshipPath('home', 'parent-6', lineage))).toBe("Mara Vale's great-great-great-great-grandparent (parentage type unknown)")
  })

  it('keeps the parentage qualifier accurate for uniform and mixed direct lineages', () => {
    const adopted = [
      relationship('one', 'parent-1', 'home', 'adoptive_parent'),
      relationship('two', 'parent-2', 'parent-1', 'adoptive_parent'),
    ]
    expect(relationshipLabel('Ada', findRelationshipPath('home', 'parent-2', adopted))).toBe("Ada's adoptive grandparent")

    const step = [
      relationship('one', 'parent-1', 'home', 'step_parent'),
      relationship('two', 'parent-2', 'parent-1', 'step_parent'),
    ]
    expect(relationshipLabel('Ada', findRelationshipPath('home', 'parent-2', step))).toBe("Ada's step grandparent")

    const mixed = [
      relationship('one', 'parent-1', 'home', 'biological_parent'),
      relationship('two', 'parent-2', 'parent-1', 'unknown_parent'),
    ]
    expect(relationshipLabel('Ada', findRelationshipPath('home', 'parent-2', mixed))).toBe("Ada's grandparent (mixed parentage types)")

    const descendants = [
      relationship('one', 'home', 'child-1', 'unknown_parent'),
      relationship('two', 'child-1', 'child-2', 'unknown_parent'),
    ]
    expect(relationshipLabel('Ada', findRelationshipPath('home', 'child-2', descendants))).toBe("Ada's grandchild (parentage type unknown)")
  })

  it('does not loop when a graph contains a circular relationship', () => {
    const cycle = [relationship('one', 'a', 'b', 'biological_parent'), relationship('two', 'b', 'a', 'biological_parent')]
    expect(findRelationshipPath('a', 'b', cycle)).toHaveLength(1)
    expect(person('a').name).toBe('a')
  })

  it('finds documented direct descendants and keeps the closest generation', () => {
    const branch = [
      relationship('child', 'root', 'child', 'biological_parent'),
      relationship('grandchild', 'child', 'grandchild', 'biological_parent'),
      relationship('alternate-path', 'root', 'grandchild', 'biological_parent'),
      relationship('unclassified-child', 'root', 'unclassified', 'unknown_parent'),
      relationship('adopted', 'root', 'adopted', 'adoptive_parent'),
      relationship('cycle', 'grandchild', 'root', 'biological_parent'),
    ]
    expect([...directDescendants('root', branch).entries()]).toEqual([['child', 1], ['grandchild', 1], ['unclassified', 1]])
  })

  it('finds documented direct ancestors and excludes adoptive relationships', () => {
    const branch = [
      relationship('parent', 'parent', 'root', 'biological_parent'),
      relationship('grandparent', 'grandparent', 'parent', 'unknown_parent'),
      relationship('alternate-path', 'grandparent', 'root', 'biological_parent'),
      relationship('adopted', 'adopted-parent', 'root', 'adoptive_parent'),
      relationship('cycle', 'root', 'grandparent', 'biological_parent'),
    ]
    expect([...directAncestors('root', branch).entries()]).toEqual([['parent', 1], ['grandparent', 1]])
  })
})
