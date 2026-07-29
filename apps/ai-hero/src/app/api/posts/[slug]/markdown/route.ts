import { NextResponse } from 'next/server'
import { getPost } from '@/lib/posts-query'

/**
 * GET /api/posts/[slug]/markdown
 *
 * The article's own source, for the "Copy page" button.
 *
 * It is a fetch-on-click rather than a prop because the alternative is shipping
 * the entire body a second time inside the RSC payload — the compiled MDX tree
 * is already there, and nobody who does not press the button needs the source.
 *
 * `getPost` (not `getCachedPost`) resolves the session and applies the same
 * ability rules the edit routes use, so a draft or private post is readable
 * here by exactly the people who can already read it on the page itself.
 */
export async function GET(
	_request: Request,
	props: { params: Promise<{ slug: string }> },
) {
	const { slug } = await props.params
	const post = await getPost(slug)

	if (!post?.fields?.body) {
		return NextResponse.json({ error: 'Not found' }, { status: 404 })
	}

	return new NextResponse(`# ${post.fields.title}\n\n${post.fields.body}`, {
		headers: {
			'Content-Type': 'text/markdown; charset=utf-8',
			// Per-viewer by construction (drafts differ by ability), so this is a
			// browser-only cache and never a shared one.
			'Cache-Control': 'private, max-age=60',
		},
	})
}
