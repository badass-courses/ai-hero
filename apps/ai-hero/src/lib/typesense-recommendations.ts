import type { TypesenseResource } from './typesense'

export type TypesenseRecommendationHit = {
	document: TypesenseResource
	vectorDistance?: number | null
}

function popularityScore(hit: TypesenseRecommendationHit) {
	return hit.document.popularity_30d ?? 0
}

function vectorDistance(hit: TypesenseRecommendationHit) {
	return hit.vectorDistance ?? Number.POSITIVE_INFINITY
}

function updatedAtTimestamp(hit: TypesenseRecommendationHit) {
	return hit.document.updated_at_timestamp ?? 0
}

export function selectTypesenseRecommendation(
	hits: TypesenseRecommendationHit[],
) {
	return [...hits].sort((a, b) => {
		const popularityDelta = popularityScore(b) - popularityScore(a)
		if (popularityDelta !== 0) return popularityDelta

		const distanceDelta = vectorDistance(a) - vectorDistance(b)
		if (distanceDelta !== 0) return distanceDelta

		const updatedAtDelta = updatedAtTimestamp(b) - updatedAtTimestamp(a)
		if (updatedAtDelta !== 0) return updatedAtDelta

		return a.document.id.localeCompare(b.document.id)
	})[0]?.document
}
