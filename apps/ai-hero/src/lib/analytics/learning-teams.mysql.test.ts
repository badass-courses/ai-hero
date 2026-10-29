import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SQL } from 'drizzle-orm'

import { LEARNING_AS_OF, learningFixture } from './learning-progress.fixtures'
import { createLearningDatabase } from './learning-progress.mysql-fixture'
import {
	expectedTeamA,
	expectedTeamAMembers,
	expectedTeamB,
	teamFixture,
} from './learning-teams.fixtures'
import {
	LearningTeamNotFoundError,
	readLearningTeam,
	readLearningTeamMembers,
	readLearningTeams,
} from './learning-teams-query'

vi.mock('@/db', () => ({}))

const url = process.env.AIH_MYSQL_TEST_URL

describe.skipIf(!url)('learning team SQL (synthetic MySQL)', () => {
	let database: Awaited<ReturnType<typeof createLearningDatabase>>
	let execute: (query: SQL) => Promise<unknown>

	beforeAll(async () => {
		database = await createLearningDatabase(url!, teamFixture, 'teams')
		execute = database.execute
	})

	afterAll(async () => {
		await database?.close()
	})

	it('lists every team newest first, aggregate only', async () => {
		const queries: string[] = []
		const result = await readLearningTeams(
			async (query) => {
				const result = await execute(query)
				queries.push(JSON.stringify((result as { rows: unknown }).rows))
				return result
			},
			null,
			LEARNING_AS_OF,
		)
		expect(result).toEqual({
			asOf: LEARNING_AS_OF.toISOString(),
			productId: null,
			teams: [expectedTeamB, expectedTeamA],
		})
		// Organization names come from buyer emails; summaries never read them.
		expect(queries.join('\n')).not.toMatch(/example\.test|Acme/)
	})

	it('filters teams by product', async () => {
		expect(
			(
				await readLearningTeams(
					execute,
					learningFixture.productId,
					LEARNING_AS_OF,
				)
			).teams.map((team) => team.teamId),
		).toEqual(['bulk-coupon-b', 'bulk-coupon'])
		expect(
			(await readLearningTeams(execute, 'another-product', LEARNING_AS_OF))
				.teams,
		).toEqual([])
	})

	it('uses team members as the funnel denominator', async () => {
		const team = await readLearningTeam(execute, 'bulk-coupon', LEARNING_AS_OF)
		expect(team.team).toEqual(expectedTeamA)
		expect(team.funnel.denominator).toEqual({
			basis: 'team-members',
			count: 2,
		})
		expect(
			team.funnel.rows.map((row) => [row.id, row.started, row.completed]),
		).toEqual([
			['w-before', 1, 0],
			['w-domain', 0, 0],
			['s-terms', 0, 0],
			['s-models', 0, 0],
			['w-draft', 0, 0],
			['w-scheduled', 0, 0],
		])
		// The refunded seat holder's completion is not team activity.
		expect(team.activity).toEqual({
			lessonsCompleted24h: 0,
			lessonsCompleted7d: 0,
			activeLearners7d: 1,
			totalLessonCompletions: 0,
		})
	})

	it('resolves a bulk purchase id to its team', async () => {
		const team = await readLearningTeam(execute, 'p-team-more', LEARNING_AS_OF)
		expect(team.team.teamId).toBe('bulk-coupon')
		await expect(
			readLearningTeam(execute, 'p-seat', LEARNING_AS_OF),
		).rejects.toBeInstanceOf(LearningTeamNotFoundError)
		await expect(
			readLearningTeam(execute, 'no-such-team', LEARNING_AS_OF),
		).rejects.toBeInstanceOf(LearningTeamNotFoundError)
	})

	it('lists members, and unredeemed seats only as a count', async () => {
		const result = await readLearningTeamMembers(
			execute,
			'bulk-coupon',
			LEARNING_AS_OF,
			{ includeUserIds: true },
		)
		expect(result).toEqual({
			asOf: LEARNING_AS_OF.toISOString(),
			pii: true,
			team: {
				teamId: 'bulk-coupon',
				product: expectedTeamA.product,
				seats: { bought: 5, redeemed: 3, unredeemed: 2 },
				organization: { id: 'org-a', name: "buyer@example.test's Team" },
			},
			members: expectedTeamAMembers,
		})
	})

	it('counts workshop completion per member', async () => {
		const result = await readLearningTeamMembers(
			execute,
			'bulk-coupon-b',
			LEARNING_AS_OF,
			{ includeUserIds: false },
		)
		expect(result.members).toEqual([
			{
				email: 'member-b@example.test',
				name: 'Bea Member',
				redeemedAt: new Date(
					LEARNING_AS_OF.getTime() - 90 * 3_600_000,
				).toISOString(),
				signedIn: true,
				lastActiveAt: new Date(
					LEARNING_AS_OF.getTime() - 2 * 3_600_000,
				).toISOString(),
				lessonsCompleted: 2,
				workshops: { started: 1, completed: 1, total: 4 },
			},
		])
	})

	it('gives a member of another team nothing', async () => {
		const result = await readLearningTeamMembers(
			execute,
			'bulk-coupon',
			LEARNING_AS_OF,
			{ onlyUserId: 'u-b-member', includeUserIds: false },
		)
		expect(result.members).toEqual([])
	})

	it('limits a seat holder to their own row', async () => {
		const result = await readLearningTeamMembers(
			execute,
			'bulk-coupon',
			LEARNING_AS_OF,
			{ onlyUserId: 'u-seat', includeUserIds: false },
		)
		expect(result.members.map((member) => member.email)).toEqual([
			'u-seat@example.test',
		])
	})
})
