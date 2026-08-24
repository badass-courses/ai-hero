type CourseSyncPollPolicyState = {
	status: string
	applyPolicyOverride?: 'operator' | null
}

export function courseSyncApplyPolicyOverride(
	state: CourseSyncPollPolicyState | null,
): 'operator' | null {
	if (state?.applyPolicyOverride === 'operator') return 'operator'
	// Rows written before the durable override column still restore an
	// operator gate from the two states that could only enter that gate.
	return state?.status === 'released' || state?.status === 'awaiting-apply'
		? 'operator'
		: null
}
