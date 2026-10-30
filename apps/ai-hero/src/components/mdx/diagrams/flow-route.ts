/**
 * Arrow routing for `Flow`. An arrow is the cubic Matt draws, leaving and
 * arriving square to the sides it joins; when that curve would cross a
 * step's badges or words, it goes around them instead, along a grid search
 * drawn with rounded corners. Pure geometry, in the figure's own pixels.
 */

export type Box = { left: number; top: number; right: number; bottom: number }
export type Point = { x: number; y: number }

/** How far a detour keeps from any label it passes, and the tighter
    clearance it falls back to where two steps leave less room. */
const CLEARANCE = 8
const TIGHT = 3
/** The search grid's cell, in pixels. */
const CELL = 6
/** A turn costs as much as this many cells, so detours stay simple. */
const TURN = 4
/** The straight run an arrow keeps off each side before it may turn. */
const LEAD = 14
/** Corner radius of a detour. Rounding a corner cuts in by under a third
    of this, which the clearance and half a cell absorb. */
const RADIUS = 20
/** How much shallower or deeper than the default each end of the curve may
    bow, tried in order before an arrow detours. */
const BOWS = [
	[1, 1],
	[0.5, 0.5],
	[1.6, 1.6],
	[0.5, 1.6],
	[1.6, 0.5],
	[0.25, 0.25],
	[2.4, 2.4],
] as const

/**
 * The arrow from `a` to `b`, leaving along the unit normal `na` and arriving
 * against `nb`. `labels` are the boxes it must not cross; `bounds` is the
 * area it may use.
 */
export function routeArrow(
	a: Point,
	na: Point,
	b: Point,
	nb: Point,
	labels: readonly Box[],
	bounds: Box,
): string {
	const distance = Math.hypot(b.x - a.x, b.y - a.y)
	const reach = Math.min(72, Math.max(20, distance * 0.4))
	// Control points inside the bounds keep the whole curve inside them (a
	// cubic stays within the hull of its four points).
	const curves = BOWS.map(([s1, s2]) => {
		const c1 = clamp(
			{ x: a.x + na.x * reach * s1, y: a.y + na.y * reach * s1 },
			bounds,
		)
		const c2 = clamp(
			{ x: b.x + nb.x * reach * s2, y: b.y + nb.y * reach * s2 },
			bounds,
		)
		return [a, c1, c2, b] as const
	})
	const clear = curves.find((curve) => !cubicHits(curve, labels))
	if (clear) return cubic(clear)

	const roomy = search(a, na, b, nb, labels, bounds, CLEARANCE)
	if (roomy) return rounded(roomy, RADIUS)
	const tight = search(a, na, b, nb, labels, bounds, TIGHT)
	if (tight) return rounded(tight, TIGHT * 2)
	return cubic(curves[0]!)
}

function cubic([a, c1, c2, b]: readonly [Point, Point, Point, Point]) {
	return `M${a.x},${a.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${b.x},${b.y}`
}

function clamp(p: Point, bounds: Box): Point {
	return {
		x: Math.min(bounds.right, Math.max(bounds.left, p.x)),
		y: Math.min(bounds.bottom, Math.max(bounds.top, p.y)),
	}
}

function inside(p: Point, box: Box, pad: number) {
	return (
		p.x > box.left - pad &&
		p.x < box.right + pad &&
		p.y > box.top - pad &&
		p.y < box.bottom + pad
	)
}

/** Whether the cubic passes through a label. */
export function cubicHits(
	[p0, p1, p2, p3]: readonly [Point, Point, Point, Point],
	labels: readonly Box[],
) {
	const steps = 64
	for (let i = 1; i < steps; i++) {
		const t = i / steps
		const u = 1 - t
		const p = {
			x:
				u * u * u * p0.x +
				3 * u * u * t * p1.x +
				3 * u * t * t * p2.x +
				t * t * t * p3.x,
			y:
				u * u * u * p0.y +
				3 * u * u * t * p1.y +
				3 * u * t * t * p2.y +
				t * t * t * p3.y,
		}
		if (labels.some((box) => inside(p, box, 2))) return true
	}
	return false
}

