/**
 * The cast of Matt's workflow diagrams. Each step names who does it, and the
 * colour is how a reader tells them apart at a glance, so it follows his
 * drawings: tracker green, orchestrator blue, runner amber, git host orange,
 * human purple.
 */
export const FLOW_ROLES = {
	tracker: { label: 'Ticket Tracker', hue: 'oklch(0.68 0.15 150)' },
	orchestrator: { label: 'Orchestrator', hue: 'oklch(0.66 0.13 245)' },
	runner: { label: 'Runner', hue: 'oklch(0.76 0.14 80)' },
	git: { label: 'Git Host', hue: 'oklch(0.68 0.17 45)' },
	human: { label: 'Human', hue: 'oklch(0.64 0.17 300)' },
} as const

export type FlowRole = keyof typeof FLOW_ROLES
