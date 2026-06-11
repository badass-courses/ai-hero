import { LAYERED_REVIEW_SIGNALS, WHO_SIGNALS, WHY_SIGNALS } from './taxonomy'
import {
	LOW_CONFIDENCE_REVIEW_THRESHOLD,
	type BucketSlug,
	type ClassificationResult,
	type NormalizedContactEvent,
	type ReviewSignalSlug,
} from './types'

/**
 * Escapes regex metacharacters so taxonomy keywords can be matched safely.
 *
 * @param value - Raw keyword or phrase.
 * @returns Keyword escaped for the RegExp constructor.
 */
const escapeRegExp = (value: string) =>
	value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Tests whether a keyword appears as a standalone token in normalized text.
 *
 * Single-token keywords treat hyphens as token characters so `buy` does not
 * match `buy-in`. Multi-token phrases only require alphanumeric boundaries.
 *
 * @param text - Lowercased summary and keyword text to inspect.
 * @param keyword - Taxonomy keyword or phrase.
 * @returns True when the keyword matches with Unicode-aware boundaries.
 */
const matchesKeyword = (text: string, keyword: string) => {
	const escaped = escapeRegExp(keyword.toLowerCase())
	const boundaryBefore = '(?<![\\p{L}\\p{N}])'
	const boundaryAfter = keyword.includes(' ')
		? '(?![\\p{L}\\p{N}])'
		: '(?![-\\p{L}\\p{N}])'

	return new RegExp(`${boundaryBefore}${escaped}${boundaryAfter}`, 'u').test(
		text,
	)
}

const scoreMatches = <T extends string>(
	text: string,
	taxonomy: Record<T, { keywords: string[] }>,
) =>
	(Object.entries(taxonomy) as Array<[T, { keywords: string[] }]>).map(
		([slug, entry]) => ({
			slug,
			score: entry.keywords.filter((keyword) => matchesKeyword(text, keyword))
				.length,
		}),
	)

const positive = <T extends string>(
	scores: Array<{ slug: T; score: number }>,
	fallback: T,
) => {
	const hits = scores
		.filter((score) => score.score > 0)
		.sort((a, b) => b.score - a.score)
	return hits.length ? hits : [{ slug: fallback, score: 0 }]
}

export function classifyContactEvent(
	event: NormalizedContactEvent,
): ClassificationResult {
	const text =
		`${event.payloadSummary.summary} ${event.payloadSummary.keywords.join(' ')}`.toLowerCase()
	const whyHits = positive(scoreMatches(text, WHY_SIGNALS), 'other-unclear')
	const whoHits = positive(scoreMatches(text, WHO_SIGNALS), 'unclear')
	const reviewSignals = scoreMatches(text, LAYERED_REVIEW_SIGNALS)
		.filter((score) => score.score > 0)
		.map((score) => score.slug as ReviewSignalSlug)

	const whySignals = whyHits.map((hit) => hit.slug)
	const whoSignals = whoHits.map((hit) => hit.slug)
	const primaryBucket = whySignals[0] as BucketSlug
	const allBuckets = Array.from(
		new Set<BucketSlug>([...whySignals, ...whoSignals]),
	)
	const totalScore = whyHits[0]!.score + whoHits[0]!.score
	const confidence = Math.min(
		0.95,
		totalScore === 0 ? 0.25 : 0.45 + totalScore * 0.15,
	)
	const tied = whyHits.length > 1 && whyHits[0]!.score === whyHits[1]!.score

	if (confidence < LOW_CONFIDENCE_REVIEW_THRESHOLD)
		reviewSignals.push('low-confidence')
	if (tied || primaryBucket === 'other-unclear') reviewSignals.push('ambiguous')
	if (event.privacyLevel === 'restricted')
		reviewSignals.push('restricted-payload')

	return {
		whySignals,
		whoSignals,
		primaryBucket,
		allBuckets,
		confidence,
		rationale: [
			`Matched why=${whySignals.join(', ')} who=${whoSignals.join(', ')}`,
			`Deterministic fixture classifier only; no LLMs or providers called.`,
		],
		reviewSignals: Array.from(new Set(reviewSignals)),
		humanReview: reviewSignals.length > 0,
	}
}
