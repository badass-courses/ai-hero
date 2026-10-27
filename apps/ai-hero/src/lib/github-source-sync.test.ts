import { describe, expect, it, vi } from 'vitest'

vi.mock('@/db', () => ({ db: {}, courseBuilderAdapter: {} }))
vi.mock('@/db/schema', () => ({ contentResource: {} }))
vi.mock('@/lib/typesense-query', () => ({ upsertPostToTypeSense: vi.fn() }))
vi.mock('@/server/logger', () => ({ log: { info: vi.fn(), error: vi.fn() } }))
vi.mock('next/cache', () => ({ revalidateTag: vi.fn() }))

import { selectSyncTargets } from './github-source-sync'

const post = (githubSource: string) => ({ fields: { githubSource } })
const skillReadme = post(
	'https://github.com/mattpocock/skills/blob/main/README.md',
)
const skillFile = post(
	'https://github.com/mattpocock/skills/blob/main/skills/grill-me/SKILL.md',
)

describe('selectSyncTargets', () => {
	it('syncs nothing from another repo that shares the webhook', () => {
		// A Sandcastle README push: same path as the skills README, other repo.
		expect(
			selectSyncTargets([skillReadme, skillFile], {
				changedPaths: ['README.md'],
				repositoryFullName: 'mattpocock/sandcastle',
			}),
		).toEqual([])
	})

	it('syncs the changed file of the pushed repo', () => {
		expect(
			selectSyncTargets([skillReadme, skillFile], {
				changedPaths: ['README.md'],
				repositoryFullName: 'MattPocock/Skills',
			}),
		).toEqual([skillReadme])
	})

	it('syncs everything when the cron asks with no scope', () => {
		expect(selectSyncTargets([skillReadme, skillFile], {})).toEqual([
			skillReadme,
			skillFile,
		])
	})
})
