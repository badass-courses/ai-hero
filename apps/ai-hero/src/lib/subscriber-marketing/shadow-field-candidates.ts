import type { OperatorContactSnapshot } from './operator-lookup'
import {
	previewShadowFieldsForContactSnapshot,
	type ShadowFieldPreviewResult,
} from './shadow-field-planner'
import type { ValuePathCandidate } from './value-path-planner'

export type ShadowFieldCandidateStatus = ShadowFieldPreviewResult['status']

export type ShadowFieldCandidate = {
	contactId: string
	status: ShadowFieldCandidateStatus
	reviewReasons: string[]
	fieldKeys: string[]
	fields: ShadowFieldPreviewResult['fields']
	gates: ShadowFieldPreviewResult['gates']
	metadata: ShadowFieldPreviewResult['metadata']
}

export type ShadowFieldCandidatesResult = {
	mode: 'shadow-field-candidates'
	privacy: {
		rawEmailsIncluded: false
		rawPayloadIncluded: false
		customerVisibleFieldsIncluded: false
	}
	input: {
		candidateContacts: number
		status?: ShadowFieldCandidateStatus
		noReviewReasons: boolean
		limit: number
	}
	counts: {
		returned: number
		byStatus: Record<string, number>
		withReviewReasons: number
	}
	candidates: ShadowFieldCandidate[]
}

export function previewShadowFieldCandidates(args: {
	snapshots: OperatorContactSnapshot[]
	valuePathCandidates?: Record<string, ValuePathCandidate | undefined>
	status?: ShadowFieldCandidateStatus
	noReviewReasons?: boolean
	limit?: number
}): ShadowFieldCandidatesResult {
	const limit = args.limit ?? 50
	const previews = args.snapshots.map((snapshot) =>
		previewShadowFieldsForContactSnapshot({
			snapshot,
			valuePathCandidate: args.valuePathCandidates?.[snapshot.contact.id],
		}),
	)
	const filtered = previews
		.filter((preview) => !args.status || preview.status === args.status)
		.filter(
			(preview) => !args.noReviewReasons || preview.reviewReasons.length === 0,
		)
		.slice(0, limit)
	const byStatus = previews.reduce<Record<string, number>>(
		(counts, preview) => {
			counts[preview.status] = (counts[preview.status] ?? 0) + 1
			return counts
		},
		{},
	)

	return {
		mode: 'shadow-field-candidates',
		privacy: {
			rawEmailsIncluded: false,
			rawPayloadIncluded: false,
			customerVisibleFieldsIncluded: false,
		},
		input: {
			candidateContacts: args.snapshots.length,
			status: args.status,
			noReviewReasons: Boolean(args.noReviewReasons),
			limit,
		},
		counts: {
			returned: filtered.length,
			byStatus,
			withReviewReasons: previews.filter(
				(preview) => preview.reviewReasons.length > 0,
			).length,
		},
		candidates: filtered.map((preview) => ({
			contactId: preview.contactId,
			status: preview.status,
			reviewReasons: preview.reviewReasons,
			fieldKeys: preview.fieldKeys,
			fields: preview.fields,
			gates: preview.gates,
			metadata: preview.metadata,
		})),
	}
}
