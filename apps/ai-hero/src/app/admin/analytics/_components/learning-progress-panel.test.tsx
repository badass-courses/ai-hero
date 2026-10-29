import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { expectedLearningProgress } from '@/lib/analytics/learning-progress.fixtures'
import type { LearningProgress } from '@/lib/analytics/learning-progress'

const mocks = vi.hoisted(() => ({ useQuery: vi.fn() }))
vi.mock('@tanstack/react-query', () => ({ useQuery: mocks.useQuery }))
import { LearningProgressPanel, shareOf } from './learning-progress-panel'

const products = [
	{ id: 'product-a', name: 'Cohort A', type: 'cohort' },
	{ id: 'product-b', name: 'Course B', type: 'self-paced' },
]
const data = expectedLearningProgress as LearningProgress

describe('learner progress admin panel', () => {
	it('shows N of M against signed-in learners', () => {
		expect(shareOf(1, 4)).toEqual({ label: '1 of 4', percent: 25 })
		expect(shareOf(0, 0)).toEqual({ label: '0 of 0', percent: null })
	})

	it('renders roster, activity and the funnel with its denominator', () => {
		mocks.useQuery.mockReturnValue({ data })
		const html = renderToStaticMarkup(
			<LearningProgressPanel products={products} />,
		)
		expect(html).toContain('Never signed in')
		expect(html).toContain('Open team seats')
		expect(html).toContain('Lessons done 7d')
		expect(html).toContain('out of 4 signed-in')
		expect(html).toContain('without the earlier')
		expect(html).toContain('Before We Start')
		expect(html).toContain('2 of 4 · 50%')
		expect(mocks.useQuery.mock.calls.at(-1)?.[0].queryKey).toEqual([
			'analytics',
			'learning/progress',
			'product-a',
		])
	})

	it('marks locked workshops locked instead of showing 0%', () => {
		mocks.useQuery.mockReturnValue({ data })
		const html = renderToStaticMarkup(
			<LearningProgressPanel products={products} />,
		)
		expect(html).toContain('Locked · draft')
		expect(html).toContain('Locked · opens Nov 20')
		expect(html).toContain('Not open to learners yet.')
		expect(html).not.toContain('0 of 4 · 0%')
	})

	it('never renders learner identifiers', () => {
		mocks.useQuery.mockReturnValue({ data })
		const html = renderToStaticMarkup(
			<LearningProgressPanel products={products} />,
		)
		expect(html).not.toMatch(/u-complete|@example|userId/)
	})

	it('uses neutral loading and unavailable states, not zero', () => {
		mocks.useQuery.mockReturnValue({ isPending: true })
		expect(
			renderToStaticMarkup(<LearningProgressPanel products={products} />),
		).toContain('Loading learner progress…')
		mocks.useQuery.mockReturnValue({ isError: true })
		const html = renderToStaticMarkup(
			<LearningProgressPanel products={products} />,
		)
		expect(html).toContain('temporarily unavailable')
		expect(html).not.toContain('0 of')
	})

	it('does not query without products', () => {
		mocks.useQuery.mockReturnValue({ isPending: true })
		const html = renderToStaticMarkup(<LearningProgressPanel products={[]} />)
		expect(html).toContain('No course or cohort products')
		expect(mocks.useQuery.mock.calls.at(-1)?.[0].enabled).toBe(false)
	})

	it('forwards the cancellation signal and picked product', async () => {
		mocks.useQuery.mockReturnValue({ isPending: true })
		renderToStaticMarkup(<LearningProgressPanel products={products} />)
		const fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ ok: true, data }),
		})
		vi.stubGlobal('fetch', fetch)
		try {
			const signal = new AbortController().signal
			await mocks.useQuery.mock.calls.at(-1)?.[0].queryFn({ signal })
			expect(fetch).toHaveBeenCalledWith(
				'/api/analytics?surface=learning%2Fprogress&productId=product-a',
				{ signal, cache: 'no-store' },
			)
		} finally {
			vi.unstubAllGlobals()
		}
	})
})
