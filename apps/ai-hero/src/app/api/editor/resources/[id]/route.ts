import { NextRequest } from 'next/server'
import {
	EditorResourceMutationRequestSchema,
	parseEditorResourceEtag,
} from '@/lib/editor-resource'
import { editorResourceService } from '@/lib/editor-resource-drizzle'
import {
	authenticateEditorResourceRequest,
	editorResourceErrorResponse,
	editorResourceJson,
	editorResourceOptionsResponse,
} from '@/server/editor-resource-route'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'

export async function OPTIONS() {
	return editorResourceOptionsResponse()
}

type RouteContext = { params: Promise<{ id: string }> }

const getEditorResourceHandler = async (
	request: NextRequest,
	{ params }: RouteContext,
) => {
	const { id } = await params
	const auth = await authenticateEditorResourceRequest(request)
	if (!auth.ok) return auth.response

	try {
		const result = await editorResourceService.get(id, auth.context)
		await log.info('api.editor.resources.get.success', {
			userId: auth.user.id,
			resourceId: id,
		})
		return editorResourceJson(result, { revision: result.revision })
	} catch (error) {
		return editorResourceErrorResponse(error, {
			action: 'get',
			resourceId: id,
			userId: auth.user.id,
		})
	}
}

const updateEditorResourceHandler = async (
	request: NextRequest,
	{ params }: RouteContext,
) => {
	const { id } = await params
	const auth = await authenticateEditorResourceRequest(request)
	if (!auth.ok) return auth.response

	const expectedRevision = parseEditorResourceEtag(
		request.headers.get('If-Match'),
	)
	if (!expectedRevision) {
		return editorResourceJson(
			{ error: 'If-Match with the last read ETag is required' },
			{ status: 428 },
		)
	}

	try {
		const parsed = EditorResourceMutationRequestSchema.safeParse(
			await request.json(),
		)
		if (!parsed.success) {
			return editorResourceJson(
				{ error: 'Invalid input', issues: parsed.error.issues },
				{ status: 400 },
			)
		}

		const result = await editorResourceService.update(
			id,
			parsed.data,
			expectedRevision,
			auth.context,
		)
		return editorResourceJson(result, { revision: result.revision })
	} catch (error) {
		return editorResourceErrorResponse(error, {
			action: 'update',
			resourceId: id,
			userId: auth.user.id,
		})
	}
}

export const GET = withSkill(getEditorResourceHandler)
export const PATCH = withSkill(updateEditorResourceHandler)
