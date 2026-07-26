'use client'

import { useEffect, useId, useMemo, useState } from 'react'
import * as Sentry from '@sentry/nextjs'
import {
	createBestEffortQuizPersistence,
	quizMachine,
} from '@/lib/quiz/quiz-machine'
import { api } from '@/trpc/react'
import { useMachine } from '@xstate/react'
import { Check, CheckSquare, Circle, Square, X } from 'lucide-react'
import { Button } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import type { QuizQuestionData } from './quiz-schema'

export function QuizQuestionClient({
	data,
	lessonId,
	authoringWarning,
}: {
	data: QuizQuestionData
	lessonId?: string
	authoringWarning?: string
}) {
	const generatedId = useId()
	const questionId = data.id ?? generatedId
	const inputName = `quiz-question-${generatedId}`
	const isMultiple = Array.isArray(data.correct) || data.allowMultiple === true
	const correct = useMemo(
		() =>
			isMultiple && !Array.isArray(data.correct)
				? [data.correct]
				: data.correct,
		[data.correct, isMultiple],
	)
	const machineQuestion = useMemo(
		() => ({
			...data,
			correct,
			persistence:
				lessonId && data.id && !authoringWarning
					? { lessonId, questionId: data.id }
					: undefined,
		}),
		[authoringWarning, correct, data, lessonId],
	)
	const [selectedAnswer, setSelectedAnswer] = useState<string | string[]>(
		isMultiple ? [] : '',
	)
	const answerMutation = api.quiz.answer.useMutation()
	const persistAnswer = useMemo(
		() =>
			createBestEffortQuizPersistence({
				persist: (request) => answerMutation.mutateAsync(request),
				reportError: (error, request) => {
					Sentry.captureException(error, {
						tags: { event: 'quiz.answer.client-persist.failed' },
						extra: {
							lessonId: request.lessonId,
							questionId: request.questionId,
						},
					})
				},
			}),
		[answerMutation],
	)
	const [state, send] = useMachine(quizMachine, {
		input: {
			currentQuestionId: questionId,
			currentQuestion: machineQuestion,
			questionSet: { [questionId]: machineQuestion },
			handleSubmitAnswer: persistAnswer,
		},
	})

	useEffect(() => {
		// Clear the previous question's selection. Without this a remount with new
		// data keeps the old answer selected, so the learner can submit the stale
		// choice against the new question and be graded on it.
		setSelectedAnswer(isMultiple ? [] : '')
		send({
			type: 'LOAD_QUESTION',
			currentQuestionId: questionId,
			currentQuestion: machineQuestion,
		})
	}, [machineQuestion, questionId, send, isMultiple])

	const isAnswered = state.matches('answered')
	const isCorrect = state.matches('answered.correct')
	const isSubmitting = state.matches('answering')
	const choices =
		data.shuffleChoices === false
			? data.choices
			: (state.context.currentQuestion.choices ?? data.choices)
	const correctAnswers = Array.isArray(correct) ? correct : [correct]
	const selectedAnswers = Array.isArray(selectedAnswer)
		? selectedAnswer
		: [selectedAnswer]
	const hasSelection = selectedAnswer.length > 0

	function selectChoice(answer: string, checked: boolean) {
		if (!isMultiple) {
			setSelectedAnswer(answer)
			return
		}

		setSelectedAnswer((current) => {
			const answers = Array.isArray(current) ? current : []
			return checked
				? [...answers, answer]
				: answers.filter((selected) => selected !== answer)
		})
	}

	return (
		<fieldset className="border-border bg-card rounded-xl border p-5 shadow-sm sm:p-7">
			<legend className="sr-only">{data.question}</legend>
			<p className="text-foreground text-balance text-lg font-semibold leading-snug sm:text-xl">
				{data.question}
			</p>

			{authoringWarning && process.env.NODE_ENV !== 'production' ? (
				<p
					role="alert"
					className="mt-3 rounded-md border border-amber-600/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-950 dark:text-amber-100"
				>
					Author warning: {authoringWarning}
				</p>
			) : null}

			<div className="mt-5 space-y-3">
				{choices.map((choice) => {
					const isSelected = selectedAnswers.includes(choice.answer)
					const isCorrectChoice = correctAnswers.includes(choice.answer)
					const showCorrect = isAnswered && isCorrectChoice
					const showIncorrect = isAnswered && isSelected && !isCorrectChoice

					return (
						<label
							key={choice.answer}
							className={cn(
								'flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary has-[:focus-visible]:ring-offset-2',
								!isAnswered &&
									(isSelected
										? 'border-primary bg-primary/10'
										: 'border-border hover:border-primary/50 hover:bg-muted/50'),
								showCorrect &&
									'border-emerald-600 bg-emerald-500/10 text-emerald-950 dark:text-emerald-100',
								showIncorrect &&
									'border-destructive bg-destructive/10 text-destructive',
								isAnswered &&
									!showCorrect &&
									!showIncorrect &&
									'border-border opacity-60',
							)}
						>
							<input
								type={isMultiple ? 'checkbox' : 'radio'}
								name={inputName}
								value={choice.answer}
								checked={isSelected}
								disabled={isAnswered || isSubmitting}
								onChange={(event) =>
									selectChoice(choice.answer, event.currentTarget.checked)
								}
								className="sr-only"
							/>
							<span className="shrink-0" aria-hidden="true">
								{showCorrect ? (
									<Check className="size-5" />
								) : showIncorrect ? (
									<X className="size-5" />
								) : isMultiple ? (
									isSelected ? (
										<CheckSquare className="text-primary size-5" />
									) : (
										<Square className="size-5" />
									)
								) : (
									<Circle
										className={cn(
											'size-5',
											isSelected && 'fill-primary text-primary',
										)}
									/>
								)}
							</span>
							<span className="flex-1 text-sm font-medium sm:text-base">
								{choice.label ?? choice.answer}
							</span>
							{showCorrect ? (
								<span className="text-xs font-semibold uppercase tracking-wide">
									Correct
								</span>
							) : showIncorrect ? (
								<span className="text-xs font-semibold uppercase tracking-wide">
									Your answer
								</span>
							) : null}
						</label>
					)
				})}
			</div>

			{!isAnswered ? (
				<Button
					type="button"
					className="mt-5 w-full sm:w-auto"
					disabled={
						!hasSelection || isSubmitting || state.matches('initializing')
					}
					onClick={() => send({ type: 'ANSWER', answer: selectedAnswer })}
				>
					{isSubmitting ? 'Checking…' : 'Check answer'}
				</Button>
			) : (
				<div
					role="status"
					aria-live="polite"
					className={cn(
						'mt-5 rounded-lg border p-4',
						isCorrect
							? 'border-emerald-600/40 bg-emerald-500/10'
							: 'border-destructive/40 bg-destructive/10',
					)}
				>
					<p className="font-semibold">
						{isCorrect ? 'That’s right.' : 'Not quite.'}
					</p>
					<p className="text-foreground/80 mt-1 text-sm leading-relaxed">
						{data.answer}
					</p>
				</div>
			)}

		</fieldset>
	)
}
