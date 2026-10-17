import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
	decideSubscribe,
	isRandomLookingName,
	subscribeBotMode,
} from './subscribe-bot-decision'

const passingNameFixtures = [
	'',
	'Al',
	'Q',
	'reader',
	'Krzysztof',
	'McDonald',
	'Anne-Marie',
	"O'Neil",
	'李小明',
	'محمد',
	'Αλέξανδρος',
	'Élodie',
	'DeAndre',
	'LaShawn',
]
const nameCases: Array<{ name: unknown; random: boolean }> = [
	...passingNameFixtures.map((name) => ({ name, random: false })),
	{ name: undefined, random: false },
	{ name: null, random: false },
	{ name: 42, random: false },
	{ name: 'aBcDeFgHiJ', random: true },
	// These real-name shapes meet the heuristic too. Humans still always pass.
	{ name: 'DeAndreLaShawn', random: true },
	{ name: 'JeanLucDeAndre', random: true },
]

describe('subscribe decision table', () => {
	for (const botid of ['human', 'bot', 'error', 'no-attestation'] as const) {
		for (const { name: firstName, random } of nameCases) {
			it(`${botid} / ${String(firstName)}`, () => {
				expect(decideSubscribe({ botid, firstName })).toEqual(
					botid === 'bot'
						? { action: 'reject', reason: random ? 'random-name' : 'botid' }
						: {
								action: 'allow',
								reason:
									botid === 'error'
										? 'botid-error'
										: botid === 'no-attestation'
											? 'no-attestation'
											: 'human',
							},
				)
			})
		}
	}

	it.each([
		[false, false, 'off'],
		[true, false, 'shadow'],
		[false, true, 'enforce'],
		[true, true, 'enforce'],
	] as const)('shadow=%s enforce=%s -> %s', (shadow, enforce, mode) => {
		expect(subscribeBotMode({ shadow, enforce })).toBe(mode)
	})
})

describe('name fixture table and generated-string property', () => {
	it.each(passingNameFixtures)('passes fixture %j', (name) => {
		expect(isRandomLookingName(name)).toBe(false)
	})

	it('flags generated mixed-case ASCII strings with enough inner capitals', () => {
		const letter = fc
			.integer({ min: 0, max: 25 })
			.map((n) => String.fromCharCode(97 + n))
		const names = fc
			.array(letter, { minLength: 8, maxLength: 80 })
			.map((letters) =>
				letters
					.map((c, index) => ([1, 3, 5].includes(index) ? c.toUpperCase() : c))
					.join(''),
			)
		fc.assert(
			fc.property(names, (name) => isRandomLookingName(name)),
			{ numRuns: 1000 },
		)
	})

	it.each([
		['aBcDeFg', false],
		['aBcDeFgh', true],
		['ABcDefgh', false],
		['AbcDEfgh', false],
		['ABcDEfgh', true],
		['aBc-DeFgH', false],
		['aBc1DeFgH', false],
		['aBc DeFgH', false],
		['DeAndre', false],
		['LaShawn', false],
		['DeAndreLaShawn', true],
		['JeanLucDeAndre', true],
	] as const)('boundary %s -> %s', (name, expected) => {
		expect(isRandomLookingName(name)).toBe(expected)
	})
})
