import { getCachedCohort } from '@/lib/cohorts-query'
import {
	buildCompanionBlock,
	withCompanionBlock,
} from '@/lib/learner-agent/guide'
import { learnerSiteUrls } from '@/lib/learner-agent/site'
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

	const companion = buildCompanionBlock(learnerSiteUrls(), {
		title: cohort.fields.title,
		slug: cohort.fields.slug,
	})
	const markdown = withCompanionBlock(serializeToMarkdown(cohort), companion)

	return createMarkdownResponse(markdown)
}
