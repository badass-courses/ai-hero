import type { ContactEventRecord } from './types'

export type SeenContentKeyDefinition = {
	key: string
	label: string
	aliases: string[]
}

export const SEEN_CONTENT_KEY_DEFINITIONS: SeenContentKeyDefinition[] = [
	{
		key: 'ai-coding-dictionary',
		label: 'AI Coding Dictionary',
		aliases: ['ai-coding-dictionary', 'dictionary'],
	},
	{
		key: 'grill-me',
		label: '/grill-me Skill',
		aliases: ['grill-me', 'grill-with-docs'],
	},
	{
		key: 'is-code-cheap',
		label: 'Is Code Cheap',
		aliases: ['is-code-cheap'],
	},
	{
		key: 'skills-newsletter',
		label: 'Skills Newsletter',
		aliases: ['skills-newsletter', 'skills-changelog'],
	},
	{
		key: 'tracer-bullets',
		label: 'Tracer Bullets',
		aliases: ['tracer-bullets'],
	},
	{
		key: 'my-claw',
		label: 'My Claw',
		aliases: ['my-claw', 'build-your-ai-system'],
	},
]

export type SeenLevel = 'clicked' | 'dwelled' | 'scrolled' | 'acted'

export type SeenContentItem = {
	key: string
	label: string
	strongestSeenLevel: SeenLevel
	lastSeenAt: string
	evidenceCount: number
	eventTypes: string[]
	customerSafeWording: {
		ifSeen: string
		ifUnseen: string
	}
}

export type SeenContentPreview = {
	contactId: string
	seenContentKeys: string
	seenContentUpdatedAt: string
	items: SeenContentItem[]
	unmatchedEventCount: number
	kitWrites: false
	sequenceEnrollments: false
	customerVisibleSideEffects: false
}

const seenLevelRank: Record<SeenLevel, number> = {
	clicked: 1,
	dwelled: 2,
	scrolled: 3,
	acted: 4,
}

export function previewSeenContent(args: {
	contactId: string
	events: ContactEventRecord[]
	now?: string
	definitions?: SeenContentKeyDefinition[]
}): SeenContentPreview {
	const definitions = args.definitions ?? SEEN_CONTENT_KEY_DEFINITIONS
	const byKey = new Map<string, SeenContentItem>()
	let unmatchedEventCount = 0

	for (const event of args.events) {
		const definition = matchSeenContentKey(event, definitions)
		if (!definition) {
			unmatchedEventCount++
			continue
		}
		const level = seenLevelForEvent(event)
		const existing = byKey.get(definition.key)
		if (!existing) {
			byKey.set(definition.key, {
				key: definition.key,
				label: definition.label,
				strongestSeenLevel: level,
				lastSeenAt: event.occurredAt,
				evidenceCount: 1,
				eventTypes: [event.eventType],
				customerSafeWording: customerSafeWording(definition.label),
			})
			continue
		}
		existing.evidenceCount += 1
		if (!existing.eventTypes.includes(event.eventType)) {
			existing.eventTypes.push(event.eventType)
		}
		if (seenLevelRank[level] > seenLevelRank[existing.strongestSeenLevel]) {
			existing.strongestSeenLevel = level
		}
		if (new Date(event.occurredAt) > new Date(existing.lastSeenAt)) {
			existing.lastSeenAt = event.occurredAt
		}
	}

	const items = definitions
		.map((definition) => byKey.get(definition.key))
		.filter((item): item is SeenContentItem => Boolean(item))
		.slice(0, 20)

	return {
		contactId: args.contactId,
		seenContentKeys: items.map((item) => item.key).join('|'),
		seenContentUpdatedAt: args.now ?? new Date().toISOString(),
		items,
		unmatchedEventCount,
		kitWrites: false,
		sequenceEnrollments: false,
		customerVisibleSideEffects: false,
	}
}

function matchSeenContentKey(
	event: ContactEventRecord,
	definitions: SeenContentKeyDefinition[],
) {
	const explicit = stringValue((event.payloadSummary as any).seenContentKey)
	if (explicit) {
		const match = definitions.find((definition) => definition.key === explicit)
		if (match) return match
	}
	const haystack = [
		event.providerEventId,
		event.providerReference,
		event.payloadSummary.summary,
		...event.payloadSummary.keywords,
	]
		.join(' ')
		.toLowerCase()
	return definitions.find((definition) =>
		definition.aliases.some((alias) => haystack.includes(alias.toLowerCase())),
	)
}

function seenLevelForEvent(event: ContactEventRecord): SeenLevel {
	if (event.eventType === 'shortlink.click') return 'clicked'
	const summary = event.payloadSummary.summary.toLowerCase()
	const keywords = event.payloadSummary.keywords.join(' ').toLowerCase()
	const text = `${summary} ${keywords}`
	if (text.includes('cta_click')) return 'acted'
	if (text.includes('scroll_50')) return 'scrolled'
	if (text.includes('dwell_30s')) return 'dwelled'
	return 'clicked'
}

function customerSafeWording(label: string) {
	return {
		ifSeen: `If you already saw ${label}, the next useful step is...`,
		ifUnseen: `A good first step is ${label}.`,
	}
}

function stringValue(value: unknown) {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
