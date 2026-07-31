import { SkillsCourseRestartButton } from './skills-course-restart-button'

export function SkillsCourseConfirmed({
	source = 'skills_course_confirmed',
	variant,
}: {
	source?: string
	variant: 'just-enrolled' | 'returning'
}) {
	return (
		<div className="bg-primary/10 border-primary/20 flex flex-col items-start gap-3 rounded-[9px] border p-4">
			<p className="text-primary text-sm font-medium">
				{variant === 'just-enrolled' ? (
					<>
						You&rsquo;re in. Lesson one is on its way to your inbox. If it
						doesn&rsquo;t arrive, send a fresh copy.
					</>
				) : (
					<>
						You&rsquo;re already enrolled. If lesson one isn&rsquo;t in your
						inbox, send a fresh copy.
					</>
				)}
			</p>
			<SkillsCourseRestartButton source={source} />
		</div>
	)
}
