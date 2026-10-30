/**
 * Inline lesson quiz. How the whole system works — authoring contract, question
 * identity, where answers land, sharp edges — is documented in docs/quiz.md.
 */
import * as React from 'react'
import { TYPE } from '@/components/landing/type'
import { log } from '@/server/logger'

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

	// One panel, the questions in it numbered and split by hairlines, so a quiz
	// reads as one exercise rather than a stack of cards.
	return (
		<section className="not-prose my-10" aria-label="Lesson quiz">
			<div className="mb-2 flex items-baseline justify-between gap-4">
				<p className={TYPE.groupLabel}>Check your understanding</p>
				<p className={TYPE.metaMark}>Answer, then check</p>
			</div>
			<div className="divide-border bg-card divide-y rounded-[12px] border">
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
