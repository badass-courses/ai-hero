import { serializeToMarkdown } from '@/lib/markdown-serializer'
import { getProduct } from '@/lib/products-query'

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
	const product = await getProduct(slug)

	if (!product || !isPublishedPublicResource(product)) {
		return markdownNotFoundResponse()
	}

	const markdown = serializeToMarkdown({
		id: product.id,
		type: 'product',
		fields: {
			title: product.name,
			slug: product.fields.slug,
			description: product.fields.description,
			body: product.fields.body,
		},
	})

	return createMarkdownResponse(markdown)
}
