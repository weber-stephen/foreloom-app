import { useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Person } from '../lib/types'
import { matchPeople, personSummary } from '../lib/person-selector'

export function PersonOption({ person }: { person: Person }) {
  return <><strong>{person.name}</strong><small>{personSummary(person)}</small></>
}

export function PersonSelector({ label, people, value, onChange, emptyLabel, autoFocus = false }: { label: string; people: Person[]; value: string; onChange: (id: string) => void; emptyLabel?: string; autoFocus?: boolean }) {
  const id = useId()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const matches = matchPeople(people, query).slice(0, 30)
  const selected = people.find(person => person.id === value)
  return <div className="person-selector field">
    <label htmlFor={id}>{label}</label>
    <div className="person-selector-control"><input id={id} autoFocus={autoFocus} role="combobox" aria-expanded={open} aria-controls={`${id}-results`} aria-autocomplete="list" aria-activedescendant={open && matches[active] ? `${id}-option-${active}` : undefined} value={open ? query : selected?.name || ''} placeholder="Choose or search a person" onFocus={() => setOpen(true)} onBlur={() => { setOpen(false); setQuery('') }} onChange={event => { setQuery(event.target.value); setActive(0); setOpen(true) }} onKeyDown={event => { if ((event.key === 'Backspace' || event.key === 'Delete') && !query && emptyLabel && value) { onChange('') } else if (event.key === 'Escape') { setOpen(false); setQuery('') } else if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActive(index => Math.min(index + 1, matches.length - 1)) } else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(index - 1, 0)) } else if (event.key === 'Enter' && open && matches[active]) { event.preventDefault(); onChange(matches[active].id); setOpen(false); setQuery('') } }} /><ChevronDown size={16} aria-hidden="true" /></div>
    {open && <div id={`${id}-results`} className="person-selector-results" role="listbox" aria-label={label}>
      {emptyLabel && <button type="button" role="option" aria-selected={!value} onMouseDown={event => event.preventDefault()} onClick={() => { onChange(''); setOpen(false); setQuery('') }}>{emptyLabel}</button>}
      {matches.map((person, index) => <button id={`${id}-option-${index}`} type="button" role="option" aria-selected={index === active} key={person.id} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => { onChange(person.id); setOpen(false); setQuery('') }}><PersonOption person={person}/></button>)}
      {!matches.length && <p>No people match this search.</p>}
    </div>}
  </div>
}
