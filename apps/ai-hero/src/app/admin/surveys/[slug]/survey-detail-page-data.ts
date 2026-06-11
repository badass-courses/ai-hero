import { notFound } from 'next/navigation'
import { getSurvey } from '@/lib/surveys-query'
import { getServerAuthSession } from '@/server/auth'

export async function getAdminSurveyOrNotFound(slug: string) {
	const { ability } = await getServerAuthSession()

	if (ability.cannot('manage', 'all')) {
		notFound()
	}

	const survey = await getSurvey(slug)

	if (!survey) {
		notFound()
	}

	return survey
}
