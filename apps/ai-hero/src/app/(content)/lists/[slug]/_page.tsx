// Used for root route /[post]

import * as React from 'react'
import { type Metadata, type ResolvingMetadata } from 'next'
import Link from 'next/link'
import { Contributor } from '@/components/contributor'
import { Share } from '@/components/share'
import type { List } from '@/lib/lists'
import { getAllLists, getList } from '@/lib/lists-query'
import { getServerAuthSession } from '@/server/auth'
import { compileMDX } from '@/utils/compile-mdx'
import { getOGImageUrlForResource } from '@/utils/get-og-image-url-for-resource'
import { Github, Share2 } from 'lucide-react'

import {
	Button,
	Dialog,
	DialogContent,
	DialogTitle,
	DialogTrigger,
} from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

type Props = {
	params: Promise<{ slug: string }>
}

export async function generateStaticParams() {
	const lists = await getAllLists()

	return lists
		.filter((list) => Boolean(list.fields?.slug))
		.map((list) => ({
			slug: list.fields?.slug,
		}))
}

export async function generateMetadata(
	props: Props,
	parent: ResolvingMetadata,
): Promise<Metadata> {
	const params = await props.params
	const list = await getList(params.slug)

	if (!list) {
		return parent as Metadata
	}

	return {
		title: list.fields.title,
		description: list.fields.description,
		openGraph: {
			images: [
				getOGImageUrlForResource({
					fields: { slug: list.fields.slug },
					id: list.id,
					updatedAt: list.updatedAt,
				}),
			],
		},
	}
}

/**
 * List landing page — deliberately simple and single-column: it's the
 * "Overview" of a series. The lesson-by-lesson navigation lives in the hub
 * sidebar (the list's own entry expands with an Overview row + lessons), so the
 * page is just a header, the body, and a plain lesson list below it. See
 * lat.md/decisions.md "List landing pages are simple overviews".
 */
export default async function ListPage(props: {
	list: List
	params: Promise<{ slug: string }>
}) {
	const list = props.list
	let body

	if (list.fields.body) {
		const { content } = await compileMDX(list.fields.body)
		body = content
	}

	const lessons = (list.resources ?? [])
		.map((entry: any) => entry?.resource)
		.filter((r: any) => r?.fields?.slug)
	const firstResourceHref = lessons[0]
		? `/${lessons[0].fields.slug}`
		: undefined

	return (
		<main className="bg-background text-foreground min-h-[calc(100vh-var(--nav-height))]">
			{/* Header */}
			<section className="border-b">
				<div className="flex flex-col gap-5 px-8 py-16 sm:px-16 md:py-20">
					<p className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
						Series
					</p>
					<h1 className="text-3xl font-medium leading-tight tracking-tight text-balance sm:text-4xl">
						{list.fields.title}
					</h1>
					{list.fields.description && (
						<p className="text-foreground/80 max-w-[65ch] text-lg leading-relaxed">
							{list.fields.description}
						</p>
					)}
					<div className="flex flex-wrap items-center gap-3 pt-2">
						{firstResourceHref && (
							<Button asChild size="lg" className="rounded-full">
								<Link href={firstResourceHref}>Start Learning</Link>
							</Button>
						)}
						{list.fields?.github && (
							<Button asChild variant="outline" size="lg" className="rounded-full">
								<Link href={list.fields.github} target="_blank">
									<Github className="mr-2 size-4" /> Code
								</Link>
							</Button>
						)}
						<Dialog>
							<DialogTrigger asChild>
								<Button variant="ghost" size="lg" className="rounded-full">
									<Share2 className="mr-2 size-4" /> Share
								</Button>
							</DialogTrigger>
							<DialogContent
								lockScroll={false}
								className="max-w-[min(640px,calc(100vw-2rem))] gap-0 overflow-hidden rounded-2xl p-0"
							>
								<DialogTitle className="border-b px-6 py-5 text-xl">
									Share
								</DialogTitle>
								<Share
									variant="dialog"
									title={list.fields.title}
									className="p-6"
								/>
							</DialogContent>
						</Dialog>
						<div className="ml-auto">
							<Contributor />
						</div>
					</div>
				</div>
			</section>

			{/* Body */}
			{body && (
				<section className="border-b">
					<article className="prose sm:prose-lg dark:prose-invert prose-headings:tracking-tight max-w-none px-8 py-12 sm:px-16 md:py-16 [&>*]:max-w-[70ch]">
						{body}
					</article>
				</section>
			)}

			{/* Lessons (moved below the body — the sidebar carries the live nav). */}
			{lessons.length > 0 && (
				<section>
					<div className="flex flex-col gap-6 py-16 md:py-20">
						<p className="px-8 font-mono text-[11px] font-medium uppercase tracking-wider opacity-60 sm:px-16">
							In this series
						</p>
						<ol className="bg-border flex flex-col gap-px border-y">
							{lessons.map((lesson: any, index: number) => (
								<li key={lesson.id} className="bg-background">
									<Link
										href={`/${lesson.fields.slug}`}
										className="focus-visible:ring-ring group flex items-center gap-4 px-8 py-5 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 sm:px-16"
									>
										<span className="text-muted-foreground/60 w-6 shrink-0 font-mono text-xs tabular-nums">
											{String(index + 1).padStart(2, '0')}
										</span>
										<span className="text-lg font-medium leading-snug tracking-tight text-balance group-hover:underline">
											{lesson.fields.title}
										</span>
									</Link>
								</li>
							))}
						</ol>
					</div>
				</section>
			)}
		</main>
	)
}

export async function ListActionBar({
	list,
	className,
}: {
	list: List | null
	className?: string
}) {
	const { ability } = await getServerAuthSession()

	return (
		<>
			{list && ability.can('update', 'Content') ? (
				<Button className={cn(className)} asChild variant="outline" size="sm">
					<Link href={`/lists/${list.fields?.slug || list.id}/edit`}>Edit</Link>
				</Button>
			) : null}
		</>
	)
}
