import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { buildManualSearchHandoff } from '../lib/manual-search'
import type { Person, Relationship, ResearchFact } from '../lib/types'
import { personConnections } from '../lib/person-selector'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import { PersonSelector } from './PersonSelector'

type ProviderId = 'familysearch' | 'findagrave' | 'familysearch_wiki' | 'irishgenealogy' | 'lac_canada'
const providers: { id: ProviderId; label: string; url: string; hint: string }[] = [
  { id: 'familysearch', label: 'FamilySearch records', url: 'https://www.familysearch.org/en/search/', hint: 'Sign in to search historical records.' },
  { id: 'findagrave', label: 'Find a Grave', url: '', hint: 'Search memorials; verify contributed details.' },
  { id: 'familysearch_wiki', label: 'FamilySearch Research Wiki', url: '', hint: 'Find record collections by place; guides do not establish person facts.' },
  { id: 'irishgenealogy', label: 'IrishGenealogy.ie', url: 'https://www.irishgenealogy.ie/', hint: 'Search Irish civil and church records on the official site.' },
  { id: 'lac_canada', label: 'Library and Archives Canada', url: 'https://library-archives.canada.ca/eng/collection/research-help/genealogy-family-history/Pages/genealogy-family-history.aspx', hint: 'Explore Canadian census and migration collections.' },
]
const emptyFact = (): ResearchFact => ({ kind: 'birth', dateText: '', place: '', detail: '', excerpt: '' })