/**
 * The cheapest path on a grid from just off `a` to just off `b` that keeps
 * `clearance` from every label, with turns penalised. Returns the corner
 * points, `a` and `b` included, or null when the labels wall it off.
 */
function search(
	a: Point,
	na: Point,
	b: Point,
	nb: Point,
	labels: readonly Box[],
	bounds: Box,
	clearance: number,
): Point[] | null {
	const cols = Math.max(1, Math.ceil((bounds.right - bounds.left) / CELL))
	const rows = Math.max(1, Math.ceil((bounds.bottom - bounds.top) / CELL))
	const blocked = new Uint8Array(cols * rows)
	for (const box of labels) {
		const c0 = Math.max(
			0,
			Math.floor((box.left - clearance - bounds.left) / CELL),
		)
		const c1 = Math.min(
			cols - 1,
			Math.floor((box.right + clearance - bounds.left) / CELL),
		)
		const r0 = Math.max(
			0,
			Math.floor((box.top - clearance - bounds.top) / CELL),
		)
		const r1 = Math.min(
			rows - 1,
			Math.floor((box.bottom + clearance - bounds.top) / CELL),
		)
		for (let r = r0; r <= r1; r++)
			blocked.fill(1, r * cols + c0, r * cols + c1 + 1)
	}

	const cellOf = (p: Point) => ({
		c: Math.min(cols - 1, Math.max(0, Math.floor((p.x - bounds.left) / CELL))),
		r: Math.min(rows - 1, Math.max(0, Math.floor((p.y - bounds.top) / CELL))),
	})
	const centre = (c: number, r: number): Point => ({
		x: bounds.left + (c + 0.5) * CELL,
		y: bounds.top + (r + 0.5) * CELL,
	})
	const start = cellOf({ x: a.x + na.x * LEAD, y: a.y + na.y * LEAD })
	const goal = cellOf({ x: b.x + nb.x * LEAD, y: b.y + nb.y * LEAD })
	blocked[start.r * cols + start.c] = 0
	blocked[goal.r * cols + goal.c] = 0

	// States are a cell and the direction it was entered by.
	const DIRS = [
		{ dc: 1, dr: 0 },
		{ dc: -1, dr: 0 },
		{ dc: 0, dr: 1 },
		{ dc: 0, dr: -1 },
	] as const
	const directionOf = (n: Point) =>
		n.x > 0 ? 0 : n.x < 0 ? 1 : n.y > 0 ? 2 : 3
	const total = cols * rows * 4
	const cost = new Float64Array(total).fill(Infinity)
	const parent = new Int32Array(total).fill(-1)
	const heap = new MinHeap()
	const h = (c: number, r: number) =>
		Math.abs(c - goal.c) + Math.abs(r - goal.r)
	const first = (start.r * cols + start.c) * 4 + directionOf(na)
	cost[first] = 0
	heap.push(first, h(start.c, start.r))
	// Arriving square to `b` means the last move runs against its normal.
	const arrival = directionOf({ x: -nb.x, y: -nb.y })

	let found = -1
	while (heap.size > 0) {
		const state = heap.pop()
		const dir = state % 4
		const cell = (state - dir) / 4
		const c = cell % cols
		const r = (cell - c) / cols
		if (c === goal.c && r === goal.r) {
			found = state
			break
		}
		for (let d = 0; d < 4; d++) {
			const { dc, dr } = DIRS[d]!
			const nc = c + dc
			const nr = r + dr
			if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
			if (blocked[nr * cols + nc]) continue
			const atGoal = nc === goal.c && nr === goal.r
			const step =
				1 + (d === dir ? 0 : TURN) + (atGoal && d !== arrival ? TURN : 0)
			const next = (nr * cols + nc) * 4 + d
			const value = cost[state]! + step
			if (value < cost[next]!) {
				cost[next] = value
				parent[next] = state
				heap.push(next, value + h(nc, nr))
			}
		}
	}
	if (found < 0) return null

	const cells: Point[] = []
	for (let s = found; s >= 0; s = parent[s]!) {
		const cell = (s - (s % 4)) / 4
		cells.push(centre(cell % cols, (cell - (cell % cols)) / cols))
	}
	cells.reverse()
	// Square the ends onto the anchors' lines, so the arrow leaves and
	// arrives straight.
	const leave = squareTo(a, na, cells[0]!)
	const enter = squareTo(b, nb, cells[cells.length - 1]!)
	return corners([a, leave, ...cells, enter, b])
}

