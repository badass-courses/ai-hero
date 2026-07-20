import { Check } from 'lucide-react'

import * as SkillsNewsletter from './skills-newsletter'
import { type SkillsNewsletterStatus } from './skills-newsletter'

const COURSE_LESSONS = [
	{
		title: 'Choose your workflow path',
		description:
			'Start with reusable agent workflows instead of one-off prompts.',
	},
	{
		title: 'Clarify the work with /grill-with-docs',
		description: 'Find the fuzzy decisions before an agent starts building.',
	},
	{
		title: 'Test uncertain ideas with /prototype and /handoff',
		description: 'Make the unknown visible in a small, throwaway context.',
	},
	{
		title: 'Turn decisions into /to-spec and /to-tickets',
		description: 'Break large work into reviewable vertical slices.',
	},
	{
		title: 'Run safer AFK agents with Sandcastle',
		description:
			'Use scoped tasks, isolation, visible logs, and reviewable commits.',
	},
	{
		title: 'Review the result with /code-review',
		description:
			'Find avoidable mistakes and improve the system around the diff.',
	},
	{
		title: 'Put the full workflow together',
		description: 'Run the loop from fuzzy idea to a better next agent run.',
	},
] as const

export function SkillsCourseFrontDoor({
	status,
	location,
}: {
	status: SkillsNewsletterStatus
	location: string
}) {
	return (
		<main className="bg-background text-foreground">
			<section className="border-border grid border-b lg:grid-cols-[minmax(0,1.15fr)_minmax(22rem,0.85fr)]">
				<div className="flex flex-col justify-center gap-6 px-8 py-16 sm:px-16 sm:py-24 lg:py-28">
					<p className="text-primary font-mono text-xs font-medium uppercase tracking-wider">
						Free 7-day email course
					</p>
					<h1 className="max-w-3xl text-balance font-sans text-5xl font-medium leading-[0.98] tracking-tight sm:text-6xl lg:text-7xl">
						AI Skills for Real Engineers
					</h1>
					<p className="text-muted-foreground max-w-2xl text-balance text-xl font-light leading-snug sm:text-2xl">
						Build a repeatable workflow for working with coding agents without
						giving up your engineering standards.
					</p>
					<p className="text-foreground/70 max-w-xl text-base leading-relaxed sm:text-lg">
						One practical lesson each day. Learn the skills, try them on real
						work, and finish with a workflow you can reuse.
					</p>
				</div>

				<div className="bg-stripes border-border flex items-center border-t p-6 sm:p-10 lg:border-l lg:border-t-0">
					<SkillsNewsletter.Root status={status} location={location}>
						<div className="bg-background border-border mx-auto flex w-full max-w-md flex-col gap-5 border p-6 shadow-sm sm:p-8">
							<p className="font-mono text-xs font-medium uppercase tracking-wider opacity-60">
								Start the course
							</p>
							<h2 className="text-balance text-2xl font-semibold leading-tight sm:text-3xl">
								Get lesson one in your inbox
							</h2>
							<SkillsNewsletter.StatusView
								subscribed={
									<div className="flex flex-col gap-3">
										<p className="bg-primary/10 text-primary border-primary/20 border p-4 text-sm font-medium">
											You’re enrolled. Check your inbox for the first lesson.
										</p>
										<SkillsNewsletter.TagMeButton
											label="Not getting emails? Reconnect"
											className="bg-secondary text-secondary-foreground"
										/>
									</div>
								}
								tagMe={
									<>
										<SkillsNewsletter.TagMeButton
											label="Start the free course"
											className="bg-primary"
										/>
										<SkillsNewsletter.Privacy />
									</>
								}
								form={
									<>
										<SkillsNewsletter.Form
											label="Start the free course"
											className="[&_button]:bg-primary flex flex-col gap-3 [&_button]:rounded-lg [&_input]:rounded-lg"
										/>
										<SkillsNewsletter.Privacy />
									</>
								}
							/>
						</div>
					</SkillsNewsletter.Root>
				</div>
			</section>

			<section
				aria-labelledby="curriculum-heading"
				className="border-border border-b px-8 py-16 sm:px-16 sm:py-24"
			>
				<div className="mx-auto max-w-5xl">
					<p className="text-primary mb-3 font-mono text-xs font-medium uppercase tracking-wider">
						The 7-day curriculum
					</p>
					<h2
						id="curriculum-heading"
						className="mb-10 text-balance text-3xl font-medium tracking-tight sm:text-5xl"
					>
						From fuzzy idea to a workflow you trust
					</h2>
					<ol className="grid gap-px overflow-hidden border bg-border md:grid-cols-2">
						{COURSE_LESSONS.map((lesson, index) => (
							<li
								key={lesson.title}
								className="bg-background flex gap-4 p-6 sm:p-8"
							>
								<span className="bg-primary text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-full font-mono text-sm font-semibold">
									{index + 1}
								</span>
								<div>
									<h3 className="font-semibold leading-snug">{lesson.title}</h3>
									<p className="text-foreground/65 mt-2 text-sm leading-relaxed">
										{lesson.description}
									</p>
								</div>
							</li>
						))}
					</ol>
				</div>
			</section>

			<section className="px-8 py-14 sm:px-16 sm:py-20">
				<div className="mx-auto flex max-w-4xl flex-col items-start gap-4 sm:flex-row sm:items-center sm:gap-6">
					<span className="bg-primary/10 text-primary flex size-12 shrink-0 items-center justify-center rounded-full">
						<Check className="size-6" aria-hidden />
					</span>
					<div>
						<h2 className="text-xl font-semibold">
							Built from Matt Pocock’s working AI skills
						</h2>
						<p className="text-foreground/65 mt-1 leading-relaxed">
							Matt created AI Hero and the practical agent skills taught in this
							course.
						</p>
					</div>
				</div>
			</section>
		</main>
	)
}
