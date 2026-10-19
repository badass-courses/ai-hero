import { env } from '@/env.mjs'
import {
	getSandcastleDocs,
	getSandcastleDocsPage,
	sandcastlePageMarkdown,
} from '@/lib/sandcastle-docs'

import {
	createMarkdownResponse,
	markdownNotFoundResponse,
} from '../../route-utils'

export const revalidate = 3600
export const dynamicParams = true
export const dynamic = 'force-static'

/** `/sandcastle/<page>.md`: one docs page, as "Copy page" copies it. */
export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ slug: string }> },
) {
	const found = await getSandcastleDocsPage((await params).slug)
	if (!found) return markdownNotFoundResponse()
	return createMarkdownResponse(
		sandcastlePageMarkdown(found.page, env.COURSEBUILDER_URL),
	)
}

// A failed README fetch must not fail the build: with no params the pages
// render on first request instead.
export async function generateStaticParams() {
	const docs = await getSandcastleDocs().catch(() => null)
	return (docs?.pages ?? []).map((page) => ({ slug: page.slug }))
}
