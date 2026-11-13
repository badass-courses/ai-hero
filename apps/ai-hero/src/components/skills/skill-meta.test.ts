import { describe, expect, it } from 'vitest'

import { skillDependencies, skillInstallCommand } from './skill-meta'

describe('skillDependencies', () => {
	it('reads a double-quoted callee from a Skill tool sentence', () => {
		const body =
			'- Call the Skill tool with "codebase-design" for the architecture vocabulary (**module**, **seam**).'
		expect(
			skillDependencies(body, 'skills-improve-codebase-architecture'),
		).toEqual(['codebase-design'])
	})

	it('reads every callee in one sentence, in order, without repeats', () => {
		const body = [
			'1. Name the destination. Call the Skill tool twice, for "grilling" and "domain-modeling", to pin it down.',
			'Later, call the Skill tool with "grilling" again.',
		].join('\n')
		expect(skillDependencies(body, 'skills-wayfinder')).toEqual([
			'grilling',
			'domain-modeling',
		])
	})

	it('reads backticked callees', () => {
		const body = '1. Call the Skill tool with `writing-for-agents` for the style guide.'
		expect(skillDependencies(body, 'skills-retro')).toEqual([
			'writing-for-agents',
		])
	})

	it('ignores names outside the Skill tool sentence', () => {
		const body = [
			'Each ticket carries a label, one of `research`, `prototype`, `grilling`.',
			'Refactoring belongs to the review stage (see the `code-review` skill).',
			'Call the Skill tool with "tdd". Then read `GLOSSARY.md` and `code-review` notes.',
		].join('\n')
		expect(skillDependencies(body, 'skills-implement')).toEqual(['tdd'])
	})

	it('never returns the skill itself or a name that is unsafe in a shell flag', () => {
		const body =
			'Call the Skill tool with "grill-me", "Bad Name", "$(rm)" and "grilling".'
		expect(skillDependencies(body, 'skills-grill-me')).toEqual(['grilling'])
	})

	it('returns nothing without a body', () => {
		expect(skillDependencies(null, 'skills-grill-me')).toEqual([])
		expect(skillDependencies('No handoffs here.', 'skills-grill-me')).toEqual(
			[],
		)
	})
})

describe('skillInstallCommand', () => {
	it('installs one skill when it calls no siblings', () => {
		expect(skillInstallCommand('skills-grill-me')).toBe(
			'npx skills@latest add mattpocock/skills --skill=grill-me',
		)
	})

	it('adds one --skill flag per sibling the skill calls', () => {
		expect(
			skillInstallCommand('skills-improve-codebase-architecture', [
				'codebase-design',
				'grilling',
			]),
		).toBe(
			'npx skills@latest add mattpocock/skills --skill=improve-codebase-architecture --skill=codebase-design --skill=grilling',
		)
	})
})
