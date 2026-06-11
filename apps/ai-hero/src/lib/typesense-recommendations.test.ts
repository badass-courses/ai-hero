import { describe, expect, it } from 'vitest'

import {
	selectTypesenseRecommendation,
	type TypesenseRecommendationHit,
} from './typesense-recommendations'

function hit({
	id,
	popularity,
	vectorDistance,
	updatedAt,
}: {
	id: string
	popularity?: number
	vectorDistance?: number
	updatedAt?: number
}): TypesenseRecommendationHit {
	return {
		vectorDistance,
		document: {
			id,
			title: id,
			slug: id,
			state: 'published',
			visibility: 'public',
			type: 'post',
			popularity_30d: popularity,
			updated_at_timestamp: updatedAt,
		},
	}
}

describe('selectTypesenseRecommendation', () => {
	it('selects the most popular hit from the nearest-neighbour set', () => {
		const selected = selectTypesenseRecommendation([
			hit({ id: 'closest', popularity: 3, vectorDistance: 0.1 }),
			hit({ id: 'popular', popularity: 12, vectorDistance: 0.3 }),
			hit({ id: 'quiet', popularity: 0, vectorDistance: 0.2 }),
		])

		expect(selected?.id).toBe('popular')
	})

	it('uses vector distance as the popularity tie-breaker', () => {
		const selected = selectTypesenseRecommendation([
			hit({ id: 'farther', popularity: 5, vectorDistance: 0.4 }),
			hit({ id: 'closer', popularity: 5, vectorDistance: 0.2 }),
		])

		expect(selected?.id).toBe('closer')
	})

	it('uses stable tie-breakers instead of randomness', () => {
		const hits = [
			hit({ id: 'b', popularity: 0, vectorDistance: 0.2, updatedAt: 100 }),
			hit({ id: 'a', popularity: 0, vectorDistance: 0.2, updatedAt: 100 }),
		]

		expect(selectTypesenseRecommendation(hits)?.id).toBe('a')
		expect(selectTypesenseRecommendation(hits)?.id).toBe('a')
	})
})
