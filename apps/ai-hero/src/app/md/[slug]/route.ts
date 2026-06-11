import { serializeToMarkdown } from '@/lib/markdown-serializer'
import { getCachedPostOrList } from '@/lib/posts-query'

import {
	createMarkdownResponse,
	isPublishedPublicResource,
	markdownNotFoundResponse,
} from '../route-utils'

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ slug: string }> },
) {
	const { slug } = await params
	const content = await getCachedPostOrList(slug)

	if (!content) {
		return markdownNotFoundResponse()
	}

	if (!isPublishedPublicResource(content)) {
		return markdownNotFoundResponse()
	}

	const markdown = serializeToMarkdown(content)

	return createMarkdownResponse(markdown)
}
