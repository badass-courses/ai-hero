import { SurveyDetailClient } from '../../_components/survey-detail-client'
import { getAdminSurveyOrNotFound } from '../survey-detail-page-data'

export default async function SurveyQuestionsPage({
	params,
}: {
	params: Promise<{ slug: string }>
}) {
	const { slug } = await params
	const survey = await getAdminSurveyOrNotFound(slug)

	return <SurveyDetailClient survey={survey} />
}
