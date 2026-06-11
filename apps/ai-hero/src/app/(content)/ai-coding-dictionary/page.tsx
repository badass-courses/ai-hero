import { Suspense } from 'react'
import type { Metadata } from 'next'
import { ContentReadTracker } from '@/components/content-read-tracker'
import LayoutClient from '@/components/layout-client'
import { PrimaryNewsletterCta } from '@/components/primary-newsletter-cta'
import {
	AI_CODING_DICTIONARY_DESCRIPTION,
	AI_CODING_DICTIONARY_TITLE,
	getAiCodingDictionary,
	getAiCodingDictionaryOgImageUrl,
} from '@/lib/ai-coding-dictionary'
import { DictionaryStructuredData } from '@/lib/structured-data'

import { DictionaryHero } from './_components/dictionary-hero'
import { DictionarySections } from './_components/dictionary-sections'
import { DictionaryShell } from './_components/dictionary-shell'
import { DictionaryShellFallback } from './_components/dictionary-shell-fallback'

export const revalidate = 3600

const dictionaryOgImage = getAiCodingDictionaryOgImageUrl()

export const metadata: Metadata = {
	title: AI_CODING_DICTIONARY_TITLE,
	description: AI_CODING_DICTIONARY_DESCRIPTION,
	applicationName: 'AI Hero',
	creator: 'Matt Pocock',
	publisher: 'AI Hero',
	category: 'Education',
	keywords: [
		'AI coding dictionary',
		'AI coding glossary',
		'AI engineering vocabulary',
		'agentic coding',
		'AI agents',
		'LLM terminology',
	],
	alternates: {
		canonical: '/ai-coding-dictionary',
	},
	openGraph: {
		title: AI_CODING_DICTIONARY_TITLE,
		description: AI_CODING_DICTIONARY_DESCRIPTION,
		url: '/ai-coding-dictionary',
		siteName: 'AI Hero',
		type: 'website',
		locale: 'en_US',
		images: [
			{
				url: dictionaryOgImage,
				width: 1200,
				height: 630,
				alt: AI_CODING_DICTIONARY_TITLE,
			},
		],
	},
	twitter: {
		card: 'summary_large_image',
		title: AI_CODING_DICTIONARY_TITLE,
		description: AI_CODING_DICTIONARY_DESCRIPTION,
		images: [dictionaryOgImage],
	},
}

export default async function DictionaryPage() {
	const dictionary = await getAiCodingDictionary()

	return (
		<LayoutClient withContainer>
			<ContentReadTracker
				contentId="ai-coding-dictionary"
				contentType="dictionary"
				contentSlug="ai-coding-dictionary"
			/>
			<DictionaryStructuredData dictionary={dictionary} />
			<main className="bg-background text-foreground">
				<DictionaryHero
					sections={dictionary.sections}
					entryCount={dictionary.entries.length}
				/>

				{/*
				 * DictionaryShell uses nuqs's useQueryState which reads
				 * useSearchParams. In Next 16's strict prerender mode, any client
				 * component that touches useSearchParams must sit under a Suspense
				 * boundary or the build fails.
				 *
				 * The fallback mirrors the live shell's grid + sidebar shape so
				 * hydration doesn't shift the layout — only the search input and
				 * active-section highlight come alive on hydration.
				 */}
				<Suspense
					fallback={
						<DictionaryShellFallback sections={dictionary.sections}>
							<DictionarySections sections={dictionary.sections} />
						</DictionaryShellFallback>
					}
				>
					<DictionaryShell sections={dictionary.sections}>
						<DictionarySections sections={dictionary.sections} />
					</DictionaryShell>
				</Suspense>

				<PrimaryNewsletterCta
					id="dictionary-newsletter-cta"
					isHiddenForSubscribers
					className="not-prose border-t py-16 [&_button]:w-full"
					actionLabel="Get AI Hero updates"
					fields={{
						interest: 'dictionary',
						source: 'aihero_dictionary_page',
					}}
					trackProps={{
						event: 'subscribed',
						params: { location: 'dictionary' },
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
			</main>
		</LayoutClient>
	)
}
