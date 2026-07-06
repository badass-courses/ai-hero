/**
 * INTERIM, MOBILE-ONLY sidebar IA.
 *
 * The desktop hub sidebar is fully MDX-driven (single source of truth: the
 * CMS `hub-sidebar` page, or the bundled `hub-sidebar-fallback.ts` default —
 * see lat.md/decisions.md "MDX-driven sidebar"). The mobile menu panel still
 * reads this hand-modeled taxonomy because it renders inside the global client
 * nav (`LayoutClient` → `Navigation` → `MobileMenuPanel`), which is mounted
 * client-side across ~70 pages and so cannot see the server-compiled MDX
 * without a client-reachable IA source. Until that bridge exists, this is a
 * second source of truth and WILL drift from the MDX — keep the two in sync by
 * hand, and delete this file once the mobile panel consumes the same MDX. See
 * WORKLOG "MDX single source" for the plan.
 *
 * Client-safe (no server imports) so the mobile panel can render it directly.
 */

export type SidebarLink = {
	label: string
	href: string
}

export type SidebarTopicGroup = {
	label: string
	items: SidebarLink[]
}

/** Flagship free resources (mobile "Resources" section). */
export const TENTPOLE_LINKS: SidebarLink[] = [
	{ label: 'LLM Fundamentals', href: '/llm-fundamentals' },
	{ label: 'AI Engineer Roadmap', href: '/ai-engineer-roadmap' },
	{ label: 'AI Coding Dictionary', href: '/ai-coding-dictionary' },
]

/**
 * Goal-oriented topic groups (mobile "Topics" accordion). MUST mirror the
 * TopicSection taxonomy in the hub-sidebar MDX; kept as a hand copy only until
 * the mobile panel is wired to the same MDX source.
 */
export const TOPIC_GROUPS: SidebarTopicGroup[] = [
	{
		label: 'Understand the Basics',
		items: [
			{ label: 'What Is An LLM?', href: '/what-is-an-llm' },
			{ label: 'What Are Tokens?', href: '/what-are-tokens' },
			{
				label: 'What Is The Context Window?',
				href: '/what-is-the-context-window',
			},
			{ label: 'What Is An Agent?', href: '/what-is-an-agent' },
		],
	},
	{
		label: 'Build AI Apps',
		items: [
			{ label: "What Is Vercel's AI SDK?", href: '/what-is-the-ai-sdk' },
			{
				label: 'Improving Your LLM-Powered App',
				href: '/how-to-improve-your-llm-powered-app',
			},
			{
				label: 'Securing Your AI App with Guardrails',
				href: '/securing-your-ai-app-with-guardrails',
			},
		],
	},
	{
		label: 'Connect Tools (MCP)',
		items: [
			{
				label: 'How Does MCP Work?',
				href: '/how-does-the-model-context-protocol-work',
			},
			{
				label: 'Connect Claude Code To GitHub',
				href: '/connect-claude-code-to-github',
			},
			{
				label: 'Publish Your MCP Server To NPM',
				href: '/publish-your-mcp-server-to-npm',
			},
		],
	},
	{
		label: 'Code with AI Agents',
		items: [
			{ label: 'An Introduction To Plan Mode', href: '/plan-mode-introduction' },
			{ label: 'A Complete Guide To AGENTS.md', href: '/a-complete-guide-to-agents-md' },
			{ label: '5 Agent Skills I Use Every Day', href: '/5-agent-skills-i-use-every-day' },
		],
	},
	{
		label: 'Level Up Your Workflow',
		items: [
			{ label: 'My 7 Phases Of AI Development', href: '/my-7-phases-of-ai-development' },
			{ label: 'Tracer Bullets', href: '/tracer-bullets' },
		],
	},
	{
		label: 'Test & Evaluate',
		items: [
			{ label: 'Your App Is Only As Good As Its Evals', href: '/what-are-evals' },
			{ label: 'The Three Types Of Evals', href: '/three-types-of-evals' },
		],
	},
]
