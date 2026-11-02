import type { Redraws } from '../redraws'
import { flowRedrawsPartOne } from './part-one'
import { flowRedrawsPartTwo } from './part-two'

export const flowRedraws: Redraws = {
	...flowRedrawsPartOne,
	...flowRedrawsPartTwo,
}
