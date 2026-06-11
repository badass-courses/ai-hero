import Link from 'next/link'

type OrganicOpportunityCtaKind =
	| 'ai-sdk'
	| 'claude-code'
	| 'skills'
	| 'ai-engineer'

const ctas: Record<
	OrganicOpportunityCtaKind,
	{
		eyebrow: string
		title: string
		description: string
		href: string
		label: string
	}
> = {
	'ai-sdk': {
		eyebrow: 'Go deeper',
		title: 'Learn the AI SDK by building with it',
		description:
			'The AI SDK v6 crash course turns the concepts from this article into a working app with streaming, tools, and agents.',
		href: '/workshops/ai-sdk-v6-crash-course',
		label: 'Start the AI SDK crash course',
	},
	'claude-code': {
		eyebrow: 'Build the workflow',
		title: 'Get practical AI coding workflow notes',
		description:
			'Subscribe for short updates on skills, handoffs, testing, code review, and the parts of AI-assisted engineering that survive real code.',
		href: '/skills/subscribe',
		label: 'Subscribe to the Skills newsletter',
	},
	skills: {
		eyebrow: 'Keep sharpening',
		title: 'Get the next skill update in your inbox',
		description:
			'Follow the skills changelog for practical agentic development patterns, not generic AI hype.',
		href: '/skills/subscribe',
		label: 'Subscribe to skill updates',
	},
	'ai-engineer': {
		eyebrow: 'Next step',
		title: 'Move from AI concepts to production habits',
		description:
			'Get practical notes on real engineering workflows for AI-assisted coding, shipped as short Skills updates.',
		href: '/skills/subscribe',
		label: 'Get AI coding workflow notes',
	},
}

/**
 * Maps high-opportunity organic page slugs to the CTA variant that best matches search intent.
 */
export const organicOpportunityCtaBySlug: Record<
	string,
	OrganicOpportunityCtaKind
> = {
	'what-is-the-ai-sdk': 'ai-sdk',
	'ai-engineer-roadmap': 'ai-engineer',
	'what-is-an-ai-engineer': 'ai-engineer',
	'creating-the-perfect-claude-code-status-line': 'claude-code',
	'a-complete-guide-to-agents-md': 'claude-code',
	'the-prompt-report': 'claude-code',
	'skills-changelog-handoff-prototype-review-and-writing': 'skills',
	'skills-to-issues': 'skills',
}

/**
 * Renders a contextual acquisition CTA for organic search opportunity pages.
 *
 * @param kind - CTA variant key, such as `ai-sdk`, `claude-code`, `skills`, or `ai-engineer`.
 * @returns A visible callout linking to the matching workshop or skills subscription page.
 */
export function OrganicOpportunityCta({
	kind,
}: {
	kind: OrganicOpportunityCtaKind
}) {
	const cta = ctas[kind]

	return (
		<aside className="not-prose border-primary/30 bg-primary/5 my-12 flex flex-col gap-4 rounded-xl border p-6 sm:p-8">
			<div className="flex flex-col gap-2">
				<span className="text-primary font-mono text-[11px] font-medium uppercase tracking-wider">
					{cta.eyebrow}
				</span>
				<h2 className="text-foreground text-balance text-2xl font-semibold leading-tight tracking-tight">
					{cta.title}
				</h2>
				<p className="text-foreground/80 text-balance text-base leading-relaxed">
					{cta.description}
				</p>
			</div>
			<div>
				<Link
					href={cta.href}
					className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-11 items-center rounded-md px-5 text-sm font-medium transition"
				>
					{cta.label}
				</Link>
			</div>
		</aside>
	)
}
