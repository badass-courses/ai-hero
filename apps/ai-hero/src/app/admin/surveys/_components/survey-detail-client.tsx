'use client'

import type { Question, SurveyWithQuestions } from '@/lib/surveys'

import { QuestionsList } from './questions-list'

export function SurveyDetailClient({
	survey,
}: {
	survey: SurveyWithQuestions
}) {
	const questions: Question[] =
		survey.resources
			?.filter((resource) => resource.resource.type === 'question')
			.map((resource) => resource.resource) || []

	return <QuestionsList surveyId={survey.id} initialQuestions={questions} />
}
