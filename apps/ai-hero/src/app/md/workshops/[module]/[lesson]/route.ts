import { getLesson } from '@/lib/lessons-query'
import { serializeToMarkdown } from '@/lib/markdown-serializer'
import { getWorkshop } from '@/lib/workshops-query'

import {
	createMarkdownResponse,
	findNestedResourceBySlug,
	isPublishedPublicResource,
	markdownNotFoundResponse,
} from '../../../route-utils'

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ module: string; lesson: string }> },
) {
	const { module, lesson } = await params
	const workshop = await getWorkshop(module)

	if (!workshop || !isPublishedPublicResource(workshop)) {
		return markdownNotFoundResponse()
	}

	const lessonReference = findNestedResourceBySlug(workshop.resources, lesson)

	if (!lessonReference?.resource?.id) {
		return markdownNotFoundResponse()
	}

	if (lessonReference.metadata?.tier !== 'free') {
		return markdownNotFoundResponse()
	}

	const lessonResource = await getLesson(lessonReference.resource.id)

	if (!lessonResource || !isPublishedPublicResource(lessonResource)) {
		return markdownNotFoundResponse()
	}

	const markdown = serializeToMarkdown(lessonResource)

	return createMarkdownResponse(markdown)
}
