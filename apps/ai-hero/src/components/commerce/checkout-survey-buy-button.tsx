'use client'

import * as React from 'react'
import { api } from '@/trpc/react'
import { useMachine } from '@xstate/react'
import {
	AtSign,
	CircleEllipsis,
	Github,
	Mail,
	Podcast,
	Search,
	Users,
	Youtube,
	type LucideIcon,
} from 'lucide-react'

import * as Pricing from '@coursebuilder/commerce-next/pricing/pricing'
import { Button } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import {
	checkoutSurveyMachine,
	type CheckoutSurveyAnswer,
} from './checkout-survey-machine'

const CHECKOUT_SURVEY_ID = 'checkout-decision-source'
const CHECKOUT_SURVEY_QUESTION_ID = 'what-helped-you-decide-to-join'
const CHECKOUT_SURVEY_STORAGE_KEY = `${CHECKOUT_SURVEY_ID}:${CHECKOUT_SURVEY_QUESTION_ID}:answered`

const checkoutSurveyAnswers = [
	{ value: 'matts_youtube', label: "Matt's YouTube" },
	{ value: 'matts_x', label: "Matt's X or Twitter" },
	{ value: 'github', label: 'GitHub' },
	{ value: 'google_search', label: 'Google search' },
	{ value: 'podcast_newsletter', label: 'Podcast or newsletter' },
	{ value: 'coworker_friend', label: 'Coworker or friend' },
	{ value: 'email_announcement', label: 'Email announcement' },
	{ value: 'other', label: 'Other' },
] as const satisfies readonly CheckoutSurveyAnswer[]

type CheckoutSurveyAnswerValue = (typeof checkoutSurveyAnswers)[number]['value']

const checkoutSurveyAnswerIcons = {
	matts_youtube: Youtube,
	matts_x: AtSign,
	github: Github,
	google_search: Search,
	podcast_newsletter: Podcast,
	coworker_friend: Users,
	email_announcement: Mail,
	other: CircleEllipsis,
} satisfies Record<CheckoutSurveyAnswerValue, LucideIcon>

function shuffleCheckoutSurveyAnswers() {
	const answers = [...checkoutSurveyAnswers]
	for (let index = answers.length - 1; index > 0; index--) {
		const randomIndex = Math.floor(Math.random() * (index + 1))
		const currentAnswer = answers[index]
		const randomAnswer = answers[randomIndex]
		if (!currentAnswer || !randomAnswer) continue
		answers[index] = randomAnswer
		answers[randomIndex] = currentAnswer
	}
	return answers
}

function safeGetStoredAnswer() {
	try {
		return window.localStorage.getItem(CHECKOUT_SURVEY_STORAGE_KEY)
	} catch {
		return null
	}
}

function safeSetStoredAnswer(answer: string) {
	try {
		window.localStorage.setItem(CHECKOUT_SURVEY_STORAGE_KEY, answer)
	} catch {
		// Ignore storage failures so checkout can continue.
	}
}

