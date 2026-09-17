import { describe, expect, it } from 'vitest'

import {
	queryLearnerFlowCohort,
	queryLearnerFlowCohortMembership,
} from './learner-flow-cohort'
import type { GateDRuntimeAllowlist } from './value-path-gate-d-allowlist'

const records = ['captured-and-live', 'live-after-activation'].map(
	(contactId) => ({
		contactId,
		intents: [],
		entryEvents: [],
	}),
)

function allowlist(
	authorizationMode: GateDRuntimeAllowlist['authorizationMode'],
) {
	return {
		authorizationMode,
		contactIds: ['captured-and-live', 'captured-but-not-live'],
	}
}

describe('learner-flow cohort query', () => {
	it.each(['rolling-public-enrollment', 'finish-approved-path'] as const)(
		'deduplicates %s membership in first-seen order without hiding scan counts',
		async (authorizationMode) => {
			const liveIds = [
				'z-last-alphabetically',
				'a-first-alphabetically',
				'z-last-alphabetically',
				'outside-approval',
				'a-first-alphabetically',
			]
			const approvedIds = [
				'a-first-alphabetically',
				'z-last-alphabetically',
				'absent',
			]
			const result = await queryLearnerFlowCohortMembership({
				repository: {
					findSkillsWorkflowLearnerFlowMembership: async () => liveIds,
				},
				allowlist: { authorizationMode, contactIds: approvedIds },
			})
			expect(result.contactIds).toEqual(
				authorizationMode === 'rolling-public-enrollment'
					? [
							'z-last-alphabetically',
							'a-first-alphabetically',
							'outside-approval',
						]
					: ['z-last-alphabetically', 'a-first-alphabetically'],
			)
			expect(result.liveRecordsScanned).toBe(5)
		},
	)

	it('uses the live cohort for rolling enrollment instead of the activation snapshot', async () => {
		const result = await queryLearnerFlowCohort({
			repository: { findSkillsWorkflowLearnerFlowRecords: () => records },
			allowlist: allowlist('rolling-public-enrollment'),
		})
		expect(result.source).toBe('live-rolling-learner-flow')
		expect(result.contactIds).toEqual([
			'captured-and-live',
			'live-after-activation',
		])
	})

	it('intersects finish-approved authorization with current live membership', async () => {
		const result = await queryLearnerFlowCohort({
			repository: { findSkillsWorkflowLearnerFlowRecords: () => records },
			allowlist: allowlist('finish-approved-path'),
		})
		expect(result.source).toBe('live-finish-approved-path')
		expect(result.contactIds).toEqual(['captured-and-live'])
	})
})
