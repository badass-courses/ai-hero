import { describe, expect, it } from 'vitest'

import {
	getWorkshopAvailability,
	type WorkshopAvailability,
} from '../get-workshop-availability'

function makeWorkshop(
	title: string,
	slug: string,
	startsAt: string | null | undefined,
	position: number,
) {
	return {
		resource: {
			id: `workshop-${slug}`,
			type: 'workshop',
			fields: { title, slug, startsAt: startsAt ?? undefined },
		},
		position,
	} as any
}

describe('getWorkshopAvailability', () => {
	it('splits workshops into available now and upcoming', () => {
		const now = new Date('2026-03-30T12:00:00.000Z')
		const workshops = [
			makeWorkshop('Before We Start', 'before-we-start', null, 0),
			makeWorkshop('Getting to Know Claude Code', 'getting-to-know', null, 1),
			makeWorkshop(
				'Claude Code Fundamentals',
				'fundamentals',
				'2026-03-30T07:01:00.000Z',
				2,
			),
			makeWorkshop('Steering', 'steering', '2026-03-30T07:01:00.000Z', 3),
			makeWorkshop('Planning', 'planning', '2026-03-30T07:01:00.000Z', 4),
			makeWorkshop(
				'Feedback Loops',
				'feedback-loops',
				'2026-04-06T07:01:00.000Z',
				5,
			),
			makeWorkshop('Ralph', 'ralph', '2026-04-06T07:01:00.000Z', 6),
			makeWorkshop('Human in the Loop', 'hitl', '2026-04-06T07:01:00.000Z', 7),
		]

		const result = getWorkshopAvailability(workshops, now)

		expect(result.availableNow).toHaveLength(5)
		expect(result.availableNow.map((w) => w.title)).toEqual([
			'Before We Start',
			'Getting to Know Claude Code',
			'Claude Code Fundamentals',
			'Steering',
			'Planning',
		])
		expect(result.upcoming).toHaveLength(1)
		expect(result.upcoming[0]!.workshops).toHaveLength(3)
		expect(result.upcoming[0]!.date).toBe('April 6th, 2026')
	})

	it('shows only null-date workshops as available before any open', () => {
		const now = new Date('2026-03-20T12:00:00.000Z')
		const workshops = [
			makeWorkshop('Before We Start', 'before-we-start', null, 0),
			makeWorkshop('Getting to Know Claude Code', 'getting-to-know', null, 1),
			makeWorkshop(
				'Claude Code Fundamentals',
				'fundamentals',
				'2026-03-30T07:01:00.000Z',
				2,
			),
			makeWorkshop(
				'Feedback Loops',
				'feedback-loops',
				'2026-04-06T07:01:00.000Z',
				3,
			),
		]

		const result = getWorkshopAvailability(workshops, now)

		expect(result.availableNow).toHaveLength(2)
		expect(result.upcoming).toHaveLength(2)
		expect(result.upcoming[0]!.date).toBe('March 30th, 2026')
		expect(result.upcoming[1]!.date).toBe('April 6th, 2026')
	})

	it('puts all workshops in availableNow when all dates are past', () => {
		const now = new Date('2026-05-01T12:00:00.000Z')
		const workshops = [
			makeWorkshop('Before We Start', 'before-we-start', null, 0),
			makeWorkshop(
				'Fundamentals',
				'fundamentals',
				'2026-03-30T07:01:00.000Z',
				1,
			),
			makeWorkshop(
				'Feedback Loops',
				'feedback-loops',
				'2026-04-06T07:01:00.000Z',
				2,
			),
		]

		const result = getWorkshopAvailability(workshops, now)

		expect(result.availableNow).toHaveLength(3)
		expect(result.upcoming).toHaveLength(0)
	})

	it('handles cohort where everything is future-dated', () => {
		const now = new Date('2026-03-15T12:00:00.000Z')
		const workshops = [
			makeWorkshop('Day 1', 'day1', '2026-03-30T07:01:00.000Z', 0),
			makeWorkshop('Day 2', 'day2', '2026-04-06T07:01:00.000Z', 1),
		]

		const result = getWorkshopAvailability(workshops, now)

		expect(result.availableNow).toHaveLength(0)
		expect(result.upcoming).toHaveLength(2)
	})

	it('handles empty input', () => {
		const result = getWorkshopAvailability([], new Date())

		expect(result.availableNow).toHaveLength(0)
		expect(result.upcoming).toHaveLength(0)
	})

	it('preserves position ordering within groups', () => {
		const now = new Date('2026-03-30T12:00:00.000Z')
		const workshops = [
			makeWorkshop('Third', 'third', null, 2),
			makeWorkshop('First', 'first', null, 0),
			makeWorkshop('Second', 'second', null, 1),
		]

		const result = getWorkshopAvailability(workshops, now)

		expect(result.availableNow.map((w) => w.title)).toEqual([
			'First',
			'Second',
			'Third',
		])
	})
})
