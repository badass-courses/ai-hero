import type {
	ValuePathAnswerPagePreview,
	ValuePathContentImportPreview,
	ValuePathEmailPagePreview,
} from './value-path-content-import-preview'

export type ValuePathTeamShareLinkMap = {
	links?: {
		teamEmail6ShareCta?: {
			shortlinkId?: string
			slug?: string
			shortUrl?: string
			destinationUrl?: string
			kitSubscriberField?: string
			sourceEmailResourceId?: string
			sourceEmailId?: string
			signupSurface?: string
			metadata?: Record<string, unknown>
		}
	}
}

export type ValuePathQaPreview = {
	mode: 'value-path-qa-preview'
	counts: {
		parents: number
		emails: number
		answers: number
		share: number
		certificate: number
	}
	parents: ValuePathContentImportPreview['parents']
	surveyOptions: Array<{
		emailResourceId: string
		sequenceId: string
		emailId: string
		surveyId: string
		optionValue: string
		label: string
		answerPageId: string | null
		answerPageSlug: string | null
		askLinkPreview: string | null
	}>
	answerRoutes: Array<{
		answerPageId: string
		answerPageSlug: string
		sequenceId: string
		emailId: string
		surveyId: string
		optionValue: string
		nextEmailId: string | null
		nextEmailResourceId: string | null
		kitSequenceId: string | null
	}>
	missingKitSequenceIds: string[]
	teamShareCta: {
		status: 'present' | 'missing'
		shortlinkId?: string
		slug?: string
		shortUrl?: string
		destinationUrl?: string
		signupSurface?: string
		metadata?: Record<string, unknown>
	}
	warnings: string[]
	blockers: string[]
}

const PATH_TOKEN_PLACEHOLDER = '<redacted-path-token>'

export function previewSkillsWorkflowValuePathQa(args: {
	preview: ValuePathContentImportPreview
	individualSequenceMdx: string
	teamSequenceMdx: string
	teamShareLinkMap?: ValuePathTeamShareLinkMap
	baseUrl?: string
}): ValuePathQaPreview {
	const baseUrl = (args.baseUrl ?? 'https://www.aihero.dev').replace(/\/$/, '')
	const emailPages = args.preview.pages.filter(isEmailPage)
	const answerPages = args.preview.pages.filter(isAnswerPage)
	const answersBySurveyOption = new Map(
		answerPages.map((answer) => [
			`${answer.sequenceId}:${answer.surveyId}:${answer.optionValue}`,
			answer,
		]),
	)

	const surveyOptions = emailPages.flatMap((email) =>
		(email.survey?.options ?? []).map((option) => {
			const answer = answersBySurveyOption.get(
				`${email.sequenceId}:${email.survey?.id}:${option.value}`,
			)
			return {
				emailResourceId: email.id,
				sequenceId: email.sequenceId,
				emailId: email.emailId,
				surveyId: email.survey?.id ?? 'unknown-survey',
				optionValue: option.value,
				label: option.label,
				answerPageId: answer?.id ?? null,
				answerPageSlug: answer?.slug ?? null,
				askLinkPreview: answer
					? `${baseUrl}/ask/${answer.slug}?pt=${PATH_TOKEN_PLACEHOLDER}`
					: null,
			}
		}),
	)

	const answerRoutes = answerPages.map((answer) => ({
		answerPageId: answer.id,
		answerPageSlug: answer.slug,
		sequenceId: answer.sequenceId,
		emailId: answer.emailId,
		surveyId: answer.surveyId,
		optionValue: answer.optionValue,
		nextEmailId: answer.nextEmailId ?? null,
		nextEmailResourceId: answer.nextEmailResourceId ?? null,
		kitSequenceId: answer.kitSequenceId ?? null,
	}))

	const missingKitSequenceIds = emailPages
		.filter((email) => !email.kitSequenceId)
		.map((email) => email.id)

	const teamShareCta = args.teamShareLinkMap?.links?.teamEmail6ShareCta
	const blockers = new Set<string>()
	for (const warning of args.preview.warnings) blockers.add(warning)
	for (const option of surveyOptions) {
		if (!option.answerPageSlug) {
			blockers.add(
				`answer-page-missing:${option.emailResourceId}:${option.surveyId}:${option.optionValue}`,
			)
		}
	}
	for (const route of answerRoutes) {
		if (route.nextEmailId && !route.nextEmailResourceId) {
			blockers.add(`next-email-resource-missing:${route.answerPageId}`)
		}
	}
	for (const emailId of missingKitSequenceIds) {
		blockers.add(`kit-sequence-missing:${emailId}`)
	}
	if (!teamShareCta) {
		blockers.add('team-share-shortlink-missing')
	} else {
		const metadata = teamShareCta.metadata ?? {}
		if (teamShareCta.signupSurface !== 'skills_newsletter') {
			blockers.add('team-share-signup-surface-missing')
		}
		if (metadata.linkRole !== 'share_value_path') {
			blockers.add('team-share-link-role-mismatch')
		}
		if (metadata.signupSurface !== 'skills_newsletter') {
			blockers.add('team-share-metadata-signup-surface-mismatch')
		}
		if (metadata.valuePath !== 'ai-hero-skills-team-workflow') {
			blockers.add('team-share-value-path-mismatch')
		}
		if (metadata.contentSlug !== 'ai-hero-skills-workflow') {
			blockers.add('team-share-content-slug-mismatch')
		}
		if (
			metadata.sourceSurface !== 'sequence' ||
			metadata.sourceId !== 'team-email-6'
		) {
			blockers.add('team-share-source-mismatch')
		}
		if (!isSkillsSignupPath(teamShareCta.destinationUrl)) {
			blockers.add('team-share-destination-not-skills-surface')
		}
	}

	return {
		mode: 'value-path-qa-preview',
		counts: {
			parents: args.preview.counts.parents,
			emails: emailPages.length,
			answers: answerPages.length,
			share: countShareCtas(args.teamSequenceMdx, teamShareCta),
			certificate: countCertificateCtas(args.individualSequenceMdx),
		},
		parents: args.preview.parents,
		surveyOptions,
		answerRoutes,
		missingKitSequenceIds,
		teamShareCta: teamShareCta
			? {
					status: 'present',
					shortlinkId: teamShareCta.shortlinkId,
					slug: teamShareCta.slug,
					shortUrl: teamShareCta.shortUrl,
					destinationUrl: teamShareCta.destinationUrl,
					signupSurface: teamShareCta.signupSurface,
					metadata: teamShareCta.metadata,
				}
			: { status: 'missing' },
		warnings: args.preview.warnings,
		blockers: [...blockers].sort(),
	}
}

function isEmailPage(
	page: ValuePathContentImportPreview['pages'][number],
): page is ValuePathEmailPagePreview {
	return page.kind === 'email'
}

function isAnswerPage(
	page: ValuePathContentImportPreview['pages'][number],
): page is ValuePathAnswerPagePreview {
	return page.kind === 'answer'
}

function isSkillsSignupPath(destinationUrl?: string) {
	try {
		const pathname = new URL(destinationUrl ?? '').pathname
		return pathname === '/skills' || pathname.startsWith('/skills/')
	} catch {
		return false
	}
}

function countShareCtas(source: string, teamShareCta: unknown) {
	return source.includes('aih_team_share_url') || teamShareCta ? 1 : 0
}

function countCertificateCtas(source: string) {
	return /<CTA>[\s\S]*certificate[\s\S]*<\/CTA>/i.test(source) ? 1 : 0
}