export function ResearchCapture({ mode, treeId, people, relationships, model, query, onSaved }: { mode: 'people' | 'facts'; treeId: string; people: Person[]; relationships: Relationship[]; model: string; query: { name: string; birthYear: string; place: string; relatives: string }; onSaved: (personId: string) => void }) {
  const [provider, setProvider] = useState<ProviderId>('familysearch')
  const [personId, setPersonId] = useState('')
  const [url, setUrl] = useState('')
  const [pasted, setPasted] = useState('')
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [citation, setCitation] = useState('')
  const [citationEdited, setCitationEdited] = useState(false)
  const [facts, setFacts] = useState<ResearchFact[]>([])
  const [working, setWorking] = useState<'extract' | 'save' | null>(null)
  const [error, setError] = useState('')
  const request = useRef(0)
  useEffect(() => { request.current++; setWorking(null); setFacts([]); setError(''); setPersonId(''); setUrl(''); setPasted(''); setName(''); setTitle(''); setCitation(''); setCitationEdited(false) }, [mode, treeId])
  const selected = people.find(person => person.id === personId)
  const guide = provider === 'familysearch_wiki'
  const suggestedCitation = citation && url && !citation.includes(url) ? `${citation} · ${url}` : citation || url
  const reviewedCitation = citationEdited ? citation : suggestedCitation
  const handoff = provider === 'findagrave' || provider === 'familysearch' || guide ? buildManualSearchHandoff(provider, { ...query, name: mode === 'facts' ? selected?.name || '' : query.name }) : { url: providers.find(item => item.id === provider)?.url || '', unavailableReason: undefined }

  async function extract() {
    const current = ++request.current
    if (!pasted.trim()) { setError('Paste relevant text from the record into the field above, then suggest fields. ForeLoom cannot read the FamilySearch page directly.'); return }
    if (!model) { setError('Choose a local Ollama model in Settings, or enter facts manually.'); return }
    setWorking('extract'); setError('')
    try {
      const result = await api.extractResearch(pasted, model)
      if (current !== request.current) return
      setName(result.name); setTitle(result.title); if (!citationEdited) setCitation(result.citation); setFacts(guide ? [] : result.facts)
      if (!guide && !result.facts.length) setError('No facts were found in this text. Check the pasted record or add a fact manually.')
    } catch (error) { if (current === request.current) setError(String(error)) }
    finally { if (current === request.current) setWorking(null) }
  }

  async function save() {
    if (mode === 'facts' && !selected) { setError('Choose a person in this tree.'); return }
    if (mode === 'people' && !selected && !name.trim()) { setError('Enter the name shown in the record.'); return }
    const current = ++request.current
    setWorking('save'); setError('')
    try {
      const id = await api.saveResearchCapture(treeId, { provider, url, title, citation: reviewedCitation, name: selected?.name || name, personId: selected?.id || null, personVersion: selected?.version ?? null, facts })
      if (current !== request.current) return
      onSaved(id)
      setFacts([]); setUrl(''); setPasted(''); setTitle(''); setCitation(''); setCitationEdited(false); setName('')
    } catch (error) { if (current === request.current) setError(String(error)) }
    finally { if (current === request.current) setWorking(null) }
  }

  async function saveGuide() {
    setWorking('save'); setError('')
    try {
      await api.addSource(treeId, { title, url, citation: citation || 'FamilySearch Research Wiki', notes: 'Research guide; not evidence for a person fact.' })
      setTitle(''); setUrl(''); setCitation('')
    } catch (error) { setError(String(error)) }
    finally { setWorking(null) }
  }

  const updateFact = (index: number, key: keyof ResearchFact, value: string) => setFacts(items => items.map((fact, i) => i === index ? { ...fact, [key]: value } : fact))
  return <section className="research-capture" aria-label="Bring a finding into ForeLoom">
    <h2>{mode === 'facts' ? 'Find facts for a person' : 'Bring a possible person into your tree'}</h2>
    {mode === 'facts' && <><PersonSelector label="Person in your tree" people={people} value={personId} onChange={id => { request.current++; setPersonId(id); setFacts([]) }}/>{selected && <SelectedPersonCard key={selected.id} treeId={treeId} person={selected} people={people} relationships={relationships}/>}</>}
    <div className="field"><label htmlFor="capture-provider">Source</label><select id="capture-provider" value={provider} onChange={event => { request.current++; setProvider(event.target.value as ProviderId); setFacts([]); setUrl('') }}>{providers.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></div>
    <p className="quiet">{providers.find(item => item.id === provider)?.hint} Search details: {query.name || selected?.name || 'name not entered'}{query.place ? ` · ${query.place}` : ''}</p>
    <Button variant="outline" disabled={!!handoff.unavailableReason} onClick={() => void api.openExternal(handoff.url).catch(error => setError(String(error)))}>Open official source</Button>{handoff.unavailableReason && <p className="quiet">{handoff.unavailableReason}</p>}
    <div className="field"><label htmlFor="capture-url">{guide ? 'Specific guide URL' : 'Specific record URL'}</label><Input id="capture-url" type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://…"/></div>
    {!guide && <>
    <div className="field"><label htmlFor="capture-text">Relevant text from the record</label><Textarea id="capture-text" value={pasted} onChange={event => { request.current++; setPasted(event.target.value); setFacts([]) }} placeholder="Paste only the details you want to review"/><small>Copy the record details from the source website and paste them here.</small></div>
    <Button variant="outline" disabled={working !== null} onClick={() => void extract()}>{working === 'extract' ? 'Extracting locally…' : 'Suggest fields with local AI'}</Button>
    </>}
    {error && <p className="source-error" role="alert">{error}</p>}
    <div className="field"><label htmlFor="capture-title">{guide ? 'Guide title' : 'Source title'}</label><Input id="capture-title" value={title} onChange={event => setTitle(event.target.value)}/></div>
    <div className="field"><label htmlFor="capture-citation">Citation</label><Input id="capture-citation" value={reviewedCitation} onChange={event => { setCitation(event.target.value); setCitationEdited(true) }}/></div>
    {mode === 'people' && !guide && <><div className="field"><label htmlFor="capture-name">Name on record</label><Input id="capture-name" value={name} onChange={event => setName(event.target.value)}/></div><PersonSelector label="Add to an existing person, or create a new one" people={people} value={personId} emptyLabel="Create new unverified person" onChange={setPersonId}/>{selected && <SelectedPersonCard key={selected.id} treeId={treeId} person={selected} people={people} relationships={relationships}/>}</>}
    {mode === 'people' && name && <p className="quiet">Possible existing people: {people.filter(person => person.name.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(person.name.toLowerCase())).slice(0, 5).map(person => person.name).join(', ') || 'none found'}</p>}
    {!guide && <><h3>Facts to add</h3>{facts.map((fact, index) => <div className="capture-fact" key={index}><select aria-label={`Fact ${index + 1} type`} value={fact.kind} onChange={event => updateFact(index, 'kind', event.target.value)}>{['birth','death','baptism','marriage','burial','residence','immigration','emigration','naturalization','census','military','occupation','other'].map(kind => <option key={kind}>{kind}</option>)}</select><Input aria-label={`Fact ${index + 1} date`} placeholder="Date as recorded" value={fact.dateText} onChange={event => updateFact(index, 'dateText', event.target.value)}/><Input aria-label={`Fact ${index + 1} place`} placeholder="Place" value={fact.place} onChange={event => updateFact(index, 'place', event.target.value)}/><Input aria-label={`Fact ${index + 1} detail`} placeholder="Detail" value={fact.detail} onChange={event => updateFact(index, 'detail', event.target.value)}/><Button variant="ghost" size="sm" onClick={() => setFacts(items => items.filter((_, i) => i !== index))}>Remove fact</Button>{fact.excerpt && <small>From pasted text: {fact.excerpt}</small>}</div>)}<Button variant="ghost" onClick={() => setFacts(items => [...items, emptyFact()])}>Add fact manually</Button></>}
    {guide && <Button disabled={working !== null || !url.trim() || !title.trim()} onClick={() => void saveGuide()}>{working === 'save' ? 'Saving…' : 'Save guide as source'}</Button>}
    {!guide && <Button disabled={working !== null || !url.trim() || !title.trim() || (mode === 'facts' && !personId) || (mode === 'people' && !name.trim() && !personId) || !facts.length} onClick={() => void save()}>{working === 'save' ? 'Saving…' : selected ? 'Add selected facts' : 'Add unverified person'}</Button>}
  </section>
}

function SelectedPersonCard({ treeId, person, people, relationships }: { treeId: string; person: Person; people: Person[]; relationships: Relationship[] }) {
  const [record, setRecord] = useState<Person | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    setRecord(null); setError(false)
    void api.getPerson(treeId, person.id).then(result => { if (active) setRecord(result) }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [treeId, person.id, person.version])
  const birth = (record || person).facts.find(fact => fact.kind === 'birth')
  const death = (record || person).facts.find(fact => fact.kind === 'death')
  const family = personConnections(person.id, people, relationships)
  return <aside className="research-person-card" aria-label={`${person.name} in your tree`}>
    <strong>{person.name}</strong>
    {!record && !error ? <p className="quiet" role="status">Loading person details…</p> : <><dl><div><dt>Born</dt><dd>{[birth?.dateText, birth?.place].filter(Boolean).join(' · ') || 'Unknown'}</dd></div><div><dt>Died</dt><dd>{[death?.dateText, death?.place].filter(Boolean).join(' · ') || 'Unknown'}</dd></div><div><dt>Parents</dt><dd>{family.parents.join(', ') || 'None recorded'}</dd></div><div><dt>Spouse or partner</dt><dd>{family.partners.join(', ') || 'None recorded'}</dd></div><div><dt>Children</dt><dd>{family.children.join(', ') || 'None recorded'}</dd></div></dl>{error && <p className="source-error" role="alert">Could not load full person details. Showing available dates.</p>}</>}
  </aside>
}
