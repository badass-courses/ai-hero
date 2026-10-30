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
			<h2 className={cn(TYPE.panelTitle, 'text-balance')}>
				Check your understanding
			</h2>
			<p className={cn(TYPE.metaMark, 'mt-2')}>
				Answer each question, then check your answer.
			</p>
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
