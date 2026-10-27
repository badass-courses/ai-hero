import { env } from '@/env.mjs'
import {
	getSandcastleDocs,
	sandcastleDocsMarkdown,
} from '@/lib/sandcastle-docs'

import { createMarkdownResponse } from '../route-utils'

export const revalidate = 3600
export const dynamic = 'force-static'

/** `/sandcastle.md`: the whole docs in one file, for an agent's context. */
export async function GET() {
	const docs = await getSandcastleDocs()
	return createMarkdownResponse(
		sandcastleDocsMarkdown(docs, env.COURSEBUILDER_URL),
	)
}
