import {
	authorizeCourseSyncRequest,
	courseSyncErrorResponse,
	courseSyncJson,
} from '@/course-sync/http'
import { courseSyncControlPlane } from '@/course-sync/runtime'

export async function GET(
	request: Request,
	context: { params: Promise<{ bindingId: string }> },
) {
	try {
		authorizeCourseSyncRequest(request, 'read')
		const { bindingId } = await context.params
		return courseSyncJson(await courseSyncControlPlane.getBinding(bindingId))
	} catch (error) {
		return courseSyncErrorResponse(error)
	}
}
