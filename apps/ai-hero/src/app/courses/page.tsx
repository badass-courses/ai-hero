import type { Metadata } from 'next'
import { ComingSoon } from '@/components/coming-soon'
import LayoutClient from '@/components/layout-client'

export const metadata: Metadata = {
	title: 'Courses | AI Hero',
	description: 'Cohorts, workshops, and courses from AI Hero.',
}

export default function CoursesPage() {
	return (
		<LayoutClient withContainer>
			<ComingSoon
				label="Courses"
				title="Courses & Cohorts"
				description="A single home for every AI Hero cohort and course is on the way. For now, see the upcoming cohorts and self-paced workshops."
			/>
		</LayoutClient>
	)
}
