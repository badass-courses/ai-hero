import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import LayoutClient from '@/components/layout-client'
import { ResourceRow } from '@/components/landing/resource-row'
import { HubLayout } from '@/components/navigation/hub-layout'
import { env } from '@/env.mjs'
import { type Post } from '@/lib/posts'
import { getCachedGoalSectionItems, type ResolvedItem } from '@/lib/goal-sections-query'
import { getCachedPostsByTag } from '@/lib/posts-query'
import { getCachedTopicTag } from '@/lib/topics-query'

type Props = {
	params: Promise<{ slug: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
	const { slug } = await params
	const tag = await getCachedTopicTag(slug)

	if (!tag) return {}

	const title = `${tag.fields.label} | AI Hero`
	const description =
		tag.fields.description ??
		`Posts about ${tag.fields.label} on AI Hero, free AI engineering resources.`

	return {
		title,
		description,
		openGraph: {
			title,
			description,
			images: [
				{
					url: `${env.NEXT_PUBLIC_URL}/api/og?title=${encodeURIComponent(tag.fields.label)}`,
				},
			],
		},
	}
}

/**
 * Topic hub page: every published, public post carrying the topic tag, newest
 * first. Renders in hub mode (sidebar via `HubLayout`; `/topics` is a
 * HUB_PREFIX in `nav-mode.ts`). 404s for unknown slugs and for
 * `skill-phase`-context tags, which are cycle phases rather than topics.
 */
export default async function TopicPage({ params }: Props) {
	const { slug } = await params
	const tag = await getCachedTopicTag(slug)

	if (!tag) {
		notFound()
	}

	const posts = await getCachedPostsByTag(slug)
	// Thumbnails, not just cover images. Most posts here are videos, and the
	// by-tag query does not join videoResource — so on cover images alone one
	// row in nine had artwork and the rest fell through to stripes. This
	// resolver already derives mux and YouTube thumbnails and is cached on the
	// same 'posts' tag; one batched call beats duplicating that derivation.
	const resolved = await getCachedGoalSectionItems(
		posts.map((post) => post.fields.slug),
	)

	return (
		<LayoutClient withContainer withFooter={false}>
			<HubLayout>
				<main className="bg-background text-foreground min-h-[calc(100vh-var(--nav-height))]">
					<section className="border-b">
						<div className="flex flex-col gap-6 px-8 py-16 sm:px-11 md:py-24">
							<p className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
								Topic
							</p>
							<h1 className="text-4xl font-normal leading-[1.05] tracking-tight text-balance sm:text-5xl">
								{tag.fields.label}
							</h1>
							{tag.fields.description ? (
								<p className="max-w-[65ch] text-base leading-relaxed opacity-80 sm:text-lg">
									{tag.fields.description}
								</p>
							) : null}
						</div>
					</section>

					{posts.length > 0 ? (
						<section aria-label={`Posts about ${tag.fields.label}`}>
							{/* No `gap-px` line layer here: `ResourceRow` draws its own
							    collapsing `-mt-px border-y`, and a container hairline
							    underneath it shows through the row's hover inset as a
							    stray line across the gradient. */}
							<ul className="flex flex-col">
								{posts.map((post) => (
									<li key={post.id}>
										<TopicPostRow
											post={post}
											resolved={resolved.get(post.fields.slug)}
										/>
									</li>
								))}
							</ul>
						</section>
					) : (
						<section aria-label="No posts yet" className="border-b">
							<div className="bg-stripes flex items-center justify-center px-8 py-16 sm:px-11 md:py-24">
								<p className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
									No posts yet
								</p>
							</div>
						</section>
					)}
				</main>
			</HubLayout>
		</LayoutClient>
	)
}

/**
 * Topic listing row — the landing page's `ResourceRow`, not a bespoke one.
 *
 * These were title-plus-description text blocks, which made a topic page a
 * wall of prose with nothing to scan by. The landing rows already solve that
 * (artwork, format label, the gradient hover), and a reader arriving here from
 * the homepage should not meet a different listing idiom one click in.
 *
 * Posts with no cover image fall through to `bg-stripes`, the sanctioned empty
 * image slot (DESIGN rule 6), so a row is never a flat grey box.
 */
function TopicPostRow({
	post,
	resolved,
}: {
	post: Post
	resolved?: ResolvedItem
}) {
	const image = resolved?.thumbnailUrl || post.fields.coverImage?.url || undefined
	const label = resolved?.isVideo ? 'Video' : 'Article'

	return (
		<ResourceRow
			title={post.fields.title}
			description={post.fields.description ?? undefined}
			href={`/${post.fields.slug}`}
			image={image}
			typeLabel={label}
			meta={resolved?.durationLabel}
			fallbackPlaceholder={label}
		/>
	)
}
