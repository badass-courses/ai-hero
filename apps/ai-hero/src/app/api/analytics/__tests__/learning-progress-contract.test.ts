import { describe, expect, it, vi } from 'vitest'

vi.mock('@/db', () => ({}))

import { catalog } from '@/lib/analytics/catalog'
import { expectedLearningProgress } from '@/lib/analytics/learning-progress.fixtures'

import {
	ANALYTICS_AGENT_INSTRUCTIONS,
	ANALYTICS_SCHEMA_VERSION,
	getAnalyticsAgentSchema,
	getRevenueSurfaceSchema,
} from '../agent-contract'
import { violations, type Schema } from './json-schema-subset'

describe('learning/progress contract', () => {
	const schema = getRevenueSurfaceSchema('learning/progress')!

	it('is in the catalog, the published schemas and the agent instructions', () => {
		expect(catalog['learning/progress']).toMatchObject({
			name: 'learning/progress',
			category: 'learning',
			provider: 'database',
		})
		expect(ANALYTICS_SCHEMA_VERSION).toBe('2026-11-01.1')
		expect(
			getAnalyticsAgentSchema(['learning/progress']).surfaces,
		).toHaveProperty('learning/progress')
		expect(schema).toMatchObject({
			supports: ['productId'],
			requires: ['productId'],
		})
		expect(ANALYTICS_AGENT_INSTRUCTIONS.join('\n')).toContain(
			'learning/progress requires productId',
		)
	})

	it('requires productId in the published query schema', () => {
		const query = getAnalyticsAgentSchema(['learning/progress']).query
		expect(query.allOf).toContainEqual({
			if: {
				properties: { surface: { const: 'learning/progress' } },
				required: ['surface'],
			},
			then: { required: ['productId'] },
		})
	})

	it('describes exactly what the query module returns', () => {
		expect(violations(schema.data as Schema, expectedLearningProgress)).toEqual(
			[],
		)
		expect(
			violations(schema.data as Schema, {
				...expectedLearningProgress,
				roster: { ...expectedLearningProgress.roster, emails: [] },
			}),
		).toEqual(['$.roster.emails: not in schema'])
	})

	it('states the denominator, locked rows and missing certificates', () => {
		const semantics = schema.semantics.join('\n')
		expect(semantics).toContain('same denominator')
		expect(semantics).toContain('later row without earlier ones')
		expect(semantics).toContain('locked')
		expect(semantics).toContain('Certificates are not reported')
		expect(semantics).toContain('No user ids')
	})
})
