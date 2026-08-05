import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
	CohortNavigation,
	CohortWorkshopNav,
} from '@/lib/cohort-navigation'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ResourceListViewProps } from '../../_components/resource-list-view'

const mocks = vi.hoisted(() => ({
	cohortNavigation: null as CohortNavigation | null,
	captured: null as ResourceListViewProps | null,
}))

vi.mock('next/navigation', () => ({
	useParams: () => ({ module: 'claude-code~p9j8f' }),
	usePathname: () => '/workshops/claude-code~p9j8f/permissions~pwt8r',
}))

vi.mock('@/trpc/react', () => ({
	api: {
		ability: {
			getCurrentAbilityRules: {
				useQuery: () => ({ data: [], status: 'success' }),
			},
		},
	},
}))

vi.mock('./cohort-navigation-provider', () => ({
	useCohortNavigation: () => mocks.cohortNavigation,
}))

vi.mock(
	'@/app/(content)/workshops/_components/workshop-navigation-provider',
	() => ({
		useWorkshopNavigation: () => ({
			id: 'workshop-p9j8f',
			fields: { slug: 'claude-code~p9j8f', title: 'Getting To Know Claude Code' },
			resources: [],
			isSidebarCollapsed: false,
			setIsSidebarCollapsed: () => {},
		}),
	}),
)

vi.mock('@/app/(content)/_components/module-progress-provider', () => ({
	useModuleProgress: () => ({ moduleProgress: null }),
}))

// The rendering of these props is covered by `resource-list-view.test.tsx`;
// here we only care what this component decides to pass down.
vi.mock('../../_components/resource-list-view', () => ({
	ResourceListView: (props: ResourceListViewProps) => {
		mocks.captured = props
		return null
	},
}))

import { WorkshopResourceList } from './workshop-resource-list'

function workshop(
	overrides: Partial<CohortWorkshopNav> & { id: string },
): CohortWorkshopNav {
	return {
		slug: `${overrides.id}-slug`,
		title: `Workshop ${overrides.id}`,
		position: 0,
		state: 'published',
		startsAt: null,
		timezone: 'America/Los_Angeles',
		firstLesson: { slug: 'first-lesson', title: 'First Lesson' },
		...overrides,
	}
}

function cohortWithNext(
	nextOverrides: Partial<CohortWorkshopNav> = {},
): CohortNavigation {
	return {
		id: 'cohort-m0k0w',
		slug: 'ai-coding-for-real-engineers',
		title: 'AI Coding for Real Engineers',
		workshops: [
			workshop({ id: 'workshop-ubuuc' }),
			workshop({ id: 'workshop-p9j8f' }),
			workshop({
				id: 'workshop-bfkce',
				title: 'Day 1 Fundamentals',
				slug: 'fundamentals~bfkce',
				firstLesson: {
					slug: 'llm-constraints~z2y87',
					title: 'The Constraints Of LLMs',
				},
				...nextOverrides,
			}),
		],
	}
}

// Annotated because the reset narrows `captured` to `null` for the compiler —
// it cannot see that rendering assigns it.
function renderList(): ResourceListViewProps | null {
	mocks.captured = null
	renderToStaticMarkup(<WorkshopResourceList />)
	return mocks.captured
}

describe('WorkshopResourceList cohort context', () => {
	beforeEach(() => {
		mocks.cohortNavigation = cohortWithNext()
	})

	it('labels the workshop with its place in the cohort', () => {
		expect(renderList()?.positionLabel).toBe('Workshop 2 of 3')
	})

	it('points the next workshop at its first lesson', () => {
		expect(renderList()?.nextModule).toEqual({
			title: 'Day 1 Fundamentals',
			href: '/workshops/fundamentals~bfkce/llm-constraints~z2y87',
			locked: false,
			unlocksAt: null,
		})
	})

	it('locks an unreleased next workshop and points at its overview', () => {
		mocks.cohortNavigation = cohortWithNext({
			startsAt: '2099-06-01T07:01:00.000Z',
		})

		expect(renderList()?.nextModule).toMatchObject({
			href: '/workshops/fundamentals~bfkce',
			locked: true,
			unlocksAt: 'June 1, 2099',
		})
	})

	it('points at the overview when the next workshop has no lessons yet', () => {
		mocks.cohortNavigation = cohortWithNext({ firstLesson: null })

		expect(renderList()?.nextModule).toMatchObject({
			href: '/workshops/fundamentals~bfkce',
			locked: false,
		})
	})

	it('leaves both off for a workshop sold on its own', () => {
		mocks.cohortNavigation = null
		const props = renderList()

		expect(props?.positionLabel).toBeUndefined()
		expect(props?.nextModule).toBeUndefined()
	})

	it('leaves the next module off at the last workshop in the cohort', () => {
		mocks.cohortNavigation = {
			...cohortWithNext(),
			workshops: [workshop({ id: 'workshop-p9j8f' })],
		}

		expect(renderList()?.nextModule).toBeUndefined()
		expect(renderList()?.positionLabel).toBe('Workshop 1 of 1')
	})
})
