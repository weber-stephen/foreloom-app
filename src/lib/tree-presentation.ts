import type { Person } from './types'

const yearFromDate = (value?: string) => {
  if (!value) return ''
  const match = value.match(/(?:^|\D)(\d{4})(?:\D|$)/)
  return match?.[1] || value
}

/** A compact, card-safe summary that never implies an unknown death date. */
export function treeLifeLabel(person: Person) {
  const birth = yearFromDate(person.facts.find(fact => fact.kind === 'birth')?.dateText)
  const death = yearFromDate(person.facts.find(fact => fact.kind === 'death')?.dateText)
  if (birth && death) return `${birth}–${death}`
  if (birth && person.livingStatus === 'living') return `${birth}–Living`
  if (birth) return `${birth}–`
  if (death) return `Died ${death}`
  return person.livingStatus === 'living' ? 'Living' : 'Dates unknown'
}

export type TreeAvatarVariant = 'woman' | 'man' | 'neutral'

export function treeAvatarVariant(person: Pick<Person, 'sex'>): TreeAvatarVariant {
  const sex = person.sex.trim().toLowerCase()
  if (sex === 'f' || sex === 'female' || sex === 'woman') return 'woman'
  if (sex === 'm' || sex === 'male' || sex === 'man') return 'man'
  return 'neutral'
}

export function possessiveFirstName(name: string) {
  const firstName = name.trim().split(/\s+/)[0] || 'This person'
  return /s$/i.test(firstName) ? `${firstName}'` : `${firstName}'s`
}
