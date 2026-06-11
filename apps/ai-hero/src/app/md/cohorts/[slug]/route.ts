import { getCachedCohort } from '@/lib/cohorts-query'
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
	const cohort = await getCachedCohort(slug)

	if (!cohort || !isPublishedPublicResource(cohort)) {
		return markdownNotFoundResponse()
	}

	const markdown = serializeToMarkdown(cohort)

	return createMarkdownResponse(markdown)
}