/** The point on the line out of `p` along `n` level with `q`. */
function squareTo(p: Point, n: Point, q: Point): Point {
	return n.x !== 0 ? { x: q.x, y: p.y } : { x: p.x, y: q.y }
}

/** Drops points that sit on a straight run. */
function corners(points: Point[]): Point[] {
	const out: Point[] = []
	for (const p of points) {
		const last = out[out.length - 1]
		if (last && Math.abs(last.x - p.x) < 0.5 && Math.abs(last.y - p.y) < 0.5)
			continue
		const prev = out[out.length - 2]
		if (
			prev &&
			last &&
			Math.abs(
				(last.x - prev.x) * (p.y - last.y) - (last.y - prev.y) * (p.x - last.x),
			) < 0.5
		) {
			out[out.length - 1] = p
			continue
		}
		out.push(p)
	}
	return out
}

/** A polyline with its corners rounded. */
function rounded(points: Point[], radius: number): string {
	let d = `M${points[0]!.x},${points[0]!.y}`
	for (let i = 1; i < points.length - 1; i++) {
		const p = points[i]!
		const prev = points[i - 1]!
		const next = points[i + 1]!
		const inLen = Math.hypot(p.x - prev.x, p.y - prev.y)
		const outLen = Math.hypot(next.x - p.x, next.y - p.y)
		const r = Math.min(radius, inLen / 2, outLen / 2)
		const from = {
			x: p.x - ((p.x - prev.x) / inLen) * r,
			y: p.y - ((p.y - prev.y) / inLen) * r,
		}
		const to = {
			x: p.x + ((next.x - p.x) / outLen) * r,
			y: p.y + ((next.y - p.y) / outLen) * r,
		}
		d += ` L${from.x},${from.y} Q${p.x},${p.y} ${to.x},${to.y}`
	}
	const end = points[points.length - 1]!
	return `${d} L${end.x},${end.y}`
}

/** A binary min-heap of numeric states by priority. */
class MinHeap {
	private items: number[] = []
	private keys: number[] = []
	get size() {
		return this.items.length
	}
	push(item: number, key: number) {
		this.items.push(item)
		this.keys.push(key)
		let i = this.items.length - 1
		while (i > 0) {
			const up = (i - 1) >> 1
			if (this.keys[up]! <= this.keys[i]!) break
			this.swap(i, up)
			i = up
		}
	}
	pop(): number {
		const top = this.items[0]!
		const lastItem = this.items.pop()!
		const lastKey = this.keys.pop()!
		if (this.items.length > 0) {
			this.items[0] = lastItem
			this.keys[0] = lastKey
			let i = 0
			for (;;) {
				const l = i * 2 + 1
				const r = l + 1
				let min = i
				if (l < this.keys.length && this.keys[l]! < this.keys[min]!) min = l
				if (r < this.keys.length && this.keys[r]! < this.keys[min]!) min = r
				if (min === i) break
				this.swap(i, min)
				i = min
			}
		}
		return top
	}
	private swap(i: number, j: number) {
		;[this.items[i], this.items[j]] = [this.items[j]!, this.items[i]!]
		;[this.keys[i], this.keys[j]] = [this.keys[j]!, this.keys[i]!]
	}
}
