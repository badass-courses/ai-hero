import { TYPE } from '@/components/landing/type'

import { cn } from '@coursebuilder/ui/utils/cn'

import { hueStyle, type BoardHue } from './hues'

/** Matt numbers the steps in this order of colours, whatever the steps are. */
const STEP_HUES: readonly BoardHue[] = ['green', 'amber', 'red', 'purple', 'blue']

/**
 * Matt's loop of skills as a numbered list, each number ringed in its own
 * colour. The ring colours carry no meaning beyond telling the steps apart.
 */
export function SkillList({ skills }: { skills: readonly string[] }) {
	return (
		<figure className="not-prose @container my-8">
			<ol className="space-y-5 @2xl:pl-[12%] @2xl:space-y-6">
				{skills.map((skill, i) => (
					<li key={skill} data-node={skill} className="flex items-center gap-4">
						<span
							className={cn(
								TYPE.subhead,
								'grid size-10 shrink-0 place-items-center rounded-full border-[2.5px] border-(--edge) @2xl:size-12',
							)}
							style={hueStyle(STEP_HUES[i % STEP_HUES.length]!)}
						>
							{i + 1}
						</span>
						<span className={cn(TYPE.subhead, 'font-mono tracking-normal')}>
							{skill}
						</span>
					</li>
				))}
			</ol>
		</figure>
	)
}
