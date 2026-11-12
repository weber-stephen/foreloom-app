import { Channel, invoke } from '@tauri-apps/api/core'
import type { Attachment, BirthplaceResolution, BranchAiSuggestion, Change, ChangeSubject, CleanupDependency, Explanation, FactInput, GazetteerPlace, ImportPreview, ImportProgress, Issue, IssueResolution, IssueSuggestion, OllamaStatus, Person, PersonInput, PlaceAiStatus, PlaceCandidate, PlaceMap, PlaceMapFilter, PlaceResolutionInput, PlaceResolutionSummary, PlaceReviewFilter, PlaceReviewItem, Portrait, Provider, Relationship, ResearchCapture, ResearchExtract, ResearchItem, ResearchQuery, ResearchResult, Source, Tree, TreeCore } from './types'
import type { BranchCandidate } from './branch-connections'

const call = <T>(command: string, args: Record<string, unknown> = {}) => invoke<T>(command, args)
const legacyChangeSubjects = (summary: string): ChangeSubject[] => {
  const person = /^(?:Added|Edited) person: (.+)$|^Set home person: (.+)$/.exec(summary)
  if (person) return [{ kind: 'person', id: null, label: person[1] || person[2] }]
  const attachment = /^Attached media: .+ to (.+)$/.exec(summary)
  if (attachment) return [{ kind: 'person', id: null, label: attachment[1] }]
  const relationship = /^(?:Added|Removed) relationship: (.+)$/.exec(summary)
  if (relationship) {
    const [from, , to] = relationship[1].split(' — ')
    if (from && to) return [{ kind: 'person', id: null, label: from }, { kind: 'person', id: null, label: to }]
  }
  return []
}
const normalizeChanges = (changes: Change[]) => changes.map(change => ({
  ...change,
  subjects: change.subjects?.length ? change.subjects : legacyChangeSubjects(change.summary),
}))
export const api = {
  listTrees: () => call<Tree[]>('list_trees'),
  getLastOpenedTree: () => call<string | null>('get_last_opened_tree'),
  setLastOpenedTree: (treeId: string) => call<void>('set_last_opened_tree', { treeId }),
  createTree: (name: string) => call<Tree>('create_tree', { name }),
  renameTree: (treeId: string, name: string) => call<void>('rename_tree', { treeId, name }),
  deleteTree: (treeId: string) => call<void>('delete_tree', { treeId }),
  listPeople: (treeId: string, search?: string) => call<Person[]>('list_people', { treeId, search: search || null }),
  loadTreeCore: (treeId: string) => call<TreeCore>('load_tree_core', { treeId }),
  getPlaceMap: (treeId: string, filter: PlaceMapFilter = { eventKinds: [] }) => call<PlaceMap>('get_place_map', { treeId, filter }),
  searchGazetteer: (query: string) => call<GazetteerPlace[]>('search_gazetteer', { query }),
  savePlaceOverride: (treeId: string, rawPlace: string, gazetteerId: string) => call<void>('save_place_override', { treeId, rawPlace, gazetteerId }),
  clearPlaceOverride: (treeId: string, rawPlace: string) => call<void>('clear_place_override', { treeId, rawPlace }),
  getPlaceResolutionSummary: (treeId: string) => call<PlaceResolutionSummary>('get_place_resolution_summary', { treeId }),
  listPlaceReviewItems: (treeId: string, filter: PlaceReviewFilter = {}) => call<PlaceReviewItem[]>('list_place_review_items', { treeId, filter }),
  savePlaceResolution: (treeId: string, input: PlaceResolutionInput) => call<void>('save_place_resolution', { treeId, input }),
  revertPlaceResolution: (treeId: string, factId: string) => call<void>('revert_place_resolution', { treeId, factId }),
  placeAiStatus: () => call<PlaceAiStatus>('place_ai_status'),
  setPlaceAiConsent: (consented: boolean) => call<void>('set_place_ai_consent', { consented }),
  findLikelyPlacesWithAi: (request: { rawPlace: string; eventType: string; eventYear: number | null; geographicContext: string; familyContext: string; model: string }) => call<PlaceCandidate[]>('find_likely_places_with_ai', { request }),
  getPerson: (treeId: string, personId: string) => call<Person>('get_person', { treeId, personId }),
  savePerson: (treeId: string, input: PersonInput) => call<Person>('save_person', { treeId, input }),
  previewPeopleDeletion: (treeId: string, personIds: string[]) => call<CleanupDependency[]>('preview_people_deletion', { treeId, personIds }),
  deletePeople: (treeId: string, personIds: string[]) => call<void>('delete_people', { treeId, personIds }),
  listRelationships: (treeId: string) => call<Relationship[]>('list_relationships', { treeId }),
  getHomePerson: (treeId: string) => call<string | null>('get_home_person', { treeId }),
  setHomePerson: (treeId: string, personId: string) => call<void>('set_home_person', { treeId, personId }),
  clearHomePerson: (treeId: string) => call<void>('clear_home_person', { treeId }),
  listIntentionalDisconnectedGroups: (treeId: string) => call<string[]>('list_intentional_disconnected_groups', { treeId }),
  markDisconnectedGroupIntentional: (treeId: string, memberIds: string[]) => call<void>('mark_disconnected_group_intentional', { treeId, memberIds }),
  reopenDisconnectedGroup: (treeId: string, memberIds: string[]) => call<void>('reopen_disconnected_group', { treeId, memberIds }),
  addRelationship: (treeId: string, fromId: string, toId: string, kind: string, sourceId?: string | null) => call<Relationship>('add_relationship', { treeId, fromId, toId, kind, sourceId: sourceId || null }),
  removeRelationship: (treeId: string, relationshipId: string) => call<void>('remove_relationship', { treeId, relationshipId }),
  updateRelationship: (treeId: string, relationshipId: string, fromId: string, toId: string, kind: string, sourceId?: string | null) => call<Relationship>('update_relationship', { treeId, relationshipId, fromId, toId, kind, sourceId: sourceId || null }),
  listSources: (treeId: string) => call<Source[]>('list_sources', { treeId }),
  addSource: (treeId: string, source: Omit<Source, 'id'>) => call<Source>('add_source', { treeId, ...source }),
  listAttachments: (treeId: string, personId: string) => call<Attachment[]>('list_attachments', { treeId, personId }),
  listPortraits: (treeId: string, personIds: string[]) => call<Portrait[]>('list_portraits', { treeId, personIds }),
  addAttachment: (treeId: string, personId: string, path: string) => call<Attachment>('add_attachment', { treeId, personId, path }),
  listChanges: (treeId: string) => call<Change[]>('list_changes', { treeId }).then(normalizeChanges),
  listIssues: (treeId: string) => call<Issue[]>('list_issues', { treeId }),
  resolveBirthplaceConflict: (treeId: string, key: string, expectedRevision: number, resolution: BirthplaceResolution) => call<string>('resolve_birthplace_conflict', { treeId, key, expectedRevision, resolution }),
  dismissIssue: (treeId: string, key: string, fingerprint: string) => call<void>('dismiss_issue', { treeId, key, fingerprint }),
  markIssueReviewed: (treeId: string, key: string, fingerprint: string) => call<void>('mark_issue_reviewed', { treeId, key, fingerprint }),
  approveIssue: (treeId: string, key: string, expectedRevision: number) => call<string>('approve_issue', { treeId, key, expectedRevision }),
  applyIssueResolution: (treeId: string, key: string, expectedRevision: number, resolution: IssueResolution) => call<string>('apply_issue_resolution', { treeId, key, expectedRevision, resolution }),
  undoChange: (treeId: string, changeId: string) => call<void>('undo_change', { treeId, changeId }),
  previewGedcom: (path: string) => call<ImportPreview>('preview_gedcom', { path }),
  importGedcom: (path: string, name: string, onProgress: (progress: ImportProgress) => void) => {
    const channel = new Channel<ImportProgress>()
    channel.onmessage = onProgress
    return call<string>('import_gedcom', { path, name, onProgress: channel })
  },
  sourceRegistry: () => call<Provider[]>('source_registry'),
  researchSearch: (treeId: string, query: ResearchQuery) => call<ResearchResult>('research_search', { treeId, query }),
  extractResearch: (text: string, model: string) => call<ResearchExtract>('extract_research', { text, model }),
  saveResearchCapture: (treeId: string, capture: ResearchCapture) => call<string>('save_research_capture', { treeId, capture }),
  promoteCandidate: (treeId: string, result: ResearchItem) => call<string>('promote_candidate', { treeId, result }),
  ollamaStatus: () => call<OllamaStatus>('ollama_status'),
  explainIssue: (treeId: string, key: string, model: string) => call<Explanation>('explain_issue', { treeId, key, model }),
  getOrCreateIssueSuggestion: (treeId: string, key: string, model: string) => call<IssueSuggestion>('get_or_create_issue_suggestion', { treeId, key, model }),
  findBranchConnectionsWithAi: (treeId: string, candidates: BranchCandidate[], model: string) => call<BranchAiSuggestion[]>('find_branch_connections_with_ai', { treeId, candidates, model }),
  backupTree: (treeId: string, path: string) => call<void>('backup_tree', { treeId, path }),
  restoreTree: (path: string) => call<string>('restore_tree', { path }),
  openExternal: (url: string) => call<void>('open_external', { url }),
}
export type { FactInput }
