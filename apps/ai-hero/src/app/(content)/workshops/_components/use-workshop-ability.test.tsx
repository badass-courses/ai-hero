// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { defineRulesForPurchases } from '@/ability'
import { cohortAbilityFixture } from '@/ability/test-fixtures/cohort-content-scope'
import { api } from '@/trpc/react'
import { createQueryClient } from '@/trpc/query-client'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { observable } from '@trpc/server/observable'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LessonAbilitySeed, LessonAbilitySeedProvider } from './lesson-ability-seed'
import { useWorkshopAbility } from './use-workshop-ability'
import { WorkshopResourceList } from './workshop-resource-list'
import { WorkshopSaleGate } from './workshop-sale-gate'
import type { ResourceListViewProps } from '../../_components/resource-list-view'

const state = vi.hoisted(() => ({
	userId: '' as string | null,
	segments: ['opening'],
}))

vi.mock('next-auth/react', () => ({
	useSession: () => state.userId
		? { data: { user: { id: state.userId } }, status: 'authenticated' }
		: { data: null, status: 'unauthenticated' },
}))
vi.mock('next/navigation', () => ({
	useParams: () => ({ module: 'workshop-slug', lesson: state.segments[0] }),
	usePathname: () => `/workshops/workshop-slug/${state.segments.join('/')}`,
	useSelectedLayoutSegments: () => state.segments,
}))
vi.mock('./workshop-navigation-provider', () => ({
	useWorkshopNavigation: () => ({ id: 'requested-workshop', type: 'workshop', fields: { slug: 'workshop-slug' } }),
}))
vi.mock('./cohort-navigation-provider', () => ({ useCohortNavigation: () => null }))
vi.mock('@/app/(content)/_components/module-progress-provider', () => ({
	useModuleProgress: () => ({ moduleProgress: null }),
}))
vi.mock('../../_components/resource-list-view', () => ({
	ResourceListView: ({ ability, abilityStatus }: ResourceListViewProps) => (
		<div data-list="">{`${abilityStatus}:${Boolean(ability?.can('manage', 'all'))}`}</div>
	),
}))

function Controls() {
	const { status, canViewWorkshop, canCreate } = useWorkshopAbility()
	return <div data-controls="">{`${status}:${canViewWorkshop}:${canCreate}`}</div>
}

const input = { moduleId: 'workshop-slug', lessonId: 'opening' }
type Viewer = ComponentProps<typeof LessonAbilitySeed>['viewer']
const viewer = { id: 'buyer', rules: [{ action: 'manage', subject: 'all' }] } satisfies Viewer
const request = vi.fn<[path: string, input: unknown], void>()
let root: Root
let host: HTMLDivElement
let queryClient: QueryClient

beforeEach(() => {
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
	state.userId = 'buyer'
	state.segments = ['opening']
	request.mockReset()
	host = document.createElement('div')
	document.body.append(host)
	root = createRoot(host)
	queryClient = createQueryClient()
})

