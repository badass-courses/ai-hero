import type { Redraws } from '../redraws'
import { BotSandboxes } from './bot-sandboxes'
import { InfraBoard } from './infra'
import { INFRA_FRAMES } from './infra-frames'
import { Roadmap } from './roadmap'
import { SessionWindows } from './session-windows'
import { SkillBars } from './skill-bars'
import { SkillList } from './skill-list'

const id = (hash: string) => `ai-hero-images/${hash}`

const LOOP = ['to-spec', 'to-tickets', 'implement', 'code-review'] as const

/** Matt's boards and lists: the course roadmap, the infrastructure board as
    he builds it up, the numbered skill loops, and the icon sketches. */
export const boardRedraws: Redraws = {
	// Where We're Going, and again in Wrapping Up: the same roadmap.
	[id('9af28bb0434926bc96cfe0e363980d5e')]: () => <Roadmap />,
	[id('5f6206ab45790553fd72a0b02ea0534d')]: () => <Roadmap />,

	...Object.fromEntries(
		Object.entries(INFRA_FRAMES).map(([hash, frame]) => [
			id(hash),
			() => <InfraBoard frame={frame} />,
		]),
	),

	[id('m07grzhqo8su32czs3uj')]: () => <SkillList skills={['grill-with-docs', ...LOOP]} />,
	[id('p2kvzb3itdyo93vqyjap')]: () => <SkillList skills={['wayfinder', ...LOOP]} />,
	[id('cafc1274e4f914c7aaaa655e9e0b840b')]: () => <SkillBars />,

	[id('1ef579b1e8921beba0e576d3c487aa76')]: () => <BotSandboxes frame={{ columns: 1 }} />,
	[id('426e16a036068212330a00a707c72e9c')]: () => <BotSandboxes frame={{ columns: 3 }} />,
	[id('ef7c583370c110b531d50b1f881f1f0d')]: () => (
		<BotSandboxes frame={{ columns: 3, people: true }} />
	),

	// Shares of the window each grilling session fills, measured off Matt's board.
	[id('apyqiqnlsyfk8you6fon')]: () => <SessionWindows fills={[0.08]} />,
	[id('dqmz0mihrroxbd77bt01')]: () => <SessionWindows fills={[0.4, 0.37]} />,
}
