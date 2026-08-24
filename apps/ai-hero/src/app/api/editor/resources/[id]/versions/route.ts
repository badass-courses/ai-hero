import { NextRequest } from 'next/server'
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

const listEditorResourceVersionsHandler = async (
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) => {
	const { id } = await params
	const auth = await authenticateEditorResourceRequest(request)
	if (!auth.ok) return auth.response

	try {
		const versions = await editorResourceService.listVersions(id, auth.context)
		await log.info('api.editor.resources.versions.success', {
			userId: auth.user.id,
			resourceId: id,
			resultCount: versions.length,
		})
		return editorResourceJson(versions)
	} catch (error) {
		return editorResourceErrorResponse(error, {
			action: 'list-versions',
			resourceId: id,
			userId: auth.user.id,
		})
	}
}

export const GET = withSkill(listEditorResourceVersionsHandler)
