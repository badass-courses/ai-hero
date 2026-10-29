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

type Schema = {
	type?: string | string[]
	const?: unknown
	enum?: readonly unknown[]
	required?: readonly string[]
	properties?: Record<string, Schema>
	additionalProperties?: boolean
	items?: Schema
	oneOf?: readonly Schema[]
}

/** The subset of JSON Schema the published contract uses, checked strictly. */
function violations(schema: Schema, value: unknown, path = '$'): string[] {
	if (schema.oneOf) {
		const matches = schema.oneOf.filter(
			(option) => violations(option, value, path).length === 0,
		)
		return matches.length === 1
			? []
			: [`${path}: matches ${matches.length} oneOf`]
	}
	if ('const' in schema)
		return value === schema.const ? [] : [`${path}: expected ${schema.const}`]
	if (schema.enum)
		return schema.enum.includes(value) ? [] : [`${path}: not in enum`]
	const types = [schema.type].flat().filter(Boolean) as string[]
	const typeOf =
		value === null
			? 'null'
			: Array.isArray(value)
				? 'array'
				: Number.isInteger(value)
					? 'integer'
					: typeof value
	if (
		types.length &&
		!types.includes(typeOf) &&
		!(typeOf === 'integer' && types.includes('number'))
	)
		return [`${path}: ${typeOf} is not ${types.join('|')}`]
	if (typeOf === 'array' && schema.items)
		return (value as unknown[]).flatMap((item, index) =>
			violations(schema.items!, item, `${path}[${index}]`),
		)
	if (typeOf !== 'object') return []
	const record = value as Record<string, unknown>
	const problems = (schema.required ?? [])
		.filter((key) => !(key in record))
		.map((key) => `${path}.${key}: missing`)
	for (const [key, item] of Object.entries(record)) {
		const property = schema.properties?.[key]
		if (property) problems.push(...violations(property, item, `${path}.${key}`))
		else if (schema.additionalProperties === false)
			problems.push(`${path}.${key}: not in schema`)
	}
	return problems
}

describe('learning/progress contract', () => {
	const schema = getRevenueSurfaceSchema('learning/progress')!

	it('is in the catalog, the published schemas and the agent instructions', () => {
		expect(catalog['learning/progress']).toMatchObject({
			name: 'learning/progress',
			category: 'learning',
			provider: 'database',
		})
		expect(ANALYTICS_SCHEMA_VERSION).toBe('2026-10-29.1')
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
