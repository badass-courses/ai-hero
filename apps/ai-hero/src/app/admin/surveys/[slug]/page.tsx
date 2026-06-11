import { redirect } from 'next/navigation'

export default async function SurveyDetailPage({
	params,
}: {
	params: Promise<{ slug: string }>
}) {
	const { slug } = await params

	redirect(`/admin/surveys/${slug}/questions`)
}
