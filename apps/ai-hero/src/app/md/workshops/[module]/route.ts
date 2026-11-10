import {
	buildCompanionBlock,
	withCompanionBlock,
} from '@/lib/learner-agent/guide'
import { learnerSiteUrls } from '@/lib/learner-agent/site'
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

	const companion = buildCompanionBlock(learnerSiteUrls(), {
		title: workshop.fields.title,
		slug: workshop.fields.slug,
	})
	const markdown = withCompanionBlock(serializeToMarkdown(workshop), companion)

	return createMarkdownResponse(markdown)
}
