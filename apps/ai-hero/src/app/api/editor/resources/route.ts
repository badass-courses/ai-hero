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

const listEditorResourcesHandler = async (request: NextRequest) => {
	const auth = await authenticateEditorResourceRequest(request)
	if (!auth.ok) return auth.response

	try {
		const resources = await editorResourceService.list(auth.context)
		await log.info('api.editor.resources.list.success', {
			userId: auth.user.id,
			resultCount: resources.length,
		})
		return editorResourceJson(resources)
	} catch (error) {
		return editorResourceErrorResponse(error, {
			action: 'list',
			userId: auth.user.id,
		})
	}
}

export const GET = withSkill(listEditorResourcesHandler)
