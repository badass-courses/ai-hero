'use client'

import * as React from 'react'
import {
	TYPESENSE_COLLECTION_NAME,
	typesenseInstantsearchAdapter,
} from '@/utils/typesense-instantsearch-adapter'
import { useQueryState } from 'nuqs'
import { Configure } from 'react-instantsearch'
import { InstantSearchNext } from 'react-instantsearch-nextjs'

import type { DictionarySection } from '@/lib/ai-coding-dictionary'

import { DictionaryContent } from './dictionary-content'
import { DictionarySearchBox } from './dictionary-search-box'
import { DictionarySidebar } from './dictionary-sidebar'

export function DictionaryShell({
	sections,
	children,
}: {
	sections: DictionarySection[]
	children: React.ReactNode
}) {
	const [query, setQuery] = useQueryState('q')

	const initialUiState = {
		[TYPESENSE_COLLECTION_NAME]: {
			query: query ?? '',
		},
	}

	return (
		<InstantSearchNext
			searchClient={typesenseInstantsearchAdapter.searchClient}
			indexName={TYPESENSE_COLLECTION_NAME}
			routing={false}
			onStateChange={({ uiState, setUiState }) => {
				try {
					const next = uiState[TYPESENSE_COLLECTION_NAME]?.query
					setQuery(next ? next : null)
					setUiState(uiState)
				} catch (error) {
					console.error('Dictionary search state error:', error)
				}
			}}
			initialUiState={initialUiState}
			future={{ preserveSharedStateOnUnmount: true }}
		>
			<Configure
				filters="visibility:public && state:published && type:=dictionary-entry"
				hitsPerPage={40}
			/>
			<div
				id="terms"
				className="border-border bg-background sticky top-(--nav-height) z-20 scroll-mt-(--nav-height) border-b lg:hidden"
			>
				<DictionarySearchBox scrollTargetId="terms-results" />
			</div>
			<section
				id="terms-results"
				className="border-border grid scroll-mt-(--nav-height) grid-cols-1 border-b lg:grid-cols-[18rem_minmax(0,1fr)]"
			>
				<DictionarySidebar sections={sections} />
				<div className="border-border min-w-0 lg:border-l">
					<DictionaryContent>{children}</DictionaryContent>
				</div>
			</section>
		</InstantSearchNext>
	)
}
