import { db } from '@/db'
import { contentResource } from '@/db/schema'
import { and, eq, sql } from 'drizzle-orm'

export const SHARED_SKILLS_WORKFLOW_CERTIFICATE_ANSWER_SLUG =
	'ai-hero-skills-workflow-certificate'

export type ValuePathAnswerPageResource = {
	id: string
	type: 'value-path-page'
	fields: {
		kind: 'answer'
		slug: string
		title?: string
		headline?: string
		body?: string
		takeaway?: string
		nextNotice?: string
		sequenceId?: string
		emailId?: string
		surveyId?: string
		variant?: 'did-it' | 'goal'
		clickIntent?: 'confirmed' | 'deferred' | 'record'
		helpUrl?: string
		helpLabel?: string
		optionValue?: string
		result?: string
		position?: number
		nextSequenceId?: string
		nextEmailId?: string
		nextEmailResourceId?: string
		kitSequenceId?: string
		captureFieldKey?: string
		captureDateFieldKey?: string
	}
}

export function parseValuePathAnswerPageResource(
	resource: unknown,
): ValuePathAnswerPageResource | null {
	if (!resource || typeof resource !== 'object') return null
	const candidate = resource as {
		id?: unknown
		type?: unknown
		fields?: unknown
	}
	if (typeof candidate.id !== 'string') return null
	if (candidate.type !== 'value-path-page') return null
	if (!candidate.fields || typeof candidate.fields !== 'object') return null
	const fields = candidate.fields as Record<string, unknown>
	if (fields.kind !== 'answer') return null
	if (typeof fields.slug !== 'string') return null
	if (
		fields.variant !== undefined &&
		fields.variant !== 'did-it' &&
		fields.variant !== 'goal'
	)
		return null
	if (
		fields.clickIntent !== undefined &&
		!['confirmed', 'deferred', 'record'].includes(String(fields.clickIntent))
	)
		return null
	if (
		fields.variant !== undefined &&
		fields.variant !== 'did-it' &&
		fields.variant !== 'goal'
	)
		return null
	if (
		fields.clickIntent !== undefined &&
		!['confirmed', 'deferred', 'record'].includes(String(fields.clickIntent))
	)
		return null
	return {
		id: candidate.id,
		type: 'value-path-page',
		fields: {
			kind: 'answer',
			slug: fields.slug,
			title: stringField(fields.title),
			headline: stringField(fields.headline),
			body: stringField(fields.body),
			takeaway: stringField(fields.takeaway),
			nextNotice: stringField(fields.nextNotice),
			sequenceId: stringField(fields.sequenceId),
			emailId: stringField(fields.emailId),
			surveyId: stringField(fields.surveyId),
			variant:
				fields.variant === 'did-it' || fields.variant === 'goal'
					? fields.variant
					: undefined,
			clickIntent:
				fields.clickIntent === 'confirmed' ||
				fields.clickIntent === 'deferred' ||
				fields.clickIntent === 'record'
					? fields.clickIntent
					: undefined,
			helpUrl: stringField(fields.helpUrl),
			helpLabel: stringField(fields.helpLabel),
			optionValue: stringField(fields.optionValue),
			result: stringField(fields.result),
			position: numberField(fields.position),
			nextSequenceId: stringField(fields.nextSequenceId),
			nextEmailId: stringField(fields.nextEmailId),
			nextEmailResourceId: stringField(fields.nextEmailResourceId),
			kitSequenceId: stringField(fields.kitSequenceId),
			captureFieldKey: stringField(fields.captureFieldKey),
			captureDateFieldKey: stringField(fields.captureDateFieldKey),
		},
	}
}

export async function getValuePathAnswerPageBySlug(input: {
	slug: string
	optionValue?: string
	sequenceId?: string
	emailId?: string
}) {
	const resources = await db.query.contentResource.findMany({
		where: and(
			eq(contentResource.type, 'value-path-page'),
			eq(sql`JSON_EXTRACT (${contentResource.fields}, "$.kind")`, 'answer'),
			eq(sql`JSON_EXTRACT (${contentResource.fields}, "$.slug")`, input.slug),
		),
	})
	return selectValuePathAnswerPageVariant(
		resources
			.map(parseValuePathAnswerPageResource)
			.filter((page): page is ValuePathAnswerPageResource => Boolean(page)),
		input,
	)
}

export function selectValuePathAnswerPageVariant(
	pages: ValuePathAnswerPageResource[],
	input: {
		optionValue?: string
		sequenceId?: string
		emailId?: string
	},
) {
	const matching = pages.filter(
		(page) =>
			(!input.optionValue || page.fields.optionValue === input.optionValue) &&
			(!input.sequenceId || page.fields.sequenceId === input.sequenceId) &&
			(!input.emailId || page.fields.emailId === input.emailId),
	)

	return matching.length === 1 ? matching[0] : undefined
}

export async function getValuePathAnswerPages() {
	const resources = await db.query.contentResource.findMany({
		where: and(
			eq(contentResource.type, 'value-path-page'),
			eq(sql`JSON_EXTRACT (${contentResource.fields}, "$.kind")`, 'answer'),
		),
	})
	return resources
		.map(parseValuePathAnswerPageResource)
		.filter((page): page is ValuePathAnswerPageResource => Boolean(page))
}

export function allowedValuePathHelpUrl(value?: string): string | undefined {
	if (!value) return undefined
	try {
		const url = new URL(value)
		if (url.protocol !== 'https:' || url.username || url.password || url.port)
			return undefined
		if (
			url.hostname === 'aihero.dev' ||
			url.hostname === 'www.aihero.dev' ||
			(url.hostname === 'github.com' &&
				(url.pathname === '/mattpocock' ||
					url.pathname.startsWith('/mattpocock/')))
		)
			return value
	} catch {
		// Invalid content never fails a learner's answer page.
	}
	return undefined
}

function stringField(value: unknown) {
	return typeof value === 'string' ? value : undefined
}

function numberField(value: unknown) {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
