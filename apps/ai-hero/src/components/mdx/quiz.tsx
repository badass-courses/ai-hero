/**
 * Inline lesson quiz. How the whole system works — authoring contract, question
 * identity, where answers land, sharp edges — is documented in docs/quiz.md.
 */
import * as React from 'react'
import { TYPE } from '@/components/landing/type'
import { log } from '@/server/logger'

import { cn } from '@coursebuilder/ui/utils/cn'

import { QuizQuestionClient } from './quiz-question-client'
import { QuizQuestionDataSchema } from './quiz-schema'

type QuizQuestionProps = {
	data?: unknown
	authoringWarning?: string
	lessonId?: string
	/** Its place in the quiz, from 1. */
	number?: number
}

function getAuthoredQuestionId(child: React.ReactNode): string | undefined {
	if (!React.isValidElement<QuizQuestionProps>(child)) return undefined
	const data = child.props.data
	if (!data || typeof data !== 'object' || !('id' in data)) return undefined
	return typeof data.id === 'string' && data.id.trim()
		? data.id.trim()
		: undefined
}

export async function Quiz({ children }: { children: React.ReactNode }) {
	const childArray = React.Children.toArray(children)
	const idCounts = new Map<string, number>()

	for (const child of childArray) {
		const id = getAuthoredQuestionId(child)
		if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1)
	}

	const duplicateIds = new Set(
		[...idCounts].filter(([, count]) => count > 1).map(([id]) => id),
	)

	if (duplicateIds.size > 0) {
		await log.error('quiz.authoring.duplicate-question-id', {
			questionIds: [...duplicateIds],
		})
	}

	let number = 0
	const renderedChildren = childArray.map((child) => {
		if (!React.isValidElement<QuizQuestionProps>(child)) return child
		const id = getAuthoredQuestionId(child)
		number += 1
		return React.cloneElement(child, {
			number,
			...(id && duplicateIds.has(id)
				? {
						authoringWarning: `Question id "${id}" is duplicated. Answers will not be saved.`,
					}
				: {}),
		})
	})

	// A quiz closes the lesson, so it opens like the Up next band below it: a
	// hairline across the whole column, then a heading. The line runs out past
	// the prose measure (border-image outset) and the lesson's `main` clips it
	// at the column's edges.
	return (
		<section
			className="not-prose mt-16 border-t pt-10 [border-image:linear-gradient(var(--color-border)_0_0)_1/1px_0_0_0/0_100vw]"
			aria-label="Lesson quiz"
		>
			<div className="flex items-center gap-3">
				<span className="bg-card text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-[9px] border">
					<QuizIcon className="size-5" />
				</span>
				<div>
					<h2 className={cn(TYPE.panelTitle, 'text-balance')}>
						Check your understanding
					</h2>
					<p className={cn(TYPE.metaMark, 'mt-1')}>
						Answer each question, then check your answer.
					</p>
				</div>
			</div>
			<div className="divide-border bg-card mt-6 divide-y rounded-[12px] border">
				{renderedChildren}
			</div>
		</section>
	)
}

export async function QuizQuestion({
	data,
	authoringWarning,
	lessonId,
	number,
}: QuizQuestionProps) {
	const parsed = QuizQuestionDataSchema.safeParse(data)

	if (!parsed.success) {
		const issues = parsed.error.issues.map(({ path, message }) => ({
			path: path.join('.'),
			message,
		}))
		await log.error('quiz.authoring.invalid-question-data', { issues })

		return (
			<div
				role="alert"
				className="bg-destructive/10 text-foreground p-5 sm:p-6"
			>
				<p className="font-semibold">This quiz question cannot be displayed.</p>
				<p className="mt-1 text-sm">
					Its question data is invalid. The rest of the lesson is still
					available.
				</p>
				{process.env.NODE_ENV !== 'production' ? (
					<ul className="mt-3 list-disc space-y-1 pl-5 text-xs">
						{issues.map((issue) => (
							<li key={`${issue.path}:${issue.message}`}>
								{issue.path || 'data'}: {issue.message}
							</li>
						))}
					</ul>
				) : null}
			</div>
		)
	}

	let warning = authoringWarning
	if (!parsed.data.id) {
		warning = 'This question has no id. Answers will not be saved.'
		await log.error('quiz.authoring.missing-question-id', {
			question: parsed.data.question,
		})
	}

	return (
		<QuizQuestionClient
			key={`${lessonId ?? 'no-lesson'}:${parsed.data.id ?? 'no-id'}`}
			data={parsed.data}
			number={number}
			lessonId={warning ? undefined : lessonId}
			authoringWarning={warning}
		/>
	)
}

/** Hugeicons' Quiz 03 (MIT): a clipboard of ticked answers. */
function QuizIcon({ className }: { className?: string }) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.5}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			className={className}
		>
			<path d="M7.5 3.5C5.9442 3.54667 5.01661 3.71984 4.37477 4.36227C3.49609 5.24177 3.49609 6.6573 3.49609 9.48836L3.49609 15.9944C3.49609 18.8255 3.49609 20.241 4.37477 21.1205C5.25345 22 6.66767 22 9.49609 22L14.4961 22C17.3245 22 18.7387 22 19.6174 21.1205C20.4961 20.241 20.4961 18.8255 20.4961 15.9944V9.48836C20.4961 6.6573 20.4961 5.24177 19.6174 4.36228C18.9756 3.71984 18.048 3.54667 16.4922 3.5" />
			<path d="M7.49609 3.75C7.49609 2.7835 8.2796 2 9.24609 2H14.7461C15.7126 2 16.4961 2.7835 16.4961 3.75C16.4961 4.7165 15.7126 5.5 14.7461 5.5H9.24609C8.2796 5.5 7.49609 4.7165 7.49609 3.75Z" />
			<path d="M6.5 10L10.5 10" />
			<path d="M13.5 11C13.5 11 14 11 14.5 12C14.5 12 16.0882 9.5 17.5 9" />
			<path d="M6.5 16L10.5 16" />
			<path d="M13.5 17C13.5 17 14 17 14.5 18C14.5 18 16.0882 15.5 17.5 15" />
		</svg>
	)
}
