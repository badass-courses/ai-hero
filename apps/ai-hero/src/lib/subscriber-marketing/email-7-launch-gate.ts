import { isLearnerFlowCanaryEmail } from './learner-flow-canary-exclusion'
import { isEmailSevenResourceId } from './skills-workflow-path'

export const EMAIL_7_COPY_APPROVAL_REVIEW_REASON =
	'email-7-copy-approval-required'

export function parseEmail7LiveEnabled(value?: string) {
	return value?.trim().toLowerCase() === 'true'
}

export function evaluateEmail7LaunchGate(args: {
	emailResourceId?: string
	email?: string | null
	liveEnabled?: boolean
}) {
	const applies = isEmailSevenResourceId(args.emailResourceId)
	const canaryBypass = applies && isLearnerFlowCanaryEmail(args.email)
	const passed = !applies || Boolean(args.liveEnabled) || canaryBypass
	return {
		slug: 'email-7-copy-approval' as const,
		applies,
		passed,
		canaryBypass,
		reviewReasons: passed ? [] : [EMAIL_7_COPY_APPROVAL_REVIEW_REASON],
		reason: !applies
			? 'Email-7 copy approval gate does not apply to this step.'
			: args.liveEnabled
				? 'Email-7 live delivery is explicitly enabled.'
				: canaryBypass
					? 'Synthetic learner-flow canary may prove email-7 while the real-learner gate is closed.'
					: 'Email-7 live delivery is blocked until approved copy enables it.',
	}
}
