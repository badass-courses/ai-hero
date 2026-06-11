import { getLesson } from '@/lib/lessons-query'
import { serializeToMarkdown } from '@/lib/markdown-serializer'
import { getTutorial } from '@/lib/tutorials-query'

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
	const tutorial = await getTutorial(module)

	if (!tutorial || !isPublishedPublicResource(tutorial)) {
		return markdownNotFoundResponse()
	}

	const lessonReference = findNestedResourceBySlug(tutorial.resources, lesson)

	if (!lessonReference?.resource?.id) {
		return markdownNotFoundResponse()
	}

	const lessonResource = await getLesson(lessonReference.resource.id)

	if (!lessonResource || !isPublishedPublicResource(lessonResource)) {
		return markdownNotFoundResponse()
	}

	const markdown = serializeToMarkdown(lessonResource)

	return createMarkdownResponse(markdown)
}
