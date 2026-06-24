import type { Metadata, ResolvingMetadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ContentReadTracker } from '@/components/content-read-tracker'
import { Contributor } from '@/components/contributor'
import LayoutClient from '@/components/layout-client'
import { HubLayout } from '@/components/navigation/hub-layout'
import { PrimaryNewsletterCta } from '@/components/primary-newsletter-cta'
import { Share } from '@/components/share'
import {
	AI_CODING_DICTIONARY_DESCRIPTION,
	AI_CODING_DICTIONARY_TITLE,
	getAiCodingDictionary,
	getAiCodingDictionaryEntry,
	getAiCodingDictionaryOgImageUrl,
	type DictionaryEntry,
} from '@/lib/ai-coding-dictionary'
import { DictionaryEntryStructuredData } from '@/lib/structured-data'
import { compileMDX } from '@/utils/compile-mdx'
import { ArrowLeft, ArrowRight } from 'lucide-react'

import { CopyPageButton } from '../../_components/copy-page-button'

export const revalidate = 3600

type Props = {
	params: Promise<{ slug: string }>
}

export default async function DictionaryEntryPage({ params }: Props) {
	const { slug } = await params
	const [dictionary, entry] = await Promise.all([
		getAiCodingDictionary(),
		getAiCodingDictionaryEntry(slug),
	])

	if (!entry) {
		notFound()
	}

	const currentIndex = dictionary.entries.findIndex(
		(dictionaryEntry) => dictionaryEntry.slug === entry.slug,
	)
	const previousEntry =
		currentIndex > 0 ? (dictionary.entries[currentIndex - 1] ?? null) : null
	const nextEntry =
		currentIndex >= 0 && currentIndex < dictionary.entries.length - 1
			? (dictionary.entries[currentIndex + 1] ?? null)
			: null
	const markdownToCopy = `# ${entry.title}\n\n${entry.rawBody}`

	return (
		<LayoutClient withContainer>
			<HubLayout>
			<ContentReadTracker
				contentId={`ai-coding-dictionary:${entry.slug}`}
				contentType="dictionary-entry"
				contentSlug={entry.slug}
				parentSlug="ai-coding-dictionary"
			/>
			<main className="bg-background text-foreground">
				<DictionaryEntryStructuredData entry={entry} dictionary={dictionary} />

				<div className="border-border flex items-center border-b px-8 py-4 sm:px-16">
					<Link
						href="/ai-coding-dictionary"
						className="text-muted-foreground hover:text-foreground group inline-flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-wider transition-colors"
					>
						<ArrowLeft
							aria-hidden
							className="size-3.5 transition-transform duration-200 ease-out group-hover:-translate-x-0.5"
						/>
						AI Coding Dictionary
					</Link>
				</div>

				<header className="border-border border-b">
					<div className="flex flex-col gap-5 px-8 py-12 sm:px-16 sm:py-16">
						<p className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
							{entry.sectionTitle}
						</p>
						<h1 className="text-balance font-sans text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl">
							{entry.title}
						</h1>
						{entry.description ? (
							<p className="text-muted-foreground max-w-3xl text-balance text-xl font-light leading-tight tracking-tight sm:text-2xl">
								{entry.description}
							</p>
						) : null}
						<div className="mt-2 flex flex-wrap items-center gap-5">
							<Contributor className="flex [&_img]:w-8" />
							<CopyPageButton markdown={markdownToCopy} />
						</div>
					</div>
				</header>

				<DictionaryEntryBody body={entry.body} />

				<DictionaryEntryNav previous={previousEntry} next={nextEntry} />

				<PrimaryNewsletterCta
					id="dictionary-entry-newsletter-cta"
					isHiddenForSubscribers
					className="not-prose border-t py-16 [&_button]:w-full"
					actionLabel="Get AI Hero updates"
					fields={{
						interest: 'dictionary',
						source: 'aihero_dictionary_entry',
					}}
					trackProps={{
						event: 'subscribed',
						params: { location: 'dictionary-entry', post: entry.slug },
					}}
				>
					<div className="relative z-10 flex max-w-3xl flex-col items-center justify-center px-5 pb-5 pt-10 text-center sm:pb-10">
						<h2 className="font-sans text-2xl font-medium leading-tight tracking-tight sm:text-3xl">
							Want more than vocabulary?
						</h2>
						<p className="text-muted-foreground mt-3 max-w-2xl text-base leading-7">
							Join AI Hero for practical skills, thinking on AI engineering, and
							resources that keep you ahead of the curve.
						</p>
					</div>
				</PrimaryNewsletterCta>

				<div className="border-border flex flex-wrap items-center justify-center gap-5 border-t px-8 sm:px-16">
					<strong className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
						Share
					</strong>
					<Share
						className="inline-flex rounded-none border-y-0"
						title={entry.title}
					/>
				</div>
			</main>
			</HubLayout>
		</LayoutClient>
	)
}

