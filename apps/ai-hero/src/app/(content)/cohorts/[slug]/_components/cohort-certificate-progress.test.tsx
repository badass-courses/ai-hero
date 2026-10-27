import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../_components/cohort-certificate-container', () => ({
	Certificate: (props: Record<string, unknown>) => (
		<div data-tile={JSON.stringify(props)} />
	),
}))

import {
	CohortCertificateProgress,
	cohortLessonCount,
} from './cohort-certificate-progress'

const progress = (completedLessonsCount: number, totalLessonsCount: number) =>
	({ completedLessonsCount, totalLessonsCount }) as never

describe('cohortLessonCount', () => {
	it('sums lessons across the workshops', () => {
		expect(
			cohortLessonCount([progress(8, 9), progress(0, 12), progress(3, 3)]),
		).toEqual({ completedCount: 11, totalCount: 24 })
	})

	it('gives no count when a workshop did not answer', () => {
		expect(cohortLessonCount([progress(8, 9), null])).toEqual({})
		expect(cohortLessonCount(null)).toEqual({})
	})

	it('gives no count when there are no lessons to count', () => {
		expect(cohortLessonCount([])).toEqual({})
		expect(cohortLessonCount([progress(0, 0)])).toEqual({})
	})
})

describe('CohortCertificateProgress', () => {
	const render = async (workshops: Promise<unknown>[]) =>
		renderToStaticMarkup(
			await CohortCertificateProgress({
				workshopProgressMap: new Map(
					workshops.map((workshop, index) => [`workshop-${index}`, workshop]),
				) as never,
				resourceSlugOrId: 'cohort',
				isCompleted: false,
			}),
		).replaceAll('&quot;', '"')

	it('hands the tile the cohort-wide count', async () => {
		const html = await render([
			Promise.resolve(progress(8, 9)),
			Promise.resolve(progress(1, 12)),
		])
		expect(html).toContain('"completedCount":9')
		expect(html).toContain('"totalCount":21')
		expect(html).toContain('"isCompleted":false')
	})

	it('still shows the tile, uncounted, when a progress read fails', async () => {
		const html = await render([
			Promise.resolve(progress(8, 9)),
			Promise.reject(new Error('progress read failed')),
		])
		expect(html).toContain('"resourceSlugOrId":"cohort"')
		expect(html).not.toContain('completedCount')
	})
})
