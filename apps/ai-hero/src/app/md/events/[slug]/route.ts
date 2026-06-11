import { getEvent } from '@/lib/events-query'
import { serializeToMarkdown } from '@/lib/markdown-serializer'

import {
	createMarkdownResponse,
	isPublishedPublicResource,
	markdownNotFoundResponse,
} from '../../route-utils'

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ slug: string }> },
) {
	const { slug } = await params
	const event = await getEvent(slug)

	if (!event || !isPublishedPublicResource(event)) {
		return markdownNotFoundResponse()
	}

	const markdown = serializeToMarkdown(event)

	return createMarkdownResponse(markdown)
}
