import { getAdminSurveyOrNotFound } from './survey-detail-page-data'
import { SurveyDetailTemplate } from '../_components/survey-detail-template'

export default async function AdminSurveyLayout({
	children,
	params,
}: {
	children: React.ReactNode
	params: Promise<{ slug: string }>
}) {
	const { slug } = await params
	const survey = await getAdminSurveyOrNotFound(slug)

	return <SurveyDetailTemplate survey={survey}>{children}</SurveyDetailTemplate>
}