afterEach(async () => {
	await act(async () => root.unmount())
	queryClient.clear()
	host.remove()
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

function lessonView() {
	const client = api.createClient({
		links: [() => ({ op }) => observable((observer) => {
			request(op.path, op.input)
			observer.next({ result: { data: [] } })
			observer.complete()
		})],
	})
	return async (seed: Viewer | undefined) => {
		await act(async () => root.render(
			<QueryClientProvider client={queryClient}>
				<api.Provider client={client} queryClient={queryClient}>
					<LessonAbilitySeedProvider>
						<WorkshopResourceList />
						<Controls />
						<WorkshopSaleGate>Buy workshop</WorkshopSaleGate>
						{seed !== undefined && (
							<LessonAbilitySeed
								moduleId={input.moduleId}
								lessonId={state.segments[0]!}
								viewer={seed}
							/>
						)}
					</LessonAbilitySeedProvider>
				</api.Provider>
			</QueryClientProvider>,
		))
	}
}

const controls = () => host.querySelector('[data-controls]')?.textContent
const list = () => host.querySelector('[data-list]')?.textContent

describe('lesson ability queries', () => {
	it('waits for the page seed, then serves both consumers without a request', async () => {
		const render = lessonView()
		await render(undefined)
		expect(list()).toBe('pending:false')
		await render(viewer)

		expect(controls()).toBe('success:true:true')
		expect(list()).toBe('success:true')
		expect(request).not.toHaveBeenCalled()
	})

	it('waits for a streamed seed after navigating to the next lesson', async () => {
		vi.useFakeTimers()
		const render = lessonView()
		await render(viewer)
		expect(list()).toBe('success:true')
		await act(async () => vi.advanceTimersByTimeAsync(150_000))
		state.segments = ['second']
		await render(undefined)
		await act(async () => vi.advanceTimersByTimeAsync(300))

		expect(request).not.toHaveBeenCalled()
		expect(list()).toBe('pending:false')
		await render({ id: viewer.id, rules: [] })

		expect(list()).toBe('success:false')
		expect(request).not.toHaveBeenCalled()
	})

	it.each([150_000, 300_001])('does not refetch a seeded lesson on focus after %i ms', async (elapsed) => {
		vi.useFakeTimers()
		await lessonView()(viewer)
		expect(list()).toBe('success:true')
		await act(async () => vi.advanceTimersByTimeAsync(elapsed))

		await act(async () => {
			window.dispatchEvent(new Event('focus'))
			// TanStack Query observes document visibility, not the focus event.
			window.dispatchEvent(new Event('visibilitychange'))
		})

		expect(request).not.toHaveBeenCalled()
		expect(list()).toBe('success:true')
	})

	it('reuses the seeded query on return within the controls freshness window', async () => {
		vi.useFakeTimers()
		const render = lessonView()
		await render(viewer)
		await act(async () => vi.advanceTimersByTimeAsync(150_000))
		state.segments = ['second']
		await render({ id: viewer.id, rules: [] })
		expect(list()).toBe('success:false')

		state.segments = ['opening']
		await render(undefined)
		await act(async () => vi.advanceTimersByTimeAsync(300))
		expect(request).not.toHaveBeenCalled()
		await render(viewer)

		expect(request).not.toHaveBeenCalled()
		expect(list()).toBe('success:true')
	})

	it('shows the buy state to a signed-in viewer when a locked lesson supplies no seed', async () => {
		vi.useFakeTimers()
		state.userId = 'non-buyer'
		await lessonView()(undefined)
		expect(controls()).toBe('pending:false:false')
		expect(host.textContent).not.toContain('Buy workshop')

		await act(async () => vi.advanceTimersByTimeAsync(2_500))
		await act(async () => vi.advanceTimersByTimeAsync(1))

		expect(request.mock.calls).toEqual([['ability.getCurrentAbilityRules', input]])
		expect(host.textContent).toContain('Buy workshop')
		expect(controls()).toBe('success:false:false')
		expect(list()).toBe('success:false')
	})

	it('does not grant workshop access from a free lesson and an unrelated entitlement', async () => {
		const fixture = cohortAbilityFixture({ free: true, contentIds: ['other-workshop'] })
		state.userId = fixture.user.id
		await lessonView()({ id: fixture.user.id, rules: defineRulesForPurchases(fixture.input) })

		expect(controls()).toBe('success:false:false')
		expect(host.textContent).toContain('Buy workshop')
		expect(request).not.toHaveBeenCalled()
	})

	it('keeps queries disabled for anonymous viewers', async () => {
		state.userId = null
		await lessonView()(null)

		expect(controls()).toBe('success:false:false')
		expect(list()).toBe('success:false')
		expect(request).not.toHaveBeenCalled()
	})

	it('does not reuse the server seed or the old query when the user changes', async () => {
		const render = lessonView()
		await render(viewer)
		state.userId = 'non-buyer'
		await render(viewer)

		expect(controls()).not.toContain('true')
		expect(list()).not.toContain('true')
		expect(request.mock.calls).toEqual([['ability.getCurrentAbilityRules', input]])
	})

	it('keeps unseeded subroutes on their original inputs', async () => {
		state.segments = ['opening', 'solution']
		await lessonView()(undefined)

		expect(request.mock.calls).toEqual([
			['ability.getCurrentAbilityRules', { moduleId: 'requested-workshop', lessonId: 'opening' }],
			['ability.getCurrentAbilityRules', { moduleId: 'requested-workshop', lessonId: undefined }],
		])
	})
})
