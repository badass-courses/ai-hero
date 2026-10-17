import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
	decideSubscribe,
	isRandomLookingName,
	subscribeBotMode,
} from './subscribe-bot-decision'

const humanNames = [
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
]
const randomName = 'aBcDeFgHiJ'

describe('subscribe decision table', () => {
	for (const botid of ['human', 'bot', 'error'] as const) {
		for (const firstName of [...humanNames, undefined, null, 42, randomName]) {
			it(`${botid} / ${String(firstName)}`, () => {
				expect(decideSubscribe({ botid, firstName })).toEqual(
					botid === 'bot'
						? {
								action: 'reject',
								reason: firstName === randomName ? 'random-name' : 'botid',
							}
						: {
								action: 'allow',
								reason: botid === 'error' ? 'botid-error' : 'human',
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

describe('name properties', () => {
	it('never flags real-name shapes, including punctuation, non-Latin names and short handles', () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...humanNames),
				(name) => !isRandomLookingName(name),
			),
			{ numRuns: 1000 },
		)
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
	] as const)('boundary %s -> %s', (name, expected) => {
		expect(isRandomLookingName(name)).toBe(expected)
	})
})
