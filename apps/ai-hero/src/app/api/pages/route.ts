import { NextRequest, NextResponse } from 'next/server'
import { courseBuilderAdapter, db } from '@/db'
import { contentResource } from '@/db/schema'
import { getPage } from '@/lib/pages-query'
import { PageSchema } from '@/lib/pages'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'
import { guid } from '@coursebuilder/utils/guid'
import slugify from '@sindresorhus/slugify'
import { and, desc, eq } from 'drizzle-orm'
import { revalidateTag } from 'next/cache'
import { z } from 'zod'

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export async function OPTIONS() {
	return NextResponse.json({}, { headers: corsHeaders })
}

const UpdatePageSchema = z.object({
	fields: z
		.object({
			title: z.string().min(2).max(90).optional(),
			body: z.string().nullable().optional(),
			description: z.string().optional(),
			slug: z.string().optional(),
			state: z
				.union([
					z.literal('draft'),
					z.literal('published'),
					z.literal('archived'),
					z.literal('deleted'),
				])
				.optional(),
			visibility: z
				.union([
					z.literal('public'),
					z.literal('private'),
					z.literal('unlisted'),
				])
				.optional(),
		})
		.partial(),
})

const getPagesHandler = async (request: NextRequest) => {
	const { searchParams } = new URL(request.url)
	const slugOrId = searchParams.get('slugOrId')

	try {
		const { ability, user } = await getUserAbilityForRequest(request)

		if (!user) {
			await log.warn('api.pages.get.unauthorized', {})
			return NextResponse.json(
				{ error: 'Unauthorized' },
				{ status: 401, headers: corsHeaders },
			)
		}

		if (ability.cannot('manage', 'all')) {
			await log.warn('api.pages.get.forbidden', { userId: user.id })
			return NextResponse.json(
				{ error: 'Forbidden: Admin access required' },
				{ status: 403, headers: corsHeaders },
			)
		}

		if (slugOrId) {
			const page = await getPage(slugOrId)
			if (!page) {
				return NextResponse.json(
					{ error: 'Page not found' },
					{ status: 404, headers: corsHeaders },
				)
			}
			await log.info('api.pages.get.success', {
				userId: user.id,
				pageId: page.id,
			})
			return NextResponse.json(page, { headers: corsHeaders })
		}

		const rows = await db.query.contentResource.findMany({
			where: eq(contentResource.type, 'page'),
			orderBy: desc(contentResource.createdAt),
		})

		const parsed = z.array(PageSchema).safeParse(rows)
		const pages = parsed.success ? parsed.data : []

		await log.info('api.pages.get.success', {
			userId: user.id,
			resultCount: pages.length,
		})
		return NextResponse.json(pages, { headers: corsHeaders })
	} catch (error) {
		await log.error('api.pages.get.failed', {
			error: error instanceof Error ? error.message : 'Unknown error',
			stack: error instanceof Error ? error.stack : undefined,
			slugOrId,
		})
		return NextResponse.json(
			{ error: 'Internal server error' },
			{ status: 500, headers: corsHeaders },
		)
	}
}
export const GET = withSkill(getPagesHandler)

const updatePageHandler = async (request: NextRequest) => {
	const { searchParams } = new URL(request.url)
	const id = searchParams.get('id')

	try {
		const { ability, user } = await getUserAbilityForRequest(request)

		if (!user) {
			await log.warn('api.pages.put.unauthorized', { pageId: id })
			return NextResponse.json(
				{ error: 'Unauthorized' },
				{ status: 401, headers: corsHeaders },
			)
		}

		if (ability.cannot('update', 'Content')) {
			await log.warn('api.pages.put.forbidden', { userId: user.id, pageId: id })
			return NextResponse.json(
				{ error: 'Forbidden: Insufficient permissions' },
				{ status: 403, headers: corsHeaders },
			)
		}

		if (!id) {
			return NextResponse.json(
				{ error: 'Missing page id' },
				{ status: 400, headers: corsHeaders },
			)
		}

		const body = await request.json()
		const parsed = UpdatePageSchema.safeParse(body)
		if (!parsed.success) {
			return NextResponse.json(
				{ error: 'Invalid input', details: parsed.error.format() },
				{ status: 400, headers: corsHeaders },
			)
		}

		const currentPage = await getPage(id)
		if (!currentPage) {
			return NextResponse.json(
				{ error: 'Page not found' },
				{ status: 404, headers: corsHeaders },
			)
		}

		const incoming = parsed.data.fields
		let nextSlug = incoming.slug ?? currentPage.fields.slug
		if (incoming.title && incoming.title !== currentPage.fields.title) {
			const [, suffix = guid()] = currentPage.fields.slug.split('~')
			nextSlug = `${slugify(incoming.title)}~${suffix}`
		}

		await log.info('api.pages.put.started', {
			userId: user.id,
			pageId: id,
			changes: Object.keys(incoming),
		})

		const updated = await courseBuilderAdapter.updateContentResourceFields({
			id: currentPage.id,
			fields: {
				...currentPage.fields,
				...incoming,
				slug: nextSlug,
			},
		})

		revalidateTag('pages', 'max')

		await log.info('api.pages.put.success', {
			userId: user.id,
			pageId: id,
		})

		return NextResponse.json(updated, { headers: corsHeaders })
	} catch (error) {
		await log.error('api.pages.put.failed', {
			error: error instanceof Error ? error.message : 'Unknown error',
			stack: error instanceof Error ? error.stack : undefined,
			pageId: id,
		})
		return NextResponse.json(
			{ error: 'Internal server error' },
			{ status: 500, headers: corsHeaders },
		)
	}
}
export const PUT = withSkill(updatePageHandler)
