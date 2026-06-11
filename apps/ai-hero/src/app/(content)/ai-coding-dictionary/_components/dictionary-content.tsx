'use client'

import * as React from 'react'
import { useInstantSearch } from 'react-instantsearch'

import { DictionarySearchResults } from './dictionary-search-results'

export function DictionaryContent({ children }: { children: React.ReactNode }) {
	const { indexUiState } = useInstantSearch()
	const isSearching = Boolean(indexUiState.query?.trim())

	if (isSearching) {
		return <DictionarySearchResults />
	}

	return <>{children}</>
}
