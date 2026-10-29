import {
	AlertCircle,
	Laptop,
	RefreshCw,
	Server,
	Timer,
} from 'lucide-react'

import type { PairSlide, QuoteSlide, StackSlide } from './slide'

/**
 * Matt's text slides, each defined once. A lesson image is one frame of one
 * of these, so the registry renders them with that frame's state.
 */

const title = (term: string, text: string, code = false): StackSlide => ({
	scale: 'title',
	items: [{ term, text, code }],
})

export const ANY_AGENT = title(
	'Any Agent',
	'You can use any agent you like, as long as it can use skills.',
)

export const WAYFINDER = title(
	'/wayfinder',
	'A planning skill that lets you plan work of any size, at the right fidelity.',
	true,
)

export const DESTINATION = title(
	'Destination',
	'The place the wayfinder map is going - can either be a spec, or a finished product.',
)

export const SHOULD_AGENTS_WRITE_TESTS = title(
	'Should Agents Write Tests?',
	'Agents write bad tests a lot of the time, so should we just prevent them?',
)

export const MAKE_BAD_TESTS_IMPOSSIBLE = title(
	'Make Bad Tests Impossible',
	'Design your codebase so agents cannot write structure-sensitive tests.',
)

export const NPM_SCRIPTS: StackSlide = {
	scale: 'large',
	items: [
		{ term: 'npm run reset', text: 'Deletes existing work', code: true },
		{ term: 'npm run cherry-pick', text: 'Preserves existing work', code: true },
		{ term: 'npm run pull', text: 'Pulls in upstream changes', code: true },
	],
}

export const WAYFINDER_MODES: StackSlide = {
	scale: 'large',
	items: [
		{
			term: '/wayfinder <prompt>',
			text: 'Create a new wayfinder map in an initial grilling session to decide your destination.',
			code: true,
		},
		{
			term: '/wayfinder #2',
			text: 'Run a wayfinder session to tackle ticket #2 in the map.',
			code: true,
		},
	],
}

export const PLANNING_MODES: StackSlide = {
	scale: 'large',
	items: [
		{
			term: 'One-Shot',
			text: 'Get the agent to create the code without grilling first.',
		},
		{
			term: '/grill-with-docs',
			text: 'Get the agent to ask you questions before you begin work.',
			code: true,
		},
		{
			term: '/wayfinder',
			text: 'Align over multiple sessions, creating prototypes and completing tasks as you go.',
			code: true,
		},
	],
}

export const REVIEW_KINDS: StackSlide = {
	scale: 'large',
	items: [
		{
			term: 'Automated Checks',
			text: 'Deterministic checks that check on the quality of the code.',
		},
		{
			term: 'Automated Review',
			text: 'LLM-as-a-judge checks, where you run an agent on the output.',
		},
		{ term: 'Human Review', text: 'A human, checking the code.' },
	],
}

export const CHECKS_AND_DATA: StackSlide = {
	scale: 'large',
	items: [
		{
			term: 'Automated Checks',
			text: 'Deterministic checks that check on the quality of the code.',
		},
		{
			term: 'Data Sources',
			text: 'Give your agent information about its own environment, so it can verify its work.',
		},
	],
}

export const REVIEW_LEVERS: StackSlide = {
	scale: 'small',
	items: [
		{ term: 'Speed', text: 'Making the actual review faster', icon: Timer },
		{
			term: 'Priority',
			text: "Reducing time on frivolous PR's, and increasing it on important ones",
			icon: AlertCircle,
		},
		{
			term: 'Make It Matter',
			text: 'Take human review comments and use them to improve the system.',
			icon: RefreshCw,
		},
	],
}

export const DOORS: StackSlide = {
	scale: 'small',
	items: [
		{ term: 'Two-Way Door', text: 'A change that is easy to walk back.' },
		{
			term: 'One-Way Door',
			text: "A change that you can't walk back easily - data loss, cost, security.",
		},
	],
}

export const TACTICAL_STRATEGIC: StackSlide = {
	scale: 'large',
	items: [
		{
			term: 'Tactical',
			text: 'Get the thing working. The sergeant, fighting the battle. Short-term view.',
		},
		{
			term: 'Strategic',
			text: 'Make the codebase healthy. The general, winning the war. Long-term view.',
		},
	],
}

export const BRAKES_ACCELERATORS: StackSlide = {
	scale: 'large',
	items: [
		{
			term: 'Brakes',
			text: 'Things that slow agents down and increase the quality of the outputs.',
		},
		{
			term: 'Accelerators',
			text: 'Things that speed the agent up, or schedule work autonomously.',
		},
	],
}

export const LOCAL_REMOTE: StackSlide = {
	scale: 'small',
	items: [
		{
			term: 'Local',
			text: 'Agents run on your computer. Great for HITL.',
			icon: Laptop,
		},
		{
			term: 'Remote',
			text: 'Agents run in remote sandboxes. Great for AFK.',
			icon: Server,
		},
	],
}

export const SKILL_FILES: PairSlide = {
	rows: [
		{ left: '/implement', right: 'AGENTS.md', tone: 'muted' },
		{ left: '/code-review', right: 'CODING_STANDARDS.md', tone: 'muted' },
	],
	code: { left: true, right: true },
}

export const SKILL_JOBS: PairSlide = {
	rows: [
		{ left: '/implement', right: 'Make It Work', tone: 'muted' },
		{ left: '/code-review', right: 'Make It Good', tone: 'muted' },
	],
	code: { left: true },
}

export const QUESTION_KINDS: PairSlide = {
	rows: [
		{ left: 'Quiz', right: 'Question', tone: 'amber' },
		{ left: 'Discussion', right: 'Question', tone: 'blue' },
	],
}

export const VIBE_CODING: QuoteSlide = {
	paragraphs: [
		'There\'s a new kind of coding I call "vibe coding", where you fully give in to the vibes, embrace exponentials, and forget that the code even exists. [...]',
		'I "Accept All" always, I don\'t read the diffs anymore. [...] It\'s not too bad for throwaway weekend projects, but still quite amusing.',
	],
	cite: 'Andrej Karpathy, Feb 2025',
}

export const TACTICAL_TORNADO: QuoteSlide = {
	paragraphs: [
		'The tactical tornado is a prolific programmer who pumps out code far faster than others, but works in a totally tactical fashion. [...]',
		'However, tactical tornadoes leave behind a wake of destruction.',
	],
	cite: 'John Ousterhout, A Philosophy Of Software Design, 2018',
}
