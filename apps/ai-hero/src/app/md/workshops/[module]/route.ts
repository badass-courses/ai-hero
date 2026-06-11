import { serializeToMarkdown } from '@/lib/markdown-serializer'
import { getWorkshop } from '@/lib/workshops-query'

import {
	createMarkdownResponse,
	isPublishedPublicResource,
	markdownNotFoundResponse,
} from '../../route-utils'

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ module: string }> },
) {
	const { module } = await params
	const workshop = await getWorkshop(module)

	if (!workshop || !isPublishedPublicResource(workshop)) {
		return markdownNotFoundResponse()
	}

	const markdown = serializeToMarkdown(workshop)

	return createMarkdownResponse(markdown)
}
