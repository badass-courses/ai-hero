import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/db'
import { contentResource, contentResourceResource } from '@/db/schema'
import { SKILL_CHANGELOG_PUBLISHED_EVENT } from '@/inngest/events/skill-changelog'
import { inngest } from '@/inngest/inngest.server'
import {
	getSkillChangelogForEdit,
	SKILL_CHANGELOG_RESOURCE_TYPE,
	SKILL_CHANGELOG_SLUG_PREFIX,
} from '@/lib/skill-changelog-query'
import { upsertPostToTypeSense } from '@/lib/typesense-query'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'
import { guid } from '@coursebuilder/utils/guid'
import slugify from '@sindresorhus/slugify'
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'

import { ContentResourceSchema } from '@coursebuilder/core/schemas/content-resource-schema'

const COMMAND = 'POST /api/skills/changelog'

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

const SkillChangelogPostSchema = z.object({
	title: z.string().min(2).max(120),
	slug: z.string().min(2).optional(),
	description: z.string().optional().nullable(),
	body: z.string().optional().default(''),
	newsletterCopy: z.string().optional().default(''),
	newsletterSubject: z.string().min(2).max(120).optional().nullable(),
	newsletterPreviewText: z.string().max(200).optional().nullable(),
	github: z.string().url().optional().nullable(),
	videoResourceId: z.string().optional().nullable(),
	thumbnailTime: z.number().optional().nullable(),
	state: z.enum(['draft', 'published']).optional().default('draft'),
	visibility: z
		.enum(['public', 'unlisted', 'private'])
		.optional()
		.default('unlisted'),
})

type NextAction = {
	command: string
	description: string
	params?: Record<
		string,
		{
			description?: string
			value?: string | number
			default?: string | number
			enum?: string[]
			required?: boolean
		}
	>
}

function jsonSuccess(
	result: Record<string, unknown>,
	status = 200,
	nextActions: NextAction[] = [],
) {
	return NextResponse.json(
		{
			ok: true,
			command: COMMAND,
			result,
			next_actions: nextActions,
		},
		{ status, headers: corsHeaders },
	)
}

function jsonError({
	message,
	code,
	fix,
	status,
	nextActions = [],
}: {
	message: string
	code: string
	fix: string
	status: number
	nextActions?: NextAction[]
}) {
	return NextResponse.json(
		{
			ok: false,
			command: COMMAND,
			error: { message, code },
			fix,
			docs: '/api',
			next_actions: nextActions,
		},
		{ status, headers: corsHeaders },
	)
}

function createNextActions(slug?: string, resourceId?: string): NextAction[] {
	return [
		...(slug
			? [
					{
						command: 'curl <base-url>/skills/<slug>',
						description: 'Open the rendered skills changelog entry',
						params: {
							'base-url': {
								description: 'AI Hero app base URL',
								default: 'https://www.aihero.dev',
							},
							slug: {
								description: 'Skills changelog slug',
								value: slug,
								required: true,
							},
						},
					},
				]
			: []),
		...(resourceId
			? [
					{
						command:
							'curl <base-url>/api/resources?slugOrId=<resource-id>&type=skill-changelog',
						description: 'Fetch the created skill changelog resource',
						params: {
							'base-url': {
								description: 'AI Hero app base URL',
								default: 'https://www.aihero.dev',
							},
							'resource-id': {
								description: 'Created content resource ID',
								value: resourceId,
								required: true,
							},
						},
					},
				]
			: []),
		{
			command: 'curl -X POST <base-url>/api/skills/changelog -d <json>',
			description: 'Create another skills changelog entry',
			params: {
				'base-url': {
					description: 'AI Hero app base URL',
					default: 'https://www.aihero.dev',
				},
				json: {
					description:
						'JSON body with title, body, newsletterCopy, and optional metadata',
					required: true,
				},
			},
		},
	]
}

export async function OPTIONS() {
	return jsonSuccess({ methods: ['POST', 'OPTIONS'] }, 200, [
		{
			command: 'curl -X POST <base-url>/api/skills/changelog -d <json>',
			description: 'Create a skills changelog entry',
		},
	])
}

