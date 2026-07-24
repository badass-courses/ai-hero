import { buildCourseSyncOpenApiDocument } from '@/course-sync/openapi'

export async function GET(request: Request) {
	const url = new URL(request.url)
	return Response.json(buildCourseSyncOpenApiDocument(url.origin), {
		headers: { 'Cache-Control': 'public, max-age=300' },
	})
}
