import { describe, expect, it } from 'vitest'
import { MySqlDialect } from 'drizzle-orm/mysql-core'

import {
	buildLearningStructure,
	formatLearningProgress,
	type LearningResourceRow,
} from './learning-progress'
import {
	expectedLearningProgress,
	LEARNING_AS_OF,
	learningFixture,
} from './learning-progress.fixtures'
import {
	learningProgressSql,
	learningRosterSql,
	splitLearningProgressRow,
} from './learning-progress-query'

/** The rows the structure walk would read for the fixture product. */
function fixtureRows(): LearningResourceRow[] {
	const byId = new Map(learningFixture.resources.map((row) => [row.id, row]))
	const toRow = (
		id: string,
		parentId: string | null,
		position: number,
	): LearningResourceRow => {
		const resource = byId.get(id)!
		const fields = resource.fields as Record<string, unknown>
		return {
			id,
			parentId,
			position,
			type: resource.type,
			title: (fields.title as string) ?? null,
			slug: (fields.slug as string) ?? null,
			state: (fields.state as string) ?? null,
			startsAt: (fields.startsAt as string) ?? null,
			optional: fields.optional === true ? 'true' : null,
		}
	}
	return [
		toRow('cohort', null, 0),
		...learningFixture.links
			.filter(([, , , deleted]) => !deleted)
			.map(([parent, child, position]) => toRow(child, parent, position)),
	]
}

const withoutCounts = expectedLearningProgress.funnel.rows.map(
	({ started, completed, requiredLessons, ...node }) => node,
)

describe('learning progress structure', () => {
	it('orders workshops then their sections, with locked reasons', () => {
		const structure = buildLearningStructure(fixtureRows(), LEARNING_AS_OF)
		expect(structure.nodes.map(({ lessonIds, ...node }) => node)).toEqual(
			withoutCounts,
		)
		expect(structure.nodes.map((node) => node.lessonIds.length)).toEqual(
			expectedLearningProgress.funnel.rows.map((row) => row.requiredLessons),
		)
	})

	it('requires lessons and exercises, not optional lessons', () => {
		const structure = buildLearningStructure(fixtureRows(), LEARNING_AS_OF)
		const domain = structure.nodes.find((node) => node.id === 'w-domain')!
		expect(domain.lessonIds).toEqual(['l-3', 'l-4', 'l-5'])
		expect(structure.lessonIds).not.toContain('l-optional')
	})

	it('reads a self-paced product whose root is a workshop', () => {
		const rows = fixtureRows()
			.filter((row) => row.id !== 'cohort')
			.map((row) => (row.id === 'w-before' ? { ...row, parentId: null } : row))
			.filter((row) => row.parentId !== 'cohort')
		const structure = buildLearningStructure(rows, LEARNING_AS_OF)
		expect(structure.nodes.map((node) => node.id)).toEqual(['w-before'])
		expect(structure.lessonIds).toEqual(['l-1', 'l-2'])
	})

	it('unlocks a scheduled workshop once startsAt passes', () => {
		const later = new Date('2026-11-21T00:00:00.000Z')
		const structure = buildLearningStructure(fixtureRows(), later)
		expect(
			structure.nodes.find((node) => node.id === 'w-scheduled')?.availability,
		).toEqual({ status: 'available' })
	})
})

describe('learning progress formatting', () => {
	const structure = buildLearningStructure(fixtureRows(), LEARNING_AS_OF)
	const roster = {
		learners: '5',
		purchased: BigInt(4),
		signedIn: 4,
		refunded: 1,
		transferredAway: 1,
		teamSeatsUnredeemed: '4',
	}
	const wide: Record<string, unknown> = {
		lessonsCompleted24h: '4',
		lessonsCompleted7d: 5,
		activeLearners7d: 3,
		totalLessonCompletions: 6,
	}
	expectedLearningProgress.funnel.rows.forEach((row, index) => {
		wide[`s${index}`] = row.started
		wide[`c${index}`] = String(row.completed)
	})

	it('produces the expected aggregate from driver-shaped counts', () => {
		const progress = splitLearningProgressRow(wide, structure)
		expect(
			formatLearningProgress({
				asOf: LEARNING_AS_OF,
				product: expectedLearningProgress.product,
				structure,
				roster,
				...progress,
			}),
		).toEqual(expectedLearningProgress)
	})

	it('refuses counts that do not reconcile instead of reporting them', () => {
		const progress = splitLearningProgressRow(
			{ ...wide, c0: 3, s0: 2 },
			structure,
		)
		expect(() =>
			formatLearningProgress({
				asOf: LEARNING_AS_OF,
				product: expectedLearningProgress.product,
				structure,
				roster,
				...progress,
			}),
		).toThrow('do not reconcile')
	})

	it('never fabricates zero from a malformed count', () => {
		expect(() =>
			splitLearningProgressRow({ ...wide, s0: 'n/a' }, structure),
		).toThrow('invalid started count')
	})
})

describe('learning progress SQL', () => {
	const dialect = new MySqlDialect()
	const structure = buildLearningStructure(fixtureRows(), LEARNING_AS_OF)

	it('takes no user-identifying filter', () => {
		for (const query of [
			learningProgressSql(learningFixture.productId, structure, LEARNING_AS_OF),
			learningRosterSql(learningFixture.productId),
		]) {
			const { sql } = dialect.sqlToQuery(query)
			expect(sql).not.toMatch(/userId\s*=\s*\?|email\s*=\s*\?/i)
		}
	})

	it('binds productId and lesson ids as parameters, never inline', () => {
		const { sql, params } = dialect.sqlToQuery(
			learningProgressSql(learningFixture.productId, structure, LEARNING_AS_OF),
		)
		expect(sql).not.toContain(learningFixture.productId)
		expect(sql).not.toContain("'l-1'")
		expect(params).toContain(learningFixture.productId)
		expect(params).toContain('l-1')
	})
})
