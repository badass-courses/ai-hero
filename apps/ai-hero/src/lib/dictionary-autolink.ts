import { toInternalHref } from '@/utils/rehype-internal-links'

import type { DictionaryEntry } from './ai-coding-dictionary'

/**
 * A site page that prose names by a proper noun, linked like a dictionary
 * term. Matched case-sensitively: the name is the tool ("Sandcastle"), while
 * lowercase spellings are paths and channels (`.sandcastle/`, `#sandcastle`).
 */
export type PageAutoLink = {
	phrase: string
	url: string
}

type DictionaryAutoLinkOptions = {
	maxLinks?: number
	excludedSlugs?: string[]
	pages?: PageAutoLink[]
}

type DictionaryLinkCandidate = {
	phrase: string
	url: string
	matchCase: boolean
}

type AutoLinkState = {
	linkedUrls: Set<string>
	linkCount: number
	maxLinks: number
	candidates: DictionaryLinkCandidate[]
}

const DEFAULT_MAX_LINKS = 3

const genericSlugs = new Set([
	'agent',
	'context',
	'environment',
	'filesystem',
	'inference',
	'model',
	'parameters',
	'session',
	'skill',
	'spec',
	'ticket',
	'token',
	'tool',
	'training',
	'turn',
])

const safeSingleWordSlugs = new Set([
	'afk',
	'autocompact',
	'compaction',
	'grilling',
	'hallucination',
	'sandbox',
	'stateful',
	'stateless',
	'subagent',
	'sycophancy',
])

const skippedNodeTypes = new Set([
	'code',
	'definition',
	'heading',
	'html',
	'image',
	'imageReference',
	'inlineCode',
	'link',
	'linkReference',
	'mdxFlowExpression',
	'mdxJsxFlowElement',
	'mdxJsxTextElement',
	'mdxTextExpression',
	'table',
	'yaml',
])

function isSpecificDictionaryEntry(entry: DictionaryEntry) {
	if (genericSlugs.has(entry.slug)) return false
	if (entry.title.includes(' ')) return true
	return safeSingleWordSlugs.has(entry.slug)
}

function normalizeCandidatePhrase(phrase: string) {
	return phrase.replace(/\s+/g, ' ').trim()
}

function getCandidateKey(candidate: DictionaryLinkCandidate) {
	return `${candidate.url}:${candidate.phrase.toLowerCase()}`
}

export function buildDictionaryLinkCandidates({
	entries,
	excludedSlugs = [],
}: {
	entries: DictionaryEntry[]
	excludedSlugs?: string[]
}) {
	const excluded = new Set(excludedSlugs)
	const candidates = new Map<string, DictionaryLinkCandidate>()

	for (const entry of entries) {
		if (excluded.has(entry.slug)) continue

		const phrases = [
			...(isSpecificDictionaryEntry(entry) ? [entry.title] : []),
			...entry.aliases,
		]

		for (const phrase of phrases) {
			const normalizedPhrase = normalizeCandidatePhrase(phrase)
			if (normalizedPhrase.length < 3) continue

			const candidate = {
				phrase: normalizedPhrase,
				url: `/ai-coding-dictionary/${entry.slug}`,
				matchCase: false,
			}
			candidates.set(getCandidateKey(candidate), candidate)
		}
	}

	return [...candidates.values()].sort(byLongestPhrase)
}

function byLongestPhrase(
	a: DictionaryLinkCandidate,
	b: DictionaryLinkCandidate,
) {
	const wordDelta = b.phrase.split(/\s+/).length - a.phrase.split(/\s+/).length
	return wordDelta || b.phrase.length - a.phrase.length
}

function isWordCharacter(character: string | undefined) {
	return Boolean(character && /[A-Za-z0-9_]/.test(character))
}

function hasBoundary(value: string, index: number, length: number) {
	return (
		!isWordCharacter(value[index - 1]) &&
		!isWordCharacter(value[index + length])
	)
}

