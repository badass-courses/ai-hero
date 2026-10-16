import * as React from 'react'

/**
 * A slim section rule for long-form MDX: the hatched, pointed band from behind
 * the cohort calendar artwork, at the width of the text column.
 *
 * It takes no props. Put it where the argument turns, above the heading or
 * paragraph that opens the next part:
 *
 *     <Divider />
 *
 *     ## Classic Concepts + Coding Agents
 *
 * All of the drawing is `.ah-divider` in `globals.css`.
 */
export function Divider() {
	return <div role="separator" className="ah-divider" />
}
