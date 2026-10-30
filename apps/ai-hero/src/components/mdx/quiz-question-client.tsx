'use client'

import { useEffect, useId, useMemo, useState } from 'react'
import * as Sentry from '@sentry/nextjs'
import {
	createBestEffortQuizPersistence,
	quizMachine,
} from '@/lib/quiz/quiz-machine'
import { api } from '@/trpc/react'
import { useMachine } from '@xstate/react'
import { TYPE } from '@/components/landing/type'
import { Check, X } from 'lucide-react'
import { useSession } from 'next-auth/react'
import { Button } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import { InlineCode } from './inline-code'
import { useReportChecked } from './quiz-progress'
import type { QuizQuestionData } from './quiz-schema'

export function QuizQuestionClient({
	data,
	number,
	lessonId,
	authoringWarning,
}: {
	data: QuizQuestionData
	/** Its place in the quiz, from 1. */
	number?: number
	lessonId?: string
	authoringWarning?: string
}) {
	const { data: session } = useSession()
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
				session?.user?.id && lessonId && data.id && !authoringWarning
					? { lessonId, questionId: data.id }
					: undefined,
		}),
		[authoringWarning, correct, data, lessonId, session?.user?.id],
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
	useReportChecked(questionId, isAnswered, isCorrect)
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
		<fieldset className="p-5 sm:p-6">
			<legend className="sr-only">{data.question.replaceAll('`', '')}</legend>
			<div className="flex gap-3" aria-hidden="true">
				{number !== undefined && (
					<span className={cn(TYPE.navNum, 'text-muted-foreground pt-[0.5em]')}>
						{String(number).padStart(2, '0')}
					</span>
				)}
				<p className={cn(TYPE.subhead, 'text-foreground text-balance')}>
					<InlineCode text={data.question} />
				</p>
			</div>

			{authoringWarning && process.env.NODE_ENV !== 'production' ? (
				<p
					role="alert"
					className="mt-3 rounded-[6px] border border-amber-600/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-950 dark:text-amber-100"
				>
					Author warning: {authoringWarning}
				</p>
			) : null}

			<div className="mt-4 space-y-2">
				{choices.map((choice) => {
					const isSelected = selectedAnswers.includes(choice.answer)
					const isCorrectChoice = correctAnswers.includes(choice.answer)
					const showCorrect = isAnswered && isCorrectChoice
					const showIncorrect = isAnswered && isSelected && !isCorrectChoice

					return (
						<label
							key={choice.answer}
							className={cn(
								TYPE.meta,
								'has-[:focus-visible]:ring-ring flex cursor-pointer items-start gap-3 rounded-[9px] border px-3.5 py-3 font-normal transition-colors has-[:disabled]:cursor-default has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-offset-2 sm:text-base',
								!isAnswered &&
									(isSelected
										? 'border-primary/60 bg-primary/[0.06]'
										: 'border-border hover:bg-[var(--ah-hover)]'),
								showCorrect &&
									'border-emerald-600/50 bg-emerald-500/[0.07] text-emerald-950 dark:text-emerald-100',
								showIncorrect &&
									'border-destructive/50 bg-destructive/[0.07] text-destructive dark:border-red-400/50 dark:bg-red-500/10 dark:text-red-200',
								isAnswered &&
									!showCorrect &&
									!showIncorrect &&
									'border-border text-muted-foreground',
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
							{/* The checklist's circle, so a choice and a task read alike. */}
							<span
								aria-hidden="true"
								className={cn(
									'mt-[0.15em] flex size-[1.125em] shrink-0 items-center justify-center border-[1.5px] transition-colors',
									isMultiple ? 'rounded-[4px]' : 'rounded-full',
									showCorrect || showIncorrect
										? 'border-current'
										: isSelected
											? 'border-primary bg-primary text-primary-foreground'
											: 'border-foreground/35',
								)}
							>
								{showCorrect ? (
									<Check strokeWidth={3} className="size-[0.7em]" />
								) : showIncorrect ? (
									<X strokeWidth={3} className="size-[0.7em]" />
								) : isSelected ? (
									isMultiple ? (
										<Check strokeWidth={3} className="size-[0.7em]" />
									) : (
										<span className="bg-primary-foreground size-[0.35em] rounded-full" />
									)
								) : null}
							</span>
							<span className="flex-1 leading-snug">
								<InlineCode text={choice.label ?? choice.answer} />
							</span>
							{showCorrect ? (
								<span className={cn(TYPE.metaMark, 'self-center text-current')}>
									Correct
								</span>
							) : showIncorrect ? (
								<span className={cn(TYPE.metaMark, 'self-center text-current')}>
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
					className="mt-4 w-full font-bold sm:w-auto"
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
						TYPE.meta,
						'mt-4 border-l-2 py-1 pl-4 font-normal',
						isCorrect ? 'border-emerald-600' : 'border-destructive',
					)}
				>
					<p className="text-foreground font-semibold">
						{isCorrect ? 'That’s right.' : 'Not quite.'}
					</p>
					<p className="text-foreground/80 mt-1 leading-relaxed">
						<InlineCode text={data.answer} />
					</p>
				</div>
			)}
		</fieldset>
	)
}
