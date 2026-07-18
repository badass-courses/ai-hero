import { isLearnerFlowBusinessMetricFixtureEmail } from './learner-flow-canary-exclusion'
import type { ValuePathSendGateMode } from './value-path-send-gate'

export const AIH_COURSE_COMPLETED_AT_FIELD = 'aih_course_completed_at'
export const AIH_FINISHER_SEGMENT_FIELD = 'aih_finisher_segment'
export const AIH_NEXT_COURSE_WAITLIST_AT_FIELD =
	'aih_next_course_waitlist_at'

export type ValuePathFinisherFieldProvider = {
	updateSubscriberFields?: (args: {
		subscriberId?: string
		subscriberEmail?: string
		fields: Record<string, string>
	}) => Promise<unknown>
}

export type ValuePathFinisherCaptureResult =
	| { status: 'not-configured'; fields: Record<string, string> }
	| { status: 'dry-run'; fields: Record<string, string> }
	| {
			status: 'excluded'
			fields: Record<string, string>
			reviewReasons: ['learner-flow-fixture-kit-field-write-excluded']
	  }
	| {
			status: 'blocked'
			fields: Record<string, string>
			reviewReasons: string[]
	  }
	| { status: 'written'; fields: Record<string, string> }

export async function captureValuePathFinisherFields(args: {
	provider?: ValuePathFinisherFieldProvider
	mode: ValuePathSendGateMode
	email?: string | null
	kitSubscriberId?: string
	optionValue?: string
	captureFieldKey?: string
	captureDateFieldKey?: string
	now: string
}): Promise<ValuePathFinisherCaptureResult> {
	if (!args.captureFieldKey && !args.captureDateFieldKey) {
		return { status: 'not-configured', fields: {} }
	}
	const reviewReasons = [
		...(args.captureFieldKey === AIH_FINISHER_SEGMENT_FIELD
			? []
			: ['finisher-segment-field-key-invalid']),
		...(args.captureDateFieldKey === AIH_NEXT_COURSE_WAITLIST_AT_FIELD
			? []
			: ['finisher-waitlist-field-key-invalid']),
		...(args.optionValue ? [] : ['finisher-segment-option-missing']),
		...(args.kitSubscriberId || args.email
			? []
			: ['kit-subscriber-identity-missing']),
	]
	const fields: Record<string, string> = args.optionValue
		? {
				[AIH_FINISHER_SEGMENT_FIELD]: args.optionValue,
				[AIH_NEXT_COURSE_WAITLIST_AT_FIELD]: args.now,
			}
		: {}
	if (reviewReasons.length > 0) {
		return { status: 'blocked', fields, reviewReasons }
	}
	if (isLearnerFlowBusinessMetricFixtureEmail(args.email)) {
		return {
			status: 'excluded',
			fields,
			reviewReasons: ['learner-flow-fixture-kit-field-write-excluded'],
		}
	}
	if (args.mode === 'dry-run') return { status: 'dry-run', fields }
	if (!args.provider?.updateSubscriberFields) {
		return {
			status: 'blocked',
			fields,
			reviewReasons: ['kit-update-subscriber-fields-not-supported'],
		}
	}
	await args.provider.updateSubscriberFields({
		subscriberId: args.kitSubscriberId,
		subscriberEmail: args.email ?? undefined,
		fields,
	})
	return { status: 'written', fields }
}
