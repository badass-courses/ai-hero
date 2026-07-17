import type {
	ContactEventRecord,
	ContactRecord,
	ContactState,
	SideEffectIntent,
} from './types'
import type { GateDRuntimeAllowlist } from './value-path-gate-d-allowlist'

export type LearnerFlowCohortRecord = {
	contactId: string
	contact?: ContactRecord
	contactState?: ContactState
	intents: SideEffectIntent[]
	entryEvents: ContactEventRecord[]
}

export type LearnerFlowCohortRepository = {
	findSkillsWorkflowLearnerFlowRecords():
		| Promise<LearnerFlowCohortRecord[]>
		| LearnerFlowCohortRecord[]
}

/**
 * The single cohort-membership query for learner-flow loops.
 *
 * Rolling enrollment always uses the current learner-flow records. A
 * finish-approved-path authorization still narrows that live set to the
 * approved IDs; it never treats the activation snapshot itself as proof that
 * a contact remains in the operational cohort.
 */
export async function queryLearnerFlowCohort(args: {
	repository: LearnerFlowCohortRepository
	allowlist: Pick<GateDRuntimeAllowlist, 'authorizationMode' | 'contactIds'>
}) {
	const liveRecords = await args.repository.findSkillsWorkflowLearnerFlowRecords()
	const approved = new Set(args.allowlist.contactIds)
	const records =
		args.allowlist.authorizationMode === 'rolling-public-enrollment'
			? liveRecords
			: liveRecords.filter((record) => approved.has(record.contactId))
	const contactIds = Array.from(new Set(records.map((record) => record.contactId)))
	return {
		source:
			args.allowlist.authorizationMode === 'rolling-public-enrollment'
				? ('live-rolling-learner-flow' as const)
				: ('live-finish-approved-path' as const),
		authorizationMode: args.allowlist.authorizationMode,
		contactIds,
		records,
		liveRecordsScanned: liveRecords.length,
		activationSnapshotContacts: args.allowlist.contactIds.length,
	}
}
