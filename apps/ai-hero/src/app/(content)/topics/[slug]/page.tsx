import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import LayoutClient from '@/components/layout-client'
import { HubLayout } from '@/components/navigation/hub-layout'
import { env } from '@/env.mjs'
import { type Post } from '@/lib/posts'
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

	return (
		<LayoutClient withContainer>
			<HubLayout>
				<main className="bg-background text-foreground min-h-[calc(100vh-var(--nav-height))]">
					<section className="border-b">
						<div className="flex flex-col gap-4 px-8 py-16 sm:px-16 md:py-24">
							<p className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
								Topic
							</p>
							<h1 className="text-3xl font-medium leading-tight tracking-tight text-balance sm:text-4xl">
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
							<ul className="bg-border flex flex-col gap-px border-b">
								{posts.map((post) => (
									<li key={post.id} className="bg-background">
										<TopicPostRow post={post} />
									</li>
								))}
							</ul>
						</section>
					) : (
						<section aria-label="No posts yet" className="border-b">
							<div className="bg-stripes flex items-center justify-center px-8 py-16 sm:px-16">
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

function TopicPostRow({ post }: { post: Post }) {
	return (
		<Link
			href={`/${post.fields.slug}`}
			className="focus-visible:ring-ring group flex flex-col gap-2 px-8 py-6 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none sm:px-16"
		>
			<h2 className="text-2xl font-semibold leading-tight tracking-tight text-balance group-hover:underline sm:text-3xl">
				{post.fields.title}
			</h2>
			{post.fields.description ? (
				<p className="max-w-[75ch] text-base leading-relaxed opacity-70">
					{post.fields.description}
				</p>
			) : null}
		</Link>
	)
}
