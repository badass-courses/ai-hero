import { getSurveyResponses } from '@/lib/surveys-query'

import SurveyResponses from '../../_components/survey-responses'
import { getAdminSurveyOrNotFound } from '../survey-detail-page-data'

export default async function SurveyResponsesPage({
	params,
}: {
	params: Promise<{ slug: string }>
}) {
	const { slug } = await params
	const survey = await getAdminSurveyOrNotFound(slug)
	const responses = await getSurveyResponses(survey.id)

	return <SurveyResponses responses={responses} />
}
