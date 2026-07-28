export const SKILLS_WORKFLOW_PATH_SLUGS = [
	'ai-hero-skills-workflow',
	'ai-hero-skills-team-workflow',
] as const

const INDIVIDUAL_KIT_SEQUENCE_IDS = [
	'2757199',
	'2757200',
	'2757201',
	'2757202',
	'2757203',
	'2757204',
	'2757205',
	'2831545',
] as const

const TEAM_KIT_SEQUENCE_IDS = [
	'2757206',
	'2757207',
	'2757208',
	'2757209',
	'2757210',
	'2757211',
	'2757212',
	'2831546',
] as const

export type SkillsWorkflowEmailStep = {
	valuePathSlug: (typeof SKILLS_WORKFLOW_PATH_SLUGS)[number]
	emailResourceId: string
	kitSequenceId: string
	nextValuePathSlug?: (typeof SKILLS_WORKFLOW_PATH_SLUGS)[number]
	nextEmailResourceId?: string
	nextKitSequenceId?: string
}

function buildPathSteps(args: {
	valuePathSlug: SkillsWorkflowEmailStep['valuePathSlug']
	emailPrefix: 'email' | 'team-email'
	kitSequenceIds: readonly string[]
}): SkillsWorkflowEmailStep[] {
	return args.kitSequenceIds.map((kitSequenceId, index) => {
		const emailResourceId = `${args.valuePathSlug}.${args.emailPrefix}-${index}`
		const nextKitSequenceId = args.kitSequenceIds[index + 1]
		return nextKitSequenceId
			? {
					valuePathSlug: args.valuePathSlug,
					emailResourceId,
					kitSequenceId,
					nextValuePathSlug: args.valuePathSlug,
					nextEmailResourceId: `${args.valuePathSlug}.${args.emailPrefix}-${index + 1}`,
					nextKitSequenceId,
				}
			: { valuePathSlug: args.valuePathSlug, emailResourceId, kitSequenceId }
	})
}

export const SKILLS_WORKFLOW_EMAIL_STEPS = [
	...buildPathSteps({
		valuePathSlug: 'ai-hero-skills-workflow',
		emailPrefix: 'email',
		kitSequenceIds: INDIVIDUAL_KIT_SEQUENCE_IDS,
	}),
	...buildPathSteps({
		valuePathSlug: 'ai-hero-skills-team-workflow',
		emailPrefix: 'team-email',
		kitSequenceIds: TEAM_KIT_SEQUENCE_IDS,
	}),
] as const

export const SKILLS_WORKFLOW_EMAIL_RESOURCE_IDS = SKILLS_WORKFLOW_EMAIL_STEPS.map(
	(step) => step.emailResourceId,
)

export const SKILLS_WORKFLOW_KIT_SEQUENCE_IDS = SKILLS_WORKFLOW_EMAIL_STEPS.map(
	(step) => step.kitSequenceId,
)

export function getSkillsWorkflowEmailStep(emailResourceId?: string) {
	return SKILLS_WORKFLOW_EMAIL_STEPS.find(
		(step) => step.emailResourceId === emailResourceId,
	)
}

export function isTerminalSkillsWorkflowEmailResourceId(value?: string) {
	return Boolean(value?.endsWith('.email-7') || value?.endsWith('.team-email-7'))
}

export function isContentCompleteSkillsWorkflowEmailResourceId(value?: string) {
	return Boolean(value?.endsWith('.email-6') || value?.endsWith('.team-email-6'))
}

export function isEmailSevenResourceId(value?: string) {
	return isTerminalSkillsWorkflowEmailResourceId(value)
}

export function nextSkillsWorkflowEmailResourceId(value?: string) {
	if (!value) return undefined
	const match = value.match(/(?:team-)?email-(\d+)$/)
	if (!match) return undefined
	const step = Number(match[1])
	if (!Number.isInteger(step) || step >= 7) return undefined
	return value.replace(/(?:team-)?email-\d+$/, (segment) =>
		segment.startsWith('team-email-')
			? `team-email-${step + 1}`
			: `email-${step + 1}`,
	)
}
