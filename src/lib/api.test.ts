import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  Channel: class<T> { onmessage?: (message: T) => void },
}))

import { api } from './api'

describe('GEDCOM import API', () => {
  beforeEach(() => invokeMock.mockReset())

  it('forwards native progress while keeping the import promise pending', async () => {
    let complete: ((treeId: string) => void) | undefined
    invokeMock.mockImplementation((command, args) => {
      if (command !== 'import_gedcom') return Promise.resolve()
      args.onProgress.onmessage({ phase: 'people', completed: 100, total: 200 })
      return new Promise<string>(resolve => { complete = resolve })
    })
    const onProgress = vi.fn()
    const importPromise = api.importGedcom('/family.ged', 'Family', onProgress)

    expect(invokeMock).toHaveBeenCalledWith('import_gedcom', expect.objectContaining({ path: '/family.ged', name: 'Family' }))
    expect(onProgress).toHaveBeenCalledWith({ phase: 'people', completed: 100, total: 200 })
    complete?.('tree-123')
    await expect(importPromise).resolves.toBe('tree-123')
  })

  it('derives people from legacy history summaries when native data has no subjects', async () => {
    invokeMock.mockResolvedValueOnce([
      { id: 'change-1', createdAt: '2026-01-01T00:00:00Z', summary: 'Edited person: Ada Lovelace', kind: 'manual', canUndo: false },
      { id: 'change-2', createdAt: '2026-01-01T00:01:00Z', summary: 'Added relationship: Ada Lovelace — spouse — William King', kind: 'manual', canUndo: false },
    ])

    const changes = await api.listChanges('tree-1')

    expect(changes[0].subjects).toEqual([{ kind: 'person', id: null, label: 'Ada Lovelace' }])
    expect(changes[1].subjects.map(subject => subject.label)).toEqual(['Ada Lovelace', 'William King'])
  })

  it('marks a review item without changing the underlying records', async () => {
    invokeMock.mockResolvedValueOnce(undefined)

    await api.markIssueReviewed('tree-1', 'parent_age:link-1', 'revision:1')

    expect(invokeMock).toHaveBeenCalledWith('mark_issue_reviewed', {
      treeId: 'tree-1', key: 'parent_age:link-1', fingerprint: 'revision:1',
    })
  })

  it('loads the interactive tree core with one native request', async () => {
    const core = { people: [], relationships: [], homePersonId: null }
    invokeMock.mockResolvedValueOnce(core)

    await expect(api.loadTreeCore('tree-1')).resolves.toEqual(core)

    expect(invokeMock).toHaveBeenCalledWith('load_tree_core', { treeId: 'tree-1' })
  })

  it('sends a fact-scoped place approval without changing the recorded fact', async () => {
    invokeMock.mockResolvedValueOnce(undefined)
    const input = { factId: 'fact-1', status: 'approved' as const, gazetteerId: 'locality:edinburgh', label: 'Edinburgh, Scotland, United Kingdom', locality: 'Edinburgh', county: '', region: 'Scotland', country: 'United Kingdom', countryCode: 'GB', latitude: 55.95, longitude: -3.19, source: 'offline', confidence: 'high', rationale: 'Exact offline match' }

    await api.savePlaceResolution('tree-1', input)

    expect(invokeMock).toHaveBeenCalledWith('save_place_resolution', { treeId: 'tree-1', input })
  })

  it('requires an explicit native AI action with the minimum place context', async () => {
    invokeMock.mockResolvedValueOnce([])
    await api.findLikelyPlacesWithAi({ rawPlace: 'Springfield', eventType: 'birth', eventYear: 1890, geographicContext: 'Illinois', familyContext: 'Related to Ada', model: 'local-model' })
    expect(invokeMock).toHaveBeenCalledWith('find_likely_places_with_ai', { request: { rawPlace: 'Springfield', eventType: 'birth', eventYear: 1890, geographicContext: 'Illinois', familyContext: 'Related to Ada', model: 'local-model' } })
  })

  it('sends only shortlisted branch clues for local AI review', async () => {
    invokeMock.mockResolvedValueOnce([])
    const candidates = [{ fromId: 'a', toId: 'b', fromName: 'Ada', toName: 'Beth', clues: ['Shared place'] }]
    await api.findBranchConnectionsWithAi('tree-1', candidates, 'local-model')
    expect(invokeMock).toHaveBeenCalledWith('find_branch_connections_with_ai', { treeId: 'tree-1', candidates, model: 'local-model' })
  })
})
