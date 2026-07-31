import { SkillsCourseRestartButton } from './skills-course-restart-button'

export function SkillsCourseConfirmed({
	source = 'skills_course_confirmed',
}: {
	source?: string
}) {
	return (
		<div className="bg-primary/10 border-primary/20 flex flex-col items-start gap-3 border p-4">
			<p className="text-primary text-sm font-medium">
				Check your inbox for the first lesson. If it never arrived, send that
				lesson again.
			</p>
			<SkillsCourseRestartButton source={source} />
		</div>
	)
}
