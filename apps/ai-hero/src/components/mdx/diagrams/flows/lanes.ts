import type { FlowPlace } from '../flow'

/**
 * The two lanes of Matt's later drawings: the main line of steps down the
 * left, wrapping at about a third of the width as his do, and the side
 * branches on the right. On a phone the left lane widens a column, since a
 * third of a phone is too little to wrap in.
 */
export const left = (row: number): { wide: FlowPlace; narrow: FlowPlace } => ({
	wide: { col: 2, row, span: 4 },
	narrow: { col: 2, row, span: 5 },
})

export const right = (row: number): { wide: FlowPlace } => ({
	wide: { col: 8, row, span: 5 },
})
