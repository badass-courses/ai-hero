import type { FlowNode, FlowPlace } from '../flow'

/** A step whose columns hold for the whole video while its row does not:
    Matt grows a drawing by adding steps between others, which pushes the
    ones below further down. */
export type FrameStep = Omit<FlowNode, 'wide' | 'narrow'> & {
	wide: Omit<FlowPlace, 'row'> & { row?: number }
	narrow?: Omit<FlowPlace, 'row'> & { row?: number }
}

/** A step on the row it sits on in one frame, in both layouts. */
export function at(step: FrameStep, row: number): FlowNode {
	return {
		...step,
		wide: { ...step.wide, row },
		narrow: step.narrow && { ...step.narrow, row },
	}
}
