import type { ReviewSignalSlug, WhoSignalSlug, WhySignalSlug } from './types'

// Gate A seed taxonomy from the approved Subscriber Marketing Automation
// domain model. Labels and slugs are reviewed domain language. Keyword arrays
// are deterministic dry-run heuristics, not corpus-derived customer language.
// Calibrate or replace them from sanitized quick-question responses before
// Gate B internal capture depends on classification quality.
export const WHY_SIGNALS: Record<
	WhySignalSlug,
	{ label: string; keywords: string[] }
> = {
	'ai-coding-workflow-real-engineering': {
		label: 'AI coding workflow and real engineering',
		keywords: [
			'coding workflow',
			'production',
			'real engineering',
			'codebase',
			'developer workflow',
			'ship code',
		],
	},
	'agentic-workflows-automation': {
		label: 'Agentic workflows and automation',
		keywords: [
			'agent',
			'automation',
			'workflow',
			'autonomous',
			'multi-agent',
			'orchestration',
		],
	},
	'professional-relevance-team-adoption': {
		label: 'Professional relevance and team adoption',
		keywords: [
			'team',
			'career',
			'job',
			'adoption',
			'manager',
			'company',
			'professional',
		],
	},
	'build-products-apps-prototypes': {
		label: 'Build products, apps, and prototypes',
		keywords: [
			'app',
			'product',
			'prototype',
			'mvp',
			'build',
			'startup',
			'saas',
		],
	},
	'content-research-knowledge-work': {
		label: 'Content, research, and knowledge work',
		keywords: ['content', 'research', 'writing', 'knowledge', 'notes', 'docs'],
	},
	'cut-through-overwhelm-build-judgment': {
		label: 'Cut through overwhelm and build judgment',
		keywords: [
			'overwhelmed',
			'confused',
			'judgment',
			'too much',
			'noise',
			'where to start',
		],
	},
	'ai-fundamentals-under-the-hood': {
		label: 'AI fundamentals and under-the-hood understanding',
		keywords: [
			'fundamentals',
			'under the hood',
			'how it works',
			'llm',
			'models',
			'tokens',
		],
	},
	'other-unclear': {
		label: 'Other or unclear',
		keywords: [],
	},
}

export const WHO_SIGNALS: Record<
	WhoSignalSlug,
	{ label: string; keywords: string[] }
> = {
	'professional-software-engineer': {
		label: 'Professional software engineer',
		keywords: [
			'software engineer',
			'developer',
			'programmer',
			'frontend',
			'backend',
			'full-stack',
		],
	},
	'technical-team-leader': {
		label: 'Technical or team leader',
		keywords: [
			'cto',
			'tech lead',
			'engineering manager',
			'lead',
			'team lead',
			'vp engineering',
		],
	},
	'educator-content-community-builder': {
		label: 'Educator, content, or community builder',
		keywords: [
			'teacher',
			'educator',
			'course',
			'content creator',
			'community',
			'newsletter',
		],
	},
	'nontraditional-early-technical-learner': {
		label: 'Nontraditional or early technical learner',
		keywords: [
			'beginner',
			'learning to code',
			'bootcamp',
			'career switch',
			'new developer',
		],
	},
	'data-research-ai-practitioner': {
		label: 'Data, research, or AI practitioner',
		keywords: [
			'data scientist',
			'researcher',
			'ml engineer',
			'ai practitioner',
			'analyst',
		],
	},
	'founder-product-builder': {
		label: 'Founder or product builder',
		keywords: [
			'founder',
			'indie hacker',
			'product manager',
			'product builder',
			'startup',
		],
	},
	unclear: {
		label: 'Unclear',
		keywords: [],
	},
}

export const LAYERED_REVIEW_SIGNALS: Record<
	ReviewSignalSlug,
	{ label: string; keywords: string[] }
> = {
	buying: {
		label: 'Buying intent',
		keywords: [
			'price',
			'buy',
			'buying',
			'purchase',
			'discount',
			'coupon',
			'refund',
		],
	},
	'team-sales': {
		label: 'Team sales',
		keywords: ['team license', 'enterprise', 'procurement', 'invoice', 'seats'],
	},
	support: {
		label: 'Support ask',
		keywords: ['help', 'bug', 'broken', 'login', 'access', 'support'],
	},
	partnership: {
		label: 'Partnership',
		keywords: ['partner', 'partnership', 'affiliate'],
	},
	sponsorship: {
		label: 'Sponsorship',
		keywords: ['sponsor', 'sponsorship', 'advertise'],
	},
	emotional: {
		label: 'Emotional signal',
		keywords: ['angry', 'frustrated', 'overwhelmed', 'anxious', 'upset'],
	},
	ambiguous: { label: 'Ambiguous', keywords: ['not sure', 'maybe', 'unclear'] },
	'low-confidence': { label: 'Low confidence', keywords: [] },
	'restricted-payload': { label: 'Restricted payload', keywords: [] },
}
