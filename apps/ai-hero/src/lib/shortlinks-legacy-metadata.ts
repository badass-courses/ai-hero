import type { ShortlinkMetadata } from './shortlinks-types'

type LegacyShortlinkMetadataMapping = {
	metadata: ShortlinkMetadata
	confidence: 'high' | 'medium' | 'low'
	evidence: string
	rationale: string
}

export const legacyShortlinkMetadataMappings: Record<
	string,
	LegacyShortlinkMetadataMapping
> = {
	hUsWyq: {
		metadata: {
			schemaVersion: 1,
			campaign: 'c004',
			campaignPhase: 'open_cart',
			sourceSurface: 'social',
			sourceId: 'x_launch_post',
			contentSlug: 'ai-coding-for-real-engineers',
			contentIntent: 'checkout',
			createdFor: 'campaign',
		},
		confidence: 'medium',
		evidence:
			'2026-05-20 Cohort 004 attribution audit labeled hUsWyq as X launch post.',
		rationale:
			'Legacy shortlink had no metadata snapshot but produced Cohort 004 paid purchase-field revenue.',
	},
	d9eKwT: {
		metadata: {
			schemaVersion: 1,
			campaign: 'c004',
			campaignPhase: 'open_cart',
			sourceSurface: 'site',
			sourceId: 'unlabeled_cohort_page',
			contentSlug: 'ai-coding-for-real-engineers',
			contentIntent: 'checkout',
			createdFor: 'campaign',
		},
		confidence: 'low',
		evidence:
			'2026-05-20 Cohort 004 attribution audit labeled d9eKwT as unlabeled cohort page.',
		rationale:
			'Legacy shortlink had no metadata snapshot and needs manual review before being treated as a named source.',
	},
	F7SvsW: {
		metadata: {
			schemaVersion: 1,
			campaign: 'c004',
			campaignPhase: 'open_cart',
			sourceSurface: 'social',
			sourceId: 'discord_cohort_page',
			contentSlug: 'ai-coding-for-real-engineers',
			contentIntent: 'checkout',
			createdFor: 'campaign',
		},
		confidence: 'medium',
		evidence:
			'2026-05-20 Cohort 004 attribution audit labeled F7SvsW as Discord cohort page.',
		rationale:
			'Legacy shortlink had no metadata snapshot but produced Cohort 004 paid purchase-field revenue.',
	},
} satisfies Record<string, LegacyShortlinkMetadataMapping>

export function getLegacyShortlinkMetadata(
	slug: string,
): ShortlinkMetadata | null {
	return legacyShortlinkMetadataMappings[slug]?.metadata ?? null
}
