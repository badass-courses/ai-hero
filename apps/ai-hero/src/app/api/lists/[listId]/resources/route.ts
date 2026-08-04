import { NextRequest, NextResponse } from 'next/server'
import {
	addItemToList,
	ListMembershipError,
	moveListItems,
	removeItemFromList,
} from '@/lib/lists/list-membership.service'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, PUT, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export async function OPTIONS() {
	return NextResponse.json({}, { headers: corsHeaders })
}

type RouteContext = { params: Promise<{ listId: string }> }

/** `listId` accepts an id or a slug, like the rest of the content API. */
async function listIdFrom(context: RouteContext) {
	const { listId } = await context.params
	return decodeURIComponent(listId)
}

function errorResponse(error: unknown) {
	if (error instanceof ListMembershipError) {
		return NextResponse.json(
			{ code: error.code, error: error.message, details: error.details },
			{ status: error.statusCode, headers: corsHeaders },
		)
	}
	return NextResponse.json(
		{ code: 'INTERNAL_ERROR', error: 'Internal server error' },
		{ status: 500, headers: corsHeaders },
	)
}

/**
 * POST /api/lists/<listIdOrSlug>/resources
 *
 * Add a resource to a list, or to one of its sections.
 * Body: { resourceId, parentId?, metadata? }
 *
 * Appends after the last sibling. Requires 'update Content'.
 */
const addHandler = async (request: NextRequest, context: RouteContext) => {
	const listId = await listIdFrom(context)

	try {
		const { ability, user } = await getUserAbilityForRequest(request)
		if (!user) {
			await log.warn('api.lists.resources.post.unauthorized', { listId })
			return NextResponse.json(
				{ code: 'UNAUTHORIZED', error: 'Unauthorized', docs: '/api' },
				{ status: 401, headers: corsHeaders },
			)
		}

		const body = await request.json()
		await log.info('api.lists.resources.post.started', {
			userId: user.id,
			listId,
			resourceId: body?.resourceId,
			parentId: body?.parentId ?? null,
		})

		const result = await addItemToList({
			listIdOrSlug: listId,
			data: body,
			ability,
		})

		await log.info('api.lists.resources.post.success', {
			userId: user.id,
			listId,
			resourceId: body?.resourceId,
		})

		return NextResponse.json(result, { status: 201, headers: corsHeaders })
	} catch (error) {
		await log.error('api.lists.resources.post.failed', {
			error: error instanceof Error ? error.message : 'Unknown error',
			stack: error instanceof Error ? error.stack : undefined,
			listId,
		})
		return errorResponse(error)
	}
}

/**
 * PUT /api/lists/<listIdOrSlug>/resources
 *
 * Reorder items and/or move them between sections in one transaction.
 * Body: { items: [{ resourceId, parentId?, position }] }
 *
 * `parentId` omitted keeps an item where it is; passing the list's own id
 * pulls it out of a section. Requires 'update Content'.
 */
const moveHandler = async (request: NextRequest, context: RouteContext) => {
	const listId = await listIdFrom(context)

	try {
		const { ability, user } = await getUserAbilityForRequest(request)
		if (!user) {
			await log.warn('api.lists.resources.put.unauthorized', { listId })
			return NextResponse.json(
				{ code: 'UNAUTHORIZED', error: 'Unauthorized', docs: '/api' },
				{ status: 401, headers: corsHeaders },
			)
		}

		const body = await request.json()
		await log.info('api.lists.resources.put.started', {
			userId: user.id,
			listId,
			itemCount: Array.isArray(body?.items) ? body.items.length : null,
		})

		const result = await moveListItems({
			listIdOrSlug: listId,
			data: body,
			ability,
		})

		await log.info('api.lists.resources.put.success', {
			userId: user.id,
			listId,
			itemCount: result.length,
		})

		return NextResponse.json(result, { headers: corsHeaders })
	} catch (error) {
		await log.error('api.lists.resources.put.failed', {
			error: error instanceof Error ? error.message : 'Unknown error',
			stack: error instanceof Error ? error.stack : undefined,
			listId,
		})
		return errorResponse(error)
	}
}

/**
 * DELETE /api/lists/<listIdOrSlug>/resources?resourceId=<id>&parentId=<id>
 *
 * Remove a resource from a list. `parentId` names the placement when the
 * resource sits in more than one; omitted, the top-level placement wins.
 * Requires 'update Content'.
 */
const removeHandler = async (request: NextRequest, context: RouteContext) => {
	const listId = await listIdFrom(context)
	const searchParams = new URL(request.url).searchParams
	const resourceId = searchParams.get('resourceId')
	const parentId = searchParams.get('parentId')

	try {
		const { ability, user } = await getUserAbilityForRequest(request)
		if (!user) {
			await log.warn('api.lists.resources.delete.unauthorized', {
				listId,
				resourceId,
			})
			return NextResponse.json(
				{ code: 'UNAUTHORIZED', error: 'Unauthorized', docs: '/api' },
				{ status: 401, headers: corsHeaders },
			)
		}

		if (!resourceId) {
			return NextResponse.json(
				{ code: 'MISSING_ID', error: 'Missing resourceId query parameter' },
				{ status: 400, headers: corsHeaders },
			)
		}

		await log.info('api.lists.resources.delete.started', {
			userId: user.id,
			listId,
			resourceId,
		})

		const result = await removeItemFromList({
			listIdOrSlug: listId,
			resourceId,
			parentId: parentId ?? undefined,
			ability,
		})

		await log.info('api.lists.resources.delete.success', {
			userId: user.id,
			listId,
			resourceId,
		})

		return NextResponse.json(result, { headers: corsHeaders })
	} catch (error) {
		await log.error('api.lists.resources.delete.failed', {
			error: error instanceof Error ? error.message : 'Unknown error',
			stack: error instanceof Error ? error.stack : undefined,
			listId,
			resourceId,
		})
		return errorResponse(error)
	}
}

export const POST = withSkill(addHandler)
export const PUT = withSkill(moveHandler)
export const DELETE = withSkill(removeHandler)
