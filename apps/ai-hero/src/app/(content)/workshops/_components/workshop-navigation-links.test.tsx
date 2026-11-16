// @vitest-environment happy-dom
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	navigation: null as any,
	progress: null as any,
}))
vi.mock('./workshop-navigation-provider', () => ({
	useWorkshopNavigation: () => mocks.navigation,
}))
vi.mock('@/app/(content)/_components/module-progress-provider', () => ({
	useModuleProgress: () => ({ moduleProgress: mocks.progress }),
}))
vi.mock('./use-workshop-ability', () => ({
	useWorkshopAbility: () => ({ canViewWorkshop: true, status: 'success' }),
}))
vi.mock('next-auth/react', () => ({
	useSession: () => ({ status: 'authenticated' }),
}))
vi.mock('next/navigation', () => ({
	useParams: () => ({ module: 'parent', lesson: 'opening' }),
	usePathname: () => '/workshops/parent/opening',
}))
vi.mock('@/trpc/react', () => ({
	api: {
		ability: {
			getCurrentAbilityRules: {
				useQuery: () => ({
					data: [{ action: 'read', subject: 'all' }],
					status: 'success',
				}),
			},
		},
	},
}))
vi.mock('./cohort-navigation-provider', () => ({
	useCohortNavigation: () => null,
}))
vi.mock('@/components/contributor', () => ({ Contributor: () => null }))
vi.mock('@/components/share', () => ({ Share: () => null }))
vi.mock('@/components/certificates/module-certificate', () => ({
	Root: () => null,
	Trigger: () => null,
}))
vi.mock('../../_components/module-certificate-container', () => ({
	CertificateDialog: () => null,
}))
vi.mock('./workshop-pricing', () => ({ WorkshopInlineBuyButton: () => null }))
vi.mock('../../_components/resource-list-view', async (importOriginal) => {
	const actual = await importOriginal<any>()
	return {
		...actual,
		ResourceListView: (props: any) => (
			<actual.ResourceListView {...props} showAutoplay={false} />
		),
	}
})

import WorkshopImage from './workshop-image'
import { WorkshopSidebarMobile } from './workshop-sidebar'
import { StartLearningWorkshopButton } from './workshop-user-actions'
import {
	getWorkshopListResources,
	WorkshopResourceList,
} from './workshop-resource-list'

const node = (id: string, type: string, children: any[] = []) => ({
	id,
	type,
	fields: { slug: id, title: id },
	resources: children.map((resource) => ({ resource })),
})
const lesson = node('opening', 'lesson')
const child = node('child', 'workshop', [node('child-lesson', 'lesson')])
const nested = node('nested', 'section', [lesson, child])
const section = node('concepts', 'section', [
	nested,
	node('unknown', 'future-type'),
])

beforeEach(() => {
	mocks.navigation = {
		...node('parent', 'workshop', [section, node('top-child', 'workshop')]),
		isSidebarCollapsed: false,
		setIsSidebarCollapsed: () => {},
	}
	mocks.progress = {
		completedLessons: [{ resourceId: 'previous' }],
		nextResource: lesson,
	}
})

const controls = () => [
	<StartLearningWorkshopButton
		moduleSlug="parent"
		workshop={mocks.navigation}
	/>,
	<WorkshopImage imageUrl="https://example.test/cover.png" />,
	<WorkshopSidebarMobile workshop={mocks.navigation} purchased />,
]

describe('workshop start and resume links', () => {
	it.each([
		['lesson', lesson, '/workshops/parent/opening'],
		['section', section, '/workshops/parent/opening'],
		['child workshop', child, '/workshops/child'],
		[
			'foreign resource',
			node('foreign', 'lesson'),
			'/workshops/parent/opening',
		],
		[
			'unknown type',
			node('unknown', 'future-type'),
			'/workshops/parent/opening',
		],
	] as const)(
		'resolves a %s across every start/resume control',
		(_, target, expected) => {
			mocks.progress.nextResource = target
			for (const control of controls()) {
				const html = renderToStaticMarkup(control)
				expect(html).toContain(`href="${expected}"`)
				expect(html).not.toContain('/undefined')
				expect(html).not.toContain('/null')
			}
		},
	)

	it('starts fresh at a typed destination and leaves empty curricula unlinked', () => {
		mocks.progress.completedLessons = []
		for (const control of controls())
			expect(renderToStaticMarkup(control)).toContain(
				'href="/workshops/parent/opening"',
			)
		mocks.navigation.resources = [{ resource: node('unknown', 'future-type') }]
		for (const control of controls())
			expect(renderToStaticMarkup(control)).not.toContain('href=')
	})
})

describe('mixed workshop resource list', () => {
	it('renders nested sections without section links, and child workshops without a false parent', () => {
		const html = renderToStaticMarkup(<WorkshopResourceList />)
		expect(html).toContain('href="/workshops/parent/opening"')
		expect(html).toContain('href="/workshops/child"')
		expect(html).toContain('href="/workshops/top-child"')
		const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1])
		const realRoutes = new Set([
			'/workshops/parent',
			'/workshops/parent/opening',
			'/workshops/child',
			'/workshops/top-child',
			'/posts?type=workshop',
		])
		for (const href of hrefs) expect(realRoutes.has(href!)).toBe(true)
	})

	it('never passes nested sections or unknown resources to the lesson-row renderer', () => {
		const { resources, hrefs } = getWorkshopListResources(mocks.navigation)
		expect(
			resources[0]?.resource.resources?.map(({ resource }) => resource.id),
		).toEqual(['opening', 'child'])
		expect(hrefs.has('nested')).toBe(false)
		expect(hrefs.has('unknown')).toBe(false)
	})
})