export function CheckoutSurveyBuyButton({
	className,
	children,
}: {
	className?: string
	children?: React.ReactNode
}) {
	const buttonRef = React.useRef<HTMLButtonElement | null>(null)
	const surveyRef = React.useRef<HTMLDivElement | null>(null)
	const hasSubmittedRef = React.useRef(false)
	const [isSubmittingStoredAnswer, setIsSubmittingStoredAnswer] =
		React.useState(false)
	const hasScrolledToSurveyRef = React.useRef(false)
	const answerSurveyMutation = api.convertkit.answerSurvey.useMutation()
	const checkoutSurveyAnswer = api.convertkit.checkoutSurveyAnswer.useQuery(
		undefined,
		{
			staleTime: 5 * 60 * 1000,
		},
	)
	const { formattedPrice, product, status, isSoldOut } = Pricing.usePricing()

	const [snapshot, send] = useMachine(checkoutSurveyMachine, {
		input: {
			saveAnswer: async (answer) => {
				await answerSurveyMutation.mutateAsync({
					surveyId: CHECKOUT_SURVEY_ID,
					question: CHECKOUT_SURVEY_QUESTION_ID,
					answer: answer.value,
				})
				safeSetStoredAnswer(answer.value)
			},
		},
	})

	const selectedAnswer = snapshot.context.selectedAnswer
	const shuffledCheckoutSurveyAnswers = React.useMemo(
		() => shuffleCheckoutSurveyAnswers(),
		[],
	)
	const isMembership = product.type === 'membership'
	const defaultAction = isMembership ? 'Subscribe' : 'Buy Now'
	const buttonLabel = children
		? children
		: isSoldOut
			? 'Sold Out'
			: formattedPrice?.upgradeFromPurchaseId
				? 'Upgrade Now'
				: product?.fields.action || defaultAction

	React.useEffect(() => {
		const button = buttonRef.current
		const form = button?.closest('form')
		if (!form) return

		const action = new URL(form.action, window.location.origin)
		if (selectedAnswer?.value) {
			action.searchParams.set('selfReportedSource', selectedAnswer.value)
		} else {
			action.searchParams.delete('selfReportedSource')
		}
		form.action = `${action.pathname}${action.search}`
	}, [selectedAnswer])

	React.useEffect(() => {
		if (snapshot.matches('idle')) return
		if (hasScrolledToSurveyRef.current) return
		if (!surveyRef.current) return

		hasScrolledToSurveyRef.current = true
		const prefersReducedMotion = window.matchMedia(
			'(prefers-reduced-motion: reduce)',
		).matches
		surveyRef.current.scrollIntoView({
			behavior: prefersReducedMotion ? 'auto' : 'smooth',
			block: 'center',
		})
	}, [snapshot])

	React.useEffect(() => {
		if (
			!snapshot.matches('redirecting') &&
			!snapshot.matches('failedSurveySaveButContinuing')
		)
			return
		if (hasSubmittedRef.current) return

		const button = buttonRef.current
		const form = button?.closest('form')
		if (!form) return
		if (!form.reportValidity()) return

		hasSubmittedRef.current = true
		send({ type: 'STRIPE_REDIRECT_STARTED' })
		form.requestSubmit()
	}, [send, snapshot])

	const continueWithoutSurveyIfAlreadyAnswered = () => {
		const storedAnswer = safeGetStoredAnswer()
		const knownAnswer = checkoutSurveyAnswer.data?.answer || storedAnswer
		const form = buttonRef.current?.closest('form')

		if (knownAnswer && form) {
			if (hasSubmittedRef.current) return
			if (!form.reportValidity()) return
			hasSubmittedRef.current = true
			setIsSubmittingStoredAnswer(true)
			const action = new URL(form.action, window.location.origin)
			action.searchParams.set('selfReportedSource', knownAnswer)
			form.action = `${action.pathname}${action.search}`
			safeSetStoredAnswer(knownAnswer)
			form.requestSubmit()
			return
		}
		send({ type: 'BUY_CLICKED' })
	}

	if (snapshot.matches('idle')) {
		return (
			<Button
				ref={buttonRef}
				className={cn(
					'bg-primary text-primary-foreground flex h-14 w-full items-center justify-center rounded px-4 py-4 text-center text-base font-medium transition ease-in-out disabled:cursor-not-allowed disabled:opacity-50',
					className,
				)}
				type="button"
				size="lg"
				disabled={
					status === 'pending' ||
					status === 'error' ||
					isSoldOut ||
					isSubmittingStoredAnswer
				}
				onClick={continueWithoutSurveyIfAlreadyAnswered}
			>
				{buttonLabel}
			</Button>
		)
	}

	return (
		<div ref={surveyRef} className="flex w-full flex-col gap-3">
			<div className="border-border bg-muted/40 text-foreground rounded-lg border p-4 text-left text-sm">
				<div className="text-base font-semibold">
					What helped you decide to join?
				</div>
				{selectedAnswer ? (
					<div className="bg-background mt-3 flex items-center justify-between gap-3 rounded-md px-3 py-2">
						<span>
							<span className="text-muted-foreground">Answer:</span>{' '}
							<strong>{selectedAnswer.label}</strong>
						</span>
						<button
							type="button"
							className="text-primary text-xs font-semibold underline"
							onClick={() => send({ type: 'CHANGE_ANSWER_CLICKED' })}
						>
							change
						</button>
					</div>
				) : (
					<>
						<p className="text-muted-foreground mt-1 text-xs">
							Optional. Choose one if you want. Continue works either way.
						</p>
						<div className="mt-3 grid gap-2">
							{shuffledCheckoutSurveyAnswers.map((answer) => {
								const Icon = checkoutSurveyAnswerIcons[answer.value]

								return (
									<button
										key={answer.value}
										type="button"
										className="border-border bg-background hover:bg-muted flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors"
										onClick={() => send({ type: 'ANSWER_SELECTED', answer })}
									>
										<Icon className="text-muted-foreground size-4 shrink-0" />
										<span>{answer.label}</span>
									</button>
								)
							})}
						</div>
					</>
				)}
			</div>
			<Button
				ref={buttonRef}
				className={cn(
					'bg-primary text-primary-foreground flex h-14 w-full items-center justify-center rounded px-4 py-4 text-center text-base font-medium transition ease-in-out disabled:cursor-not-allowed disabled:opacity-50',
					className,
				)}
				type="button"
				size="lg"
				disabled={
					status === 'pending' ||
					status === 'error' ||
					isSoldOut ||
					hasSubmittedRef.current
				}
				onClick={() => send({ type: 'CONTINUE_CLICKED' })}
			>
				Continue to Stripe
			</Button>
		</div>
	)
}
