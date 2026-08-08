/**
 * Inline lesson quiz. How the whole system works — authoring contract, question
 * identity, where answers land, sharp edges — is documented in docs/quiz.md.
 */
import * as React from 'react'
import { log } from '@/server/logger'

import { QuizQuestionClient } from './quiz-question-client'
import { QuizQuestionDataSchema } from './quiz-schema'

type QuizQuestionProps = {
	data?: unknown
	authoringWarning?: string
	lessonId?: string
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

	const renderedChildren = childArray.map((child) => {
		const id = getAuthoredQuestionId(child)
		if (!id || !duplicateIds.has(id) || !React.isValidElement(child)) {
			return child
		}

		return React.cloneElement(child as React.ReactElement<QuizQuestionProps>, {
			authoringWarning: `Question id "${id}" is duplicated. Answers will not be saved.`,
		})
	})

	return (
		<section className="not-prose my-10 space-y-8" aria-label="Lesson quiz">
			<div className="border-primary/20 bg-primary/5 rounded-lg border px-5 py-4">
				<p className="text-foreground text-sm font-semibold uppercase tracking-[0.14em]">
					Check your understanding
				</p>
				<p className="text-muted-foreground mt-1 text-sm">
					Answer each question, then check your answer.
				</p>
			</div>
			{renderedChildren}
		</section>
	)
}

export async function QuizQuestion({
	data,
	authoringWarning,
	lessonId,
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
				className="border-destructive/50 bg-destructive/10 text-foreground rounded-xl border p-5"
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
			lessonId={warning ? undefined : lessonId}
			authoringWarning={warning}
		/>
	)
}
