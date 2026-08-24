import { serializeToMarkdown } from '@/lib/markdown-serializer'
import { getCachedAllLists } from '@/lib/lists-query'
import { getCachedAllPosts, getCachedPostOrList } from '@/lib/posts-query'

import {
	createMarkdownResponse,
	isPublishedPublicResource,
	markdownNotFoundResponse,
} from '../route-utils'

export const revalidate = 3600
export const dynamicParams = true
export const dynamic = 'force-static'

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

export async function generateStaticParams() {
	const [posts, lists] = await Promise.all([
		getCachedAllPosts(),
		getCachedAllLists(),
	])

	return [...posts, ...lists]
		.filter(
			(resource) =>
				Boolean(resource.fields.slug) &&
				resource.fields.state === 'published' &&
				resource.fields.visibility === 'public',
		)
		.map((resource) => ({ slug: resource.fields.slug }))
}
