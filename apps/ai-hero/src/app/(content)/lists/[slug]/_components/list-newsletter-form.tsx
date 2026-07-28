'use client'

import * as React from 'react'
import { TYPE } from '@/components/landing/type'
import { SubscribeToConvertkitForm } from '@/convertkit'

import { cn } from '@coursebuilder/ui/utils/cn'

/**
 * The newsletter half of the overview's two-up footer.
 *
 * `SlimNewsletterForm` is the landing's version of this and puts both fields
 * and the button on one line — which needs the full container width. Here the
 * form lives in half of a two-column footer, where that same row squeezes the
 * inputs down to a few characters each. Same fields, same styling vocabulary,
 * wrapped to two lines.
 */
export function ListNewsletterForm() {
	return (
		<div className="flex w-full max-w-[460px] flex-col gap-3">
			<SubscribeToConvertkitForm
				actionLabel="Subscribe"
				className="[&_button]:bg-accent-fill [&_button]:text-accent-fill-foreground [&_button]:hover:bg-accent-fill-hover [&_input]:border-border [&_input]:bg-background [&_input]:text-foreground grid w-full grid-cols-2 gap-3 [&_button]:col-span-2 [&_button]:h-11 [&_button]:rounded-[9px] [&_button]:border-0 [&_button]:text-sm [&_button]:font-bold [&_input]:h-11 [&_input]:rounded-[9px] [&_input]:border [&_input]:px-4 [&_input]:text-sm [&_input]:placeholder:text-[color:var(--ah-fg-faint)] [&_label]:hidden"
			/>
			<p className={cn(TYPE.command, 'text-[color:var(--ah-fg-faint)]')}>
				No spam. Unsubscribe anytime.
			</p>
		</div>
	)
}
