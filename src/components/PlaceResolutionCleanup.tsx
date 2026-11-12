import { useEffect, useMemo, useState } from 'react'
import { Check, CircleAlert, Pencil, RotateCcw, Search, SkipForward, Sparkles } from 'lucide-react'
import { api } from '../lib/api'
import type { PlaceAiStatus, PlaceCandidate, PlaceResolutionInput, PlaceResolutionSummary, PlaceReviewFilter, PlaceReviewItem } from '../lib/types'
import { Button } from './ui/button'
import { Input } from './ui/input'

type Props = { treeId: string; model: string; onError: (error: unknown) => void }
const blank = (factId: string): PlaceResolutionInput => ({ factId, status: 'approved', label: '', locality: '', county: '', region: '', country: '', countryCode: '', latitude: null, longitude: null, source: 'manual', confidence: 'medium', rationale: '' })
const asInput = (factId: string, candidate: PlaceCandidate): PlaceResolutionInput => ({ factId, status: 'approved', gazetteerId: candidate.source === 'offline' ? candidate.id : null, label: candidate.label, locality: candidate.locality, county: candidate.county, region: candidate.region, country: candidate.country, countryCode: candidate.countryCode, latitude: candidate.latitude, longitude: candidate.longitude, source: candidate.source, confidence: candidate.confidence, rationale: candidate.rationale })

