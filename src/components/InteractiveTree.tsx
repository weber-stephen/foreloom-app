import { memo, useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from 'react'
import type { Person, Portrait, Relationship } from '../lib/types'
import { api } from '../lib/api'
import { familyDepths, familyVisibility, findRelationshipPath, nextFamilyLimit, relationshipIndex, relationshipLabel, siblingIds } from '../lib/tree-graph'
import { treeAvatarVariant, treeLifeLabel } from '../lib/tree-presentation'
import { fitTree } from '../lib/tree-camera'
import { PersonSelector } from './PersonSelector'
import genericUserIcon from '../assets/heroicons-user.svg'
import materialManIcon from '../assets/material-symbol-man.svg'
import materialWomanIcon from '../assets/material-symbol-woman.svg'

type Props = {
  treeId: string
  people: Person[]
  relationships: Relationship[]
  homePersonId: string | null
  selectedPersonId: string | null
  onSelect: (personId: string) => void
  onOpenPerson: (personId: string) => void
}
type Position = { x: number; y: number }
type Size = { width: number; height: number }

const nodeSize: Size = { width: 156, height: 188 }
const relationClass = (kind: string) => kind.replace('_parent', '').replace('_', '-')

function TreeAvatar({ person, portrait }: { person: Person; portrait?: Portrait }) {
  if (portrait) return <img className="tree-node-photo" src={portrait.dataUrl} alt="" />
  const variant = treeAvatarVariant(person)
  const label = variant === 'woman' ? 'Female avatar' : variant === 'man' ? 'Male avatar' : 'Person avatar'
  return <span className={`tree-node-avatar ${variant}`} aria-label={label}><svg viewBox="0 0 160 136" aria-hidden="true">
    <rect width="160" height="136" rx="2" className="avatar-backdrop" />
    {variant === 'woman' && <><path className="avatar-hair" d="M62 20c22-15 49 0 47 30l-3 27H53V44c0-10 3-18 9-24Z" /><path className="avatar-skin" d="M67 35c14-8 36-2 39 15v28c-2 13-13 24-27 24-13 0-24-10-26-24V51c1-7 6-12 14-16Z" /><path className="avatar-body" d="M38 136c4-29 18-43 37-47l10 9 11-9c22 5 34 20 39 47Z" /><path className="avatar-hair" d="M48 72c-8-4-8-17 1-22 1 17 7 29 18 35-10 2-15-2-19-13Z" /></>}
    {variant === 'man' && <><path className="avatar-hair" d="M53 42c0-23 19-34 39-31 14 2 25 13 25 30l-4 17-14-12-38 19-8-23Z" /><path className="avatar-skin" d="M63 38c15-7 36-1 43 15v21c-2 16-12 28-28 28-14 0-25-10-27-25V55c1-7 5-13 12-17Z" /><path className="avatar-body" d="M30 136c4-29 20-42 39-47l10 13 12-13c19 5 34 19 39 47Z" /></>}
    {variant === 'neutral' && <><circle className="avatar-hair" cx="80" cy="47" r="31" /><path className="avatar-skin" d="M58 47c8-11 37-16 45 2v27c-3 15-13 25-24 25-13 0-23-11-25-25V55c0-3 1-6 4-8Z" /><path className="avatar-body" d="M31 136c5-30 21-42 38-47h20c18 5 34 18 40 47Z" /></>}
  </svg><span className="tree-avatar-figure" aria-hidden="true"><i className="tree-avatar-hair"/><i className="tree-avatar-face"/><i className="tree-avatar-smile"/><i className="tree-avatar-body"/></span></span>
}

const fallbackPersonIcons = { woman: materialWomanIcon, man: materialManIcon, neutral: genericUserIcon }

function OpenPeepsAvatar({ person, portrait }: { person: Person; portrait?: Portrait }) {
  if (portrait) return <TreeAvatar person={person} portrait={portrait}/>
  return <img className="tree-node-photo tree-node-generic-icon" src={fallbackPersonIcons[treeAvatarVariant(person)]} alt="" />
}

const connectorPath = (relationship: Relationship, from: Position, to: Position, fromSize: Size, toSize: Size) => {
  if (relationship.kind.endsWith('_parent')) {
    const startY = from.y + fromSize.height / 2
    const endY = to.y - toSize.height / 2
    const branchY = startY + (endY - startY) / 2
    return `M ${from.x} ${startY} V ${branchY} H ${to.x} V ${endY}`
  }
  const fromIsLeft = from.x <= to.x
  const startX = from.x + (fromIsLeft ? fromSize.width / 2 : -fromSize.width / 2)
  const endX = to.x + (fromIsLeft ? -toSize.width / 2 : toSize.width / 2)
  const middleX = startX + (endX - startX) / 2
  return `M ${startX} ${from.y} H ${middleX} V ${to.y} H ${endX}`
}

export const InteractiveTree = memo(function InteractiveTree({ treeId, people, relationships, homePersonId, selectedPersonId, onSelect, onOpenPerson }: Props) {
  const initialFocus = homePersonId || selectedPersonId || people[0]?.id || ''
  const [focusId, setFocusId] = useState(initialFocus)
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set())
  const [siblingsShown, setSiblingsShown] = useState(false)
  const [familyLimits, setFamilyLimits] = useState({ siblings: 8, children: 8 })
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState<Position>({ x: 0, y: 0 })
  const [quickPersonId, setQuickPersonId] = useState<string | null>(null)
  const [portraits, setPortraits] = useState<Map<string, Portrait>>(new Map())
  const [nodeSizes, setNodeSizes] = useState<Map<string, Size>>(new Map())
  const [drag, setDrag] = useState<{ x: number; y: number; pan: Position } | null>(null)
  const previousTree = useRef<string | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const nodeRefs = useRef(new Map<string, HTMLElement>())
  const graph = useMemo(() => relationshipIndex(relationships), [relationships])
  const peopleById = useMemo(() => new Map(people.map(person => [person.id, person])), [people])
  const sortIds = (ids: string[]) => [...new Set(ids)].filter(id => peopleById.has(id)).sort((left, right) => (peopleById.get(left)?.name || '').localeCompare(peopleById.get(right)?.name || '') || left.localeCompare(right))
  const parentIds = (personId: string) => sortIds((graph.parents.get(personId) || []).map(relationship => relationship.fromId))
  const childIds = (personId: string) => sortIds((graph.children.get(personId) || []).map(relationship => relationship.toId))
  const partnerIds = (personId: string) => sortIds((graph.neighbors.get(personId) || []).filter(item => item.relationship.kind === 'spouse' || item.relationship.kind === 'partner').map(item => item.personId))

  useEffect(() => {
    if (!initialFocus) return
    if (previousTree.current !== treeId) {
      previousTree.current = treeId
      setFocusId(initialFocus)
      setExpandedParents(new Set())
      setSiblingsShown(false)
      setFamilyLimits({ siblings: 8, children: 8 })
      setQuickPersonId(null)
      setZoom(1)
    } else if (!focusId) setFocusId(initialFocus)
  }, [focusId, initialFocus, treeId])

  const layout = useMemo(() => {
    const positions = new Map<string, Position>()
    if (!focusId || !peopleById.has(focusId)) return { positions, visibleIds: new Set<string>(), siblings: [], children: [], siblingCount: 0, siblingsRemaining: 0, childrenRemaining: 0 }
    const focusParents = parentIds(focusId)
    const siblings = sortIds(siblingIds(focusId, graph))
    const partners = partnerIds(focusId)
    const children = childIds(focusId)
    const baseIds = new Set([focusId, ...focusParents, ...(siblingsShown ? siblings.slice(0, familyLimits.siblings) : []), ...partners, ...children.slice(0, familyLimits.children)])
    const visibleIds = familyVisibility(baseIds, expandedParents, graph)
    const depths = familyDepths(focusId, visibleIds, graph)
    const layers = new Map<number, string[]>()
    depths.forEach((depth, id) => {
      const layer = layers.get(depth) || []
      layer.push(id)
      layers.set(depth, layer)
    })
    const preferred = [...siblings, focusId, ...partners, ...focusParents, ...children]
    layers.forEach((ids, depth) => {
      ids.sort((left, right) => {
        const leftOrder = preferred.indexOf(left)
        const rightOrder = preferred.indexOf(right)
        return (leftOrder < 0 ? Infinity : leftOrder) - (rightOrder < 0 ? Infinity : rightOrder) || (peopleById.get(left)?.name || '').localeCompare(peopleById.get(right)?.name || '') || left.localeCompare(right)
      })
      ids.forEach((id, index) => positions.set(id, { x: (index - (ids.length - 1) / 2) * 220, y: depth * 300 }))
    })
    return { positions, visibleIds, siblings, children, siblingCount: siblings.length, siblingsRemaining: siblingsShown ? siblings.filter(id => !visibleIds.has(id)).length : 0, childrenRemaining: children.filter(id => !visibleIds.has(id)).length }
  }, [expandedParents, familyLimits, focusId, graph, peopleById, siblingsShown])

  const visiblePeople = useMemo(() => [...layout.visibleIds].map(id => peopleById.get(id)).filter((person): person is Person => Boolean(person)), [layout.visibleIds, peopleById])
  const visibleRelationships = useMemo(() => relationships.filter(relationship => layout.visibleIds.has(relationship.fromId) && layout.visibleIds.has(relationship.toId)), [layout.visibleIds, relationships])
  const home = homePersonId ? peopleById.get(homePersonId) || null : null
  const path = useMemo(() => homePersonId && focusId ? findRelationshipPath(homePersonId, focusId, relationships, graph) : [], [focusId, graph, homePersonId, relationships])
  const pathIds = new Set(path.map(step => step.relationship.id))
  const quickPerson = quickPersonId ? peopleById.get(quickPersonId) || null : null

  const centerOn = (personId: string, nextZoom = zoom) => {
    const position = layout.positions.get(personId)
    const canvas = viewportRef.current
    if (!position || !canvas) return
    setZoom(nextZoom)
    setPan({ x: canvas.clientWidth / 2 - position.x * nextZoom, y: canvas.clientHeight / 2 - position.y * nextZoom })
  }
  useEffect(() => {
    const canvas = viewportRef.current
    if (!canvas || !focusId) return
    const camera = fitTree(layout.positions.values(), canvas.clientWidth, canvas.clientHeight)
    requestAnimationFrame(() => { setZoom(camera.zoom); setPan({ x: camera.x, y: camera.y }) })
  }, [focusId, layout.positions])
  useEffect(() => {
    if (!visiblePeople.length) { setPortraits(new Map()); return }
    let cancelled = false
    void api.listPortraits(treeId, visiblePeople.map(person => person.id)).then(items => {
      if (!cancelled) setPortraits(new Map(items.map(item => [item.personId, item])))
    }).catch(() => { if (!cancelled) setPortraits(new Map()) })
    return () => { cancelled = true }
  }, [treeId, visiblePeople])
  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      setNodeSizes(current => {
        const next = new Map(current)
        let changed = false
        entries.forEach(entry => {
          const id = entry.target.getAttribute('data-person-id')
          if (!id) return
          const size = { width: entry.contentRect.width, height: entry.contentRect.height }
          const prior = next.get(id)
          if (!prior || prior.width !== size.width || prior.height !== size.height) { next.set(id, size); changed = true }
        })
        return changed ? next : current
      })
    })
    nodeRefs.current.forEach(node => observer.observe(node))
    return () => observer.disconnect()
  }, [visiblePeople])

  const focusPerson = (personId: string) => {
    setFocusId(personId)
    setExpandedParents(new Set())
    setSiblingsShown(false)
    setFamilyLimits({ siblings: 8, children: 8 })
    setQuickPersonId(null)
    onSelect(personId)
  }
  const toggleParents = (personId: string) => {
    setExpandedParents(current => {
      const next = new Set(current)
      if (next.has(personId)) next.delete(personId)
      else next.add(personId)
      return next
    })
  }
  const zoomBy = (amount: number) => centerOn(focusId, Math.max(0.42, Math.min(1.7, zoom + amount)))
  const onWheel = (event: WheelEvent<HTMLDivElement>) => { event.preventDefault(); zoomBy(event.deltaY > 0 ? -0.1 : 0.1) }
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => { if (event.button === 0) { event.currentTarget.setPointerCapture(event.pointerId); setDrag({ x: event.clientX, y: event.clientY, pan }) } }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => { if (drag) setPan({ x: drag.pan.x + event.clientX - drag.x, y: drag.pan.y + event.clientY - drag.y }) }

  return <div className="tree-workspace">
    <div className="tree-context-bar"><div>{home ? <><span className="home-pin">HOME</span><strong>{home.name}</strong><span className="relationship-copy">{relationshipLabel(home.name, path)}</span></> : <span className="relationship-copy">Choose a Home person in Settings to anchor this tree.</span>}{focusId && <span className="relationship-copy">{layout.siblingCount === 0 ? 'No recorded siblings' : layout.siblingCount === 1 ? '1 recorded sibling' : `${layout.siblingCount} recorded siblings`}</span>}</div><div className="tree-context-actions"><PersonSelector label="Find a person in the tree" people={people} value="" onChange={id => { if (id) focusPerson(id) }}/>{home && focusId !== home.id && <button className="tree-action" onClick={() => focusPerson(home.id)}>Return Home</button>}</div></div>
    <div ref={viewportRef} className="tree-viewport" onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)} role="application" aria-label="Interactive family tree. Drag the empty canvas to pan and use the zoom controls to change scale.">
      <div className={`tree-stage ${drag ? 'is-dragging' : ''}`} style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}><svg className="tree-graph-lines" viewBox="-2200 -1800 4400 3600" aria-hidden="true">{visibleRelationships.map(relationship => { const from = layout.positions.get(relationship.fromId); const to = layout.positions.get(relationship.toId); return from && to ? <path key={relationship.id} d={connectorPath(relationship, from, to, nodeSizes.get(relationship.fromId) || nodeSize, nodeSizes.get(relationship.toId) || nodeSize)} className={`tree-edge ${relationClass(relationship.kind)} ${pathIds.has(relationship.id) ? 'route' : ''}`} /> : null })}</svg>
        {visiblePeople.map(person => { const position = layout.positions.get(person.id); if (!position) return null; const size = nodeSizes.get(person.id) || nodeSize; const parentsExpanded = expandedParents.has(person.id); const hiddenParents = parentIds(person.id).filter(id => !layout.visibleIds.has(id)).length; const portrait = portraits.get(person.id); return <article key={person.id} ref={node => { if (node) nodeRefs.current.set(person.id, node); else nodeRefs.current.delete(person.id) }} data-person-id={person.id} className={`tree-node ${person.id === homePersonId ? 'home' : ''} ${person.id === focusId ? 'focused' : ''}`} style={{ transform: `translate(${position.x - size.width / 2}px, ${position.y - size.height / 2}px)` }} onPointerDown={event => event.stopPropagation()} aria-label={`${person.name}. ${treeLifeLabel(person)}`}><button className="tree-node-main" onClick={() => setQuickPersonId(person.id)}><OpenPeepsAvatar person={person} portrait={portrait}/><span className="tree-node-details">{person.id === homePersonId && <span className="tree-home-badge">Home</span>}<strong>{person.name}</strong><small>{treeLifeLabel(person)}</small></span></button>{(parentsExpanded || hiddenParents > 0) && <button className="tree-node-expand" onClick={() => toggleParents(person.id)} aria-expanded={parentsExpanded} aria-label={`${parentsExpanded ? 'Hide' : 'Show'} ${person.name}'s parents`} title={`${parentsExpanded ? 'Hide' : 'Show'} parents`}>{parentsExpanded ? '↓' : '↑'}</button>}{person.id === focusId && layout.siblingCount > 0 && <button className="tree-node-siblings" onClick={() => setSiblingsShown(current => !current)} aria-expanded={siblingsShown} aria-label={`${siblingsShown ? 'Hide' : 'Show'} ${person.name}'s siblings`}>{siblingsShown ? 'Hide siblings' : 'Show siblings'}</button>}</article>})}</div>
      {(layout.siblingsRemaining > 0 || layout.childrenRemaining > 0) && <div className="tree-branch-actions" onPointerDown={event => event.stopPropagation()}>{layout.siblingsRemaining > 0 && <button onClick={() => setFamilyLimits(current => ({ ...current, siblings: nextFamilyLimit(layout.siblings, layout.visibleIds, current.siblings) }))}>Show more siblings</button>}{layout.childrenRemaining > 0 && <button onClick={() => setFamilyLimits(current => ({ ...current, children: nextFamilyLimit(layout.children, layout.visibleIds, current.children) }))}>Show more children</button>}</div>}
      <div className="tree-canvas-controls" onPointerDown={event => event.stopPropagation()}><button onClick={() => zoomBy(0.15)} aria-label="Zoom in">+</button><button onClick={() => zoomBy(-0.15)} aria-label="Zoom out">−</button><button onClick={() => centerOn(focusId, 1)} aria-label="Center focused person">Center</button></div>

      {quickPerson && <aside className="tree-quick-card" role="dialog" aria-label={`${quickPerson.name} quick details`} onPointerDown={event => event.stopPropagation()}><button className="quick-close" onClick={() => setQuickPersonId(null)} aria-label="Close details">×</button>{portraits.get(quickPerson.id) && <img className="quick-photo" src={portraits.get(quickPerson.id)?.dataUrl} alt=""/>}<span className="tree-node-kicker">Quick view</span><h2>{quickPerson.name}</h2><p>{treeLifeLabel(quickPerson)}</p><div className="quick-relatives">{parentIds(quickPerson.id).length > 0 && <span>Parents: {parentIds(quickPerson.id).slice(0, 2).map(id => peopleById.get(id)?.name).join(' · ')}</span>}{partnerIds(quickPerson.id).length > 0 && <span>Partner: {partnerIds(quickPerson.id).slice(0, 2).map(id => peopleById.get(id)?.name).join(' · ')}</span>}{childIds(quickPerson.id).length > 0 && <span>Children: {childIds(quickPerson.id).slice(0, 4).map(id => peopleById.get(id)?.name).join(' · ')}</span>}</div><div className="quick-actions"><button onClick={() => onOpenPerson(quickPerson.id)}>Open profile</button></div></aside>}
    </div>
  </div>
})
