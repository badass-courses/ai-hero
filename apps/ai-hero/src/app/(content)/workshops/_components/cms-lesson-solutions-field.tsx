'use client'

import * as React from 'react'
import Link from 'next/link'
import { api } from '@/trpc/react'

import { Skeleton } from '@coursebuilder/ui'
import { Field } from '@coursebuilder/ui/cms'

/**
 * The lesson↔solution navigation, cms-editor style — the `{ kind: 'custom' }`
 * field appended to the lesson manifest's Content tab at the call site
 * (`EditLessonClient`). Covers what the legacy metadata Solution section did:
 *
 * - lists the attached solution(s) via tRPC (`api.solutions.getAllForLesson`),
 *   flagging duplicates beyond the first (only the first is ever served);
 * - links to the solution edit route (`…/{lesson}/solution/edit` — one
 *   solution per lesson, no slug segment of its own);
 * - "Add solution" when none exists (same route; that page's first save
 *   creates the row);
 * - remove/delete with the legacy `confirm()` guard.
 *
 * Dropped from legacy: the 200px markdown body preview + description render —
 * metadata-panel altitude keeps rows scannable; the body lives one click away.
 */
export function CmsLessonSolutionsField({
	lessonId,
	moduleSlug,
	lessonSlug,
}: {
	lessonId: string
	moduleSlug: string
	lessonSlug: string
}) {
	const utils = api.useUtils()
	const {
		data: solutions,
		isLoading,
		isError,
	} = api.solutions.getAllForLesson.useQuery({ lessonId })
	const deleteSolution = api.solutions.delete.useMutation({
		onSettled: () => utils.solutions.getAllForLesson.invalidate({ lessonId }),
	})

	const editHref = `/workshops/${moduleSlug}/${lessonSlug}/solution/edit`

	let content: React.ReactNode
	if (isLoading) {
		content = (
			<div className="space-y-1.5" aria-hidden="true">
				<Skeleton className="h-9 w-full rounded-md" />
			</div>
		)
	} else if (isError) {
		content = (
			<p className="text-[11px] text-[color:var(--cms-danger)]">
				Couldn't load the solution.
			</p>
		)
	} else if (solutions && solutions.length > 0) {
		content = (
			<div className="space-y-1.5">
				<ul className="space-y-1.5">
					{solutions.map((solution, index) => {
						const duplicate = index > 0
						return (
							<li
								key={solution.id}
								className="border-border bg-muted flex items-center gap-2 rounded-md border px-2.5 py-1.5"
							>
								<div className="min-w-0 flex-1">
									<Link
										href={editHref}
										className="text-foreground block truncate text-[13px] font-medium hover:underline"
									>
										{solution.fields.title || 'Untitled solution'}
									</Link>
									{duplicate ? (
										<p className="text-[11px] text-[color:var(--cms-danger)]">
											Duplicate #{index + 1} — remove it; only the first
											solution is served.
										</p>
									) : null}
								</div>
								{!duplicate ? (
									<Link
										href={editHref}
										className="text-primary shrink-0 text-[11px] font-medium hover:underline"
									>
										Edit
									</Link>
								) : null}
								<button
									type="button"
									disabled={deleteSolution.isPending}
									onClick={() => {
										if (
											window.confirm(
												duplicate
													? 'Delete this duplicate solution?'
													: 'Are you sure you want to delete this solution?',
											)
										) {
											deleteSolution.mutate({ solutionId: solution.id })
										}
									}}
									className="shrink-0 text-[11px] font-medium text-[color:var(--cms-danger)] hover:underline disabled:opacity-50"
								>
									Remove
								</button>
							</li>
						)
					})}
				</ul>
				{deleteSolution.isError ? (
					<p className="text-[11px] text-[color:var(--cms-danger)]">
						{deleteSolution.error.message === 'Unauthorized'
							? "You don't have permission to remove this solution."
							: "Couldn't remove the solution. Please try again."}
					</p>
				) : null}
			</div>
		)
	} else {
		content = (
			<Link
				href={editHref}
				className="text-muted-foreground border-border hover:text-foreground hover:border-ring block rounded-md border border-dashed px-2.5 py-1.5 text-center text-[13px] transition-colors"
			>
				+ Add solution
			</Link>
		)
	}

	return (
		<Field
			label={solutions && solutions.length > 1 ? 'Solutions' : 'Solution'}
			hint="The worked answer for this exercise lesson — one per lesson."
		>
			{content}
		</Field>
	)
}
