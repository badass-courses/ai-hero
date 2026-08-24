import { NextRequest } from 'next/server'
import { EditorResourceRollbackRequestSchema } from '@/lib/editor-resource'
import { editorResourceService } from '@/lib/editor-resource-drizzle'
import {
	AIH_EXPECTED_REVISION_HEADER,
	authenticateEditorResourceRequest,
	editorResourceErrorResponse,
	editorResourceJson,
	editorResourceOptionsResponse,
} from '@/server/editor-resource-route'
import { withSkill } from '@/server/with-skill'

export async function OPTIONS() {
	return editorResourceOptionsResponse()
}

const rollbackEditorResourceHandler = async (
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
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
		const parsed = EditorResourceRollbackRequestSchema.safeParse(body)
		if (!parsed.success) {
			return editorResourceJson(
				{ error: 'Invalid input', issues: parsed.error.issues },
				{ status: 400 },
			)
		}

		const result = await editorResourceService.rollback(
			id,
			parsed.data.versionId,
			expectedRevision,
			auth.context,
		)
		return editorResourceJson(result, { revision: result.revision })
	} catch (error) {
		return editorResourceErrorResponse(error, {
			action: 'rollback',
			resourceId: id,
			userId: auth.user.id,
		})
	}
}

export const POST = withSkill(rollbackEditorResourceHandler)
