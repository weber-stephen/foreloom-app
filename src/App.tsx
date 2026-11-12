import {
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { open, save } from '@tauri-apps/plugin-dialog'
import {
  Archive,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  FilePlus2,
  FileText,
  GitBranch,
  Globe2,
  Heart,
  LibraryBig,
  ListChecks,
  LoaderCircle,
  Moon,
  PanelLeftClose,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react'
import { api } from './lib/api'
import { buildManualSearchHandoff, type ManualSearchProvider } from './lib/manual-search'
import type {
  BirthplaceRelation,
  BirthplaceResolution,
  CleanupDependency,
  FactInput,
  ImportPreview,
  ImportProgress,
  Issue,
  IssueResolution,
  IssueSuggestion,
  MergePlan,
  OllamaStatus,
  Person,
  PersonInput,
  Provider,
  Relationship,
  ResearchItem,
  ResearchResult,
  Source,
  Tree,
} from './lib/types'
import { errorMessage, factLine } from './lib/utils'
import { decodeHtmlEntities } from './lib/text'
import { descendantCountryDistribution } from './lib/descendant-country'
import { directAncestors, directDescendants } from './lib/tree-graph'
import {
  buildCleanupData,
  type CleanupCategory,
  type CleanupRecord,
  type DisconnectedGroup,
} from './lib/cleanup'
import { branchCandidates } from './lib/branch-connections'
import type { BranchAiSuggestion } from './lib/types'
import { Button } from './components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './components/ui/dialog'
import { Input } from './components/ui/input'
import { Textarea } from './components/ui/textarea'
import { InteractiveTree } from './components/InteractiveTree'
import { PlaceResolutionCleanup } from './components/PlaceResolutionCleanup'
import { ResearchCapture } from './components/ResearchCapture'
import { PersonSelector, PersonOption } from './components/PersonSelector'
import { matchPeople } from './lib/person-selector'
const FamilyPlacesMap = lazy(() =>
  import('./components/FamilyPlacesMap').then((module) => ({ default: module.FamilyPlacesMap })),
)

type Page = 'tree' | 'places' | 'people' | 'cleanup' | 'review' | 'research' | 'settings'
const DATA_CLEANUP_ENABLED = import.meta.env.VITE_ENABLE_DATA_CLEANUP === 'true'
type Activity = {
  id: number
  label: string
  working: string
  state: 'saving' | 'updating' | 'done' | 'error'
  treeId: string | null
  error?: string
  recoverable?: boolean
}
type TreeLoad = { treeId: string; reason: 'restoring' | 'opening' | 'refreshing'; error?: string }
type FailedDraft =
  | { treeId: string; kind: 'person'; draft: PersonInput; variants: string }
  | {
      treeId: string
      kind: 'source'
      draft: { title: string; url: string; citation: string; notes: string }
    }
type ImportJob = {
  state: 'running' | 'done' | 'error'
  path: string
  name: string
  progress: ImportProgress
  treeId?: string
  error?: string
}
const importPhaseLabels: Record<ImportProgress['phase'], string> = {
  reading: 'Reading GEDCOM',
  copying: 'Copying original file',
  people: 'Importing people',
  sources: 'Importing sources',
  facts: 'Importing facts',
  relationships: 'Connecting families',
  finalizing: 'Finishing import',
}
const tabs: { id: Page; label: string; icon: typeof GitBranch }[] = [
  { id: 'tree', label: 'Tree', icon: GitBranch },
  { id: 'people', label: 'People', icon: Users },
  { id: 'places', label: 'Places', icon: Globe2 },
  { id: 'cleanup', label: 'Cleanup', icon: ListChecks },
  { id: 'review', label: 'Review', icon: ShieldCheck },
  { id: 'research', label: 'Research', icon: Search },
  { id: 'settings', label: 'Settings', icon: Settings2 },
]
const relationLabels: Record<string, string> = {
  biological_parent: 'Biological parent',
  adoptive_parent: 'Adoptive parent',
  step_parent: 'Step parent',
  unknown_parent: 'Parent, type unknown',
  spouse: 'Spouse',
  partner: 'Partner',
}
const eventKinds = [
  'birth',
  'death',
  'baptism',
  'marriage',
  'divorce',
  'engagement',
  'adoption',
  'burial',
  'residence',
  'immigration',
  'emigration',
  'naturalization',
  'census',
  'military',
  'occupation',
  'ordination',
  'retirement',
  'probate',
  'medical',
  'other',
]
const issueCategoryLabels: Record<Issue['category'], string> = {
  chronology: 'Chronology',
  duplicates: 'Duplicates',
  place_conflicts: 'Place conflicts',
  relationships: 'Relationships',
  disconnected: 'Disconnected people',
  other: 'Other',
}
const issueCategoryOrder: Issue['category'][] = [
  'chronology',
  'duplicates',
  'place_conflicts',
  'relationships',
  'disconnected',
  'other',
]
const emptyPerson = (): PersonInput => ({
  name: '',
  variants: [],
  notes: '',
  livingStatus: 'unknown',
  sex: '',
  facts: [{ kind: 'birth', dateText: '', place: '', detail: '', sourceId: null }],
})
const toInput = (p: Person): PersonInput => ({
  id: p.id,
  name: p.name,
  variants: [...p.variants],
  notes: p.notes,
  livingStatus: p.livingStatus,
  sex: p.sex,
  facts: p.facts.map((f) => ({
    id: f.id,
    kind: f.kind,
    dateText: f.dateText,
    place: f.place,
    detail: f.detail,
    sourceId: f.sourceId,
  })),
})
const fmtDate = (text: string) => {
  try {
    return new Date(text).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  } catch {
    return text
  }
}
const fmtDateTime = (text: string) => {
  try {
    return new Date(text).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return text
  }
}
const changeSubjectLabel = (kind: string) =>
  ({
    person: 'Person',
    kept: 'Kept',
    merged: 'Merged',
    tree: 'Tree',
    source: 'Source',
    review: 'Review item',
  })[kind] || 'Context'

function App() {
  const [trees, setTrees] = useState<Tree[]>([])
  const [treeId, setTreeId] = useState<string | null>(null)
  const [treeLoad, setTreeLoad] = useState<TreeLoad | null>(null)
  const [page, setPage] = useState<Page>('tree')
  const [placesView, setPlacesView] = useState<'map' | 'resolve'>('map')
  const [people, setPeople] = useState<Person[]>([])
  const [peopleDetailsLoaded, setPeopleDetailsLoaded] = useState(false)
  const [peopleDetailsLoading, setPeopleDetailsLoading] = useState(false)
  const [relationships, setRelationships] = useState<Relationship[]>([])
  const [sources, setSources] = useState<Source[]>([])
  const [issues, setIssues] = useState<Issue[]>([])
  const [changes, setChanges] = useState<Awaited<ReturnType<typeof api.listChanges>>>([])
  const [treeDataVersion, setTreeDataVersion] = useState(0)
  const [providers, setProviders] = useState<Provider[]>([])
  const [ollama, setOllama] = useState<OllamaStatus | null>(null)
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null)
  const [homePersonId, setHomePersonId] = useState<string | null>(null)
  const [selectedIssueKey, setSelectedIssueKey] = useState<string | null>(null)
  const [searchText, setSearchText] = useState('')
  const [placePeopleFilter, setPlacePeopleFilter] = useState<string[] | null>(null)
  const [dialog, setDialog] = useState<
    | 'create'
    | 'import'
    | 'person'
    | 'relationship'
    | 'branch'
    | 'source'
    | 'rename'
    | 'delete'
    | 'home'
    | null
  >(null)
  const [newTreeName, setNewTreeName] = useState('')
  const [actionTreeId, setActionTreeId] = useState<string | null>(null)
  const [importPath, setImportPath] = useState('')
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [importJob, setImportJob] = useState<ImportJob | null>(null)
  const [activities, setActivities] = useState<Activity[]>([])
  const [failedDrafts, setFailedDrafts] = useState<Record<number, FailedDraft>>({})
  const [reviewUpdating, setReviewUpdating] = useState(false)
  const [sourcesLoading, setSourcesLoading] = useState(false)
  const reviewDetailRef = useRef<HTMLElement | null>(null)
  const treeIdRef = useRef<string | null>(null)
  const refreshVersion = useRef(0)
  const peopleDetailsVersion = useRef(0)
  const sourcesTreeId = useRef<string | null>(null)
  const changesTreeId = useRef<string | null>(null)
  const issuesTreeId = useRef<string | null>(null)
  const treesVersion = useRef(0)
  const previewVersion = useRef(0)
  const activityId = useRef(0)
  const toastTimer = useRef<number | null>(null)
  const writeLocks = useRef(new Set<string>())
  const importing = useRef(false)
  const restoredLastTree = useRef(false)
  const [personDraft, setPersonDraft] = useState<PersonInput>(emptyPerson())
  const [variantDraft, setVariantDraft] = useState('')
  const [sourceDraft, setSourceDraft] = useState({ title: '', url: '', citation: '', notes: '' })
  const [relationDraft, setRelationDraft] = useState<{
    id?: string
    fromId: string
    toId: string
    kind: string
    sourceId: string | null
  }>({ fromId: '', toId: '', kind: 'biological_parent', sourceId: null })
  const [toast, setToast] = useState<{
    text: string
    changeId?: string
    treeId?: string | null
  } | null>(null)
  const [researchBusy, setResearchBusy] = useState(false)
  const [researchMode, setResearchMode] = useState<'people' | 'facts'>('people')
  const [error, setError] = useState('')
  const [showDismissed, setShowDismissed] = useState(false)
  const [suggestion, setSuggestion] = useState<{ key: string; value: IssueSuggestion } | null>(null)
  const [resolutionDraft, setResolutionDraft] = useState<IssueResolution | null>(null)
  const [mergePlanReady, setMergePlanReady] = useState(false)
  const [birthplaceDraft, setBirthplaceDraft] = useState<BirthplaceResolution | null>(null)
  const [suggestionLoading, setSuggestionLoading] = useState(false)
  const [issueSort, setIssueSort] = useState<'severity' | 'effort' | 'category'>(() => {
    const saved = localStorage.getItem('kinfolk.review-sort')
    return saved === 'effort' || saved === 'category' ? saved : 'severity'
  })
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    localStorage.getItem('kinfolk.theme') === 'dark' ? 'dark' : 'light',
  )
  const [issueCategoryFilter, setIssueCategoryFilter] = useState<Issue['category'] | 'all'>('all')
  const [model, setModel] = useState('')
  const [researchName, setResearchName] = useState('')
  const [researchYear, setResearchYear] = useState('')
  const [researchPlace, setResearchPlace] = useState('')
  const [researchRelatives, setResearchRelatives] = useState('')
  const [livingLeads, setLivingLeads] = useState(false)
  const [enabledSources, setEnabledSources] = useState<string[]>(() => {
    try {
      return (
        JSON.parse(localStorage.getItem('kinfolk.sources') || 'null') || [
          'wikitree',
          'wikidata',
          'chronicling_america',
        ]
      )
    } catch {
      return ['wikitree', 'wikidata', 'chronicling_america']
    }
  })
  const [europeanaKey, setEuropeanaKey] = useState('')
  const [research, setResearch] = useState<ResearchResult | null>(null)
  const [cleanupFilter, setCleanupFilter] = useState<'all' | CleanupCategory>('all')
  const [cleanupSelection, setCleanupSelection] = useState<string[]>([])
  const [cleanupDependencies, setCleanupDependencies] = useState<CleanupDependency[] | null>(null)
  const [intentionalUnknownIds, setIntentionalUnknownIds] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('kinfolk.intentional-unknowns') || '[]')
    } catch {
      return []
    }
  })
  const [intentionalGroupFingerprints, setIntentionalGroupFingerprints] = useState<string[]>([])
  const [showIntentionalGroups, setShowIntentionalGroups] = useState(false)
  const [branchDraft, setBranchDraft] = useState<{
    group: DisconnectedGroup
    fromId: string
    toId: string
    kind: string
    sourceId: string | null
  } | null>(null)
  const [branchAi, setBranchAi] = useState<{
    loading: boolean
    results: BranchAiSuggestion[]
    error: string
    searched: boolean
  }>({ loading: false, results: [], error: '', searched: false })
  const branchRequest = useRef(0)
  const branchLeads = useMemo(
    () =>
      branchDraft
        ? branchCandidates(
            branchDraft.group.members,
            people.filter((person) => !branchDraft.group.memberIds.includes(person.id)),
          )
        : [],
    [branchDraft?.group, people],
  )
  useEffect(() => {
    branchRequest.current += 1
    setBranchAi({ loading: false, results: [], error: '', searched: false })
  }, [treeId, treeDataVersion])

  const currentTree = trees.find((t) => t.id === treeId)
  const busy = activities.some((item) => item.treeId === treeId && item.state === 'saving')
  const actionTree = trees.find((t) => t.id === actionTreeId)
  const actionBusy = activities.some(
    (item) => item.treeId === actionTreeId && item.state === 'saving',
  )
  const selectedPerson = people.find((p) => p.id === selectedPersonId) || null
  const selectedIssue = issues.find((i) => i.key === selectedIssueKey) || null
  const openIssues = useMemo(() => issues.filter((i) => !i.dismissed && !i.reviewed), [issues])
  const birthplaceFacts =
    selectedIssue?.kind === 'birthplace'
      ? people
          .find((person) => person.id === selectedIssue.personIds[0])
          ?.facts.filter((fact) => fact.kind === 'birth' && fact.place.trim()) || []
      : []
  const deterministicResolution = (issue: Issue): IssueResolution | null => {
    if (issue.proposedFactId) return { operation: 'remove_fact', factId: issue.proposedFactId }
    if (issue.kind === 'duplicate' && issue.personIds.length === 2) {
      const survivorId = issue.mergeCandidate?.survivorId || issue.personIds[0]
      const duplicateId = issue.mergeCandidate?.duplicateId || issue.personIds[1]
      const survivor = people.find((person) => person.id === survivorId)
      return {
        operation: 'merge_people',
        survivorId,
        duplicateId,
        mergePlan: {
          primaryName: survivor?.name || '',
          preferredBirthFactId: survivor?.preferredBirthFactId || null,
          decisions: {},
        },
      }
    }
    return null
  }
  useEffect(() => {
    if (page === 'review' && selectedIssueKey) {
      setMergePlanReady(false)
      reviewDetailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [page, selectedIssueKey])

  const notify = (text: string, changeId?: string, forTreeId?: string | null) => {
    setToast({ text, changeId, treeId: forTreeId })
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 7000)
  }
  const fail = (e: unknown) => {
    setError(errorMessage(e))
  }
  const loadTrees = useCallback(async () => {
    const version = ++treesVersion.current
    try {
      const next = await api.listTrees()
      if (version === treesVersion.current) {
        setTrees(next)
      }
    } catch (e) {
      fail(e)
    }
  }, [])
  const loadSources = useCallback(async (id: string) => {
    if (sourcesTreeId.current === id) return
    sourcesTreeId.current = id
    setSourcesLoading(true)
    try {
      const next = await api.listSources(id)
      if (treeIdRef.current === id && sourcesTreeId.current === id) setSources(next)
    } catch (e) {
      if (treeIdRef.current === id) {
        sourcesTreeId.current = null
        fail(e)
      }
    } finally {
      if (treeIdRef.current === id && sourcesTreeId.current === id) setSourcesLoading(false)
    }
  }, [])
  const loadChanges = useCallback(async (id: string) => {
    if (changesTreeId.current === id) return
    changesTreeId.current = id
    try {
      const next = await api.listChanges(id)
      if (treeIdRef.current === id && changesTreeId.current === id) setChanges(next)
    } catch (e) {
      if (treeIdRef.current === id) {
        changesTreeId.current = null
        fail(e)
      }
    }
  }, [])
  const loadIssues = useCallback(async (id: string) => {
    if (issuesTreeId.current === id) return
    issuesTreeId.current = id
    setReviewUpdating(true)
    try {
      const next = await api.listIssues(id)
      if (treeIdRef.current !== id || issuesTreeId.current !== id) return
      setIssues(next)
      setSelectedIssueKey((previous) =>
        previous && next.some((issue) => issue.key === previous)
          ? previous
          : next.find((issue) => !issue.dismissed)?.key || null,
      )
    } catch (e) {
      if (treeIdRef.current === id) {
        issuesTreeId.current = null
        fail(e)
      }
    } finally {
      if (treeIdRef.current === id && issuesTreeId.current === id) setReviewUpdating(false)
    }
  }, [])
  const loadFullPeople = useCallback(
    async (id: string) => {
      if (peopleDetailsLoaded || peopleDetailsLoading) return
      const version = ++peopleDetailsVersion.current
      setPeopleDetailsLoading(true)
      try {
        const next = await api.listPeople(id)
        if (treeIdRef.current === id && version === peopleDetailsVersion.current) {
          setPeople(next)
          setPeopleDetailsLoaded(true)
        }
      } catch (e) {
        if (treeIdRef.current === id && version === peopleDetailsVersion.current) fail(e)
      } finally {
        if (treeIdRef.current === id && version === peopleDetailsVersion.current)
          setPeopleDetailsLoading(false)
      }
    },
    [peopleDetailsLoaded, peopleDetailsLoading],
  )
  const refresh = useCallback(async (id: string, reason: TreeLoad['reason'] = 'refreshing') => {
    const version = ++refreshVersion.current
    if (treeIdRef.current !== id) return
    setTreeLoad({ treeId: id, reason })
    peopleDetailsVersion.current += 1
    setPeopleDetailsLoaded(false)
    setPeopleDetailsLoading(false)
    setReviewUpdating(false)
    setSourcesLoading(false)
    sourcesTreeId.current = null
    changesTreeId.current = null
    issuesTreeId.current = null
    setSources([])
    setIssues([])
    setChanges([])
    setSelectedIssueKey(null)
    try {
      const core = await api.loadTreeCore(id)
      if (version !== refreshVersion.current || treeIdRef.current !== id) return
      setPeople(core.people)
      setRelationships(core.relationships)
      setHomePersonId(core.homePersonId)
      setSelectedPersonId((previous) =>
        previous && core.people.some((person) => person.id === previous)
          ? previous
          : core.people[0]?.id || null,
      )
      setTreeDataVersion((current) => current + 1)
      setTreeLoad(null)
    } catch (e) {
      if (version === refreshVersion.current && treeIdRef.current === id)
        setTreeLoad({ treeId: id, reason, error: errorMessage(e) })
    }
  }, [])
  useEffect(() => {
    void loadTrees()
    if (!restoredLastTree.current) {
      restoredLastTree.current = true
      void api
        .getLastOpenedTree()
        .then((lastTreeId) => {
          if (lastTreeId) chooseTree(lastTreeId, 'restoring')
        })
        .catch(fail)
    }
    void api.sourceRegistry().then(setProviders).catch(fail)
    void api
      .ollamaStatus()
      .then((status) => {
        setOllama(status)
        setModel(status.models[0] || '')
      })
      .catch(fail)
  }, [loadTrees])
  useEffect(() => {
    if (!treeId) {
      treeIdRef.current = null
      refreshVersion.current += 1
      setTreeLoad(null)
      setReviewUpdating(false)
      setSourcesLoading(false)
    }
  }, [treeId])
  useEffect(() => {
    if (!treeId || treeLoad?.treeId === treeId) return
    if (page === 'people' || page === 'review' || page === 'cleanup') void loadSources(treeId)
    if (page === 'review') void loadIssues(treeId)
    if (page === 'settings') void loadChanges(treeId)
    if (page === 'cleanup' || page === 'review' || page === 'places') void loadFullPeople(treeId)
  }, [page, treeId, treeLoad, loadSources, loadChanges, loadIssues, loadFullPeople])
  useEffect(() => {
    if (!treeId) {
      setIntentionalGroupFingerprints([])
      return
    }
    let cancelled = false
    void api
      .listIntentionalDisconnectedGroups(treeId)
      .then((groups) => {
        if (!cancelled && treeIdRef.current === treeId) setIntentionalGroupFingerprints(groups)
      })
      .catch(fail)
    return () => {
      cancelled = true
    }
  }, [treeId, treeDataVersion])
  useEffect(() => {
    localStorage.setItem('kinfolk.sources', JSON.stringify(enabledSources))
  }, [enabledSources])
  useEffect(() => {
    localStorage.setItem('kinfolk.intentional-unknowns', JSON.stringify(intentionalUnknownIds))
  }, [intentionalUnknownIds])
  useEffect(() => {
    localStorage.setItem('kinfolk.review-sort', issueSort)
  }, [issueSort])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('kinfolk.theme', theme)
  }, [theme])
  useEffect(() => {
    if (
      !treeId ||
      !selectedIssue ||
      selectedIssue.kind === 'birthplace' ||
      !ollama?.available ||
      !model ||
      selectedIssue.dismissed ||
      selectedIssue.reviewed
    )
      return
    let cancelled = false
    setSuggestionLoading(true)
    setSuggestion(null)
    setResolutionDraft(deterministicResolution(selectedIssue))
    void api
      .getOrCreateIssueSuggestion(treeId, selectedIssue.key, model)
      .then((value) => {
        if (!cancelled) {
          setSuggestion({ key: selectedIssue.key, value })
          const proposal = value.proposal
          if (proposal)
            setResolutionDraft((previous) =>
              proposal.operation === 'merge_people' && previous?.operation === 'merge_people'
                ? { ...proposal, mergePlan: previous.mergePlan }
                : { ...proposal },
            )
        }
      })
      .catch(() => {
        if (!cancelled)
          setSuggestion({
            key: selectedIssue.key,
            value: {
              explanation:
                'Local AI could not prepare an alternate suggestion. The safe review action remains available.',
              limitations: 'Check Ollama in Settings, then select another issue to retry.',
              proposal: null,
              cached: false,
            },
          })
      })
      .finally(() => {
        if (!cancelled) setSuggestionLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [
    treeId,
    selectedIssueKey,
    selectedIssue?.fingerprint,
    selectedIssue?.dismissed,
    ollama?.available,
    model,
  ])
  useEffect(() => {
    if (selectedIssue && selectedIssue.kind !== 'birthplace' && (!ollama?.available || !model))
      setResolutionDraft(deterministicResolution(selectedIssue))
  }, [selectedIssueKey, selectedIssue?.fingerprint, selectedIssue?.kind, ollama?.available, model])

  const updateActivity = (id: number, patch: Partial<Activity>) =>
    setActivities((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  async function run<T>(
    action: () => Promise<T>,
    success: string,
    options: {
      treeId?: string | null
      key?: string
      refresh?: boolean
      working?: string
      onCommit?: (result: T) => void
      onError?: (error: unknown, id: number) => void
      undoChangeId?: (result: T) => string
    } = {},
  ) {
    const affectedTree = options.treeId === undefined ? treeId : options.treeId
    const key = options.key || affectedTree || 'catalog'
    if (writeLocks.current.has(key)) {
      setError('This tree is still saving. Try again when it finishes.')
      return
    }
    writeLocks.current.add(key)
    const id = ++activityId.current
    setError('')
    setActivities((items) => [
      ...items,
      {
        id,
        label: success,
        working: options.working || 'Saving changes…',
        state: 'saving',
        treeId: affectedTree,
      },
    ])
    try {
      const result = await action()
      options.onCommit?.(result)
      notify(success, options.undoChangeId?.(result), affectedTree)
      updateActivity(id, { state: 'updating' })
      writeLocks.current.delete(key)
      const updates = [loadTrees()]
      if (affectedTree && options.refresh !== false && treeIdRef.current === affectedTree)
        updates.push(refresh(affectedTree))
      void Promise.allSettled(updates).then(() => {
        updateActivity(id, { state: 'done' })
        window.setTimeout(
          () => setActivities((items) => items.filter((item) => item.id !== id)),
          7000,
        )
      })
      return result
    } catch (e) {
      writeLocks.current.delete(key)
      const message = errorMessage(e)
      updateActivity(id, { state: 'error', error: message })
      options.onError?.(e, id)
      fail(e)
      return undefined
    }
  }
  function leaveTree() {
    treeIdRef.current = null
    refreshVersion.current += 1
    peopleDetailsVersion.current += 1
    setPeopleDetailsLoaded(false)
    setPeopleDetailsLoading(false)
    setTreeId(null)
    setTreeLoad(null)
    setPeople([])
    setRelationships([])
    setSources([])
    setIssues([])
    setChanges([])
    setHomePersonId(null)
  }
  function chooseTree(id: string, reason: TreeLoad['reason'] = 'opening') {
    treeIdRef.current = id
    peopleDetailsVersion.current += 1
    setPeopleDetailsLoaded(false)
    setPeopleDetailsLoading(false)
    setTreeId(id)
    setPeople([])
    setRelationships([])
    setSources([])
    setIssues([])
    setChanges([])
    setHomePersonId(null)
    setPage('tree')
    setResearch(null)
    setSuggestion(null)
    void refresh(id, reason)
    void api.setLastOpenedTree(id).catch(fail)
  }
  function openRename(tree: Tree) {
    setActionTreeId(tree.id)
    setNewTreeName(tree.name)
    setDialog('rename')
  }
  function openDelete(tree: Tree) {
    setActionTreeId(tree.id)
    setDialog('delete')
  }
  async function renameTree() {
    if (!actionTreeId || !newTreeName.trim()) return
    if (writeLocks.current.has(actionTreeId)) return
    const id = actionTreeId,
      name = newTreeName.trim()
    setDialog(null)
    await run(() => api.renameTree(id, name), 'Tree renamed', {
      treeId: id,
      refresh: false,
      working: 'Renaming tree…',
    })
  }
  async function deleteTree() {
    if (!actionTreeId) return
    if (writeLocks.current.has(actionTreeId)) return
    const id = actionTreeId
    setDialog(null)
    await run(() => api.deleteTree(id), 'Tree deleted', {
      treeId: id,
      refresh: false,
      working: 'Deleting tree…',
      onCommit: () => {
        if (treeIdRef.current === id) leaveTree()
      },
    })
  }
  async function chooseGedcom() {
    const path = await open({
      multiple: false,
      filters: [{ name: 'GEDCOM or ZIP', extensions: ['ged', 'zip'] }],
    })
    if (typeof path !== 'string') return
    const version = ++previewVersion.current
    setImportPath(path)
    setImportPreview(null)
    setError('')
    setPreviewing(true)
    try {
      const preview = await api.previewGedcom(path)
      if (version === previewVersion.current) {
        setImportPreview(preview)
        setNewTreeName(
          path
            .split(/[\\/]/)
            .pop()
            ?.replace(/\.(zip|ged)$/i, '') || 'Imported tree',
        )
      }
    } catch (e) {
      if (version === previewVersion.current) fail(e)
    } finally {
      if (version === previewVersion.current) setPreviewing(false)
    }
  }
  async function startImport(path: string, name: string) {
    if (importing.current) return
    importing.current = true
    setDialog(null)
    setError('')
    setImportJob({
      state: 'running',
      path,
      name,
      progress: { phase: 'reading', completed: 0, total: 0 },
    })
    try {
      const id = await api.importGedcom(path, name, (progress) =>
        setImportJob((job) => (job?.state === 'running' ? { ...job, progress } : job)),
      )
      setImportJob((job) => (job ? { ...job, state: 'done', treeId: id } : job))
      await loadTrees()
    } catch (e) {
      setImportJob((job) => (job ? { ...job, state: 'error', error: errorMessage(e) } : job))
      fail(e)
    } finally {
      importing.current = false
    }
  }
  async function editPerson(person?: Person) {
    if (treeId) void loadSources(treeId)
    try {
      const full = person && treeId ? await api.getPerson(treeId, person.id) : person
      const input = full ? toInput(full) : emptyPerson()
      setPersonDraft(input)
      setVariantDraft(input.variants.join(','))
      setDialog('person')
    } catch (e) {
      fail(e)
    }
  }
  function updateFact(index: number, key: keyof FactInput, value: string | null) {
    setPersonDraft((d) => ({
      ...d,
      facts: d.facts.map((f, i) => (i === index ? { ...f, [key]: value } : f)),
    }))
  }
  async function storePerson() {
    if (!treeId) return
    if (writeLocks.current.has(treeId)) return
    const id = treeId,
      draft = structuredClone({
        ...personDraft,
        variants: variantDraft
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
      }),
      variants = variantDraft
    setDialog(null)
    await run(() => api.savePerson(id, draft), draft.id ? 'Person updated' : 'Person added', {
      treeId: id,
      onCommit: (saved) => {
        if (treeIdRef.current === id) {
          setPeople((items) =>
            [...items.filter((item) => item.id !== saved.id), saved].sort((a, b) =>
              a.name.localeCompare(b.name),
            ),
          )
          setSelectedPersonId(saved.id)
        }
      },
      onError: (_error, activity) => {
        setFailedDrafts((items) => ({
          ...items,
          [activity]: { treeId: id, kind: 'person', draft, variants },
        }))
        updateActivity(activity, { recoverable: true })
      },
    })
  }
  async function attachMedia() {
    if (!treeId || !selectedPersonId) return
    const id = treeId,
      personId = selectedPersonId
    const path = await open({ multiple: false })
    if (typeof path === 'string')
      await run(() => api.addAttachment(id, personId, path), 'Media copied into this tree', {
        treeId: id,
        working: 'Copying media…',
      })
  }
  async function backup() {
    if (!treeId) return
    const id = treeId
    const path = await save({
      defaultPath: `${currentTree?.name || 'family-tree'}.foreloom.zip`,
      filters: [{ name: 'ForeLoom backup', extensions: ['zip'] }],
    })
    if (path)
      await run(() => api.backupTree(id, path), 'Backup created', {
        treeId: id,
        refresh: false,
        working: 'Creating backup…',
      })
  }
  async function restore() {
    const path = await open({
      multiple: false,
      filters: [{ name: 'ForeLoom backup', extensions: ['zip'] }],
    })
    if (typeof path === 'string')
      await run(() => api.restoreTree(path), 'Backup restored as a separate tree', {
        treeId: null,
        key: 'restore',
        refresh: false,
        working: 'Restoring backup…',
        onCommit: (id) => chooseTree(id),
      })
  }
  async function applyResolution(issue: Issue) {
    if (!treeId || !resolutionDraft || reviewUpdating) return
    if (
      resolutionDraft.operation === 'merge_people' &&
      !window.confirm(
        `Merge ${personName(resolutionDraft.duplicateId || '')} into ${personName(resolutionDraft.survivorId || '')}?\n\nFacts, relationships, notes, media references, and citations will be preserved. You can undo the merge if no later change is made.`,
      )
    )
      return
    const id = treeId,
      resolution = { ...resolutionDraft }
    await run(
      () => api.applyIssueResolution(id, issue.key, issue.revision, resolution),
      'Review change applied',
      {
        treeId: id,
        onCommit: () => {
          setSuggestion(null)
          setResolutionDraft(null)
        },
        undoChangeId: (changeId) => changeId,
      },
    )
  }
  async function applyBirthplaceResolution(issue: Issue) {
    if (!treeId || !birthplaceDraft || reviewUpdating) return
    const expectedAlternatives = birthplaceFacts.filter(
      (fact) => fact.id !== birthplaceDraft.preferredFactId,
    )
    if (
      !birthplaceDraft.preferredFactId ||
      birthplaceDraft.alternatives.length !== expectedAlternatives.length
    ) {
      setError('Choose a preferred display place and classify every other birthplace.')
      return
    }
    const id = treeId,
      resolution = { ...birthplaceDraft }
    await run(
      () => api.resolveBirthplaceConflict(id, issue.key, issue.revision, resolution),
      'Birthplace variation reviewed',
      {
        treeId: id,
        onCommit: () => setBirthplaceDraft(null),
        undoChangeId: (changeId) => changeId,
      },
    )
  }
  async function searchResearch() {
    if (!treeId) return
    setResearchBusy(true)
    setError('')
    setResearch(null)
    try {
      const result = await api.researchSearch(treeId, {
        name: researchName,
        birthYear: researchYear ? Number(researchYear) : null,
        deathYear: null,
        place: researchPlace || null,
        relatives: researchRelatives || null,
        livingLeads,
        sources: enabledSources,
        europeanaKey: europeanaKey || null,
      })
      setResearch(result)
    } catch (e) {
      fail(e)
    } finally {
      setResearchBusy(false)
    }
  }
  async function launchManualSearch(provider: ManualSearchProvider) {
    const handoff = buildManualSearchHandoff(provider, {
      name: researchName,
      birthYear: researchYear,
      place: researchPlace,
      relatives: researchRelatives,
    })
    if (handoff.unavailableReason) {
      setError(handoff.unavailableReason)
      return
    }
    try {
      await api.openExternal(handoff.url)
      notify('Opened official source search')
    } catch (e) {
      fail(e)
    }
  }
  async function promote(item: ResearchItem) {
    if (
      !treeId ||
      !window.confirm(
        `Add ${item.title} as an unverified person with the cited lead?\n\nSource: ${item.sourceCitation}\n${item.url}`,
      )
    )
      return
    const id = treeId
    await run(() => api.promoteCandidate(id, item), 'Candidate added as unverified', {
      treeId: id,
      onCommit: (personId) => {
        if (treeIdRef.current === id) {
          setSelectedPersonId(personId)
          setPage('people')
        }
      },
    })
  }
  function reopenDraft(id: number) {
    const saved = failedDrafts[id]
    if (!saved) return
    chooseTree(saved.treeId)
    if (saved.kind === 'person') {
      setPersonDraft(saved.draft)
      setVariantDraft(saved.variants)
    } else setSourceDraft(saved.draft)
    setDialog(saved.kind)
    setActivities((items) => items.filter((item) => item.id !== id))
    setFailedDrafts((items) => {
      const next = { ...items }
      delete next[id]
      return next
    })
  }
  function dismissActivity(id: number) {
    setActivities((items) => items.filter((item) => item.id !== id))
    setFailedDrafts((items) => {
      const next = { ...items }
      delete next[id]
      return next
    })
  }
  async function createTree() {
    if (!newTreeName.trim()) return
    if (writeLocks.current.has('create')) return
    const name = newTreeName.trim()
    setDialog(null)
    await run(() => api.createTree(name), 'Tree created', {
      treeId: null,
      key: 'create',
      refresh: false,
      working: 'Creating tree…',
      onCommit: (tree) => chooseTree(tree.id),
    })
  }
  async function addRelationship() {
    if (!treeId) return
    if (writeLocks.current.has(treeId)) return
    const id = treeId,
      draft = { ...relationDraft }
    setDialog(null)
    await run(
      () =>
        draft.id
          ? api.updateRelationship(
              id,
              draft.id,
              draft.fromId,
              draft.toId,
              draft.kind,
              draft.sourceId,
            )
          : api.addRelationship(id, draft.fromId, draft.toId, draft.kind, draft.sourceId),
      draft.id ? 'Relationship updated' : 'Relationship added',
      { treeId: id },
    )
  }
  async function findBranchConnections() {
    if (!treeId || !ollama?.available || !model || !branchDraft || !branchLeads.length) return
    const request = ++branchRequest.current
    setBranchAi({ loading: true, results: [], error: '', searched: true })
    try {
      const results = await api.findBranchConnectionsWithAi(treeId, branchLeads, model)
      if (request === branchRequest.current)
        setBranchAi({ loading: false, results, error: '', searched: true })
    } catch (error) {
      if (request === branchRequest.current)
        setBranchAi({ loading: false, results: [], error: errorMessage(error), searched: true })
    }
  }
  async function addSource() {
    if (!treeId) return
    if (writeLocks.current.has(treeId)) return
    const id = treeId,
      draft = { ...sourceDraft }
    setDialog(null)
    setSourceDraft({ title: '', url: '', citation: '', notes: '' })
    await run(() => api.addSource(id, draft), 'Source added', {
      treeId: id,
      onError: (_error, activity) => {
        setFailedDrafts((items) => ({
          ...items,
          [activity]: { treeId: id, kind: 'source', draft },
        }))
        updateActivity(activity, { recoverable: true })
      },
    })
  }
  const personName = useCallback(
    (id: string) => people.find((p) => p.id === id)?.name || 'Unknown',
    [people],
  )
  const sortedIssues = useMemo(() => {
    if (page !== 'review') return []
    const displayIssues = (showDismissed ? issues : openIssues).filter(
      (issue) => issueCategoryFilter === 'all' || issue.category === issueCategoryFilter,
    )
    const severity = { high: 0, medium: 1, low: 2 }
    const effort = { quick: 0, assisted: 1, manual: 2 }
    const compare = (x: number, y: number) => x - y
    return [...displayIssues].sort((a, b) => {
      if (issueSort === 'effort')
        return (
          compare(effort[a.fixEffort], effort[b.fixEffort]) ||
          compare(severity[a.severity], severity[b.severity]) ||
          a.title.localeCompare(b.title)
        )
      if (issueSort === 'category')
        return (
          compare(issueCategoryOrder.indexOf(a.category), issueCategoryOrder.indexOf(b.category)) ||
          compare(severity[a.severity], severity[b.severity]) ||
          a.title.localeCompare(b.title)
        )
      return (
        compare(severity[a.severity], severity[b.severity]) ||
        compare(effort[a.fixEffort], effort[b.fixEffort]) ||
        a.title.localeCompare(b.title)
      )
    })
  }, [issues, issueCategoryFilter, issueSort, openIssues, page, showDismissed])
  const deferredSearchText = useDeferredValue(searchText)
  const peopleMatches = useMemo(() => {
    if (page !== 'people') return []
    const query = deferredSearchText.trim().toLowerCase()
    const allowedIds = placePeopleFilter ? new Set(placePeopleFilter) : null
    return matchPeople(
      people.filter((person) => !allowedIds || allowedIds.has(person.id)),
      query,
    )
  }, [deferredSearchText, page, people, placePeopleFilter])
  const cleanupData = useMemo(
    () =>
      page === 'cleanup' && peopleDetailsLoaded
        ? buildCleanupData(
            people,
            relationships,
            intentionalUnknownIds,
            intentionalGroupFingerprints,
          )
        : { records: [], groups: [] },
    [
      page,
      people,
      peopleDetailsLoaded,
      relationships,
      intentionalUnknownIds,
      intentionalGroupFingerprints,
    ],
  )
  const cleanupRecords = cleanupData.records
  const disconnectedGroups = cleanupData.groups
  const filteredCleanup = useMemo(
    () =>
      cleanupRecords.filter(
        (record) => cleanupFilter === 'all' || record.categories.includes(cleanupFilter),
      ),
    [cleanupFilter, cleanupRecords],
  )
  const openPerson = useCallback((personId: string) => {
    setSelectedPersonId(personId)
    setPage('people')
  }, [])
  const previewCleanupDeletion = async () => {
    if (!treeId || !cleanupSelection.length) return
    try {
      setCleanupDependencies(await api.previewPeopleDeletion(treeId, cleanupSelection))
    } catch (e) {
      fail(e)
    }
  }
  const deleteCleanupPeople = async () => {
    if (!treeId || !cleanupDependencies?.length) return
    if (
      !window.confirm(
        `Delete ${cleanupDependencies.length} selected record${cleanupDependencies.length === 1 ? '' : 's'}? Relationships and facts shown in the preview will be removed. This cannot be undone.`,
      )
    )
      return
    const ids = cleanupDependencies.map((item) => item.personId)
    setCleanupDependencies(null)
    setCleanupSelection([])
    await run(() => api.deletePeople(treeId, ids), 'Selected records deleted', { treeId })
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setPage('tree')} aria-label="ForeLoom home">
          <img className="brand-lockup" src="/brand/foreloom-horizontal-white.svg" alt="" />
          <span className="brand-symbol" aria-hidden="true" />
          <small>FAMILY RESEARCH</small>
        </button>
        <div className="tree-picker">
          <span className="sidebar-label">CURRENT TREE</span>
          {treeId ? (
            <button className="tree-select" onClick={leaveTree}>
              <span className="tree-select-icon brand-symbol" aria-hidden="true" />
              <span className="truncate">{currentTree?.name || 'Opening tree…'}</span>
              <ChevronDown size={16} />
            </button>
          ) : (
            <button className="tree-select" onClick={() => setDialog('create')}>
              <Plus size={16} /> Choose a tree
            </button>
          )}
        </div>
        <nav aria-label="Primary navigation">
          {tabs
            .filter((tab) => DATA_CLEANUP_ENABLED || tab.id !== 'cleanup')
            .map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={`nav-item ${page === id ? 'active' : ''}`}
                onClick={() => setPage(id)}
              >
                <Icon size={18} />
                <span>{label}</span>
                {id === 'review' && openIssues.length > 0 && (
                  <span className="nav-count">{openIssues.length}</span>
                )}
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-note">
            <span className="local-pulse" />
            Private by design
            <br />
            <small>Your tree stays on this computer</small>
          </div>
          <button className="sidebar-link" onClick={leaveTree}>
            <PanelLeftClose size={16} /> All trees
          </button>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <div className="topbar-right">
            <span className="offline-badge">
              <ShieldCheck size={14} /> LOCAL FIRST
            </span>
            <button
              className="theme-toggle"
              onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
              <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
            </button>
            <div className="avatar">SW</div>
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <CircleAlert size={17} />
            <span>{error}</span>
            <button onClick={() => setError('')} aria-label="Dismiss error">
              <X size={16} />
            </button>
          </div>
        )}
        {(importJob || activities.length > 0) && (
          <div className="activity-list" aria-label="Background activity">
            {importJob && (
              <div className={`activity-row ${importJob.state}`} role="status" aria-live="polite">
                {importJob.state === 'running' ? (
                  <LoaderCircle size={17} className="spin" />
                ) : importJob.state === 'done' ? (
                  <Check size={17} />
                ) : (
                  <CircleAlert size={17} />
                )}
                <span>
                  <strong>
                    {importJob.state === 'running'
                      ? importPhaseLabels[importJob.progress.phase]
                      : importJob.state === 'done'
                        ? `${importJob.name} imported`
                        : 'Import failed'}
                  </strong>
                  <small>
                    {importJob.state === 'running'
                      ? importJob.progress.total
                        ? `${importJob.progress.completed} of ${importJob.progress.total}`
                        : 'You can keep using other trees.'
                      : importJob.state === 'error'
                        ? importJob.error
                        : 'Your new tree is ready.'}
                  </small>
                </span>
                {importJob.state === 'done' && importJob.treeId && (
                  <button
                    onClick={() => {
                      chooseTree(importJob.treeId!)
                      setImportJob(null)
                    }}
                  >
                    Open tree
                  </button>
                )}
                {importJob.state === 'error' && (
                  <button onClick={() => void startImport(importJob.path, importJob.name)}>
                    Retry
                  </button>
                )}
                {importJob.state !== 'running' && (
                  <button
                    className="activity-dismiss"
                    onClick={() => setImportJob(null)}
                    aria-label="Dismiss import status"
                  >
                    <X size={15} />
                  </button>
                )}
              </div>
            )}
            {activities.map((item) => (
              <div
                className={`activity-row ${item.state}`}
                key={item.id}
                role="status"
                aria-live="polite"
              >
                {item.state === 'saving' || item.state === 'updating' ? (
                  <LoaderCircle size={17} className="spin" />
                ) : item.state === 'done' ? (
                  <Check size={17} />
                ) : (
                  <CircleAlert size={17} />
                )}
                <span>
                  <strong>
                    {item.state === 'saving'
                      ? item.working
                      : item.state === 'updating'
                        ? `${item.label} · Updating view…`
                        : item.state === 'done'
                          ? item.label
                          : `${item.label} failed`}
                  </strong>
                  {item.error && <small>{item.error}</small>}
                </span>
                {item.recoverable && (
                  <button onClick={() => reopenDraft(item.id)}>Reopen draft</button>
                )}
                {(item.state === 'error' || item.state === 'done') && (
                  <button
                    className="activity-dismiss"
                    onClick={() => dismissActivity(item.id)}
                    aria-label={
                      item.recoverable ? 'Discard saved draft' : `Dismiss ${item.label} status`
                    }
                  >
                    {item.recoverable ? 'Discard draft' : <X size={15} />}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {!treeId ? (
          <div className="content">
            <section className="welcome-head">
              <span className="eyebrow">YOUR FAMILY ARCHIVE</span>
              <h1>
                Every family has a story
                <br />
                <em>worth uncovering.</em>
              </h1>
              <p>Build your tree, follow the evidence, and make each discovery your own.</p>
              <div className="flex gap-3 mt-7">
                <Button
                  onClick={() => {
                    setNewTreeName('')
                    setDialog('create')
                  }}
                >
                  <Plus size={17} /> Create a tree
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setDialog('import')
                    void chooseGedcom()
                  }}
                >
                  <Upload size={17} /> Import GEDCOM
                </Button>
              </div>
            </section>
            <div className="section-heading">
              <h2>Your trees</h2>
              <span>
                {trees.length} {trees.length === 1 ? 'archive' : 'archives'}
              </span>
            </div>
            {trees.length ? (
              <div className="tree-list">
                {trees.map((tree) => (
                  <div key={tree.id} className="tree-list-row">
                    <button className="tree-list-item" onClick={() => chooseTree(tree.id)}>
                      <span className="tree-list-icon">
                        <span className="brand-symbol" aria-hidden="true" />
                      </span>
                      <span>
                        <strong>{tree.name}</strong>
                        <small>
                          {tree.peopleCount} people · Started {fmtDate(tree.createdAt)}
                        </small>
                      </span>
                      <ArrowRight size={18} />
                    </button>
                    <div className="tree-list-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openRename(tree)}
                        aria-label={`Rename ${tree.name}`}
                      >
                        <Pencil size={15} /> Rename
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="danger-text"
                        onClick={() => openDelete(tree)}
                        aria-label={`Delete ${tree.name}`}
                      >
                        <Trash2 size={15} /> Delete
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-block">
                <Archive size={27} />
                <h3>Your archive begins here</h3>
                <p>Create a tree or bring in a GEDCOM you exported from Ancestry.</p>
              </div>
            )}
            <Button variant="ghost" className="mt-4" onClick={() => void restore()}>
              <RotateCcw size={16} /> Restore a backup
            </Button>
          </div>
        ) : treeLoad?.treeId === treeId ? (
          <TreeLoading
            treeName={currentTree?.name}
            error={treeLoad.error}
            onRetry={() => void refresh(treeId, treeLoad.reason)}
            onChooseAnother={leaveTree}
          />
        ) : (
          <div
            className={
              'content ' + (page === 'places' && placesView === 'map' ? 'places-content' : '')
            }
          >
            {page === 'tree' && (
              <>
                <div className="page-head">
                  <div>
                    <span className="eyebrow">FAMILY CONNECTIONS</span>
                    <h1>Family tree</h1>
                    <p>Show siblings or reveal each person’s parents as you explore.</p>
                  </div>
                  <Button onClick={() => editPerson()}>
                    <Plus size={17} /> Add person
                  </Button>
                </div>
                {people.length ? (
                  <>
                    <div className="view-toolbar">
                      <span>
                        {people.length} people · {relationships.length} relationships
                      </span>
                    </div>
                    <InteractiveTree
                      treeId={treeId}
                      people={people}
                      relationships={relationships}
                      homePersonId={homePersonId}
                      selectedPersonId={selectedPersonId}
                      onSelect={setSelectedPersonId}
                      onOpenPerson={openPerson}
                    />
                    <div className="tree-foot">
                      <span>
                        <i className="legend-dot biological" /> Biological parent-child
                      </span>
                      <span>
                        <i className="legend-dot adoptive" /> Adoptive parent
                      </span>
                      <span>
                        <i className="legend-dot step" /> Step parent
                      </span>
                      <span>
                        <i className="legend-dot unknown" /> Parent type unknown
                      </span>
                      <span>
                        <i className="legend-dot partner" /> Partner or spouse
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="empty-block">
                    <GitBranch size={28} />
                    <h3>Start with someone you know</h3>
                    <p>Add your first person. You can fill in uncertain dates and sources later.</p>
                    <Button onClick={() => editPerson()}>
                      <Plus size={16} /> Add first person
                    </Button>
                  </div>
                )}
              </>
            )}
            {page === 'places' && (
              <>
                <div className="page-head places-page-head">
                  <div>
                    <span className="eyebrow">FAMILY GEOGRAPHY</span>
                    <h1>
                      Places <em>in the record</em>
                    </h1>
                    <p>
                      {placesView === 'map'
                        ? 'See where your family’s documented lives converge.'
                        : 'Review uncertain place records without changing the original evidence unless you choose to.'}
                    </p>
                  </div>
                  <div
                    className="segmented places-view-switcher"
                    role="tablist"
                    aria-label="Places views"
                  >
                    <button
                      className={placesView === 'map' ? 'selected' : ''}
                      onClick={() => setPlacesView('map')}
                      role="tab"
                      aria-selected={placesView === 'map'}
                    >
                      Map
                    </button>
                    <button
                      className={placesView === 'resolve' ? 'selected' : ''}
                      onClick={() => setPlacesView('resolve')}
                      role="tab"
                      aria-selected={placesView === 'resolve'}
                    >
                      Resolve places
                    </button>
                  </div>
                </div>
                {placesView === 'resolve' ? (
                  <PlaceResolutionCleanup treeId={treeId!} model={model} onError={fail} />
                ) : !peopleDetailsLoaded ? (
                  <div className="places-loading" role="status">
                    Preparing records for the family atlas…
                  </div>
                ) : (
                  treeId && (
                    <Suspense
                      fallback={<div className="places-loading">Preparing the family atlas…</div>}
                    >
                      <FamilyPlacesMap
                        key={treeDataVersion}
                        treeId={treeId}
                        people={people}
                        relationships={relationships}
                        homePersonId={homePersonId}
                        theme={theme}
                        onOpenPerson={(personId) => {
                          setSelectedPersonId(personId)
                          setPage('people')
                        }}
                        onViewPeople={(ids) => {
                          setPlacePeopleFilter(ids)
                          setSelectedPersonId(ids[0] || null)
                          setPage('people')
                        }}
                        onResolvePlaces={() => setPlacesView('resolve')}
                      />
                    </Suspense>
                  )
                )}
              </>
            )}
            {page === 'people' && (
              <>
                <div className="page-head">
                  <div>
                    <span className="eyebrow">THE PEOPLE IN YOUR TREE</span>
                    <h1>People</h1>
                    <p>Keep the facts, relationships, and evidence together.</p>
                  </div>
                  <Button onClick={() => editPerson()}>
                    <Plus size={17} /> Add person
                  </Button>
                </div>
                {sourcesLoading && (
                  <p className="quiet" role="status">
                    Loading citations…
                  </p>
                )}
                {placePeopleFilter && (
                  <div className="view-toolbar">
                    <span>Showing people recorded in the selected place</span>
                    <button className="source-link" onClick={() => setPlacePeopleFilter(null)}>
                      Clear place filter
                    </button>
                  </div>
                )}
                <div className="people-layout">
                  <section className="people-index">
                    <label className="search-field">
                      <Search size={17} />
                      <Input
                        placeholder="Search names and variants"
                        value={searchText}
                        onChange={(e) => setSearchText(e.target.value)}
                      />
                    </label>
                    <div className="index-count">{peopleMatches.length} PEOPLE</div>
                    <div className="index-scroll">
                      {peopleMatches.slice(0, 200).map((person) => (
                        <button
                          key={person.id}
                          className={`person-row ${selectedPersonId === person.id ? 'selected' : ''}`}
                          onClick={() => setSelectedPersonId(person.id)}
                        >
                          <span className="person-initial">
                            {person.name.charAt(0).toUpperCase()}
                          </span>
                          <span>
                            <PersonOption person={person} />
                          </span>
                          <ArrowRight size={15} />
                        </button>
                      ))}
                      {peopleMatches.length > 200 && (
                        <p className="quiet px-4 py-5">
                          Showing the first 200 matches. Refine your search to narrow the list.
                        </p>
                      )}
                      {!peopleMatches.length && (
                        <p className="quiet px-4 py-5">No people match this search.</p>
                      )}
                    </div>
                  </section>
                  <section className="profile">
                    {selectedPerson ? (
                      <PersonProfile
                        treeId={treeId}
                        treeDataVersion={treeDataVersion}
                        person={selectedPerson}
                        relationships={relationships}
                        sources={sources}
                        personName={personName}
                        onEdit={() => editPerson(selectedPerson)}
                        onAddRelation={() => {
                          setRelationDraft({
                            fromId: selectedPerson.id,
                            toId: people.find((p) => p.id !== selectedPerson.id)?.id || '',
                            kind: 'biological_parent',
                            sourceId: null,
                          })
                          setDialog('relationship')
                        }}
                        onAddSource={() => setDialog('source')}
                        onAttach={() => void attachMedia()}
                        onRemoveRelation={async (id) => {
                          if (treeId)
                            await run(
                              () => api.removeRelationship(treeId, id),
                              'Relationship removed',
                            )
                        }}
                      />
                    ) : (
                      <div className="empty-profile">
                        <Users size={26} />
                        <h3>Select a person</h3>
                        <p>Or add someone to begin building your family record.</p>
                      </div>
                    )}
                  </section>
                </div>
              </>
            )}
            {DATA_CLEANUP_ENABLED &&
              page === 'cleanup' &&
              (!peopleDetailsLoaded ? (
                <div className="empty-block compact" role="status">
                  <LoaderCircle size={25} className="spin" />
                  <h3>Preparing cleanup suggestions…</h3>
                </div>
              ) : (
                <CleanupDashboard
                  records={filteredCleanup}
                  groups={disconnectedGroups}
                  showIntentionalGroups={showIntentionalGroups}
                  onToggleIntentionalGroups={() => setShowIntentionalGroups((value) => !value)}
                  onReviewGroup={(group) => {
                    branchRequest.current += 1
                    setBranchAi({ loading: false, results: [], error: '', searched: false })
                    setBranchDraft({
                      group,
                      fromId: group.memberIds[0],
                      toId: '',
                      kind: '',
                      sourceId: null,
                    })
                    setDialog('branch')
                  }}
                  onKeepGroup={(group) =>
                    treeId &&
                    void run(
                      () => api.markDisconnectedGroupIntentional(treeId, group.memberIds),
                      'Separate branch kept',
                      {
                        treeId,
                        onCommit: () =>
                          setIntentionalGroupFingerprints((ids) => [...ids, group.fingerprint]),
                      },
                    )
                  }
                  onReopenGroup={(group) =>
                    treeId &&
                    void run(
                      () => api.reopenDisconnectedGroup(treeId, group.memberIds),
                      'Separate branch reopened',
                      {
                        treeId,
                        onCommit: () =>
                          setIntentionalGroupFingerprints((ids) =>
                            ids.filter((id) => id !== group.fingerprint),
                          ),
                      },
                    )
                  }
                  filter={cleanupFilter}
                  selectedIds={cleanupSelection}
                  dependencies={cleanupDependencies}
                  onFilter={setCleanupFilter}
                  onSelect={(id) =>
                    setCleanupSelection((ids) =>
                      ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id],
                    )
                  }
                  onSelectAll={() =>
                    setCleanupSelection(
                      filteredCleanup.every((record) => cleanupSelection.includes(record.person.id))
                        ? []
                        : filteredCleanup.map((record) => record.person.id),
                    )
                  }
                  onEdit={(person) => void editPerson(person)}
                  onConnect={(person) => {
                    setSelectedPersonId(person.id)
                    setRelationDraft({
                      fromId: person.id,
                      toId: people.find((item) => item.id !== person.id)?.id || '',
                      kind: 'biological_parent',
                      sourceId: null,
                    })
                    setDialog('relationship')
                  }}
                  onFindDuplicates={(person) => {
                    setSearchText(person.name === '?' ? '' : person.name)
                    setSelectedPersonId(person.id)
                    setPage('people')
                  }}
                  onMarkIntentional={(person) =>
                    setIntentionalUnknownIds((ids) =>
                      ids.includes(person.id)
                        ? ids.filter((item) => item !== person.id)
                        : [...ids, person.id],
                    )
                  }
                  onPreviewDelete={() => void previewCleanupDeletion()}
                  onCancelDelete={() => setCleanupDependencies(null)}
                  onDelete={() => void deleteCleanupPeople()}
                />
              ))}
            {page === 'review' && (
              <>
                <div className="page-head review-head">
                  <div>
                    <span className="eyebrow">EVIDENCE BEFORE ASSUMPTION</span>
                    <h1>Review</h1>
                    <p>
                      Sort what needs attention, inspect the evidence, then make one deliberate
                      change.
                    </p>
                    {reviewUpdating && (
                      <p className="review-updating" role="status">
                        <LoaderCircle size={14} className="spin" /> Checking review items…
                      </p>
                    )}
                  </div>
                  <label className="subtle-check">
                    <input
                      type="checkbox"
                      checked={showDismissed}
                      onChange={(e) => setShowDismissed(e.target.checked)}
                    />{' '}
                    Show reviewed and dismissed
                  </label>
                </div>
                <div className="review-controls" aria-label="Review controls">
                  <div className="review-counts">
                    {issueCategoryOrder.map((category) => {
                      const count = openIssues.filter((issue) => issue.category === category).length
                      return count ? (
                        <button
                          key={category}
                          className={issueCategoryFilter === category ? 'selected' : ''}
                          onClick={() =>
                            setIssueCategoryFilter((current) =>
                              current === category ? 'all' : category,
                            )
                          }
                        >
                          {issueCategoryLabels[category]} <span>{count}</span>
                        </button>
                      ) : null
                    })}
                  </div>
                  <label>
                    Sort{' '}
                    <select
                      value={issueSort}
                      onChange={(e) => setIssueSort(e.target.value as typeof issueSort)}
                    >
                      <option value="severity">Severity, then effort</option>
                      <option value="effort">Easiest fixes first</option>
                      <option value="category">Category, then severity</option>
                    </select>
                  </label>
                </div>
                {sortedIssues.length ? (
                  <div className="review-layout">
                    <div className="issue-list">
                      {sortedIssues.slice(0, 200).map((issue) => (
                        <button
                          key={issue.key}
                          className={`issue-row ${selectedIssueKey === issue.key ? 'selected' : ''}`}
                          onClick={() => {
                            setSelectedIssueKey(issue.key)
                            setSuggestion(null)
                            setResolutionDraft(null)
                            setBirthplaceDraft(null)
                          }}
                        >
                          <span className={`severity-dot ${issue.severity}`} />
                          <span>
                            <strong>{issue.title}</strong>
                            <small>
                              {issueCategoryLabels[issue.category]} · {issue.severity} severity ·{' '}
                              {issue.fixEffort} fix
                              {issue.dismissed
                                ? ' · dismissed'
                                : issue.reviewed
                                  ? ' · reviewed'
                                  : ''}
                            </small>
                          </span>
                          <ArrowRight size={16} />
                        </button>
                      ))}
                      {sortedIssues.length > 200 && (
                        <p className="quiet px-4 py-5">
                          Showing the first 200 review items. Use the filters to narrow the queue.
                        </p>
                      )}
                    </div>
                    <section className="issue-detail" ref={reviewDetailRef} tabIndex={-1}>
                      {selectedIssue && (
                        <>
                          <div className="issue-detail-top">
                            <span className="eyebrow">
                              {issueCategoryLabels[selectedIssue.category]}
                            </span>
                            <div className="issue-tags">
                              <span className={`severity-tag ${selectedIssue.severity}`}>
                                {selectedIssue.severity} severity
                              </span>
                              <span className="effort-tag">{selectedIssue.fixEffort} fix</span>
                            </div>
                          </div>
                          <h2>{selectedIssue.title}</h2>
                          <p className="issue-lede">{selectedIssue.explanation}</p>
                          <div className="evidence-block">
                            <h3>Why this was flagged</h3>
                            {selectedIssue.evidence.map((e, i) => (
                              <div key={i} className="evidence-line">
                                <FileText size={16} />
                                {e}
                              </div>
                            ))}
                          </div>
                          {selectedIssue.kind === 'duplicate' && (
                            <DuplicateComparison
                              people={people}
                              relationships={relationships}
                              sources={sources}
                              personIds={selectedIssue.personIds}
                              mergePlan={
                                resolutionDraft?.operation === 'merge_people'
                                  ? resolutionDraft.mergePlan
                                  : undefined
                              }
                              onPlanChange={(mergePlan) =>
                                setResolutionDraft((draft) =>
                                  draft?.operation === 'merge_people'
                                    ? { ...draft, mergePlan }
                                    : draft,
                                )
                              }
                              onPlanValidityChange={setMergePlanReady}
                              onEdit={(person) => editPerson(person)}
                            />
                          )}
                          {selectedIssue.kind === 'birthplace' ? (
                            <div className="birthplace-review">
                              <h3>Review birthplace variation</h3>
                              <p className="quiet">
                                Choose the place to display first, then describe how every other
                                recorded place relates to it. This does not edit or remove any
                                source fact.
                              </p>
                              {!birthplaceDraft ? (
                                <Button
                                  variant="outline"
                                  onClick={() =>
                                    setBirthplaceDraft({ preferredFactId: '', alternatives: [] })
                                  }
                                >
                                  Review recorded places
                                </Button>
                              ) : (
                                <>
                                  <div className="field">
                                    <label>Preferred display place</label>
                                    <select
                                      value={birthplaceDraft.preferredFactId}
                                      onChange={(e) =>
                                        setBirthplaceDraft({
                                          preferredFactId: e.target.value,
                                          alternatives: [],
                                        })
                                      }
                                    >
                                      <option value="">Choose a recorded birthplace</option>
                                      {birthplaceFacts.map((fact) => (
                                        <option key={fact.id} value={fact.id}>
                                          {fact.place}
                                          {fact.dateText ? ` · ${fact.dateText}` : ''}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                  {birthplaceDraft.preferredFactId &&
                                    birthplaceFacts
                                      .filter((fact) => fact.id !== birthplaceDraft.preferredFactId)
                                      .map((fact) => {
                                        const relation =
                                          birthplaceDraft.alternatives.find(
                                            (item) => item.factId === fact.id,
                                          )?.relation || ''
                                        const setRelation = (next: BirthplaceRelation) =>
                                          setBirthplaceDraft((draft) =>
                                            draft
                                              ? {
                                                  ...draft,
                                                  alternatives: [
                                                    ...draft.alternatives.filter(
                                                      (item) => item.factId !== fact.id,
                                                    ),
                                                    { factId: fact.id, relation: next },
                                                  ],
                                                }
                                              : draft,
                                          )
                                        const preferred = birthplaceFacts.find(
                                          (item) => item.id === birthplaceDraft.preferredFactId,
                                        )
                                        return (
                                          <div className="birthplace-alternative" key={fact.id}>
                                            <strong>
                                              {fact.place}
                                              {fact.dateText ? ` · ${fact.dateText}` : ''}
                                            </strong>
                                            <label>Relationship to {preferred?.place}</label>
                                            <select
                                              value={relation}
                                              onChange={(e) =>
                                                setRelation(e.target.value as BirthplaceRelation)
                                              }
                                            >
                                              <option value="">Choose a classification</option>
                                              <option value="same_historical_place">
                                                Same historical place or alternate name
                                              </option>
                                              <option value="alternative_within_preferred">
                                                This place is within the preferred place
                                              </option>
                                              <option value="preferred_within_alternative">
                                                Preferred place is within this place
                                              </option>
                                              <option value="unresolved_conflict">
                                                Unresolved conflict
                                              </option>
                                            </select>
                                          </div>
                                        )
                                      })}
                                </>
                              )}
                            </div>
                          ) : (
                            <div className="ai-block">
                              <span>
                                <Sparkles size={16} /> LOCAL AI REVIEW
                                {suggestion?.key === selectedIssue.key && suggestion.value.cached
                                  ? ' · SAVED'
                                  : ''}
                              </span>
                              {suggestionLoading ? (
                                <p className="quiet">
                                  <LoaderCircle className="spin" size={15} /> Preparing an
                                  evidence-bound suggestion…
                                </p>
                              ) : suggestion?.key === selectedIssue.key ? (
                                <>
                                  <p>{suggestion.value.explanation}</p>
                                  <small>{suggestion.value.limitations}</small>
                                </>
                              ) : (
                                <p className="quiet">
                                  {ollama?.available && model
                                    ? 'A suggestion will appear here.'
                                    : 'Start Ollama and select a model in Settings to receive a local suggestion.'}
                                </p>
                              )}
                            </div>
                          )}
                          {resolutionDraft ? (
                            <div className="resolution-editor">
                              <h3>
                                {resolutionDraft.operation === 'merge_people'
                                  ? 'Merge plan'
                                  : 'Suggested change'}{' '}
                                <span>
                                  {resolutionDraft.operation === 'merge_people'
                                    ? 'Confirmation required'
                                    : 'Editable before applying'}
                                </span>
                              </h3>
                              {resolutionDraft.operation === 'remove_fact' ? (
                                <>
                                  <div className="diff-remove">
                                    <span>−</span> Remove:{' '}
                                    {(() => {
                                      const f = people
                                        .flatMap((p) => p.facts)
                                        .find((f) => f.id === resolutionDraft.factId)
                                      return f
                                        ? factLine(f.kind, f.dateText, f.place)
                                        : 'the conflicting fact'
                                    })()}
                                  </div>
                                  <p>
                                    The original fact stays in change history and can be restored
                                    with Undo.
                                  </p>
                                </>
                              ) : resolutionDraft.operation === 'merge_people' ? (
                                <div className="merge-preview">
                                  <div className="field">
                                    <PersonSelector
                                      label="Keep this person"
                                      people={people.filter((person) =>
                                        selectedIssue.personIds.includes(person.id),
                                      )}
                                      value={resolutionDraft.survivorId || ''}
                                      onChange={(next) =>
                                        setResolutionDraft((draft) =>
                                          draft
                                            ? {
                                                ...draft,
                                                survivorId: next,
                                                duplicateId: draft.survivorId,
                                              }
                                            : draft,
                                        )
                                      }
                                    />
                                  </div>
                                  <p>
                                    <strong>{personName(resolutionDraft.duplicateId || '')}</strong>{' '}
                                    will be merged into the selected person. Facts, variants, notes,
                                    media, relationships, and their citations are preserved; exact
                                    duplicate facts and links are not copied twice.
                                  </p>
                                  <div className="merge-summary">
                                    <span>
                                      {people.find((p) => p.id === resolutionDraft.duplicateId)
                                        ?.facts.length || 0}{' '}
                                      facts
                                    </span>
                                    <span>
                                      {
                                        relationships.filter(
                                          (r) =>
                                            r.fromId === resolutionDraft.duplicateId ||
                                            r.toId === resolutionDraft.duplicateId,
                                        ).length
                                      }{' '}
                                      relationships
                                    </span>
                                  </div>
                                </div>
                              ) : (
                                <div className="inline-resolution-fields">
                                  <div className="field">
                                    <label>Date</label>
                                    <Input
                                      value={resolutionDraft.dateText || ''}
                                      onChange={(e) =>
                                        setResolutionDraft((draft) =>
                                          draft ? { ...draft, dateText: e.target.value } : draft,
                                        )
                                      }
                                    />
                                  </div>
                                  <div className="field">
                                    <label>Place</label>
                                    <Input
                                      value={resolutionDraft.place || ''}
                                      onChange={(e) =>
                                        setResolutionDraft((draft) =>
                                          draft ? { ...draft, place: e.target.value } : draft,
                                        )
                                      }
                                    />
                                  </div>
                                  <div className="field">
                                    <label>Detail</label>
                                    <Textarea
                                      value={resolutionDraft.detail || ''}
                                      onChange={(e) =>
                                        setResolutionDraft((draft) =>
                                          draft ? { ...draft, detail: e.target.value } : draft,
                                        )
                                      }
                                    />
                                  </div>
                                </div>
                              )}
                            </div>
                          ) : !suggestionLoading && suggestion?.key === selectedIssue.key ? (
                            <div className="manual-review">
                              <strong>Manual review needed</strong>
                              <p>
                                The available evidence does not support a safe change. Compare the
                                records and edit the affected person only when you can support the
                                correction.
                              </p>
                            </div>
                          ) : null}
                          <div className="issue-actions">
                            {selectedIssue.kind === 'birthplace' &&
                              birthplaceDraft &&
                              !selectedIssue.dismissed &&
                              !selectedIssue.reviewed && (
                                <Button
                                  disabled={
                                    busy ||
                                    reviewUpdating ||
                                    !birthplaceDraft.preferredFactId ||
                                    birthplaceDraft.alternatives.length !==
                                      birthplaceFacts.length - 1
                                  }
                                  onClick={() => void applyBirthplaceResolution(selectedIssue)}
                                >
                                  <Check size={16} />
                                  Mark reviewed
                                </Button>
                              )}
                            {resolutionDraft &&
                              !selectedIssue.dismissed &&
                              !selectedIssue.reviewed && (
                                <Button
                                  disabled={
                                    busy ||
                                    reviewUpdating ||
                                    (resolutionDraft.operation === 'merge_people' &&
                                      !mergePlanReady)
                                  }
                                  onClick={() => void applyResolution(selectedIssue)}
                                >
                                  <Check size={16} />
                                  {resolutionDraft.operation === 'merge_people'
                                    ? 'Preview & merge'
                                    : 'Apply edited fix'}
                                </Button>
                              )}
                            {!selectedIssue.dismissed && !selectedIssue.reviewed && (
                              <>
                                <Button
                                  variant="outline"
                                  onClick={() => {
                                    const person = people.find(
                                      (item) => item.id === selectedIssue.personIds[0],
                                    )
                                    if (person) editPerson(person)
                                  }}
                                >
                                  <Pencil size={16} />
                                  Edit person
                                </Button>
                                {selectedIssue.personIds.length > 1 && (
                                  <Button
                                    variant="outline"
                                    onClick={() => {
                                      const person = people.find(
                                        (item) => item.id === selectedIssue.personIds[1],
                                      )
                                      if (person) editPerson(person)
                                    }}
                                  >
                                    <Pencil size={16} />
                                    Edit related person
                                  </Button>
                                )}
                                {selectedIssue.kind === 'connection' && (
                                  <Button
                                    variant="outline"
                                    onClick={() => {
                                      const link = relationships.find(
                                        (item) =>
                                          selectedIssue.personIds.includes(item.fromId) &&
                                          selectedIssue.personIds.includes(item.toId),
                                      )
                                      if (link) {
                                        setRelationDraft({
                                          id: link.id,
                                          fromId: link.fromId,
                                          toId: link.toId,
                                          kind: link.kind,
                                          sourceId: link.sourceId,
                                        })
                                        setDialog('relationship')
                                      }
                                    }}
                                  >
                                    <GitBranch size={16} />
                                    Change relationship
                                  </Button>
                                )}
                                {selectedIssue.kind === 'connection' && (
                                  <Button
                                    variant="ghost"
                                    className="danger-text"
                                    onClick={() => {
                                      const link = relationships.find(
                                        (item) =>
                                          selectedIssue.personIds.includes(item.fromId) &&
                                          selectedIssue.personIds.includes(item.toId),
                                      )
                                      if (
                                        link &&
                                        window.confirm(
                                          'Remove this relationship? This can be undone only by restoring it manually.',
                                        )
                                      )
                                        void run(
                                          () => api.removeRelationship(treeId!, link.id),
                                          'Relationship removed',
                                        )
                                    }}
                                  >
                                    <Trash2 size={16} />
                                    Remove relationship
                                  </Button>
                                )}
                                <Button
                                  variant="outline"
                                  disabled={busy || reviewUpdating}
                                  onClick={() =>
                                    treeId &&
                                    void run(
                                      () =>
                                        api.markIssueReviewed(
                                          treeId,
                                          selectedIssue.key,
                                          selectedIssue.fingerprint,
                                        ),
                                      selectedIssue.kind === 'duplicate'
                                        ? 'Records marked not duplicates'
                                        : 'Review item marked reviewed',
                                    )
                                  }
                                >
                                  {selectedIssue.kind === 'duplicate'
                                    ? 'Mark not duplicates'
                                    : 'Mark reviewed'}
                                </Button>
                                <Button
                                  variant="outline"
                                  disabled={busy || reviewUpdating}
                                  onClick={() =>
                                    treeId &&
                                    void run(
                                      () =>
                                        api.dismissIssue(
                                          treeId,
                                          selectedIssue.key,
                                          selectedIssue.fingerprint,
                                        ),
                                      'Issue dismissed',
                                    )
                                  }
                                >
                                  Dismiss
                                </Button>
                              </>
                            )}
                          </div>
                        </>
                      )}
                    </section>
                  </div>
                ) : reviewUpdating ? (
                  <div className="empty-block compact" role="status">
                    <LoaderCircle size={25} className="spin" />
                    <h3>Checking review items…</h3>
                  </div>
                ) : (
                  <div className="empty-block">
                    <ShieldCheck size={28} />
                    <h3>
                      {issueCategoryFilter === 'all'
                        ? 'Nothing needs review right now'
                        : 'No items in this category'}
                    </h3>
                    <p>
                      {issueCategoryFilter === 'all'
                        ? 'Add people and relationships or import a tree to start checking for possible issues.'
                        : 'Choose another category to continue reviewing your tree.'}
                    </p>
                  </div>
                )}
              </>
            )}
            {page === 'research' && (
              <>
                <div className="page-head">
                  <div>
                    <span className="eyebrow">FOLLOW THE RECORD</span>
                    <h1>Research</h1>
                    <p>Compare public leads. A matching name is a starting point, not proof.</p>
                  </div>
                </div>
                <div className="research-modes" role="group" aria-label="Research mode">
                  <Button
                    variant={researchMode === 'people' ? 'default' : 'outline'}
                    onClick={() => setResearchMode('people')}
                  >
                    Find people
                  </Button>
                  <Button
                    variant={researchMode === 'facts' ? 'default' : 'outline'}
                    onClick={() => setResearchMode('facts')}
                  >
                    Find facts
                  </Button>
                </div>
                {researchMode === 'people' && (
                  <div className="research-layout">
                    <section className="research-form">
                      <h2>Who are you looking for?</h2>
                      <div className="field">
                        <label htmlFor="research-name">Ancestor's name</label>
                        <Input
                          id="research-name"
                          placeholder="e.g. Maria Rossi"
                          value={researchName}
                          onChange={(e) => setResearchName(e.target.value)}
                        />
                      </div>
                      <div className="field-row">
                        <div className="field">
                          <label htmlFor="research-year">Approx. birth year</label>
                          <Input
                            id="research-year"
                            type="number"
                            placeholder="1880"
                            value={researchYear}
                            onChange={(e) => setResearchYear(e.target.value)}
                          />
                        </div>
                        <div className="field">
                          <label htmlFor="research-place">Place</label>
                          <Input
                            id="research-place"
                            placeholder="Town, region, country"
                            value={researchPlace}
                            onChange={(e) => setResearchPlace(e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="field">
                        <label htmlFor="research-relatives">Known relatives</label>
                        <Input
                          id="research-relatives"
                          placeholder="Names of parents, spouse, or children"
                          value={researchRelatives}
                          onChange={(e) => setResearchRelatives(e.target.value)}
                        />
                      </div>
                      <label className="subtle-check living-toggle">
                        <input
                          type="checkbox"
                          checked={livingLeads}
                          onChange={(e) => setLivingLeads(e.target.checked)}
                        />{' '}
                        Include tentative public-profile leads for living people
                      </label>
                      <div className="source-checks">
                        <span className="form-label">SEARCH SOURCES</span>
                        {providers
                          .filter((p) =>
                            ['wikitree', 'wikidata', 'chronicling_america', 'europeana'].includes(
                              p.id,
                            ),
                          )
                          .map((p) => (
                            <label key={p.id}>
                              <input
                                type="checkbox"
                                checked={enabledSources.includes(p.id)}
                                onChange={(e) =>
                                  setEnabledSources((old) =>
                                    e.target.checked
                                      ? [...old, p.id]
                                      : old.filter((id) => id !== p.id),
                                  )
                                }
                              />
                              <span>
                                <strong>{p.name}</strong>
                                <small>
                                  {p.region} · {p.coverage}
                                </small>
                              </span>
                            </label>
                          ))}
                      </div>
                      {enabledSources.includes('europeana') && (
                        <div className="field">
                          <label htmlFor="europeana-key">
                            Europeana API key (this session only)
                          </label>
                          <Input
                            id="europeana-key"
                            type="password"
                            value={europeanaKey}
                            onChange={(e) => setEuropeanaKey(e.target.value)}
                          />
                        </div>
                      )}
                      <Button
                        className="w-full"
                        disabled={
                          researchBusy || busy || !researchName.trim() || !enabledSources.length
                        }
                        onClick={() => void searchResearch()}
                      >
                        {researchBusy ? (
                          <LoaderCircle size={17} className="spin" />
                        ) : (
                          <Search size={17} />
                        )}{' '}
                        Search public sources
                      </Button>
                      <p className="privacy-note">
                        <ShieldCheck size={15} /> Search sends only these query details to the
                        selected sources.
                      </p>
                      <div className="manual-searches">
                        <span className="form-label">MANUAL SOURCE SEARCHES</span>
                        <p>
                          Open one official source at a time. ForeLoom does not read or save results
                          from these sites.
                        </p>
                        {providers
                          .filter((provider) =>
                            [
                              'familysearch',
                              'findagrave',
                              'scotlandspeople',
                              'familysearch_wiki',
                            ].includes(provider.id),
                          )
                          .map((provider) => (
                            <div className="manual-search-row" key={provider.id}>
                              <div>
                                <strong>{provider.name}</strong>
                                <small>
                                  {provider.id === 'familysearch_wiki'
                                    ? 'Uses your place to find research guidance.'
                                    : 'Uses the details shown above in the official search.'}
                                </small>
                              </div>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={
                                  provider.id === 'familysearch_wiki' && !researchPlace.trim()
                                }
                                onClick={() =>
                                  void launchManualSearch(provider.id as ManualSearchProvider)
                                }
                              >
                                Open <ArrowRight size={14} />
                              </Button>
                            </div>
                          ))}
                      </div>
                    </section>
                    <section className="research-results">
                      {research ? (
                        <>
                          <div className="results-head">
                            <div>
                              <span className="eyebrow">RESEARCH LEADS</span>
                              <h2>{research.results.length} results</h2>
                            </div>
                            <span>{research.searchedSources.length} sources searched</span>
                          </div>
                          {research.providerErrors.map((message, i) => (
                            <div className="source-error" key={i}>
                              <CircleAlert size={16} />
                              {message}
                            </div>
                          ))}
                          {research.results.length ? (
                            <div className="result-list">
                              {research.results.map((item, i) => (
                                <article className="result-item" key={item.sourceId + item.id + i}>
                                  <div className="result-top">
                                    <span className="source-pill">
                                      {providers.find((p) => p.id === item.sourceId)?.name ||
                                        item.sourceId}
                                    </span>
                                    <span className="result-kind">
                                      {item.recordType.replace('_', ' ')}
                                    </span>
                                  </div>
                                  <h3>{item.title}</h3>
                                  <p>{item.description}</p>
                                  {item.livingLead && (
                                    <p className="living-warning">
                                      Possible living person · identity and relationship
                                      unconfirmed. No contact details are collected.
                                    </p>
                                  )}
                                  {(item.matchingEvidence.length > 0 ||
                                    item.conflictingEvidence.length > 0 ||
                                    item.unknownEvidence.length > 0) && (
                                    <div className="comparison">
                                      <strong>Comparison</strong>
                                      {item.matchingEvidence.map((e, n) => (
                                        <span key={`m${n}`} className="match">
                                          ✓ {e}
                                        </span>
                                      ))}
                                      {item.conflictingEvidence.map((e, n) => (
                                        <span key={`c${n}`} className="conflict">
                                          ! {e}
                                        </span>
                                      ))}
                                      {item.unknownEvidence.map((e, n) => (
                                        <span key={`u${n}`}>? {e}</span>
                                      ))}
                                    </div>
                                  )}
                                  <div className="result-meta">
                                    {item.date && (
                                      <span>
                                        <Clock3 size={14} />
                                        {item.date}
                                      </span>
                                    )}
                                    {item.place && (
                                      <span>
                                        <Archive size={14} />
                                        {item.place}
                                      </span>
                                    )}
                                  </div>
                                  <div className="result-bottom">
                                    <button
                                      className="source-link"
                                      onClick={() => void api.openExternal(item.url).catch(fail)}
                                    >
                                      Open original <ArrowRight size={14} />
                                    </button>
                                    {['tree_profile', 'knowledge_profile'].includes(
                                      item.recordType,
                                    ) && (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => void promote(item)}
                                      >
                                        Add as unverified <Plus size={14} />
                                      </Button>
                                    )}
                                  </div>
                                  <small className="citation">
                                    {item.sourceCitation} · Accessed {fmtDate(item.accessedAt)} ·{' '}
                                    {item.evidenceClass.replace('_', ' ')}
                                  </small>
                                </article>
                              ))}
                            </div>
                          ) : (
                            <div className="empty-block compact">
                              <Search size={25} />
                              <h3>No matching leads found</h3>
                              <p>
                                Try a name variant, broader date, or another source. Coverage varies
                                by region.
                              </p>
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="research-empty">
                          <BookOpen size={34} />
                          <span className="eyebrow">A RESEARCH WORKSPACE</span>
                          <h2>Start with a question.</h2>
                          <p>
                            Search public profiles and archival collections. Compare each lead with
                            what you already know before adding it to your tree.
                          </p>
                          <div className="research-steps">
                            <span>01&nbsp; Search</span>
                            <ArrowRight size={16} />
                            <span>02&nbsp; Compare</span>
                            <ArrowRight size={16} />
                            <span>03&nbsp; Decide</span>
                          </div>
                        </div>
                      )}
                    </section>
                  </div>
                )}
                <ResearchCapture
                  mode={researchMode}
                  treeId={treeId}
                  people={people}
                  relationships={relationships}
                  model={model}
                  query={{
                    name: researchName,
                    birthYear: researchYear,
                    place: researchPlace,
                    relatives: researchRelatives,
                  }}
                  onSaved={(id) => {
                    void refresh(treeId)
                    setSelectedPersonId(id)
                  }}
                />
              </>
            )}
            {page === 'settings' && (
              <>
                <div className="page-head">
                  <div>
                    <span className="eyebrow">YOUR WORKSPACE</span>
                    <h1>Settings</h1>
                    <p>Manage local data, AI assistance, and research sources.</p>
                  </div>
                </div>
                <div className="settings-grid">
                  <section className="settings-section">
                    <div className="settings-icon">
                      <Archive size={19} />
                    </div>
                    <h2>Tree & recovery</h2>
                    <p>Backups include the tree database, imported GEDCOM, and media you added.</p>
                    <div className="settings-actions">
                      <Button variant="outline" onClick={() => void backup()}>
                        <Archive size={16} /> Create backup
                      </Button>
                      <Button variant="outline" onClick={() => void restore()}>
                        <RotateCcw size={16} /> Restore backup
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => currentTree && openRename(currentTree)}
                      >
                        Rename tree
                      </Button>
                      <Button
                        variant="ghost"
                        className="danger-text"
                        onClick={() => currentTree && openDelete(currentTree)}
                      >
                        {' '}
                        <Trash2 size={15} /> Delete tree
                      </Button>
                    </div>
                  </section>
                  <section className="settings-section">
                    <div className="settings-icon">
                      <Sparkles size={19} />
                    </div>
                    <h2>Local AI</h2>
                    <p>
                      Ollama explains possible issues using a model installed on this computer. It
                      never edits your tree.
                    </p>
                    <div className={`service-status ${ollama?.available ? 'ready' : ''}`}>
                      <span className="local-pulse" />
                      {ollama?.message || 'Checking Ollama…'}
                    </div>
                    {ollama?.models.length ? (
                      <div className="field">
                        <label htmlFor="model">Model for explanations</label>
                        <select id="model" value={model} onChange={(e) => setModel(e.target.value)}>
                          {ollama.models.map((m) => (
                            <option key={m}>{m}</option>
                          ))}
                        </select>
                      </div>
                    ) : (
                      <p className="quiet">
                        Install Ollama and a compatible local model, then refresh this status.
                      </p>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void api.ollamaStatus().then(setOllama).catch(fail)}
                    >
                      Check again
                    </Button>
                  </section>
                  <section className="settings-section wide">
                    <div className="settings-icon">
                      <LibraryBig size={19} />
                    </div>
                    <h2>Source directory</h2>
                    <p>
                      Use link-only sources in your browser; only available sources run in-app
                      searches.
                    </p>
                    <div className="provider-list">
                      {providers.map((provider) => (
                        <div className="provider-row" key={provider.id}>
                          <div>
                            <strong>{provider.name}</strong>
                            <span>
                              {provider.region} · {provider.coverage}
                            </span>
                            <button
                              className="provider-link"
                              onClick={() =>
                                void api.openExternal(provider.documentation).catch(fail)
                              }
                            >
                              Visit source <ArrowRight size={12} />
                            </button>
                          </div>
                          <span className={`provider-status ${provider.status}`}>
                            {provider.status.replaceAll('_', ' ')}
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                  <section className="settings-section wide">
                    <div className="settings-icon">
                      <Clock3 size={19} />
                    </div>
                    <h2>Change history</h2>
                    <p>
                      Every change made in this tree is recorded locally with its action, affected
                      person or context, and time. Approved suggestions can be undone when their
                      changed fields have not been edited since approval.
                    </p>
                    <div className="history-list">
                      {changes.length ? (
                        changes.map((change) => (
                          <div key={change.id}>
                            <span>
                              <strong>{change.summary}</strong>
                              {change.subjects.length ? (
                                <small className="history-subjects">
                                  {change.subjects
                                    .map(
                                      (subject) =>
                                        `${changeSubjectLabel(subject.kind)}: ${subject.label}`,
                                    )
                                    .join(' · ')}
                                </small>
                              ) : (
                                <small className="history-subjects legacy">
                                  Person details were not recorded for this earlier entry.
                                </small>
                              )}
                              <small>{fmtDateTime(change.createdAt)}</small>
                            </span>
                            {change.canUndo && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  treeId &&
                                  void run(
                                    () => api.undoChange(treeId, change.id),
                                    'Suggestion undone',
                                  )
                                }
                              >
                                <RotateCcw size={15} /> Undo
                              </Button>
                            )}
                          </div>
                        ))
                      ) : (
                        <span className="quiet">No changes yet.</span>
                      )}
                    </div>
                  </section>
                </div>
              </>
            )}
          </div>
        )}
      </main>
      {page === 'settings' && treeId && (
        <div className="home-settings-float">
          <section className="settings-section home-settings">
            <div className="settings-icon">
              <Heart size={19} />
            </div>
            <h2>Home person</h2>
            <p>
              {homePersonId
                ? `${people.find((person) => person.id === homePersonId)?.name || 'A selected person'} anchors your tree.`
                : 'Choose the person who should anchor your family tree.'}
            </p>
            <div className="settings-actions">
              <Button
                variant="outline"
                onClick={() => {
                  setDialog('home')
                }}
              >
                <Search size={16} /> {homePersonId ? 'Change Home person' : 'Choose Home person'}
              </Button>
              {homePersonId && (
                <Button
                  variant="ghost"
                  onClick={() => void run(() => api.clearHomePerson(treeId), 'Home person cleared')}
                >
                  Clear Home person
                </Button>
              )}
            </div>
          </section>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast.text}
          {toast.changeId && toast.treeId && (
            <button
              onClick={() =>
                void run(
                  () => api.undoChange(toast.treeId!, toast.changeId!),
                  'Suggestion undone',
                  { treeId: toast.treeId },
                )
              }
            >
              Undo
            </button>
          )}
        </div>
      )}
      <Dialog open={dialog === 'home'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent>
          <DialogTitle className="dialog-title">Choose Home person</DialogTitle>
          <DialogDescription className="dialog-subtitle">
            Search names and aliases, then choose the person who should anchor your tree.
          </DialogDescription>
          <PersonSelector
            label="Find a person"
            people={people}
            value=""
            autoFocus
            onChange={(id) => {
              if (!treeId || !id) return
              setDialog(null)
              void run(() => api.setHomePerson(treeId, id), 'Home person updated', {
                treeId,
                onCommit: () => setSelectedPersonId(id),
              })
            }}
          />
          <div className="dialog-actions">
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={dialog === 'create'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent>
          <DialogTitle className="dialog-title">Create a new tree</DialogTitle>
          <DialogDescription className="dialog-subtitle">
            Give your family archive a name. You can change it later.
          </DialogDescription>
          <div className="field">
            <label htmlFor="tree-name">Tree name</label>
            <Input
              id="tree-name"
              autoFocus
              value={newTreeName}
              onChange={(e) => setNewTreeName(e.target.value)}
              placeholder="The Vale family"
            />
          </div>
          <div className="dialog-actions">
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button disabled={!newTreeName.trim()} onClick={() => void createTree()}>
              Create tree
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={dialog === 'import'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent>
          <DialogTitle className="dialog-title">Import a GEDCOM</DialogTitle>
          <DialogDescription className="dialog-subtitle">
            Use a GEDCOM exported from your own tree. We preserve the original file and report
            details that cannot be imported.
          </DialogDescription>
          <Button variant="outline" disabled={previewing} onClick={() => void chooseGedcom()}>
            {previewing ? <LoaderCircle size={16} className="spin" /> : <FilePlus2 size={16} />}{' '}
            {previewing
              ? 'Checking file…'
              : importPath
                ? 'Choose another file'
                : 'Choose GEDCOM or ZIP'}
          </Button>
          {importPath && <p className="file-path">{importPath}</p>}
          {importPreview && (
            <>
              <div className="import-stats">
                <span>
                  <strong>{importPreview.peopleCount}</strong> people
                </span>
                <span>
                  <strong>{importPreview.relationshipCount}</strong> links
                </span>
                <span>
                  <strong>{importPreview.sourceCount}</strong> sources
                </span>
              </div>
              {importPreview.warnings.length > 0 && (
                <div className="import-warnings">
                  <strong>Import notes</strong>
                  {importPreview.warnings.map((w, i) => (
                    <p key={i}>{w}</p>
                  ))}
                </div>
              )}
              <div className="field">
                <label htmlFor="import-name">New tree name</label>
                <Input
                  id="import-name"
                  value={newTreeName}
                  onChange={(e) => setNewTreeName(e.target.value)}
                />
              </div>
            </>
          )}
          <div className="dialog-actions">
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              disabled={previewing || importing.current || !importPreview || !newTreeName.trim()}
              onClick={() => void startImport(importPath, newTreeName.trim())}
            >
              Import as new tree
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={dialog === 'person'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="person-dialog">
          <DialogTitle className="dialog-title">
            {personDraft.id ? 'Edit person' : 'Add a person'}
          </DialogTitle>
          <DialogDescription className="dialog-subtitle">
            Keep uncertainty visible. Approximate, before, and after dates can be written as they
            appear in your evidence.
          </DialogDescription>
          <div className="field">
            <label htmlFor="person-name">Name</label>
            <Input
              id="person-name"
              autoFocus
              value={personDraft.name}
              onChange={(e) => setPersonDraft((d) => ({ ...d, name: e.target.value }))}
            />
          </div>
          <div className="field">
            <label htmlFor="person-variants">
              Other names <span className="quiet">· comma separated</span>
            </label>
            <Input
              id="person-variants"
              value={variantDraft}
              onChange={(e) => setVariantDraft(e.target.value)}
              placeholder="Maiden name, spelling variants"
            />
          </div>
          <div className="field">
            <label htmlFor="living-status">Living status</label>
            <select
              id="living-status"
              value={personDraft.livingStatus}
              onChange={(e) =>
                setPersonDraft((d) => ({
                  ...d,
                  livingStatus: e.target.value as Person['livingStatus'],
                }))
              }
            >
              <option value="unknown">Unknown</option>
              <option value="deceased">Deceased</option>
              <option value="living">Living</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="person-sex">Sex recorded in source</label>
            <Input
              id="person-sex"
              value={personDraft.sex}
              onChange={(e) => setPersonDraft((d) => ({ ...d, sex: e.target.value }))}
              placeholder="M, F, X, U, or source wording"
            />
          </div>
          <div className="form-divider">
            <span>FACTS & EVENTS</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setPersonDraft((d) => ({
                  ...d,
                  facts: [
                    ...d.facts,
                    { kind: 'other', dateText: '', place: '', detail: '', sourceId: null },
                  ],
                }))
              }
            >
              <Plus size={14} /> Add fact
            </Button>
          </div>
          {personDraft.facts.map((fact, i) => (
            <div className="fact-editor" key={fact.id || i}>
              <div className="fact-editor-head">
                <select
                  aria-label={`Fact ${i + 1} type`}
                  value={fact.kind}
                  onChange={(e) => updateFact(i, 'kind', e.target.value)}
                >
                  {eventKinds.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind[0].toUpperCase() + kind.slice(1)}
                    </option>
                  ))}
                </select>
                <button
                  aria-label={`Remove fact ${i + 1}`}
                  onClick={() =>
                    setPersonDraft((d) => ({ ...d, facts: d.facts.filter((_, n) => n !== i) }))
                  }
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <div className="field-row">
                <Input
                  aria-label={`Fact ${i + 1} date`}
                  placeholder="Date: exact, about, before…"
                  value={fact.dateText}
                  onChange={(e) => updateFact(i, 'dateText', e.target.value)}
                />
                <Input
                  aria-label={`Fact ${i + 1} place`}
                  placeholder="Place"
                  value={fact.place}
                  onChange={(e) => updateFact(i, 'place', e.target.value)}
                />
              </div>
              <Input
                aria-label={`Fact ${i + 1} detail`}
                placeholder="Details or uncertainty"
                value={fact.detail}
                onChange={(e) => updateFact(i, 'detail', e.target.value)}
              />
              <select
                aria-label={`Fact ${i + 1} source`}
                value={fact.sourceId || ''}
                onChange={(e) => updateFact(i, 'sourceId', e.target.value || null)}
              >
                <option value="">No cited source yet</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <div className="field">
            <label htmlFor="person-notes">Research notes</label>
            <Textarea
              id="person-notes"
              value={personDraft.notes}
              onChange={(e) => setPersonDraft((d) => ({ ...d, notes: e.target.value }))}
            />
          </div>
          <div className="dialog-actions">
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button disabled={busy || !personDraft.name.trim()} onClick={() => void storePerson()}>
              Save person
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={dialog === 'relationship'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent>
          <DialogTitle className="dialog-title">
            {relationDraft.id ? 'Correct relationship' : 'Connect two people'}
          </DialogTitle>
          <DialogDescription className="dialog-subtitle">
            Choose the relationship as it is supported by your evidence.
          </DialogDescription>
          <PersonSelector
            label="First person"
            people={people}
            value={relationDraft.fromId}
            onChange={(id) => setRelationDraft((d) => ({ ...d, fromId: id }))}
          />
          <div className="field">
            <label htmlFor="relation-kind">Relationship</label>
            <select
              id="relation-kind"
              value={relationDraft.kind}
              onChange={(e) =>
                setRelationDraft((d) => ({ ...d, kind: e.target.value as typeof d.kind }))
              }
            >
              {Object.entries(relationLabels).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <PersonSelector
            label={`Second person ${relationDraft.kind.endsWith('_parent') ? '(child)' : ''}`}
            people={people.filter((p) => p.id !== relationDraft.fromId)}
            value={relationDraft.toId}
            onChange={(id) => setRelationDraft((d) => ({ ...d, toId: id }))}
          />
          <div className="field">
            <label htmlFor="relation-source">Supporting source</label>
            <select
              id="relation-source"
              value={relationDraft.sourceId || ''}
              onChange={(e) =>
                setRelationDraft((d) => ({ ...d, sourceId: e.target.value || null }))
              }
            >
              <option value="">No cited source yet</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.title}
                </option>
              ))}
            </select>
          </div>
          <div className="dialog-actions">
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy || !relationDraft.toId || relationDraft.fromId === relationDraft.toId}
              onClick={() => void addRelationship()}
            >
              {relationDraft.id ? 'Save relationship' : 'Add relationship'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={dialog === 'branch'}
        onOpenChange={(open) => {
          if (!open) {
            branchRequest.current += 1
            setDialog(null)
          }
        }}
      >
        <DialogContent>
          <DialogTitle className="dialog-title">Connect separate branches</DialogTitle>
          <DialogDescription className="dialog-subtitle">
            Explore recorded clues, then add a relationship only when your records support it.
          </DialogDescription>
          {branchDraft && (
            <>
              <section className="branch-leads" aria-label="Possible connections">
                <div className="branch-leads-head">
                  <strong>Possible connections</strong>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      !ollama?.available || !model || !branchLeads.length || branchAi.loading
                    }
                    onClick={() => void findBranchConnections()}
                  >
                    <Sparkles size={14} />
                    Find with local AI
                  </Button>
                </div>
                {!ollama?.available || !model ? (
                  <p className="quiet">
                    Start Ollama and select a model in Settings for local AI review.
                  </p>
                ) : null}
                {branchAi.loading && (
                  <p role="status" className="quiet">
                    <LoaderCircle size={14} className="spin" /> Reviewing recorded clues…
                  </p>
                )}
                {branchAi.error && (
                  <p role="alert" className="branch-ai-error">
                    Local AI could not assess these leads: {branchAi.error}
                  </p>
                )}
                {branchAi.searched &&
                  !branchAi.loading &&
                  !branchAi.error &&
                  !branchAi.results.length && (
                    <p className="quiet">Local AI found no useful connection in these clues.</p>
                  )}
                {branchAi.results.map((item) => (
                  <div className="branch-lead" key={`${item.fromId}-${item.toId}`}>
                    <strong>
                      {people.find((person) => person.id === item.fromId)?.name} ↔{' '}
                      {people.find((person) => person.id === item.toId)?.name}
                    </strong>
                    <p>{item.explanation}</p>
                    <small>{item.limitations}</small>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setBranchDraft((draft) =>
                          draft
                            ? { ...draft, fromId: item.fromId, toId: item.toId, kind: '' }
                            : draft,
                        )
                      }
                    >
                      Review this pair
                    </Button>
                  </div>
                ))}
                {!branchLeads.length ? (
                  <p className="quiet">
                    No strong clues in the saved records. You can still choose two people below.
                  </p>
                ) : (
                  branchLeads.slice(0, 5).map((item) => (
                    <div className="branch-lead" key={`${item.fromId}-${item.toId}`}>
                      <strong>
                        {item.fromName} ↔ {item.toName}
                      </strong>
                      <small>{item.clues.join(' · ')}</small>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setBranchDraft((draft) =>
                            draft
                              ? { ...draft, fromId: item.fromId, toId: item.toId, kind: '' }
                              : draft,
                          )
                        }
                      >
                        Review this pair
                      </Button>
                    </div>
                  ))
                )}
              </section>
              <PersonSelector
                label="Person in this branch"
                people={branchDraft.group.members}
                value={branchDraft.fromId}
                onChange={(id) =>
                  setBranchDraft((draft) => (draft ? { ...draft, fromId: id } : draft))
                }
              />
              <PersonSelector
                label="Connect to a person outside this branch"
                people={people.filter((person) => !branchDraft.group.memberIds.includes(person.id))}
                value={branchDraft.toId}
                onChange={(id) =>
                  setBranchDraft((draft) => (draft ? { ...draft, toId: id } : draft))
                }
              />
              <div className="field">
                <label htmlFor="branch-kind">Documented relationship</label>
                <select
                  id="branch-kind"
                  value={branchDraft.kind}
                  onChange={(e) =>
                    setBranchDraft((draft) => (draft ? { ...draft, kind: e.target.value } : draft))
                  }
                >
                  <option value="">Choose relationship type</option>
                  {Object.entries(relationLabels).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="branch-source">
                  Supporting source <span className="quiet">optional</span>
                </label>
                <select
                  id="branch-source"
                  value={branchDraft.sourceId || ''}
                  onChange={(e) =>
                    setBranchDraft((draft) =>
                      draft ? { ...draft, sourceId: e.target.value || null } : draft,
                    )
                  }
                >
                  <option value="">No cited source yet</option>
                  {sources.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.title}
                    </option>
                  ))}
                </select>
              </div>
              <div className="dialog-actions">
                <Button
                  variant="outline"
                  onClick={() => {
                    branchRequest.current += 1
                    setDialog(null)
                  }}
                >
                  Cancel
                </Button>
                <Button
                  disabled={busy || !branchDraft.toId || !branchDraft.kind}
                  onClick={() => {
                    const draft = branchDraft
                    branchRequest.current += 1
                    setDialog(null)
                    void run(
                      () =>
                        api.addRelationship(
                          treeId!,
                          draft.fromId,
                          draft.toId,
                          draft.kind,
                          draft.sourceId,
                        ),
                      'Branches connected',
                      { treeId },
                    )
                  }}
                >
                  <GitBranch size={15} />
                  Add documented relationship
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={dialog === 'source'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent>
          <DialogTitle className="dialog-title">Add a source</DialogTitle>
          <DialogDescription className="dialog-subtitle">
            A source can be cited by any fact or relationship in this tree.
          </DialogDescription>
          {(['title', 'url', 'citation', 'notes'] as const).map((key) => (
            <div className="field" key={key}>
              <label htmlFor={`source-${key}`}>{key[0].toUpperCase() + key.slice(1)}</label>
              <Input
                id={`source-${key}`}
                value={sourceDraft[key]}
                onChange={(e) => setSourceDraft((d) => ({ ...d, [key]: e.target.value }))}
              />
            </div>
          ))}
          <div className="dialog-actions">
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button disabled={busy || !sourceDraft.title.trim()} onClick={() => void addSource()}>
              Save source
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={dialog === 'rename'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent>
          <DialogTitle className="dialog-title">Rename tree</DialogTitle>
          <DialogDescription className="dialog-subtitle">
            Change the name of {actionTree?.name}.
          </DialogDescription>
          <div className="field">
            <label htmlFor="rename-tree">Tree name</label>
            <Input
              id="rename-tree"
              autoFocus
              value={newTreeName}
              onChange={(e) => setNewTreeName(e.target.value)}
            />
          </div>
          <div className="dialog-actions">
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              disabled={
                actionBusy || !newTreeName.trim() || newTreeName.trim() === actionTree?.name
              }
              onClick={() => void renameTree()}
            >
              Rename
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={dialog === 'delete'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent>
          <DialogTitle className="dialog-title">Delete {actionTree?.name}?</DialogTitle>
          <DialogDescription className="dialog-subtitle">
            This permanently removes this tree and its app-managed media from this computer. Backups
            you created elsewhere remain separate.
          </DialogDescription>
          <div className="dialog-actions">
            <Button variant="outline" onClick={() => setDialog(null)}>
              Keep tree
            </Button>
            <Button
              variant="destructive"
              disabled={actionBusy || !actionTree}
              onClick={() => void deleteTree()}
            >
              Delete tree
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function DuplicateComparison({
  people,
  relationships,
  sources,
  personIds,
  mergePlan,
  onPlanChange,
  onPlanValidityChange,
  onEdit,
}: {
  people: Person[]
  relationships: Relationship[]
  sources: Source[]
  personIds: string[]
  mergePlan?: MergePlan
  onPlanChange: (plan: MergePlan) => void
  onPlanValidityChange: (valid: boolean) => void
  onEdit: (person: Person) => void
}) {
  const records = personIds
    .map((id) => people.find((person) => person.id === id))
    .filter((person): person is Person => Boolean(person))
    .slice(0, 2)
  if (records.length !== 2) return null
  const relationList = (person: Person) =>
    relationships
      .filter((relation) => relation.fromId === person.id || relation.toId === person.id)
      .map((relation) => {
        const other = people.find(
          (candidate) =>
            candidate.id === (relation.fromId === person.id ? relation.toId : relation.fromId),
        )
        return `${relationLabels[relation.kind] || relation.kind}: ${other?.name || 'Unknown person'}`
      })
  const sourcesFor = (person: Person) =>
    [...new Set(person.facts.map((fact) => fact.sourceId).filter(Boolean))].map(
      (id) =>
        sources.find((source) => source.id === id)?.citation ||
        sources.find((source) => source.id === id)?.title ||
        'Untitled source',
    )
  const facts = (person: Person, kind: string) =>
    person.facts
      .filter((fact) => fact.kind === kind)
      .map(
        (fact) => factLine(kind, fact.dateText, fact.place) || 'Recorded without a date or place',
      )
  const rows: {
    key: string
    label: string
    left: string[]
    right: string[]
    leftBirth?: string
  }[] = [
    {
      key: 'name',
      label: 'Names',
      left: [records[0].name, ...records[0].variants],
      right: [records[1].name, ...records[1].variants],
    },
    {
      key: 'birth',
      label: 'Birth',
      left: facts(records[0], 'birth'),
      right: facts(records[1], 'birth'),
      leftBirth: records[0].facts.find((fact) => fact.kind === 'birth')?.id,
    },
    {
      key: 'death',
      label: 'Death',
      left: facts(records[0], 'death'),
      right: facts(records[1], 'death'),
    },
    {
      key: 'relationships',
      label: 'Parents, spouses, children & siblings',
      left: relationList(records[0]),
      right: relationList(records[1]),
    },
    {
      key: 'sources',
      label: 'Sources & citations',
      left: sourcesFor(records[0]),
      right: sourcesFor(records[1]),
    },
    {
      key: 'notes',
      label: 'Research notes',
      left: records[0].notes ? [decodeHtmlEntities(records[0].notes)] : [],
      right: records[1].notes ? [decodeHtmlEntities(records[1].notes)] : [],
    },
  ]
  const status = (left: string[], right: string[]) =>
    !left.length && !right.length
      ? 'same'
      : !left.length
        ? 'only-right'
        : !right.length
          ? 'only-left'
          : left.join('|').toLowerCase() === right.join('|').toLowerCase()
            ? 'same'
            : 'conflict'
  const conflicts = rows.filter((row) => status(row.left, row.right) === 'conflict')
  useEffect(() => {
    onPlanValidityChange(
      Boolean(mergePlan) && conflicts.every((row) => Boolean(mergePlan?.decisions[row.key])),
    )
  }, [mergePlan, conflicts.map((row) => row.key).join('|')])
  const choose = (row: (typeof rows)[number], choice: 'left' | 'right' | 'both') => {
    if (!mergePlan) return
    const primaryName =
      row.key === 'name'
        ? choice === 'right'
          ? records[1].name
          : records[0].name
        : mergePlan.primaryName
    const birthFact =
      row.key === 'birth' && choice !== 'both'
        ? choice === 'right'
          ? records[1].facts.find((fact) => fact.kind === 'birth')?.id || null
          : row.leftBirth || null
        : mergePlan.preferredBirthFactId
    onPlanChange({
      ...mergePlan,
      primaryName,
      preferredBirthFactId: birthFact,
      decisions: { ...mergePlan.decisions, [row.key]: choice },
    })
  }
  return (
    <section className="duplicate-comparison" aria-label="Duplicate record comparison">
      <div className="comparison-head">
        <div>
          <span className="eyebrow">STEP 1 · RESOLVE DIFFERENCES</span>
          <h3>Compare records before merging</h3>
        </div>
        <p>
          Matching evidence is collapsed. Resolve conflicts deliberately; every cited value remains
          preserved.
        </p>
      </div>
      <div className="comparison-columns">
        <article>
          <strong>{records[0].name}</strong>
          <Button variant="ghost" size="sm" onClick={() => onEdit(records[0])}>
            <Pencil size={14} /> Edit
          </Button>
        </article>
        <article>
          <strong>{records[1].name}</strong>
          <Button variant="ghost" size="sm" onClick={() => onEdit(records[1])}>
            <Pencil size={14} /> Edit
          </Button>
        </article>
      </div>
      {rows
        .filter((row) => status(row.left, row.right) !== 'same')
        .map((row) => {
          const rowStatus = status(row.left, row.right)
          return (
            <div className={`comparison-row ${rowStatus}`} key={row.key}>
              <span>
                {row.label}
                <small>
                  {rowStatus === 'conflict'
                    ? 'Conflict — choose a primary treatment'
                    : rowStatus === 'only-left'
                      ? 'Recorded only on left'
                      : 'Recorded only on right'}
                </small>
              </span>
              <div>
                {row.left.length ? (
                  row.left.map((value, index) => <p key={index}>{value}</p>)
                ) : (
                  <em>Not recorded</em>
                )}
              </div>
              <div>
                {row.right.length ? (
                  row.right.map((value, index) => <p key={index}>{value}</p>)
                ) : (
                  <em>Not recorded</em>
                )}
              </div>
              {rowStatus === 'conflict' && mergePlan && (
                <div className="merge-choices" role="group" aria-label={`Resolve ${row.label}`}>
                  <button
                    className={mergePlan.decisions[row.key] === 'left' ? 'selected' : ''}
                    onClick={() => choose(row, 'left')}
                  >
                    Use left
                  </button>
                  <button
                    className={mergePlan.decisions[row.key] === 'right' ? 'selected' : ''}
                    onClick={() => choose(row, 'right')}
                  >
                    Use right
                  </button>
                  <button
                    className={mergePlan.decisions[row.key] === 'both' ? 'selected' : ''}
                    onClick={() => choose(row, 'both')}
                  >
                    Keep both
                  </button>
                </div>
              )}
            </div>
          )
        })}
      {!mergePlan && (
        <p className="manual-review">
          This possible match needs more evidence before it can be merged. You can still compare
          both records, edit them, or mark them not duplicates.
        </p>
      )}
      <details className="matching-records">
        <summary>
          Show {rows.filter((row) => status(row.left, row.right) === 'same').length} matching
          section
          {rows.filter((row) => status(row.left, row.right) === 'same').length === 1 ? '' : 's'}
        </summary>
        {rows
          .filter((row) => status(row.left, row.right) === 'same')
          .map((row) => (
            <p key={row.key}>
              <strong>{row.label}:</strong> {row.left.join(' · ') || 'No recorded value'}
            </p>
          ))}
      </details>
      {mergePlan && (
        <div className="merge-impact">
          <strong>Step 2 · Merge preview</strong>
          <span>Primary name: {mergePlan.primaryName || 'Choose a name'}</span>
          <span>
            {mergePlan.preferredBirthFactId
              ? 'A preferred birth fact will be displayed.'
              : 'All birth facts will remain alternatives.'}
          </span>
          <span>Facts, citations, notes, media, and non-conflicting links are retained.</span>
        </div>
      )}
      <p className="comparison-safety">
        “Keep both” retains both cited values as separate evidence. A merge is reversible from
        Change history until a later tree change.
      </p>
    </section>
  )
}

function CleanupDashboard({
  records,
  groups,
  showIntentionalGroups,
  filter,
  selectedIds,
  dependencies,
  onFilter,
  onToggleIntentionalGroups,
  onReviewGroup,
  onKeepGroup,
  onReopenGroup,
  onSelect,
  onSelectAll,
  onEdit,
  onConnect,
  onFindDuplicates,
  onMarkIntentional,
  onPreviewDelete,
  onCancelDelete,
  onDelete,
}: {
  records: CleanupRecord[]
  groups: DisconnectedGroup[]
  showIntentionalGroups: boolean
  filter: 'all' | CleanupCategory
  selectedIds: string[]
  dependencies: CleanupDependency[] | null
  onFilter: (filter: 'all' | CleanupCategory) => void
  onToggleIntentionalGroups: () => void
  onReviewGroup: (group: DisconnectedGroup) => void
  onKeepGroup: (group: DisconnectedGroup) => void
  onReopenGroup: (group: DisconnectedGroup) => void
  onSelect: (id: string) => void
  onSelectAll: (ids: string[]) => void
  onEdit: (person: Person) => void
  onConnect: (person: Person) => void
  onFindDuplicates: (person: Person) => void
  onMarkIntentional: (person: Person) => void
  onPreviewDelete: () => void
  onCancelDelete: () => void
  onDelete: () => void
}) {
  const labels: Record<'all' | CleanupCategory, string> = {
    all: 'All suggestions',
    unknown: 'Named ?',
    missingName: 'Missing name',
    isolated: 'No relationships',
    minimal: 'Minimal information',
  }
  const visibleRecords = records.slice(0, 200)
  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">REVIEW BEFORE REMOVING</span>
          <h1>Data cleanup</h1>
          <p>
            Prioritize incomplete records without treating disconnected families or unknown names as
            errors by default.
          </p>
        </div>
      </div>
      <div className="cleanup-controls">
        <div>
          {(Object.keys(labels) as Array<'all' | CleanupCategory>).map((key) => (
            <button
              key={key}
              className={filter === key ? 'selected' : ''}
              onClick={() => onFilter(key)}
            >
              {labels[key]}
            </button>
          ))}
        </div>
        {visibleRecords.length > 0 && (
          <label className="subtle-check">
            <input
              type="checkbox"
              checked={visibleRecords.every((record) => selectedIds.includes(record.person.id))}
              onChange={() => onSelectAll(visibleRecords.map((record) => record.person.id))}
            />{' '}
            Select shown
          </label>
        )}
      </div>
      {groups.filter((group) => !group.acknowledged).length > 0 && (
        <section className="branch-review">
          <span className="eyebrow">SEPARATE FAMILY BRANCHES</span>
          <h2>Review only if you expected a connection</h2>
          <p>
            These people are connected to each other, but not to anyone else in this tree. That is
            common in imported or incomplete records.
          </p>
          {groups
            .filter((group) => !group.acknowledged)
            .map((group) => (
              <article className="branch-card" key={group.fingerprint}>
                <div>
                  <strong>{group.members.length} people in this branch</strong>
                  <span>
                    {group.members
                      .slice(0, 5)
                      .map((person) => person.name || 'Unnamed person')
                      .join(' · ')}
                    {group.members.length > 5 ? ` +${group.members.length - 5} more` : ''}
                  </span>
                </div>
                <div>
                  <Button size="sm" onClick={() => onReviewGroup(group)}>
                    <GitBranch size={14} />
                    Review & connect
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => onKeepGroup(group)}>
                    Keep separate
                  </Button>
                </div>
              </article>
            ))}
        </section>
      )}
      {groups.some((group) => group.acknowledged) && (
        <section className="intentional-branches">
          <button onClick={onToggleIntentionalGroups}>
            {showIntentionalGroups ? 'Hide' : 'Show'}{' '}
            {groups.filter((group) => group.acknowledged).length} intentional separate branch
            {groups.filter((group) => group.acknowledged).length === 1 ? '' : 'es'}
          </button>
          {showIntentionalGroups &&
            groups
              .filter((group) => group.acknowledged)
              .map((group) => (
                <div key={group.fingerprint}>
                  <span>
                    {group.members.length} people ·{' '}
                    {group.members
                      .slice(0, 3)
                      .map((person) => person.name)
                      .join(' · ')}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => onReopenGroup(group)}>
                    Resume review
                  </Button>
                </div>
              ))}
        </section>
      )}
      {dependencies ? (
        <section className="cleanup-preview">
          <h2>Deletion dependency preview</h2>
          <p>
            Deleting removes the selected people and their recorded facts and relationships.
            Attached files remain in your local media folder for safety.
          </p>
          {dependencies.map((item) => (
            <p key={item.personId}>
              <strong>{item.name}</strong> · {item.relationships} relationships · {item.facts} facts
              · {item.attachments} attachments
            </p>
          ))}
          <div className="issue-actions">
            <Button variant="outline" onClick={onCancelDelete}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={onDelete}>
              <Trash2 size={15} />
              Delete after review
            </Button>
          </div>
        </section>
      ) : null}
      <div className="cleanup-list">
        {visibleRecords.map((record) => (
          <article className="cleanup-row" key={record.person.id}>
            <label>
              <input
                type="checkbox"
                checked={selectedIds.includes(record.person.id)}
                onChange={() => onSelect(record.person.id)}
              />
            </label>
            <div>
              <h2>
                {record.person.name || 'Unnamed person'}{' '}
                {record.intentional && <span className="intentional-tag">Intentional unknown</span>}
              </h2>
              <p>{record.evidence}</p>
              <div className="cleanup-tags">
                {record.categories.map((category) => (
                  <span key={category}>{labels[category]}</span>
                ))}
              </div>
              <small>
                Deterministic evidence: {record.person.facts.length} facts,{' '}
                {record.person.variants.length} alternate names.
              </small>
            </div>
            <div className="cleanup-actions">
              <Button variant="outline" size="sm" onClick={() => onEdit(record.person)}>
                <Pencil size={14} />
                Edit
              </Button>
              <Button variant="outline" size="sm" onClick={() => onConnect(record.person)}>
                <GitBranch size={14} />
                Connect
              </Button>
              <Button variant="outline" size="sm" onClick={() => onFindDuplicates(record.person)}>
                <Search size={14} />
                Find duplicates
              </Button>
              {record.person.name === '?' && (
                <Button variant="ghost" size="sm" onClick={() => onMarkIntentional(record.person)}>
                  {record.intentional ? 'Resume cleanup' : 'Mark intentional'}
                </Button>
              )}
            </div>
          </article>
        ))}
        {records.length > 200 && (
          <p className="quiet px-4 py-5">
            Showing the first 200 suggestions. Choose a category to narrow the list.
          </p>
        )}
        {!records.length && (
          <div className="empty-block">
            <Check size={28} />
            <h3>No matching cleanup suggestions</h3>
            <p>Try another category. Clean records remain untouched.</p>
          </div>
        )}
      </div>
      {selectedIds.length > 0 && !dependencies && (
        <div className="cleanup-bulk">
          <span>{selectedIds.length} selected</span>
          <Button variant="outline" onClick={onPreviewDelete}>
            <Trash2 size={15} />
            Preview deletion
          </Button>
        </div>
      )}
    </>
  )
}

function TreeLoading({
  treeName,
  error,
  onRetry,
  onChooseAnother,
}: {
  treeName?: string
  error?: string
  onRetry: () => void
  onChooseAnother: () => void
}) {
  return (
    <div className="content">
      <section className="tree-loading" role="status" aria-live="polite">
        <LoaderCircle size={28} className={error ? '' : 'spin'} />
        <span className="eyebrow">LOCAL FAMILY ARCHIVE</span>
        <h1>{error ? 'That tree could not open' : 'Opening your family tree'}</h1>
        <p>
          {error ||
            (treeName
              ? `Loading ${treeName} locally. You can still change trees or use the navigation.`
              : 'Loading people and relationships locally. You can still change trees or use the navigation.')}
        </p>
        <div className="flex gap-3 mt-7">
          {error && <Button onClick={onRetry}>Try again</Button>}
          <Button variant="outline" onClick={onChooseAnother}>
            {error ? 'Return to your trees' : 'Choose another tree'}
          </Button>
        </div>
      </section>
    </div>
  )
}

function BirthCountryChart({
  treeId,
  personIds,
  treeDataVersion,
  relationshipLabel,
  splitUnitedKingdom = false,
}: {
  treeId: string
  personIds: string[]
  treeDataVersion: number
  relationshipLabel: string
  splitUnitedKingdom?: boolean
}) {
  const [distribution, setDistribution] = useState<ReturnType<
    typeof descendantCountryDistribution
  > | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    if (!personIds.length) {
      setDistribution(
        descendantCountryDistribution([], {
          places: [],
          countries: [],
          unresolved: [],
          mappedPeopleCount: 0,
          totalPeopleCount: 0,
        }),
      )
      setLoading(false)
      setError('')
      return
    }
    setLoading(true)
    setError('')
    setDistribution(null)
    void api
      .getPlaceMap(treeId, { eventKinds: ['birth'], personIds })
      .then((map) => {
        if (!cancelled)
          setDistribution(descendantCountryDistribution(personIds, map, { splitUnitedKingdom }))
      })
      .catch((reason) => {
        if (!cancelled)
          setError(
            reason instanceof Error ? reason.message : 'Birth countries could not be loaded.',
          )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [personIds, splitUnitedKingdom, treeDataVersion, treeId])
  if (loading)
    return (
      <div className="descendant-country-loading" role="status">
        <LoaderCircle size={16} className="spin" />
        Loading {relationshipLabel} birth countries…
      </div>
    )
  if (error) return <p className="descendant-country-message">{error}</p>
  if (!distribution?.total)
    return (
      <p className="descendant-country-message">
        No direct {relationshipLabel} are linked to this person yet.
      </p>
    )
  const palette = ['#b45f3d', '#b78b39', '#668c55', '#3e7d73', '#4e6f9b', '#725886', '#a16a86']
  const circumference = 2 * Math.PI * 42
  let offset = 0
  return (
    <div className="descendant-country-chart">
      <div className="country-donut-wrap">
        <svg
          viewBox="0 0 120 120"
          role="img"
          aria-label={`Birth countries for ${distribution.total} direct ${relationshipLabel}`}
        >
          <circle className="country-donut-track" cx="60" cy="60" r="42" />
          {distribution.slices.map((slice, index) => {
            const length = slice.fraction * circumference
            const currentOffset = offset
            offset += length
            return (
              <circle
                key={slice.key}
                className="country-donut-slice"
                cx="60"
                cy="60"
                r="42"
                pathLength="1"
                stroke={slice.unmapped ? '#c8c8bb' : palette[index % palette.length]}
                strokeDasharray={`${slice.fraction} ${1 - slice.fraction}`}
                strokeDashoffset={-currentOffset / circumference}
                transform="rotate(-90 60 60)"
              >
                <title>
                  {slice.label}: {slice.count} {relationshipLabel}
                  {slice.count === 1 ? '' : 's'} ({Math.round(slice.fraction * 100)}%)
                </title>
              </circle>
            )
          })}
        </svg>
        <div>
          <strong>{distribution.mapped}</strong>
          <span>
            of {distribution.total}
            <br />
            mapped
          </span>
        </div>
      </div>
      <div className="country-chart-legend">
        {distribution.slices.map((slice, index) => (
          <div key={slice.key}>
            <i
              style={{ background: slice.unmapped ? '#c8c8bb' : palette[index % palette.length] }}
            />
            <span>{slice.label}</span>
            <strong>
              {slice.count} · {Math.round(slice.fraction * 100)}%
            </strong>
          </div>
        ))}
      </div>
    </div>
  )
}

function DescendantCountryChart({
  treeId,
  rootId,
  relationships,
  treeDataVersion,
}: {
  treeId: string
  rootId: string
  relationships: Relationship[]
  treeDataVersion: number
}) {
  const personIds = useMemo(
    () => [...directDescendants(rootId, relationships).keys()],
    [relationships, rootId],
  )
  return (
    <BirthCountryChart
      treeId={treeId}
      personIds={personIds}
      treeDataVersion={treeDataVersion}
      relationshipLabel="descendant"
    />
  )
}

function AncestorCountryChart({
  treeId,
  rootId,
  relationships,
  treeDataVersion,
}: {
  treeId: string
  rootId: string
  relationships: Relationship[]
  treeDataVersion: number
}) {
  const personIds = useMemo(
    () => [...directAncestors(rootId, relationships).keys()],
    [relationships, rootId],
  )
  return (
    <BirthCountryChart
      treeId={treeId}
      personIds={personIds}
      treeDataVersion={treeDataVersion}
      relationshipLabel="ancestor"
      splitUnitedKingdom
    />
  )
}

function PersonProfile({
  treeId,
  treeDataVersion,
  person,
  relationships,
  sources,
  personName,
  onEdit,
  onAddRelation,
  onAddSource,
  onAttach,
  onRemoveRelation,
}: {
  treeId: string
  treeDataVersion: number
  person: Person
  relationships: Relationship[]
  sources: Source[]
  personName: (id: string) => string
  onEdit: () => void
  onAddRelation: () => void
  onAddSource: () => void
  onAttach: () => void
  onRemoveRelation: (id: string) => void
}) {
  const [attachments, setAttachments] = useState<Awaited<ReturnType<typeof api.listAttachments>>>(
    [],
  )
  const [detail, setDetail] = useState<Person | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setDetail(null)
    setAttachments([])
    void Promise.all([api.getPerson(treeId, person.id), api.listAttachments(treeId, person.id)])
      .then(([next, nextAttachments]) => {
        if (!cancelled) {
          setDetail(next)
          setAttachments(nextAttachments)
        }
      })
      .catch(() => {
        if (!cancelled) setDetail(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [treeId, person.id, treeDataVersion])
  const record = detail || person
  return (
    <>
      <div className="profile-head">
        <div>
          <span className="eyebrow">PERSON PROFILE</span>
          <h2>{record.name}</h2>
          <span className="person-status">
            {record.livingStatus === 'unknown' ? 'Living status unknown' : record.livingStatus}
          </span>
          {record.sex && <span className="person-status">GEDCOM sex: {record.sex}</span>}
        </div>
        <Button variant="outline" size="sm" onClick={onEdit}>
          Edit person
        </Button>
      </div>
      {loading ? (
        <p className="quiet" role="status">
          Loading full record…
        </p>
      ) : (
        <>
          {record.variants.length > 0 && (
            <div className="profile-variants">Also known as {record.variants.join(', ')}</div>
          )}
          <div className="profile-section">
            <div className="profile-section-head">
              <h3>Life & events</h3>
              <button onClick={onEdit}>
                <Plus size={15} /> Add fact
              </button>
            </div>
            {record.facts.length ? (
              <div className="timeline">
                {record.facts.map((f) => (
                  <div className="timeline-item" key={f.id || `${f.kind}-${f.dateText}`}>
                    <span className="timeline-mark" />
                    <div>
                      <strong>{factLine(f.kind, f.dateText, f.place)}</strong>
                      {f.detail && <p>{f.detail}</p>}
                      <small>
                        {f.sourceId
                          ? sources.find((s) => s.id === f.sourceId)?.title || 'Cited source'
                          : f.provenance === 'gedcom'
                            ? 'Imported from GEDCOM · no citation'
                            : 'User-entered · no citation'}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="quiet">
                No facts recorded. Add a date or event when you have evidence.
              </p>
            )}
          </div>
          <div className="profile-section">
            <div className="profile-section-head">
              <h3>Relationships</h3>
              <button onClick={onAddRelation}>
                <Plus size={15} /> Connect person
              </button>
            </div>
            {relationships
              .filter((r) => r.fromId === record.id || r.toId === record.id)
              .map((r) => (
                <div className="relation-line" key={r.id}>
                  <Heart size={15} />
                  <span>
                    {r.fromId === record.id
                      ? r.kind.endsWith('_parent')
                        ? `Parent of ${personName(r.toId)}`
                        : `${relationLabels[r.kind]} of ${personName(r.toId)}`
                      : r.kind.endsWith('_parent')
                        ? `Child of ${personName(r.fromId)}`
                        : `${relationLabels[r.kind]} of ${personName(r.fromId)}`}
                  </span>
                  <button onClick={() => onRemoveRelation(r.id)} aria-label="Remove relationship">
                    <X size={14} />
                  </button>
                </div>
              ))}
            {!relationships.some((r) => r.fromId === record.id || r.toId === record.id) && (
              <p className="quiet">No relationships recorded.</p>
            )}
          </div>
          <div className="profile-section">
            <div className="profile-section-head">
              <h3>Descendant birth countries</h3>
            </div>
            <DescendantCountryChart
              treeId={treeId}
              rootId={record.id}
              relationships={relationships}
              treeDataVersion={treeDataVersion}
            />
          </div>
          <div className="profile-section">
            <div className="profile-section-head">
              <h3>Ancestor birth countries</h3>
            </div>
            <AncestorCountryChart
              treeId={treeId}
              rootId={record.id}
              relationships={relationships}
              treeDataVersion={treeDataVersion}
            />
          </div>
          <div className="profile-section">
            <div className="profile-section-head">
              <h3>Notes & sources</h3>
              <button onClick={onAddSource}>
                <Plus size={15} /> Add source
              </button>
            </div>
            {record.notes ? (
              <p className="notes-text">{decodeHtmlEntities(record.notes)}</p>
            ) : (
              <p className="quiet">Research notes will appear here.</p>
            )}
            {sources.length > 0 && (
              <div className="source-summary">
                {sources.length} source{sources.length === 1 ? '' : 's'} in this tree
              </div>
            )}
          </div>
          <div className="profile-section">
            <div className="profile-section-head">
              <h3>Media</h3>
              <button onClick={onAttach}>
                <Plus size={15} /> Attach file
              </button>
            </div>
            {attachments.length ? (
              attachments.map((a) => (
                <div className="attachment-line" key={a.id}>
                  <FileText size={16} />
                  {a.name}
                </div>
              ))
            ) : (
              <p className="quiet">
                Attach a local photo or document. Its original file stays untouched.
              </p>
            )}
          </div>
        </>
      )}
    </>
  )
}

export default App
