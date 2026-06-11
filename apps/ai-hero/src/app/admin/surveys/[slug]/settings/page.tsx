import { SurveySettings } from '../../_components/survey-settings'
import { getAdminSurveyOrNotFound } from '../survey-detail-page-data'

export default async function SurveySettingsPage({
	params,
}: {
	params: Promise<{ slug: string }>
}) {
	const { slug } = await params
	const survey = await getAdminSurveyOrNotFound(slug)

	return <SurveySettings survey={survey} />
}