function findCandidateMatch(value: string, state: AutoLinkState) {
	const lowerValue = value.toLowerCase()
	let bestMatch: {
		candidate: DictionaryLinkCandidate
		index: number
		text: string
	} | null = null

	for (const candidate of state.candidates) {
		if (state.linkedUrls.has(candidate.url)) continue

		const haystack = candidate.matchCase ? value : lowerValue
		const needle = candidate.matchCase
			? candidate.phrase
			: candidate.phrase.toLowerCase()
		let index = haystack.indexOf(needle)

		while (index >= 0) {
			if (hasBoundary(value, index, candidate.phrase.length)) {
				if (!bestMatch || index < bestMatch.index) {
					bestMatch = {
						candidate,
						index,
						text: value.slice(index, index + candidate.phrase.length),
					}
				}
				break
			}

			index = haystack.indexOf(needle, index + 1)
		}
	}

	return bestMatch
}

function linkTextNode(
	value: string,
	state: AutoLinkState,
): Array<Record<string, any>> {
	const nodes: Array<Record<string, any>> = []
	let remaining = value

	while (remaining && state.linkCount < state.maxLinks) {
		const match = findCandidateMatch(remaining, state)
		if (!match) break

		if (match.index > 0) {
			nodes.push({ type: 'text', value: remaining.slice(0, match.index) })
		}

		nodes.push({
			type: 'link',
			url: match.candidate.url,
			title: null,
			children: [{ type: 'text', value: match.text }],
		})

		state.linkedUrls.add(match.candidate.url)
		state.linkCount += 1
		remaining = remaining.slice(match.index + match.text.length)
	}

	if (remaining) {
		nodes.push({ type: 'text', value: remaining })
	}

	return nodes.length > 0 ? nodes : [{ type: 'text', value }]
}

function transformParagraph(node: Record<string, any>, state: AutoLinkState) {
	if (!Array.isArray(node.children)) return

	for (let index = 0; index < node.children.length; index++) {
		if (state.linkCount >= state.maxLinks) return

		const child = node.children[index]
		if (!child || skippedNodeTypes.has(child.type)) continue

		if (child.type === 'text' && typeof child.value === 'string') {
			const replacement = linkTextNode(child.value, state)
			if (replacement.length !== 1 || replacement[0]?.type !== 'text') {
				node.children.splice(index, 1, ...replacement)
				index += replacement.length - 1
			}
		}
	}
}

function transformParagraphsOnly(
	node: Record<string, any>,
	state: AutoLinkState,
) {
	if (state.linkCount >= state.maxLinks) return
	if (skippedNodeTypes.has(node.type) || !Array.isArray(node.children)) return

	for (const child of node.children) {
		if (state.linkCount >= state.maxLinks) return
		if (!child || skippedNodeTypes.has(child.type)) continue

		if (child.type === 'paragraph') {
			transformParagraph(child, state)
			continue
		}

		transformParagraphsOnly(child, state)
	}
}

/**
 * Where the author already links, an auto-link would only repeat them: a
 * lesson that opens on "[Sandcastle](/sandcastle)" needs no second link on the
 * next mention. Absolute links to this site count as the path they name.
 */
function collectLinkedUrls(node: Record<string, any>, urls: Set<string>) {
	if (node.type === 'link' && typeof node.url === 'string') {
		urls.add(toInternalHref(node.url) ?? node.url)
	}
	if (Array.isArray(node.children)) {
		for (const child of node.children) collectLinkedUrls(child, urls)
	}
	return urls
}

export function createDictionaryAutoLinkRemarkPlugin({
	entries,
	maxLinks = DEFAULT_MAX_LINKS,
	excludedSlugs = [],
	pages = [],
}: DictionaryAutoLinkOptions & { entries: DictionaryEntry[] }) {
	const candidates = [
		...buildDictionaryLinkCandidates({ entries, excludedSlugs }),
		...pages.map((page) => ({ ...page, matchCase: true })),
	].sort(byLongestPhrase)

	return function dictionaryAutoLinkRemarkPlugin() {
		return function transformDictionaryLinks(tree: Record<string, any>) {
			const state: AutoLinkState = {
				linkedUrls: collectLinkedUrls(tree, new Set()),
				linkCount: 0,
				maxLinks,
				candidates,
			}

			transformParagraphsOnly(tree, state)
		}
	}
}
