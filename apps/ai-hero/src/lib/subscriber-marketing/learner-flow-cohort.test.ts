import { describe, expect, it } from 'vitest'

import { queryLearnerFlowCohort } from './learner-flow-cohort'
import type { GateDRuntimeAllowlist } from './value-path-gate-d-allowlist'

const records = ['captured-and-live', 'live-after-activation'].map((contactId) => ({
	contactId,
	intents: [],
	entryEvents: [],
}))

function allowlist(
	authorizationMode: GateDRuntimeAllowlist['authorizationMode'],
) {
	return {
		authorizationMode,
		contactIds: ['captured-and-live', 'captured-but-not-live'],
	}
}

describe('learner-flow cohort query', () => {
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
