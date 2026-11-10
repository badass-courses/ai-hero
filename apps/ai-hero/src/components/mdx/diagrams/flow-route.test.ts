import { describe, expect, it } from 'vitest'

import { routeArrow, type Box, type Point } from './flow-route'

const BOUNDS: Box = { left: 0, top: 0, right: 400, bottom: 400 }
const DOWN = { x: 0, y: 1 }
const UP = { x: 0, y: -1 }

/** Every point the path draws through, read off its commands: ends,
    corners and the points along each straight run and curve. */
function sample(d: string): Point[] {
	const numbers = d.match(/-?\d+(\.\d+)?/g)!.map(Number)
	const points: Point[] = []
	for (let i = 0; i < numbers.length; i += 2)
		points.push({ x: numbers[i]!, y: numbers[i + 1]! })
	const dense: Point[] = []
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1]!
		const b = points[i]!
		for (let t = 0; t <= 1; t += 0.05)
			dense.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
	}
	return dense
}

const crosses = (d: string, box: Box) =>
	sample(d).some(
		(p) =>
			p.x > box.left && p.x < box.right && p.y > box.top && p.y < box.bottom,
	)

describe('routeArrow', () => {
	it('draws the plain curve when nothing is in the way', () => {
		const d = routeArrow(
			{ x: 100, y: 50 },
			DOWN,
			{ x: 100, y: 300 },
			UP,
			[],
			BOUNDS,
		)
		expect(d).toMatch(/^M100,50 C/)
	})

	it('goes around a label sitting between the two steps', () => {
		const label: Box = { left: 60, top: 150, right: 240, bottom: 180 }
		const d = routeArrow(
			{ x: 100, y: 50 },
			DOWN,
			{ x: 100, y: 300 },
			UP,
			[label],
			BOUNDS,
		)
		expect(d).not.toMatch(/ C/)
		expect(crosses(d, label)).toBe(false)
		expect(d).toMatch(/^M100,50 /)
		expect(d).toMatch(/ L100,300$/)
	})

	it('keeps the curve inside the bounds', () => {
		const d = routeArrow(
			{ x: 10, y: 50 },
			{ x: -1, y: 0 },
			{ x: 10, y: 200 },
			{ x: -1, y: 0 },
			[],
			BOUNDS,
		)
		for (const p of sample(d)) expect(p.x).toBeGreaterThanOrEqual(0)
	})

	it('ends every arrow in a straight run longer than its head', () => {
		const label: Box = { left: 60, top: 150, right: 240, bottom: 180 }
		for (const labels of [[], [label]]) {
			const d = routeArrow(
				{ x: 100, y: 50 },
				DOWN,
				{ x: 100, y: 300 },
				UP,
				labels,
				BOUNDS,
			)
			const [x0, y0, x1, y1] = d
				.match(/-?[\d.]+/g)!
				.slice(-4)
				.map(Number)
			expect(x0).toBe(x1)
			expect(y1! - y0!).toBeGreaterThanOrEqual(10)
		}
	})

	it('stops the line a head short of the tip, still running straight', () => {
		const d = routeArrow(
			{ x: 100, y: 50 },
			DOWN,
			{ x: 100, y: 300 },
			UP,
			[],
			BOUNDS,
			8,
		)
		const [x0, y0, x1, y1] = d
			.match(/-?[\d.]+/g)!
			.slice(-4)
			.map(Number)
		expect([x1, y1]).toEqual([100, 292])
		expect(x0).toBe(x1)
		expect(y1! - y0!).toBeGreaterThanOrEqual(10)
	})
})
