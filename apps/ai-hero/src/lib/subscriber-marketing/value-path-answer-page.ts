import { db } from '@/db'
import { contentResource } from '@/db/schema'
import { and, eq, sql } from 'drizzle-orm'

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
		optionValue?: string
		result?: string
		nextSequenceId?: string
		nextEmailId?: string
		nextEmailResourceId?: string
		kitSequenceId?: string
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
			optionValue: stringField(fields.optionValue),
			result: stringField(fields.result),
			nextSequenceId: stringField(fields.nextSequenceId),
			nextEmailId: stringField(fields.nextEmailId),
			nextEmailResourceId: stringField(fields.nextEmailResourceId),
			kitSequenceId: stringField(fields.kitSequenceId),
		},
	}
}

export async function getValuePathAnswerPageBySlug(slug: string) {
	const resource = await db.query.contentResource.findFirst({
		where: and(
			eq(contentResource.type, 'value-path-page'),
			eq(sql`JSON_EXTRACT (${contentResource.fields}, "$.kind")`, 'answer'),
			eq(sql`JSON_EXTRACT (${contentResource.fields}, "$.slug")`, slug),
		),
	})
	return parseValuePathAnswerPageResource(resource)
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

function stringField(value: unknown) {
	return typeof value === 'string' ? value : undefined
}
