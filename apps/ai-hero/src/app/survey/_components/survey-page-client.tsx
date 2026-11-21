'use client'

import React from 'react'
import Spinner from '@/components/spinner'
import { useConvertkitSubscriberUrlParam } from '@/hooks/use-convertkit-subscriber-url-param'
import { api } from '@/trpc/react'
import { useSession } from 'next-auth/react'
import { useSearchParams } from 'next/navigation'

import { useSurveyPageOfferMachine } from '@coursebuilder/survey'
import type {
	QuestionResource,
	QuizResource,
	SurveyConfig,
} from '@coursebuilder/survey/types'

import {
	AiCodingReadinessResult,
	isAiCodingReadinessSurvey,
} from './ai-coding-readiness-result'
import { SurveyRenderer } from './survey-renderer'
import {
	isSkillsWorkflowCompletionSurvey,
	ValuePathCompletionResult,
} from './value-path-completion-result'

type SurveyPageClientProps = {
	quizResource: QuizResource
	surveyConfig: SurveyConfig
	surveyId: string
}

export function SurveyPageClient({
	quizResource,
	surveyConfig,
	surveyId,
}: SurveyPageClientProps) {
	// Read the email-link params before the cookie hook strips ck_subscriber_id
	// from the URL. sh_kit stays in the URL, and the server falls back to the
	// cookie for the id on a reload.
	const searchParams = useSearchParams()
	const [link] = React.useState(() => ({
		subscriberId: searchParams.get('ck_subscriber_id') || undefined,
		shKit: searchParams.get('sh_kit') || undefined,
	}))
	const cookieReady = useConvertkitSubscriberUrlParam()
	const { data: session, status: sessionStatus } = useSession()

	const { data: subscriberData, status } =
		api.ability.getCurrentSubscriberFromCookie.useQuery(undefined, {
			enabled: cookieReady,
		})

	// The address comes only from the session or a hash-verified email link.
	// The cookie payload never carries one: it is public and caller-settable.
	const { data: linkSubscriber, isLoading: linkLoading } =
		api.ability.getVerifiedLinkSubscriber.useQuery(
			{ shKit: link.shKit ?? '', subscriberId: link.subscriberId },
			{ enabled: cookieReady && Boolean(link.shKit) },
		)

	const effectiveSubscriber = React.useMemo(
		() =>
			subscriberData || linkSubscriber || session?.user?.email
				? {
						id: linkSubscriber?.id || 0,
						email_address:
							session?.user?.email || linkSubscriber?.email_address || '',
						state: subscriberData?.state || 'active',
						fields: subscriberData?.fields || {},
					}
				: null,
		[subscriberData, linkSubscriber, session?.user?.email],
	)

	const {
		currentQuestion,
		currentQuestionId,
		isLoading,
		isComplete,
		isPresenting,
		sendToMachine,
		handleSubmitAnswer,
		machineState,
	} = useSurveyPageOfferMachine(
		quizResource,
		surveyId,
		effectiveSubscriber,
		status === 'pending' || linkLoading || sessionStatus === 'loading',
	)

	const answerSurveyMutation = api.convertkit.answerSurvey.useMutation()

	const answerSurveyMultipleMutation =
		api.convertkit.answerSurveyMultiple.useMutation()

	const [email, setEmail] = React.useState<string | null>(null)
	const [skippedToCompletion, setSkippedToCompletion] = React.useState(false)
	const hasSubmittedRef = React.useRef(false)

	const handleEmailSubmit = async (email: string) => {
		setEmail(email)
		hasSubmittedRef.current = true
		sendToMachine({ type: 'EMAIL_COLLECTED' })

		// Submit all answers from the machine context
		answerSurveyMultipleMutation.mutate({
			email,
			answers: machineState.context.answers || {},
			surveyId: surveyId,
		})
	}

	const handleSkipToCompletion = () => {
		setSkippedToCompletion(true)
		hasSubmittedRef.current = true

		if (effectiveSubscriber?.email_address) {
			answerSurveyMultipleMutation.mutate({
				email: effectiveSubscriber.email_address,
				answers: machineState.context.answers || {},
				surveyId: surveyId,
			})
		}

		sendToMachine({ type: 'OFFER_DISMISSED' })
	}

	// Reset submission flag when survey changes
	React.useEffect(() => {
		hasSubmittedRef.current = false
		setSkippedToCompletion(false)
	}, [surveyId])

	React.useEffect(() => {
		// Fallback: only for authenticated users who didn't go through email collection
		// (their answers were already written per-question, just update completion timestamp)
		if (
			isComplete &&
			machineState.matches('offerComplete') &&
			!email &&
			effectiveSubscriber?.email_address &&
			!hasSubmittedRef.current
		) {
			hasSubmittedRef.current = true
			// Logged-in users shouldn't be forced through email collection.
			// Their answers are written per-question and completion is synced best-effort.
			answerSurveyMultipleMutation.mutate({
				email: effectiveSubscriber.email_address,
				answers: {},
				surveyId: surveyId,
			})
		}
	}, [
		isComplete,
		machineState,
		email,
		effectiveSubscriber,
		surveyId,
		answerSurveyMultipleMutation,
	])

	if (isLoading) {
		return (
			<div className="flex items-center justify-center gap-3 py-10 text-center text-lg">
				<Spinner className="size-5" />{' '}
				<span className="">
					Loading survey<span className="animate-pulse">...</span>
				</span>
			</div>
		)
	}

	if (!currentQuestion && !isPresenting) {
		return (
			<div className="flex items-center justify-center py-10 text-center text-2xl">
				No survey available at this time.
			</div>
		)
	}

	return (
		<SurveyRenderer
			currentQuestionId={currentQuestionId}
			currentQuestion={currentQuestion as QuestionResource}
			handleSubmitAnswer={async (context) => {
				if (effectiveSubscriber?.email_address) {
					answerSurveyMutation.mutate({
						answer: Array.isArray(context.answer)
							? context.answer.join(', ')
							: context.answer,
						question: context.currentQuestionId,
						surveyId: surveyId,
					})
				}
				await handleSubmitAnswer(context)
			}}
			surveyConfig={surveyConfig}
			sendToMachine={sendToMachine}
			isComplete={isComplete || skippedToCompletion}
			showEmailQuestion={machineState.matches('collectEmail')}
			onEmailSubmit={handleEmailSubmit}
			onSkipToCompletion={
				isSkillsWorkflowCompletionSurvey(surveyId)
					? handleSkipToCompletion
					: undefined
			}
			completionMessageComponent={
				isAiCodingReadinessSurvey(surveyId) ? (
					<AiCodingReadinessResult
						answers={machineState.context.answers || {}}
					/>
				) : isSkillsWorkflowCompletionSurvey(surveyId) ? (
					<ValuePathCompletionResult
						kitSubscriberId={linkSubscriber?.id}
						shKit={link.shKit}
						email={effectiveSubscriber?.email_address}
					/>
				) : undefined
			}
			emailMessageComponent={
				isAiCodingReadinessSurvey(surveyId) ? (
					<AiCodingReadinessResult
						answers={machineState.context.answers || {}}
					/>
				) : undefined
			}
		/>
	)
}