export function PlaceResolutionCleanup({ treeId, model, onError }: Props) {
  const [summary, setSummary] = useState<PlaceResolutionSummary | null>(null)
  const [items, setItems] = useState<PlaceReviewItem[]>([])
  const [filter, setFilter] = useState<PlaceReviewFilter>({})
  const [selected, setSelected] = useState(0)
  const [draft, setDraft] = useState<PlaceResolutionInput | null>(null)
  const [rawDraft, setRawDraft] = useState('')
  const [editingRaw, setEditingRaw] = useState(false)
  const [ai, setAi] = useState<PlaceAiStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [manual, setManual] = useState<PlaceCandidate[]>([])
  const load = async () => {
    try {
      const [nextSummary, nextItems, status] = await Promise.all([api.getPlaceResolutionSummary(treeId), api.listPlaceReviewItems(treeId, filter), api.placeAiStatus()])
      setSummary(nextSummary); setItems(nextItems); setAi(status)
      setSelected(current => Math.min(current, Math.max(nextItems.length - 1, 0)))
    } catch (error) { onError(error) }
  }
  useEffect(() => { void load() }, [treeId, JSON.stringify(filter)])
  const item = items[selected]
  const candidates = useMemo(() => [...(item?.candidates || []), ...manual], [item, manual])
  useEffect(() => { setManual([]); setSearch(''); setEditingRaw(false); setRawDraft(item?.rawPlace || ''); setDraft(item ? blank(item.factId) : null) }, [item?.factId])
  const choose = (candidate: PlaceCandidate) => item && setDraft(asInput(item.factId, candidate))
  const commit = async (input: PlaceResolutionInput) => {
    if (!item) return
    if (input.status === 'approved' && input.confidence === 'low' && !window.confirm('This is a low-confidence place. Approve only if you have verified it.')) return
    setBusy(true)
    try { await api.savePlaceResolution(treeId, input); await load() } catch (error) { onError(error) } finally { setBusy(false) }
  }
  const saveRecordedPlace = async () => {
    if (!item) return
    setBusy(true)
    try {
      const person = await api.getPerson(treeId, item.personId)
      await api.savePerson(treeId, { id: person.id, name: person.name, variants: person.variants, notes: person.notes, livingStatus: person.livingStatus, sex: person.sex, facts: person.facts.map(fact => ({ id: fact.id, kind: fact.kind, dateText: fact.dateText, place: fact.id === item.factId ? rawDraft.trim() : fact.place, detail: fact.detail, sourceId: fact.sourceId })) })
      setEditingRaw(false); await load()
    } catch (error) { onError(error) } finally { setBusy(false) }
  }
  const findAi = async () => {
    if (!item || !ai?.available) return
    if (!ai.consented) {
      const accepted = window.confirm('Local AI consent\n\nForeLoom will send only this recorded place, event type/year, and the minimal geographic and family context shown here to Ollama running on this computer. It does not send your full family tree. Continue?')
      if (!accepted) return
      try { await api.setPlaceAiConsent(true); setAi({ ...ai, consented: true }) } catch (error) { onError(error); return }
    }
    setBusy(true)
    try { setManual(await api.findLikelyPlacesWithAi({ rawPlace: item.rawPlace, eventType: item.eventType, eventYear: Number((item.eventDate.match(/\d{4}/) || [])[0]) || null, geographicContext: item.candidates.map(candidate => candidate.label).join('; '), familyContext: item.familyContext, model })) } catch (error) { onError(error) } finally { setBusy(false) }
  }
  const searchManual = async () => {
    if (search.trim().length < 2 || !item) return
    try { setManual((await api.searchGazetteer(search)).map(match => ({ id: match.id, label: match.label, locality: match.level === 'locality' ? match.name : '', county: match.level === 'county' ? match.name : '', region: match.level === 'region' ? match.name : '', country: '', countryCode: match.countryCode, latitude: match.latitude, longitude: match.longitude, source: 'offline', confidence: 'medium', rationale: 'Manual offline gazetteer search', alternatives: [], requiresConfirmation: true }))) } catch (error) { onError(error) }
  }
  const reasons: Record<string, string> = { no_match: 'No reliable offline match', multiple_matches: 'Multiple matches', incomplete_context: 'Incomplete context' }
  return <section className="place-resolver">
    <div className="place-resolver-head"><div><span className="eyebrow">AI SUGGESTIONS, HUMAN-CONFIRMED</span><h2>Resolve places</h2><p>Original place text remains unchanged unless you explicitly edit it.</p></div><div className="place-counts"><span><strong>{summary?.unresolved || 0}</strong> unresolved</span><span><strong>{summary?.ambiguous || 0}</strong> ambiguous</span><span><strong>{summary?.resolved || 0}</strong> resolved</span></div></div>
    <div className="place-review-controls"><label>Reason<select value={filter.reason || ''} onChange={e => setFilter(value => ({ ...value, reason: e.target.value }))}><option value="">All reasons</option><option value="no_match">No match</option><option value="multiple_matches">Multiple matches</option><option value="incomplete_context">Incomplete context</option></select></label><label>Event<select value={filter.eventType || ''} onChange={e => setFilter(value => ({ ...value, eventType: e.target.value }))}><option value="">All events</option>{[...new Set(items.map(value => value.eventType))].map(value => <option key={value}>{value}</option>)}</select></label><label>Confidence<select value={filter.confidence || ''} onChange={e => setFilter(value => ({ ...value, confidence: e.target.value }))}><option value="">All confidence</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label><label>Country<select value={filter.country || ''} onChange={e => setFilter(value => ({ ...value, country: e.target.value }))}><option value="">All countries</option>{[...new Set(items.flatMap(value => value.candidates.map(candidate => candidate.countryCode)).filter(Boolean))].map(value => <option key={value} value={value}>{value}</option>)}</select></label><span>{summary?.reviewed || 0} reviewed · {items.length} remaining · {summary?.skipped || 0} skipped</span></div>
    {!item ? <div className="empty-block compact"><Check size={24}/><h3>No place records need review</h3><p>Offline matches and your approved resolutions are reflected on the map.</p></div> : <div className="place-review-layout">
      <aside className="place-queue" aria-label="Place review queue">{items.map((value, index) => <button key={value.factId} className={index === selected ? 'selected' : ''} onClick={() => setSelected(index)}><strong>{value.rawPlace}</strong><small>{value.personName} · {value.eventType}</small></button>)}</aside>
      <div className="place-review-main"><div className="place-original"><span className="eyebrow">RECORDED PLACE</span>{editingRaw ? <div className="place-raw-editor"><Input autoFocus value={rawDraft} onChange={event => setRawDraft(event.target.value)} placeholder="Place as recorded"/><Button size="sm" disabled={busy} onClick={() => void saveRecordedPlace()}>Save recorded text</Button><Button size="sm" variant="ghost" onClick={() => { setRawDraft(item.rawPlace); setEditingRaw(false) }}>Cancel</Button></div> : <><h3>{item.rawPlace}</h3><Button variant="ghost" size="sm" onClick={() => setEditingRaw(true)}><Pencil size={14}/>Edit recorded place</Button></>}<p><strong>{item.personName}</strong> · {item.eventType} {item.eventDate || 'date unknown'}{item.familyContext && ` · related to ${item.familyContext}`}</p><span className="review-reason"><CircleAlert size={14}/>{reasons[item.reason] || item.reason}</span></div>
      <div className="place-ai-banner"><span><Sparkles size={16}/>{ai?.message || 'Checking AI availability…'}</span><Button size="sm" disabled={busy || !ai?.available || !model} onClick={() => void findAi()}>Find likely places with AI</Button></div>
      <div className="place-candidate-list"><h3>Candidates</h3>{candidates.map(candidate => <button className={draft?.label === candidate.label ? 'candidate selected' : 'candidate'} key={candidate.id} onClick={() => choose(candidate)}><span><strong>{candidate.label}</strong><small>{candidate.source === 'ai' ? 'AI suggestion' : 'Offline match'} · {candidate.confidence} confidence</small></span><small>{candidate.rationale}{candidate.alternatives.length ? ` · Alternatives: ${candidate.alternatives.join(', ')}` : ''}</small></button>)}{!candidates.length && <p className="quiet">No offline candidate found. Search or enter a location manually.</p>}</div>
      <div className="place-manual-search"><Input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search the offline gazetteer" onKeyDown={event => { if (event.key === 'Enter') void searchManual() }}/><Button size="sm" variant="outline" onClick={() => void searchManual()}><Search size={14}/> Search</Button></div></div>
      <aside className="place-resolution-editor"><span className="eyebrow">SELECTED RESOLUTION</span><div className="place-map-preview" role="img" aria-label={draft?.label ? `Map preview: ${draft.label}` : 'No place selected'}><img src="/maps/world.svg" alt="" />{draft?.latitude != null && <span style={{ left: `${Math.max(5, Math.min(95, (draft.longitude! + 180) / 3.6))}%`, top: `${Math.max(5, Math.min(95, (90 - draft.latitude) / 1.8))}%` }} />}</div>{draft && <><label>Display label<Input value={draft.label} onChange={e => setDraft(value => value && ({ ...value, label: e.target.value, source: 'manual' }))}/></label><label>Locality<Input value={draft.locality} onChange={e => setDraft(value => value && ({ ...value, locality: e.target.value, source: 'manual' }))}/></label><label>Region/state<Input value={draft.region} onChange={e => setDraft(value => value && ({ ...value, region: e.target.value, source: 'manual' }))}/></label><label>Country<Input value={draft.country} onChange={e => setDraft(value => value && ({ ...value, country: e.target.value, source: 'manual' }))}/></label><div className="field-row"><label>Latitude<Input value={draft.latitude ?? ''} onChange={e => setDraft(value => value && ({ ...value, latitude: Number(e.target.value), source: 'manual' }))}/></label><label>Longitude<Input value={draft.longitude ?? ''} onChange={e => setDraft(value => value && ({ ...value, longitude: Number(e.target.value), source: 'manual' }))}/></label></div><Button className="w-full" disabled={busy || !draft.label || draft.latitude == null || draft.longitude == null} onClick={() => void commit(draft)}><Check size={15}/>Approve resolution</Button></>}<div className="place-secondary-actions"><Button variant="outline" size="sm" disabled={busy} onClick={() => void commit({ ...blank(item.factId), status: 'skipped' })}><SkipForward size={14}/>Skip</Button><Button variant="outline" size="sm" disabled={busy} onClick={() => void commit({ ...blank(item.factId), status: 'permanently_unresolved' })}>Keep unresolved</Button><Button variant="ghost" size="sm" onClick={() => void api.revertPlaceResolution(treeId, item.factId).then(load).catch(onError)}><RotateCcw size={14}/>Revert</Button></div></aside>
    </div>}
  </section>
}
