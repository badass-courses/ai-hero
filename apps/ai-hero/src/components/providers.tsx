'use client'

import * as React from 'react'
import { usePathname } from 'next/navigation'
import { sendFeedbackFromUser } from '@/components/feedback-widget/feedback-actions'
import { FeedbackDialog } from '@/components/feedback-widget/feedback-dialog'
import { MuxPlayerProvider } from '@/hooks/use-mux-player'
import { MDXProvider } from '@mdx-js/react'
import { SessionProvider } from 'next-auth/react'

import { FeedbackProvider } from '@coursebuilder/ui/feedback-widget'

export function Providers({ children }: { children: React.ReactNode }) {
	const pathname = usePathname()
	const currentUrl = `${process.env.NEXT_PUBLIC_URL}${pathname}`

	return (
		<SessionProvider>
			<MDXProvider>
				<MuxPlayerProvider>
					<FeedbackProvider
						sendFeedback={sendFeedbackFromUser}
						currentUrl={currentUrl}
						feedbackComponent={<FeedbackDialog />}
					>
						{children}
					</FeedbackProvider>
				</MuxPlayerProvider>
			</MDXProvider>
		</SessionProvider>
	)
}
