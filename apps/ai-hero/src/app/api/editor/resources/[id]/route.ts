import { NextRequest } from 'next/server'
import { EditorResourceMutationRequestSchema } from '@/lib/editor-resource'
import { editorResourceService } from '@/lib/editor-resource-drizzle'
import {
	AIH_EXPECTED_REVISION_HEADER,
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

	const expectedRevision = request.headers
		.get(AIH_EXPECTED_REVISION_HEADER)
		?.trim()
	if (!expectedRevision) {
		return editorResourceJson(
			{
				error: `${AIH_EXPECTED_REVISION_HEADER} with the last read revision is required`,
			},
			{ status: 428 },
		)
	}

	try {
		let body: unknown
		try {
			body = await request.json()
		} catch {
			return editorResourceJson(
				{ error: 'Malformed JSON', code: 'invalid-input' },
				{ status: 400 },
			)
		}
		const parsed = EditorResourceMutationRequestSchema.safeParse(body)
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
