import { useEffect, useMemo, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import { ChevronDown, MapPin, Minus, Plus, RotateCcw, Users, X } from 'lucide-react'
import { api } from '../lib/api'
import { focusMapOnPlace } from '../lib/place-map-camera'
import { directDescendants } from '../lib/tree-graph'
import { countryFillExpression, mapPalette, type Theme } from '../lib/map-theme'
import type { Person, PlaceBucket, PlaceMap, Relationship, UnresolvedPlace } from '../lib/types'

maplibregl.setWorkerUrl(maplibreWorkerUrl)

type Props = { treeId: string; people: Person[]; relationships: Relationship[]; homePersonId: string | null; theme: Theme; onOpenPerson: (id: string) => void; onViewPeople: (ids: string[]) => void; onResolvePlaces: () => void }
type ResultsTab = 'ranked' | 'review'
type PlaceMode = 'family' | 'descendants'
type DisplayPlace = PlaceBucket & { descendantIds: string[]; generations: number[]; isOrigin: boolean }
type Journey = { places: DisplayPlace[]; countries: DisplayPlace[]; unresolved: UnresolvedPlace[]; missing: Person[]; mappedCount: number; recordedBirthPlaceCount: number; generationCount: number }
const worldView = { center: [5, 30] as [number, number], zoom: 1.05 }
const generationLabel = (generation: number) => generation > 5 ? 'Generation 6+' : `Generation ${generation}`

function points(places: DisplayPlace[]) {
  return { type: 'FeatureCollection' as const, features: places.map(place => ({ type: 'Feature' as const, properties: { id: place.id, count: place.peopleCount }, geometry: { type: 'Point' as const, coordinates: [place.longitude, place.latitude] } })) }
}
function journeyRings(places: DisplayPlace[]) {
  const features = places.flatMap(place => place.generations
    .map(generation => Math.min(generation, 6))
    .sort((a, b) => a - b)
    .map((generation, index) => ({
      type: 'Feature' as const,
      properties: { id: place.id, generation: generation === 6 ? '6+' : String(generation), radius: 7 + index * 3 },
      geometry: { type: 'Point' as const, coordinates: [place.longitude, place.latitude] },
    })))
  return { type: 'FeatureCollection' as const, features }
}
function originPoints(places: DisplayPlace[]) {
  return { type: 'FeatureCollection' as const, features: places.filter(place => place.isOrigin).map(place => ({ type: 'Feature' as const, properties: { id: place.id }, geometry: { type: 'Point' as const, coordinates: [place.longitude, place.latitude] } })) }
}
function countries(geo: any, items: DisplayPlace[], selected: string | null) {
  const counts = new Map(items.map(place => [place.countryCode, place]))
  return { ...geo, features: geo.features.map((feature: any) => {
    const place = counts.get(String(feature.properties?.ISO_A2 || ''))
    return { ...feature, properties: { ...feature.properties, count: place?.peopleCount || 0, selected: place?.id === selected } }
  }) }
}
function ancestors(homePersonId: string | null, relationships: Relationship[]) {
  if (!homePersonId) return []
  const ids = new Set<string>(), queue = [homePersonId]
  while (queue.length) {
    const child = queue.shift()!
    relationships.forEach(relationship => {
      if (relationship.toId === child && relationship.kind.endsWith('_parent') && !ids.has(relationship.fromId)) { ids.add(relationship.fromId); queue.push(relationship.fromId) }
    })
  }
  return [...ids]
}

export function FamilyPlacesMap({ treeId, people, relationships, homePersonId, theme, onOpenPerson, onViewPeople, onResolvePlaces }: Props) {
  const node = useRef<HTMLDivElement | null>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const displayRef = useRef<DisplayPlace[]>([])
  const pendingFocus = useRef<DisplayPlace | null>(null)
  const request = useRef(0)
  const [data, setData] = useState<PlaceMap | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [mapError, setMapError] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [resultsTab, setResultsTab] = useState<ResultsTab>('ranked')
  const [mode] = useState<PlaceMode>('family')
  const rootId = ''
  const [eventKinds, setEventKinds] = useState<string[]>(() => [...new Set(people.flatMap(person => person.facts.map(fact => fact.kind)))])
  const [locationQuery, setLocationQuery] = useState('')
  const [yearStart, setYearStart] = useState('')
  const [yearEnd, setYearEnd] = useState('')
  const [direct, setDirect] = useState(false)
  const kinds = useMemo(() => [...new Set(people.flatMap(person => person.facts.map(fact => fact.kind)))].sort(), [people])
  const peopleById = useMemo(() => new Map(people.map(person => [person.id, person])), [people])
  const root = peopleById.get(rootId) || null
  const descendantGenerations = useMemo(() => mode === 'descendants' && rootId ? directDescendants(rootId, relationships) : new Map<string, number>(), [mode, rootId, relationships])
  const isJourney = mode === 'descendants'
  const palette = useMemo(() => mapPalette(theme), [theme])
  const filter = useMemo(() => ({ eventKinds: isJourney ? ['birth'] : eventKinds, locationQuery: isJourney ? '' : locationQuery, yearStart: isJourney ? null : yearStart ? Number(yearStart) : null, yearEnd: isJourney ? null : yearEnd ? Number(yearEnd) : null, personIds: isJourney ? root ? [rootId, ...descendantGenerations.keys()] : ['__no_descendant_root__'] : direct ? ancestors(homePersonId, relationships) : [] }), [descendantGenerations, direct, eventKinds, homePersonId, isJourney, locationQuery, relationships, root, rootId, yearEnd, yearStart])
  const hasActiveFilters = eventKinds.length !== kinds.length || Boolean(locationQuery || yearStart || yearEnd || direct)
  const journey = useMemo<Journey>(() => {
    const project = (place: PlaceBucket): DisplayPlace | null => {
      const descendantIds = place.personIds.filter(id => descendantGenerations.has(id))
      const isOrigin = place.personIds.includes(rootId)
      if (!descendantIds.length && !isOrigin) return null
      return { ...place, personIds: descendantIds, peopleCount: descendantIds.length, descendantIds, generations: [...new Set(descendantIds.map(id => descendantGenerations.get(id)!))].sort((a, b) => a - b), isOrigin }
    }
    const places = (data?.places || []).map(project).filter((place): place is DisplayPlace => Boolean(place))
    const countryPlaces = (data?.countries || []).map(project).filter((place): place is DisplayPlace => Boolean(place))
    const unresolved = (data?.unresolved || []).map(place => ({ ...place, personIds: place.personIds.filter(id => descendantGenerations.has(id)) })).filter(place => place.personIds.length > 0)
    const missing = [...descendantGenerations.keys()]
      .map(id => peopleById.get(id))
      .filter((person): person is Person => Boolean(person))
      .filter(person => !person.facts.some(fact => fact.kind === 'birth' && fact.place.trim()))
    const recordedBirthPlaceCount = [...descendantGenerations.keys()].filter(id => peopleById.get(id)?.facts.some(fact => fact.kind === 'birth' && fact.place.trim())).length
    return { places, countries: countryPlaces, unresolved, missing, mappedCount: new Set(countryPlaces.flatMap(place => place.descendantIds)).size, recordedBirthPlaceCount, generationCount: Math.max(0, ...descendantGenerations.values()) }
  }, [data, descendantGenerations, peopleById, rootId])
  const normalPlaces = useMemo<DisplayPlace[]>(() => (data?.places || []).map(place => ({ ...place, descendantIds: place.personIds, generations: [], isOrigin: false })), [data])
  const normalCountries = useMemo<DisplayPlace[]>(() => (data?.countries || []).map(place => ({ ...place, descendantIds: place.personIds, generations: [], isOrigin: false })), [data])
  const displayPlaces = isJourney ? journey.places : normalPlaces
  const displayCountries = isJourney ? journey.countries : normalCountries
  const allDisplayPlaces = useMemo(() => [...displayPlaces, ...displayCountries], [displayCountries, displayPlaces])
  const sync = (places: DisplayPlace[], countryPlaces: DisplayPlace[], id: string | null, journeyActive: boolean) => {
    const currentMap = map.current
    if (!currentMap?.isStyleLoaded()) return
    const placeSource = currentMap.getSource('family-places') as maplibregl.GeoJSONSource | undefined
    const ringSource = currentMap.getSource('descendant-rings') as maplibregl.GeoJSONSource | undefined
    const originSource = currentMap.getSource('descendant-origins') as maplibregl.GeoJSONSource | undefined
    const countrySource = currentMap.getSource('countries') as maplibregl.GeoJSONSource | undefined
    if (placeSource) placeSource.setData(points(journeyActive ? [] : places))
    if (ringSource) ringSource.setData(journeyRings(journeyActive ? places : []))
    if (originSource) originSource.setData(originPoints(journeyActive ? places : []))
    if (countrySource && (currentMap as any).geo) countrySource.setData(countries((currentMap as any).geo, countryPlaces, id))
    currentMap.resize()
  }
  useEffect(() => {
    const version = ++request.current
    setLoading(true); setError('')
    void api.getPlaceMap(treeId, filter).then(next => { if (version === request.current) setData(next) }).catch(reason => { if (version === request.current) setError(reason instanceof Error ? reason.message : 'Family places could not be loaded.') }).finally(() => { if (version === request.current) setLoading(false) })
  }, [treeId, filter])
  useEffect(() => {
    displayRef.current = allDisplayPlaces
    setSelected(current => current && allDisplayPlaces.some(place => place.id === current) ? current : displayPlaces[0]?.id || displayCountries[0]?.id || null)
  }, [allDisplayPlaces, displayCountries, displayPlaces])
  useEffect(() => {
    if (!node.current || map.current) return
    const initialPalette = mapPalette(theme)
    const currentMap = new maplibregl.Map({ container: node.current, ...worldView, minZoom: 0.7, maxZoom: 12, attributionControl: false, style: { version: 8, sources: {}, layers: [{ id: 'water', type: 'background', paint: { 'background-color': initialPalette.water } }] } })
    map.current = currentMap
    currentMap.on('error', event => { setMapError(event.error?.message || 'MapLibre failed to initialize.'); setReady(false) })
    currentMap.on('load', () => {
      void fetch('/maps/countries.geojson').then(response => response.ok ? response.json() : Promise.reject(new Error('Country boundaries could not be loaded.'))).then(geo => {
        ;(currentMap as any).geo = geo
        currentMap.addSource('countries', { type: 'geojson', data: countries(geo, [], null) })
        currentMap.addLayer({ id: 'country-ground', type: 'fill', source: 'countries', paint: { 'fill-color': countryFillExpression(initialPalette), 'fill-opacity': 0.92 } })
        currentMap.addLayer({ id: 'country-outline', type: 'line', source: 'countries', paint: { 'line-color': initialPalette.countryOutline, 'line-width': 0.7 } })
        currentMap.addSource('family-places', { type: 'geojson', data: points([]) })
        currentMap.addLayer({ id: 'place-core', type: 'circle', source: 'family-places', paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'count'], 1, 5, 10, 12], 'circle-color': initialPalette.placeCore, 'circle-stroke-color': initialPalette.markerStroke, 'circle-stroke-width': 2 } })
        currentMap.addSource('descendant-rings', { type: 'geojson', data: journeyRings([]) })
        ;['6+', '5', '4', '3', '2', '1'].forEach(generation => currentMap.addLayer({ id: `descendant-generation-${generation}`, type: 'circle', source: 'descendant-rings', filter: ['==', ['get', 'generation'], generation], paint: { 'circle-radius': ['get', 'radius'], 'circle-color': initialPalette.generations[generation], 'circle-stroke-color': initialPalette.markerStroke, 'circle-stroke-width': 1.5 } }))
        currentMap.addSource('descendant-origins', { type: 'geojson', data: originPoints([]) })
        currentMap.addLayer({ id: 'descendant-origin', type: 'circle', source: 'descendant-origins', paint: { 'circle-radius': 4, 'circle-color': initialPalette.originFill, 'circle-stroke-color': initialPalette.originStroke, 'circle-stroke-width': 2.5 } })
        const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12, className: 'place-hover-popup' })
        const show = (event: maplibregl.MapLayerMouseEvent, place: DisplayPlace) => {
          const content = document.createElement('div'), name = document.createElement('strong'), count = document.createElement('span')
          name.textContent = place.name; count.textContent = place.generations.length ? `${place.descendantIds.length} descendant${place.descendantIds.length === 1 ? '' : 's'} · ${place.generations.map(generationLabel).join(', ')}` : `${place.peopleCount} ${place.peopleCount === 1 ? 'person' : 'people'} mapped`
          content.append(name, count); popup.setLngLat(event.lngLat).setDOMContent(content).addTo(currentMap); currentMap.getCanvas().style.cursor = 'pointer'
        }
        const clear = () => { popup.remove(); currentMap.getCanvas().style.cursor = '' }
        const wirePlaceLayer = (layer: string) => {
          currentMap.on('mousemove', layer, event => { const id = event.features?.[0]?.properties?.id, place = displayRef.current.find(item => item.id === id); if (place) show(event, place) })
          currentMap.on('mouseleave', layer, clear)
          currentMap.on('click', layer, event => { const id = event.features?.[0]?.properties?.id; if (typeof id === 'string') setSelected(id) })
        }
        wirePlaceLayer('place-core'); wirePlaceLayer('descendant-origin'); ['6+', '5', '4', '3', '2', '1'].forEach(generation => wirePlaceLayer(`descendant-generation-${generation}`))
        currentMap.on('mousemove', 'country-ground', event => { const place = displayRef.current.find(item => item.level === 'country' && item.countryCode === event.features?.[0]?.properties?.ISO_A2); if (place) show(event, place); else clear() })
        currentMap.on('mouseleave', 'country-ground', clear)
        currentMap.on('click', 'country-ground', event => { const place = displayRef.current.find(item => item.level === 'country' && item.countryCode === event.features?.[0]?.properties?.ISO_A2); if (place) setSelected(place.id) })
        setReady(true)
      }).catch(reason => { setMapError(reason.message); setReady(false) })
    })
    return () => { currentMap.remove(); map.current = null }
  }, [])
  useEffect(() => {
    const currentMap = map.current
    if (!ready || !currentMap?.isStyleLoaded()) return
    currentMap.setPaintProperty('water', 'background-color', palette.water)
    currentMap.setPaintProperty('country-ground', 'fill-color', countryFillExpression(palette))
    currentMap.setPaintProperty('country-outline', 'line-color', palette.countryOutline)
    currentMap.setPaintProperty('place-core', 'circle-color', palette.placeCore)
    currentMap.setPaintProperty('place-core', 'circle-stroke-color', palette.markerStroke)
    ;['6+', '5', '4', '3', '2', '1'].forEach(generation => {
      currentMap.setPaintProperty(`descendant-generation-${generation}`, 'circle-color', palette.generations[generation])
      currentMap.setPaintProperty(`descendant-generation-${generation}`, 'circle-stroke-color', palette.markerStroke)
    })
    currentMap.setPaintProperty('descendant-origin', 'circle-color', palette.originFill)
    currentMap.setPaintProperty('descendant-origin', 'circle-stroke-color', palette.originStroke)
  }, [palette, ready])
  useEffect(() => {
    if (ready) sync(displayPlaces, displayCountries, selected, isJourney)
  }, [displayCountries, displayPlaces, isJourney, ready, selected])
  useEffect(() => {
    const place = pendingFocus.current
    if (!ready || !place) return
    pendingFocus.current = null
    const activePlace = allDisplayPlaces.find(item => item.id === place.id)
    if (activePlace && map.current?.isStyleLoaded()) focusMapOnPlace(map.current, activePlace)
  }, [allDisplayPlaces, ready])
  useEffect(() => { if (!node.current) return; const observer = new ResizeObserver(() => map.current?.resize()); observer.observe(node.current); return () => observer.disconnect() }, [])
  const selectedPlace = allDisplayPlaces.find(place => place.id === selected) || null
  const selectedPeople = selectedPlace?.personIds.map(id => peopleById.get(id)).filter((person): person is Person => Boolean(person)) || []
  const zoom = (amount: 1 | -1) => { if (ready && map.current) map.current.easeTo({ zoom: map.current.getZoom() + amount, duration: 220, essential: true }) }
  const choose = (place: DisplayPlace) => {
    setSelected(place.id)
    pendingFocus.current = place
    if (ready && map.current?.isStyleLoaded()) {
      focusMapOnPlace(map.current, place)
      pendingFocus.current = null
    }
  }
  const clearFilters = () => { setEventKinds(kinds); setLocationQuery(''); setYearStart(''); setYearEnd(''); setDirect(false) }
  const journeyReviewPeople = [...journey.missing, ...journey.unresolved.flatMap(place => place.personIds.map(id => peopleById.get(id)).filter((person): person is Person => Boolean(person)))].filter((person, index, values) => values.findIndex(value => value.id === person.id) === index)

  return <section className="places-workspace">
    <div className="places-summary" aria-live="polite">{isJourney ? <><span><strong>{descendantGenerations.size}</strong> direct descendants</span><span><strong>{journey.mappedCount}</strong> birthplaces mapped</span><span>{journey.generationCount} generations represented</span></> : <><span><strong>{data?.mappedPeopleCount || 0}</strong> people mapped</span><span>{data?.unresolved.length || 0} places need review</span><span>Distinct people per area</span></>}</div>
    <div className="places-layout"><div className={'places-map-wrap ' + (ready ? 'map-ready' : '')}>
      <img className="places-map-fallback" src="/maps/world.svg" alt="World map showing country boundaries" /><div ref={node} className="places-map" />
      <div className="map-zoom-controls" aria-label="Map controls"><button onClick={() => zoom(1)} disabled={!ready} aria-label="Zoom in"><Plus size={17} /></button><button onClick={() => zoom(-1)} disabled={!ready} aria-label="Zoom out"><Minus size={17} /></button><button onClick={() => ready && map.current?.easeTo({ ...worldView, duration: 320, essential: true })} disabled={!ready} aria-label="Reset world map"><RotateCcw size={15} /></button></div>
      {loading && <p className="map-loading">Updating family places…</p>}{mapError && <p className="map-error">Interactive map unavailable: {mapError}</p>}
      {selectedPlace && <section className="map-place-preview" aria-label={`Selected place: ${selectedPlace.name}`}><button className="map-preview-close" onClick={() => setSelected(null)} aria-label="Clear selected place"><X size={14} /></button><span className="eyebrow">{isJourney ? 'DESCENDANT BIRTHPLACE' : 'SELECTED PLACE'}</span><h2>{selectedPlace.name}</h2><p><Users size={14} />{selectedPlace.peopleCount} {isJourney ? `descendant${selectedPlace.peopleCount === 1 ? '' : 's'}` : `distinct ${selectedPlace.peopleCount === 1 ? 'person' : 'people'}`}</p>{isJourney && selectedPlace.isOrigin && <p className="journey-origin-note">Origin marker for {root?.name}</p>}{isJourney && selectedPlace.generations.length > 0 && <p className="journey-generation-copy">{selectedPlace.generations.map(generationLabel).join(' · ')}</p>}{selectedPeople.length > 0 && <div className="map-preview-people">{selectedPeople.slice(0, 4).map(person => <button key={person.id} onClick={() => onOpenPerson(person.id)}>{person.name}{isJourney && descendantGenerations.has(person.id) ? ` · G${descendantGenerations.get(person.id)}` : ''}</button>)}{selectedPeople.length > 4 && <span>+{selectedPeople.length - 4} more</span>}</div>}{selectedPlace.peopleCount > 0 && <button className="place-more" onClick={() => onViewPeople(selectedPlace.personIds)}>View all {selectedPlace.peopleCount} people</button>}</section>}
      {isJourney ? <div className="journey-legend" aria-label="Descendant generation legend"><strong><i className="origin-swatch" />Origin</strong>{['1', '2', '3', '4', '5', '6+'].map(generation => <span key={generation}><i style={{ background: palette.generations[generation] }} />{generation === '6+' ? '6+' : `Gen ${generation}`}</span>)}</div> : <div className="map-legend"><strong>People</strong><span>1</span><span>2–5</span><span>6–9</span><span>10–29</span><span>30–79</span><span>80–199</span></div>}
    </div><aside className="places-detail"><div className="map-filters"><div className="filter-heading"><span className="eyebrow">MAP VIEW</span>{hasActiveFilters && <button onClick={clearFilters}>Clear filters</button>}</div><label>Location<input value={locationQuery} onChange={event => setLocationQuery(event.target.value)} placeholder="City, county, region, or country" /></label><label>Date range<span className="year-range"><input value={yearStart} onChange={event => setYearStart(event.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="From" inputMode="numeric" /><input value={yearEnd} onChange={event => setYearEnd(event.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="To" inputMode="numeric" /></span></label><details className="event-picker"><summary>Event types <span>{eventKinds.length === kinds.length ? 'All events' : `${eventKinds.length} selected`}</span><ChevronDown size={14} /></summary><div>{kinds.map(kind => <label key={kind}><input type="checkbox" checked={eventKinds.includes(kind)} onChange={event => setEventKinds(current => event.target.checked ? [...current, kind] : current.filter(value => value !== kind))} />{kind}</label>)}</div></details><label className="ancestor-filter"><input type="checkbox" disabled={!homePersonId} checked={direct} onChange={event => setDirect(event.target.checked)} />Direct-line ancestors {!homePersonId && <small>Choose a Home person first</small>}</label></div>
      <div className="places-results"><div className="places-results-head"><div className="results-tabs" role="tablist" aria-label="Place results"><button className={resultsTab === 'ranked' ? 'selected' : ''} onClick={() => setResultsTab('ranked')} role="tab" aria-selected={resultsTab === 'ranked'}>{isJourney ? 'Birth places' : 'Most represented'} <span>{displayPlaces.length}</span></button><button className={resultsTab === 'review' ? 'selected' : ''} onClick={() => setResultsTab('review')} role="tab" aria-selected={resultsTab === 'review'}>{isJourney ? 'Incomplete records' : 'Needs review'} <span>{isJourney ? journeyReviewPeople.length : data?.unresolved.length || 0}</span></button></div></div><div className="places-results-list" role="tabpanel">{error && <p className="places-result-message">{error}</p>}{!error && resultsTab === 'ranked' && (displayPlaces.length ? displayPlaces.map((place, index) => <button key={place.id} className={'place-result ' + (selected === place.id ? 'selected' : '')} onClick={() => choose(place)}><span className="place-rank">{String(index + 1).padStart(2, '0')}</span><span><strong>{place.name}</strong><small>{isJourney ? `${place.peopleCount} descendant${place.peopleCount === 1 ? '' : 's'} · ${place.generations.map(generationLabel).join(', ')}${place.isOrigin ? ' · origin' : ''}` : `${place.peopleCount} people · ${place.eventKinds.join(', ')}`}</small></span></button>) : isJourney && root ? <div className="journey-empty"><strong>{descendantGenerations.size === 0 ? 'No direct descendants are linked to this person.' : journey.recordedBirthPlaceCount === 0 ? 'Their descendants have no recorded birth places.' : 'Their recorded birth places need map matches.'}</strong><small>{descendantGenerations.size} linked descendants · {journey.recordedBirthPlaceCount} recorded birth places · {journey.mappedCount} mapped</small>{journey.recordedBirthPlaceCount > 0 && <button onClick={onResolvePlaces}>Resolve recorded places</button>}</div> : <p className="places-result-message">Choose a person to follow their descendants.</p>)}{!error && resultsTab === 'review' && (isJourney ? journeyReviewPeople.length ? journeyReviewPeople.map(person => <button className="unmapped-row journey-review-person" key={person.id} onClick={() => onOpenPerson(person.id)}><MapPin size={15} /><span><strong>{person.name}</strong><small>{journey.missing.some(item => item.id === person.id) ? 'No recorded birth place' : 'Recorded birth place needs a reliable map match'}</small></span></button>) : <p className="places-result-message">Every descendant has a mapped birth place.</p> : data?.unresolved.length ? data.unresolved.map(place => <div className="unmapped-row" key={place.place}><MapPin size={15} /><span><strong>{place.place}</strong><small>{place.peopleCount} {place.peopleCount === 1 ? 'person' : 'people'} · needs a reliable match</small></span></div>) : <p className="places-result-message">Every recorded place has a map match.</p>)}</div></div>
    </aside></div>
  </section>
}
