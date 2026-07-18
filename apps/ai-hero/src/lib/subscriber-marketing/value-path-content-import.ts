import { contentResource, contentResourceResource } from '@/db/schema'
import { and, eq } from 'drizzle-orm'

import type {
	ValuePathAnswerPagePreview,
	ValuePathContentImportPreview,
	ValuePathEmailPagePreview,
	ValuePathParentPreview,
} from './value-path-content-import-preview'

export type ValuePathContentResourcePlan = {
	resources: ValuePathResourceUpsert[]
	relations: ValuePathRelationUpsert[]
}

export type ValuePathResourceUpsert = {
	id: string
	type: 'value-path' | 'value-path-page'
	fields: Record<string, unknown>
}

export type ValuePathRelationUpsert = {
	resourceOfId: string
	resourceId: string
	position: number
	metadata: Record<string, unknown>
}

export type ValuePathContentImportResult = {
	mode: 'dry-run' | 'allow-write'
	preview: ValuePathContentImportPreview
	plan: ValuePathContentResourcePlan
	operations: Array<{
		kind: 'resource' | 'relation'
		action: 'would-upsert' | 'created' | 'updated'
		id: string
	}>
}

type AiHeroDatabase = any

export function buildValuePathContentResourcePlan(
	preview: ValuePathContentImportPreview,
): ValuePathContentResourcePlan {
	const resources: ValuePathResourceUpsert[] = [
		...preview.parents.map(parentToResource),
		...preview.pages.map(pageToResource),
	]
	const relations: ValuePathRelationUpsert[] = []
	let position = 0
	for (const parent of preview.parents) {
		for (const page of preview.pages.filter(
			(page) => page.sequenceId === parent.id,
		)) {
			position += 1
			relations.push({
				resourceOfId: parent.id,
				resourceId: page.id,
				position,
				metadata: {
					type: 'value-path-page',
					kind: page.kind,
					sequenceId: page.sequenceId,
					emailId: page.emailId,
				},
			})
		}
	}
	return { resources, relations }
}

export async function importValuePathContentResources(args: {
	database?: AiHeroDatabase
	preview: ValuePathContentImportPreview
	allowWrite?: boolean
	createdById?: string
}): Promise<ValuePathContentImportResult> {
	const mode = args.allowWrite ? 'allow-write' : 'dry-run'
	const plan = buildValuePathContentResourcePlan(args.preview)
	if (!args.allowWrite) {
		return {
			mode,
			preview: args.preview,
			plan,
			operations: [
				...plan.resources.map((resource) => ({
					kind: 'resource' as const,
					action: 'would-upsert' as const,
					id: resource.id,
				})),
				...plan.relations.map((relation) => ({
					kind: 'relation' as const,
					action: 'would-upsert' as const,
					id: `${relation.resourceOfId}:${relation.resourceId}`,
				})),
			],
		}
	}
	if (!args.database) throw new Error('database is required for allow-write')
	if (!args.createdById)
		throw new Error('createdById is required for allow-write')

	const operations: ValuePathContentImportResult['operations'] = []
	for (const resource of plan.resources) {
		const action = await upsertResource({
			database: args.database,
			resource,
			createdById: args.createdById,
		})
		operations.push({ kind: 'resource', action, id: resource.id })
	}
	for (const relation of plan.relations) {
		const action = await upsertRelation({ database: args.database, relation })
		operations.push({
			kind: 'relation',
			action,
			id: `${relation.resourceOfId}:${relation.resourceId}`,
		})
	}

	return { mode, preview: args.preview, plan, operations }
}

function parentToResource(
	parent: ValuePathParentPreview,
): ValuePathResourceUpsert {
	return {
		id: parent.id,
		type: 'value-path',
		fields: {
			kind: 'value-path',
			slug: parent.slug,
			title: parent.title,
			product: 'ai-hero',
			status: 'draft',
		},
	}
}

function pageToResource(
	page: ValuePathEmailPagePreview | ValuePathAnswerPagePreview,
): ValuePathResourceUpsert {
	if (page.kind === 'email') return emailToResource(page)
	return answerToResource(page)
}

function emailToResource(
	page: ValuePathEmailPagePreview,
): ValuePathResourceUpsert {
	return {
		id: page.id,
		type: 'value-path-page',
		fields: compactFields({
			kind: 'email',
			slug: page.slug,
			sequenceId: page.sequenceId,
			emailId: page.emailId,
			position: page.position,
			title: page.title,
			type: page.type,
			skill: page.skill,
			subject: page.subject,
			preview: page.preview,
			body: page.body,
			certificateLink: page.certificateLink,
			waitlistLine: page.waitlistLine,
			survey: page.survey,
			kitSequenceId: page.kitSequenceId,
		}),
	}
}

function answerToResource(
	page: ValuePathAnswerPagePreview,
): ValuePathResourceUpsert {
	return {
		id: page.id,
		type: 'value-path-page',
		fields: compactFields({
			kind: 'answer',
			slug: page.slug,
			sequenceId: page.sequenceId,
			emailId: page.emailId,
			surveyId: page.surveyId,
			optionValue: page.optionValue,
			result: page.result,
			headline: page.headline,
			body: page.body,
			takeaway: page.takeaway,
			nextNotice: page.nextNotice,
			nextSequenceId: page.nextSequenceId,
			nextEmailId: page.nextEmailId,
			nextEmailResourceId: page.nextEmailResourceId,
			kitSequenceId: page.kitSequenceId,
			captureFieldKey: page.captureFieldKey,
			captureDateFieldKey: page.captureDateFieldKey,
		}),
	}
}

async function upsertResource(args: {
	database: AiHeroDatabase
	resource: ValuePathResourceUpsert
	createdById: string
}): Promise<'created' | 'updated'> {
	const existing = await args.database.query.contentResource.findFirst({
		where: eq(contentResource.id, args.resource.id),
	})
	if (existing) {
		await args.database
			.update(contentResource)
			.set({
				type: args.resource.type,
				fields: args.resource.fields,
				updatedAt: new Date(),
				deletedAt: null,
			})
			.where(eq(contentResource.id, args.resource.id))
		return 'updated'
	}
	await args.database.insert(contentResource).values({
		id: args.resource.id,
		type: args.resource.type,
		fields: args.resource.fields,
		createdById: args.createdById,
	})
	return 'created'
}

async function upsertRelation(args: {
	database: AiHeroDatabase
	relation: ValuePathRelationUpsert
}): Promise<'created' | 'updated'> {
	const existing = await args.database.query.contentResourceResource.findFirst({
		where: and(
			eq(contentResourceResource.resourceOfId, args.relation.resourceOfId),
			eq(contentResourceResource.resourceId, args.relation.resourceId),
		),
	})
	if (existing) {
		await args.database
			.update(contentResourceResource)
			.set({
				position: args.relation.position,
				metadata: args.relation.metadata,
				updatedAt: new Date(),
				deletedAt: null,
			})
			.where(
				and(
					eq(contentResourceResource.resourceOfId, args.relation.resourceOfId),
					eq(contentResourceResource.resourceId, args.relation.resourceId),
				),
			)
		return 'updated'
	}
	await args.database.insert(contentResourceResource).values({
		resourceOfId: args.relation.resourceOfId,
		resourceId: args.relation.resourceId,
		position: args.relation.position,
		metadata: args.relation.metadata,
	})
	return 'created'
}

function compactFields(input: Record<string, unknown>) {
	return Object.fromEntries(
		Object.entries(input).filter(([, value]) => value !== undefined),
	)
}