async function DictionaryEntryBody({ body }: { body: string }) {
	const { content } = await compileMDX(body, {}, {})

	return (
		<div className="border-border border-b px-8 py-12 sm:px-16 sm:py-16">
			<article className="prose prose-hr:border-border dark:prose-invert dark:prose-a:text-primary prose-a:text-blue-600 sm:prose-lg lg:prose-lg prose-p:max-w-4xl prose-headings:max-w-4xl prose-ul:max-w-4xl prose-table:max-w-4xl prose-pre:max-w-4xl **:data-pre:max-w-4xl max-w-none">
				{content}
			</article>
		</div>
	)
}

function DictionaryEntryNav({
	previous,
	next,
}: {
	previous: DictionaryEntry | null
	next: DictionaryEntry | null
}) {
	if (!previous && !next) return null

	return (
		<nav
			aria-label="Dictionary entry navigation"
			className="bg-border grid grid-cols-1 gap-px sm:grid-cols-2"
		>
			{previous ? (
				<NavTile entry={previous} direction="previous" />
			) : (
				<div aria-hidden className="bg-background hidden sm:block" />
			)}
			{next ? (
				<NavTile entry={next} direction="next" />
			) : (
				<div aria-hidden className="bg-background hidden sm:block" />
			)}
		</nav>
	)
}

function NavTile({
	entry,
	direction,
}: {
	entry: DictionaryEntry
	direction: 'previous' | 'next'
}) {
	const isPrev = direction === 'previous'
	return (
		<Link
			href={`/ai-coding-dictionary/${entry.slug}`}
			prefetch={false}
			className="bg-background hover:bg-muted/40 group relative flex min-h-32 flex-col justify-between gap-4 p-8 transition-colors sm:p-10"
		>
			<span className="text-muted-foreground group-hover:text-foreground inline-flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-wider transition-colors">
				{isPrev ? (
					<>
						<ArrowLeft
							aria-hidden
							className="size-3.5 transition-transform duration-200 ease-out group-hover:-translate-x-0.5"
						/>
						Previous term
					</>
				) : (
					<>
						Next term
						<ArrowRight
							aria-hidden
							className="size-3.5 transition-transform duration-200 ease-out group-hover:translate-x-0.5"
						/>
					</>
				)}
			</span>
			<strong className="text-balance text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
				{entry.title}
			</strong>
		</Link>
	)
}

export async function generateStaticParams() {
	const dictionary = await getAiCodingDictionary()

	return dictionary.entries.map((entry) => ({
		slug: entry.slug,
	}))
}

export async function generateMetadata(
	props: Props,
	parent: ResolvingMetadata,
): Promise<Metadata> {
	const { slug } = await props.params
	const entry = await getAiCodingDictionaryEntry(slug)

	if (!entry) {
		return parent as Metadata
	}

	const title = `${entry.title} | ${AI_CODING_DICTIONARY_TITLE}`
	const description = entry.description || AI_CODING_DICTIONARY_DESCRIPTION
	const canonicalPath = `/ai-coding-dictionary/${entry.slug}`
	const ogImage = getAiCodingDictionaryOgImageUrl(title)

	return {
		title,
		description,
		applicationName: 'AI Hero',
		creator: 'Matt Pocock',
		publisher: 'AI Hero',
		category: 'Education',
		keywords: [
			entry.title,
			'AI coding dictionary',
			'AI coding glossary',
			'AI engineering vocabulary',
			entry.sectionTitle,
		],
		alternates: {
			canonical: canonicalPath,
		},
		openGraph: {
			title,
			description,
			url: canonicalPath,
			siteName: 'AI Hero',
			type: 'article',
			locale: 'en_US',
			images: [
				{
					url: ogImage,
					width: 1200,
					height: 630,
					alt: title,
				},
			],
		},
		twitter: {
			card: 'summary_large_image',
			title,
			description,
			images: [ogImage],
		},
	}
}
