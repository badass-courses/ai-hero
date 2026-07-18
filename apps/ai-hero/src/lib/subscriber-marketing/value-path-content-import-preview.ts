export type ValuePathSurveyOptionPreview = {
	value: string
	label: string
	correct: boolean
}

export type ValuePathSurveyPreview = {
	id: string
	type?: string
	question?: string
	options: ValuePathSurveyOptionPreview[]
}

export type ValuePathCertificateLinkPreview = {
	href: string
	label?: string
}

export type ValuePathEmailPagePreview = {
	kind: 'email'
	id: string
	slug: string
	sequenceId: string
	emailId: string
	position: number
	title?: string
	type?: string
	skill?: string
	subject?: string
	preview?: string
	body?: string
	certificateLink?: ValuePathCertificateLinkPreview
	waitlistLine?: string
	survey?: ValuePathSurveyPreview
	kitSequenceId?: string
}

export type ValuePathAnswerPagePreview = {
	kind: 'answer'
	id: string
	slug: string
	sequenceId: string
	emailId: string
	surveyId: string
	optionValue: string
	result?: string
	headline?: string
	body?: string
	takeaway?: string
	nextNotice?: string
	nextSequenceId?: string
	nextEmailId?: string
	nextEmailResourceId?: string
	kitSequenceId?: string
	captureFieldKey?: string
	captureDateFieldKey?: string
}

export type ValuePathParentPreview = {
	id: string
	slug: string
	title: string
	type: 'value-path'
}

export type ValuePathContentImportPreview = {
	mode: 'dry-run'
	parents: ValuePathParentPreview[]
	pages: Array<ValuePathEmailPagePreview | ValuePathAnswerPagePreview>
	counts: {
		parents: number
		emails: number
		answers: number
	}
	warnings: string[]
}

export function previewValuePathContentImport(args: {
	individualSequenceMdx: string
	teamSequenceMdx: string
	individualAnswerPagesMdx: string
	teamAnswerPagesMdx: string
}): ValuePathContentImportPreview {
	const individual = parseEmailSequence(args.individualSequenceMdx)
	const team = parseEmailSequence(args.teamSequenceMdx)
	const individualAnswers = parseAnswerPageSet(args.individualAnswerPagesMdx)
	const teamAnswers = parseAnswerPageSet(args.teamAnswerPagesMdx)

	const parents: ValuePathParentPreview[] = [
		{
			id: individual.id,
			slug: individual.id,
			title: individual.title ?? 'AI Hero Skills Workflow',
			type: 'value-path',
		},
		{
			id: team.id,
			slug: team.id,
			title: team.title ?? 'AI Hero Skills Workflow for Teams',
			type: 'value-path',
		},
	]
	const emailPages = [...individual.emails, ...team.emails]
	const answerPages = [...individualAnswers.pages, ...teamAnswers.pages]
	const emailResourceBySequenceAndEmailId = new Map(
		emailPages.map((email) => [`${email.sequenceId}:${email.emailId}`, email]),
	)
	const answersBySurveyOption = new Map(
		answerPages.map((answer) => [
			`${answer.sequenceId}:${answer.surveyId}:${answer.optionValue}`,
			answer,
		]),
	)
	const warnings: string[] = []
	const ids = new Set<string>()
	const slugs = new Set<string>()

	for (const page of [...emailPages, ...answerPages]) {
		if (ids.has(page.id)) warnings.push(`duplicate-page-id:${page.id}`)
		ids.add(page.id)
		if (slugs.has(page.slug)) warnings.push(`duplicate-page-slug:${page.slug}`)
		slugs.add(page.slug)
		if (page.kind === 'email' && !page.kitSequenceId) {
			warnings.push(`kit-sequence-missing:${page.id}`)
		}
		if (page.kind === 'answer' && page.nextEmailId) {
			const nextSequenceId = page.nextSequenceId ?? page.sequenceId
			const nextEmail = emailResourceBySequenceAndEmailId.get(
				`${nextSequenceId}:${page.nextEmailId}`,
			)
			page.nextEmailResourceId = nextEmail?.id
			page.kitSequenceId = nextEmail?.kitSequenceId
			if (!page.nextEmailResourceId) {
				warnings.push(
					`next-email-missing:${page.id}:${nextSequenceId}:${page.nextEmailId}`,
				)
			}
		}
	}

	for (const email of emailPages) {
		if (!email.survey) continue
		for (const option of email.survey.options) {
			const answer = answersBySurveyOption.get(
				`${email.sequenceId}:${email.survey.id}:${option.value}`,
			)
			if (!answer) {
				warnings.push(
					`answer-page-missing:${email.id}:${email.survey.id}:${option.value}`,
				)
			}
		}
	}

	return {
		mode: 'dry-run',
		parents,
		pages: [...emailPages, ...answerPages],
		counts: {
			parents: parents.length,
			emails: emailPages.length,
			answers: answerPages.length,
		},
		warnings,
	}
}

