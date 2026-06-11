import type { ContactEventPreviewSummary } from './contact-event-normalizer-preview'

export type ContactEventProductionReceipt = {
	mode: 'read-only'
	tables: string[]
	stagedContentReadPreview: Pick<
		ContactEventPreviewSummary,
		| 'eligibleCount'
		| 'skippedCount'
		| 'skippedByReason'
		| 'kitWrites'
		| 'sequenceEnrollments'
		| 'customerVisibleSideEffects'
	>
	retentionCandidates?: {
		retentionDays: number
		cutoff: string
		candidateCount: number
	}
	safety: {
		identityValuesRedacted: true
		writesPerformed: false
		customerVisibleSideEffects: false
	}
}

export function buildContactEventProductionReceipt(args: {
	preview: ContactEventPreviewSummary
	retention?: {
		retentionDays: number
		cutoff: string
		candidateCount: number
	}
}): ContactEventProductionReceipt {
	return {
		mode: 'read-only',
		tables: ['AI_ContentRead', 'AI_ContactEvent', 'AI_ProviderIdentity'],
		stagedContentReadPreview: {
			eligibleCount: args.preview.eligibleCount,
			skippedCount: args.preview.skippedCount,
			skippedByReason: args.preview.skippedByReason,
			kitWrites: args.preview.kitWrites,
			sequenceEnrollments: args.preview.sequenceEnrollments,
			customerVisibleSideEffects: args.preview.customerVisibleSideEffects,
		},
		retentionCandidates: args.retention,
		safety: {
			identityValuesRedacted: true,
			writesPerformed: false,
			customerVisibleSideEffects: false,
		},
	}
}
