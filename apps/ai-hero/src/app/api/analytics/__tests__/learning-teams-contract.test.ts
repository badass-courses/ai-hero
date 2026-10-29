import { describe, expect, it, vi } from 'vitest'

vi.mock('@/db', () => ({}))

import { catalog } from '@/lib/analytics/catalog'
import { expectedLearningProgress } from '@/lib/analytics/learning-progress.fixtures'
import {
	expectedTeamA,
	expectedTeamAMembers,
	expectedTeamB,
} from '@/lib/analytics/learning-teams.fixtures'

import {
	ANALYTICS_AGENT_INSTRUCTIONS,
	getAnalyticsAgentSchema,
	getRevenueSurfaceSchema,
} from '../agent-contract'
import { violations, type Schema } from './json-schema-subset'

const teamProgress = {
	asOf: expectedLearningProgress.asOf,
	team: expectedTeamA,
	funnel: {
		denominator: { basis: 'team-members', count: 2 },
		rows: expectedLearningProgress.funnel.rows,
	},
	activity: expectedLearningProgress.activity,
}

const teamMembers = {
	asOf: expectedLearningProgress.asOf,
	pii: true,
	team: {
		teamId: expectedTeamA.teamId,
		product: expectedTeamA.product,
		seats: expectedTeamA.seats,
		organization: { id: 'org-a', name: "buyer@example.test's Team" },
	},
	members: expectedTeamAMembers,
}

describe('learning team contracts', () => {
	it('publishes all three surfaces in the catalog and schemas', () => {
		for (const name of [
			'learning/teams',
			'learning/team',
			'learning/team-members',
		] as const) {
			expect(catalog[name]).toMatchObject({ name, category: 'learning' })
			expect(getAnalyticsAgentSchema([name]).surfaces).toHaveProperty(name)
		}
		expect(catalog['learning/team-members'].description).toMatch(/^PII/)
	})

	it('describes the aggregate team list without names', () => {
		const schema = getRevenueSurfaceSchema('learning/teams')!
		expect(
			violations(schema.data as Schema, {
				asOf: expectedLearningProgress.asOf,
				productId: null,
				teams: [expectedTeamB, expectedTeamA],
			}),
		).toEqual([])
		expect(
			violations(schema.data as Schema, {
				asOf: expectedLearningProgress.asOf,
				productId: null,
				teams: [{ ...expectedTeamA, organizationName: 'Acme' }],
			}),
		).toEqual(['$.teams[0].organizationName: not in schema'])
		expect(schema.semantics.join('\n')).toContain('no organization names')
	})

	it('describes one team with members as the denominator', () => {
		const schema = getRevenueSurfaceSchema('learning/team')!
		expect(schema).toMatchObject({ requires: ['teamId'] })
		expect(violations(schema.data as Schema, teamProgress)).toEqual([])
		expect(
			violations(schema.data as Schema, {
				...teamProgress,
				members: expectedTeamAMembers,
			}),
		).toEqual(['$.members: not in schema'])
	})

	it('marks member rows as PII in the schema and instructions', () => {
		const schema = getRevenueSurfaceSchema('learning/team-members')!
		expect(schema).toMatchObject({ requires: ['teamId'], pii: true })
		expect(violations(schema.data as Schema, teamMembers)).toEqual([])
		const semantics = schema.semantics.join('\n')
		expect(semantics).toContain('AI Hero admins only')
		expect(semantics).toContain('Never cached')
		expect(semantics).toContain('Member emails are never logged')
		expect(ANALYTICS_AGENT_INSTRUCTIONS.join('\n')).toContain(
			'learning/team-members is PII',
		)
	})

	it('requires teamId for the single-team surfaces', () => {
		expect(
			getAnalyticsAgentSchema(['learning/team']).query.allOf,
		).toContainEqual({
			if: {
				properties: {
					surface: { enum: ['learning/team', 'learning/team-members'] },
				},
				required: ['surface'],
			},
			then: { required: ['teamId'] },
		})
	})
})