function parseEmailSequence(source: string) {
	const root = source.match(/<EmailSequence\b([^>]*)>/)
	if (!root) throw new Error('No <EmailSequence> root found')
	const rootAttrs = parseAttrs(root[1] ?? '')
	const emails: ValuePathEmailPagePreview[] = []
	const emailRe = /<EmailPlan\b([^>]*)>([\s\S]*?)<\/EmailPlan>/g
	let match: RegExpExecArray | null
	let position = 0
	while ((match = emailRe.exec(source))) {
		position += 1
		const attrs = parseAttrs(match[1] ?? '')
		const body = match[2] ?? ''
		const sequenceId = rootAttrs.id ?? 'unknown-sequence'
		const emailId = attrs.id ?? `email-${position}`
		emails.push({
			kind: 'email',
			id: `${sequenceId}.${emailId}`,
			slug: slugifyId(`${sequenceId}-${emailId}`),
			sequenceId,
			emailId,
			position,
			title: attrs.title,
			type: attrs.type,
			skill: attrs.skill,
			subject: textOf(body, 'Subject'),
			preview: textOf(body, 'Preview'),
			body: textOf(body, 'Body'),
			certificateLink: parseCertificateLink(body),
			waitlistLine: textOf(body, 'WaitlistLine'),
			survey: parseSurvey(body),
			kitSequenceId: attrs.kitSequenceId,
		})
	}
	return {
		id: rootAttrs.id ?? 'unknown-sequence',
		title: rootAttrs.title,
		emails,
	}
}

function parseAnswerPageSet(source: string) {
	const root = source.match(/<AnswerPageSet\b([^>]*)>/)
	if (!root) throw new Error('No <AnswerPageSet> root found')
	const rootAttrs = parseAttrs(root[1] ?? '')
	const sequenceId = rootAttrs.sequenceId ?? rootAttrs.id ?? 'unknown-sequence'
	const pages: ValuePathAnswerPagePreview[] = []
	const pageRe = /<AnswerPage\b([^>]*)>([\s\S]*?)<\/AnswerPage>/g
	let match: RegExpExecArray | null
	while ((match = pageRe.exec(source))) {
		const attrs = parseAttrs(match[1] ?? '')
		const body = match[2] ?? ''
		const id = attrs.id ?? `${attrs.surveyId}.${attrs.optionValue}`
		pages.push({
			kind: 'answer',
			id: `${sequenceId}.${id}`,
			slug: attrs.slug ?? slugifyId(`${sequenceId}-${id}`),
			sequenceId: attrs.sequenceId ?? sequenceId,
			emailId: attrs.emailId ?? 'unknown-email',
			surveyId: attrs.surveyId ?? 'unknown-survey',
			optionValue: attrs.optionValue ?? 'unknown-option',
			result: attrs.result,
			headline: textOf(body, 'Headline'),
			body: textOf(body, 'Body'),
			takeaway: textOf(body, 'Takeaway'),
			nextNotice: textOf(body, 'NextNotice'),
			nextSequenceId: attrs.nextSequenceId,
			nextEmailId: attrs.nextEmailId,
			captureFieldKey: attrs.captureFieldKey,
			captureDateFieldKey: attrs.captureDateFieldKey,
		})
	}
	return { id: rootAttrs.id ?? 'unknown-answer-pages', pages }
}

function parseCertificateLink(
	body: string,
): ValuePathCertificateLinkPreview | undefined {
	const match = body.match(/<CertificateLink\b([^>]*)>([\s\S]*?)<\/CertificateLink>/)
	if (!match) return undefined
	const attrs = parseAttrs(match[1] ?? '')
	if (!attrs.href) return undefined
	return {
		href: attrs.href,
		label: normalizeText(match[2] ?? '') || undefined,
	}
}

function parseSurvey(body: string): ValuePathSurveyPreview | undefined {
	const match = body.match(/<Survey\b([^>]*)>([\s\S]*?)<\/Survey>/)
	if (!match) return undefined
	const attrs = parseAttrs(match[1] ?? '')
	const surveyBody = match[2] ?? ''
	return {
		id: attrs.id ?? 'unknown-survey',
		type: attrs.type,
		question: textOf(surveyBody, 'Question'),
		options: parseOptions(surveyBody),
	}
}

function parseOptions(body: string): ValuePathSurveyOptionPreview[] {
	const options: ValuePathSurveyOptionPreview[] = []
	const optionRe = /<Option\b([^>]*)>([\s\S]*?)<\/Option>/g
	let match: RegExpExecArray | null
	while ((match = optionRe.exec(body))) {
		const rawAttrs = match[1] ?? ''
		const attrs = parseAttrs(rawAttrs)
		options.push({
			value: attrs.value ?? 'unknown-option',
			label: normalizeText(match[2] ?? ''),
			correct: /(^|\s)correct(\s|=|$)/.test(rawAttrs),
		})
	}
	return options
}

function parseAttrs(input: string): Record<string, string> {
	const attrs: Record<string, string> = {}
	const re = /(\w+)=(?:"([^"]*)"|'([^']*)')/g
	let match: RegExpExecArray | null
	while ((match = re.exec(input))) {
		const name = match[1]
		if (name) attrs[name] = match[2] ?? match[3] ?? ''
	}
	return attrs
}

function textOf(body: string, tag: string) {
	const match = body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))
	return match?.[1] ? normalizeText(match[1]) : undefined
}

function normalizeText(input: string) {
	return input
		.replace(/<[^>]+>/g, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
}

function slugifyId(input: string) {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
}
