// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
	resources: [] as any[],
	parents: {} as Record<string, any>,
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ prefetch: vi.fn() }) }))
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null }) }))
vi.mock('@/env.mjs', () => ({ env: {} }))
vi.mock('../../_components/use-set-lesson-completed', () => ({
	useSetLessonCompleted: () => vi.fn(),
}))
vi.mock('@/lib/content-navigation', () => ({
	flattenNavigationResources: () => mocks.resources,
	findParentLessonForSolution: (_navigation: unknown, id: string) =>
		mocks.parents[id] ?? null,
}))
vi.mock('./workshop-navigation-provider', () => ({
	useWorkshopNavigation: () => ({
		id: 'workshop',
		fields: { slug: 'workshop' },
		resources: [],
	}),
}))
vi.mock('../../_components/module-progress-provider', () => ({
	useModuleProgress: () => ({
		moduleProgress: { completedLessons: [] },
		addLessonProgress: vi.fn(),
		removeLessonProgress: vi.fn(),
	}),
}))
vi.mock('./workshop-complete-card', () => ({
	WorkshopCompleteCard: () => <p>Workshop complete</p>,
}))
import UpNext from './up-next'
const lesson = (id: string, optional = false) => ({
	id,
	type: 'lesson',
	fields: { slug: id, title: id, optional },
})
beforeEach(() => {
	mocks.parents = {}
	;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
})
async function renderNext(currentResourceId: string) {
	const host = document.createElement('div')
	document.body.append(host)
	const root = createRoot(host)
	await act(async () =>
		root.render(
			<React.Suspense>
				<UpNext
					currentResourceId={currentResourceId}
					abilityLoader={Promise.resolve({ canViewLesson: true } as any)}
				/>
			</React.Suspense>,
		),
	)
	const markup = host.innerHTML
	await act(async () => root.unmount())
	host.remove()
	return markup
}
describe('required Up Next sequence', () => {
	it('skips optional lessons and their solutions, without removing them from navigation', async () => {
		const faq = lesson('faq', true)
		mocks.resources = [
			lesson('current'),
			faq,
			{
				id: 'faq-solution',
				type: 'solution',
				fields: { slug: 'faq-solution' },
			},
			lesson('next-required'),
		]
		mocks.parents['faq-solution'] = faq
		const markup = await renderNext('current')
		expect(markup).toContain('/workshops/workshop/next-required')
		expect(markup).not.toContain('href="/workshops/workshop/faq')
		expect(mocks.resources).toHaveLength(4)
	})
	it('offers workshop completion after the last required lesson even if optional FAQ follows', async () => {
		mocks.resources = [lesson('last-required'), lesson('faq', true)]
		expect(await renderNext('last-required')).toContain('Workshop complete')
	})
	it('continues normally when reading an optional lesson directly', async () => {
		mocks.resources = [lesson('faq', true), lesson('next-required')]
		expect(await renderNext('faq')).toContain(
			'/workshops/workshop/next-required',
		)
	})
})