const createSkillChangelogHandler = async (request: NextRequest) => {
	const requestId = guid()
	const operation = 'create_skill_changelog'

	try {
		const { ability, user } = await getUserAbilityForRequest(request)

		if (!user) {
			await log.warn('api.skills.changelog.post.unauthorized', {
				requestId,
				operation,
				route: '/api/skills/changelog',
				method: 'POST',
			})
			return jsonError({
				message: 'Unauthorized',
				code: 'UNAUTHORIZED',
				fix: 'Send an Authorization bearer token for a user that can create Content.',
				status: 401,
			})
		}

		if (!ability.can('create', 'Content')) {
			await log.warn('api.skills.changelog.post.forbidden', {
				requestId,
				operation,
				route: '/api/skills/changelog',
				method: 'POST',
				userId: user.id,
			})
			return jsonError({
				message: 'Forbidden',
				code: 'FORBIDDEN',
				fix: 'Use a token for a user with create Content ability.',
				status: 403,
			})
		}

		const body = await request.json()
		const payload = SkillChangelogPostSchema.safeParse(body)

		if (!payload.success) {
			await log.warn('api.skills.changelog.post.invalid_body', {
				requestId,
				operation,
				route: '/api/skills/changelog',
				method: 'POST',
				userId: user.id,
				issues: payload.error.issues.map((issue) => ({
					path: issue.path.join('.'),
					code: issue.code,
				})),
			})
			return jsonError({
				message: 'Invalid request body',
				code: 'INVALID_REQUEST_BODY',
				fix: 'Send title plus optional slug, description, body, newsletterCopy, newsletterSubject, newsletterPreviewText, github, videoResourceId, thumbnailTime, state, and visibility fields matching the schema.',
				status: 400,
				nextActions: createNextActions(),
			})
		}

		const input = payload.data
		const hash = guid()
		const resourceId = slugify(`${SKILL_CHANGELOG_RESOURCE_TYPE}~${hash}`)
		const baseSlug = input.slug || slugify(input.title)
		const slug = baseSlug.startsWith(SKILL_CHANGELOG_SLUG_PREFIX)
			? baseSlug
			: `${SKILL_CHANGELOG_SLUG_PREFIX}${baseSlug}`

		const existingResource = await getSkillChangelogForEdit(slug)

		if (existingResource) {
			await log.warn('api.skills.changelog.post.duplicate_slug', {
				requestId,
				operation,
				route: '/api/skills/changelog',
				method: 'POST',
				userId: user.id,
				resourceId: existingResource.id,
				slug,
				state: existingResource.fields.state,
				visibility: existingResource.fields.visibility,
			})
			return jsonError({
				message: `A skill changelog with slug "${slug}" already exists.`,
				code: 'SKILL_CHANGELOG_SLUG_EXISTS',
				fix: 'Fetch and update the existing skill changelog, or choose a unique slug before creating a new one.',
				status: 409,
				nextActions: createNextActions(slug, existingResource.id),
			})
		}

		const fields = {
			title: input.title.trim(),
			description: input.description,
			body: input.body,
			newsletterCopy: input.newsletterCopy,
			newsletterSubject: input.newsletterSubject,
			newsletterPreviewText: input.newsletterPreviewText,
			github: input.github,
			thumbnailTime: input.thumbnailTime,
			state: input.state,
			visibility: input.visibility,
			slug,
		}

		await log.info('api.skills.changelog.post.started', {
			requestId,
			operation,
			route: '/api/skills/changelog',
			method: 'POST',
			userId: user.id,
			resourceId,
			title: fields.title,
			slug,
			state: fields.state,
			visibility: fields.visibility,
			fieldNames: Object.keys(fields),
			hasNewsletterCopy: Boolean(fields.newsletterCopy),
			hasVideoResource: Boolean(input.videoResourceId),
			videoResourceId: input.videoResourceId,
		})

		await db.insert(contentResource).values({
			id: resourceId,
			type: SKILL_CHANGELOG_RESOURCE_TYPE,
			fields,
			createdById: user.id,
		})

		if (input.videoResourceId) {
			await db.insert(contentResourceResource).values({
				resourceOfId: resourceId,
				resourceId: input.videoResourceId,
			})
		}

		const resource = await db.query.contentResource.findFirst({
			where: eq(contentResource.id, resourceId),
			with: {
				resources: {
					with: { resource: true },
					orderBy: asc(contentResourceResource.position),
				},
			},
		})

		const parsed = ContentResourceSchema.safeParse(resource)

		if (!parsed.success) {
			await log.error('api.skills.changelog.post.parse_error', {
				requestId,
				operation,
				userId: user.id,
				resourceId,
				slug,
				error: parsed.error.message,
			})
			return jsonSuccess(
				{
					created: true,
					parsed: false,
					resourceId,
					slug,
					url: `/skills/${slug}`,
				},
				201,
				createNextActions(slug, resourceId),
			)
		}

		await upsertPostToTypeSense(
			parsed.data,
			fields.state === 'published' ? 'publish' : 'save',
		)

		let inngestEventId: string | null = null
		if (fields.state === 'published') {
			const sent = await inngest.send({
				name: SKILL_CHANGELOG_PUBLISHED_EVENT,
				data: {
					resourceId,
					slug,
				},
				user,
			})
			inngestEventId = Array.isArray(sent.ids) ? (sent.ids[0] ?? null) : null
		}

		await log.info('api.skills.changelog.post.success', {
			requestId,
			operation,
			route: '/api/skills/changelog',
			method: 'POST',
			userId: user.id,
			resourceId,
			slug,
			url: `/skills/${slug}`,
			hasNewsletterCopy: Boolean(fields.newsletterCopy),
			inngestEventId,
		})

		return jsonSuccess(
			{
				resource: parsed.data,
				url: `/skills/${slug}`,
				newsletterCopy: fields.newsletterCopy,
				requestId,
				inngestEventId,
			},
			201,
			createNextActions(slug, resourceId),
		)
	} catch (error) {
		await log.error('api.skills.changelog.post.failed', {
			requestId,
			operation,
			route: '/api/skills/changelog',
			method: 'POST',
			error: error instanceof Error ? error.message : 'Unknown error',
			stack: error instanceof Error ? error.stack : undefined,
		})
		return jsonError({
			message: 'Internal server error',
			code: 'INTERNAL_SERVER_ERROR',
			fix: 'Check structured logs for api.skills.changelog.post.failed with this requestId.',
			status: 500,
		})
	}
}

export const POST = withSkill(createSkillChangelogHandler)
