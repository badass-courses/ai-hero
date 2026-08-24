'use client'

import { useSearchParams } from 'next/navigation'

import { ChangelogList, type ChangelogItem } from './changelog-list'
import { ChangelogPagination } from './changelog-pagination'

export function parseChangelogPage(value: string | null) {
	const requestedPage = Math.floor(Number(value ?? '1'))
	return Number.isSafeInteger(requestedPage) && requestedPage >= 1
		? requestedPage
		: 1
}

export function ChangelogPage({
	items,
	currentPage,
	pageSize,
}: {
	items: ChangelogItem[]
	currentPage: number
	pageSize: number
}) {
	const totalPages = Math.max(Math.ceil(items.length / pageSize), 1)
	const offset = (currentPage - 1) * pageSize

	return (
		<>
			<ChangelogList items={items.slice(offset, offset + pageSize)} />
			<ChangelogPagination
				currentPage={currentPage}
				totalPages={totalPages}
			/>
		</>
	)
}

export function PaginatedChangelog({
	items,
	pageSize,
}: {
	items: ChangelogItem[]
	pageSize: number
}) {
	const searchParams = useSearchParams()
	const currentPage = parseChangelogPage(searchParams.get('page'))

	return (
		<ChangelogPage
			items={items}
			currentPage={currentPage}
			pageSize={pageSize}
		/>
	)
}
