'use client'

import * as React from 'react'
import Image from 'next/image'
import LayoutClient from '@/components/layout-client'
import { TYPE } from '@/components/landing/type'
import {
	Alert,
	AlertDescription,
	AlertTitle,
	Button,
	Skeleton,
} from '@coursebuilder/ui'
import {
	PostPurchaseProgress,
	type PurchaseStep,
} from './post-purchase-progress'

export function PostPurchaseShell({
	step = 'processing',
	paymentConfirmed = false,
	title,
	image,
	message,
	supportEmail,
	onRetry,
	children,
	landmark = 'main',
}: {
	step?: PurchaseStep
	paymentConfirmed?: boolean
	title?: string
	image?: string | null
	message?: string
	supportEmail?: string
	onRetry?: () => void
	children?: React.ReactNode
	landmark?: 'main' | 'section'
}) {
	const Landmark = landmark
	const heading = React.useRef<HTMLHeadingElement>(null)
	React.useEffect(() => {
		if (step === 'failed') heading.current?.focus({ preventScroll: true })
	}, [step])
	const status =
		message ??
		{
			processing: 'Setting up your access. This usually takes a few seconds.',
			slow: 'Taking longer than usual. We are still waiting for your purchase to finish processing.',
			ready: 'Ready. Your access is set up.',
			email: 'One last step. Check your email for your login link.',
			failed:
				'We could not finish checking your access. Please check your email for a login link or contact support. Do not pay again.',
		}[step]
	const moving = step === 'processing' || step === 'slow'
	return (
		<LayoutClient withContainer>
			<Landmark className="min-h-[calc(100vh-var(--nav-height))]">
				<div className="mx-auto flex min-h-[32rem] max-w-4xl flex-col gap-6 px-[18px] py-12 sm:px-11 md:py-[52px]">
					<PostPurchaseProgress
						step={step}
						paymentConfirmed={paymentConfirmed}
					/>
					<div
						role="status"
						aria-live="polite"
						aria-atomic="true"
						className={`${TYPE.metaProse} min-h-12 text-muted-foreground`}
					>
						{status}
					</div>
					{step === 'failed' && (
						<Alert>
							<AlertTitle>
								<h1 ref={heading} tabIndex={-1} className={TYPE.panelTitle}>
									Setup needs a hand
								</h1>
							</AlertTitle>
							<AlertDescription className="mt-4 flex flex-wrap gap-3">
								<Button onClick={onRetry ?? (() => window.location.reload())}>
									Check again
								</Button>
								<Button asChild variant="outline">
									<a href={`mailto:${supportEmail ?? 'support@aihero.dev'}`}>
										Contact support
									</a>
								</Button>
							</AlertDescription>
						</Alert>
					)}
					{step === 'slow' && (
						<Alert>
							<AlertTitle>Still setting up</AlertTitle>
							<AlertDescription>
								You can leave this tab open while we check. If you already
								received a login link, you can use it to sign in.
							</AlertDescription>
						</Alert>
					)}
					{children ?? (
						<div aria-hidden={!title} className="flex flex-col gap-6">
							<div className="flex items-start gap-6">
								{image ? (
									<Image
										src={image}
										alt=""
										width={112}
										height={112}
										className="h-28 w-28 rounded-lg object-cover motion-safe:animate-in motion-safe:fade-in"
									/>
								) : (
									<Skeleton
										className={`bg-stripes-muted h-28 w-28 shrink-0 rounded-lg ${moving ? 'motion-reduce:animate-none' : 'animate-none'}`}
									/>
								)}
								<div className="flex flex-1 flex-col gap-4">
									{title ? (
										<h1
											className={`${TYPE.heading} motion-safe:animate-in motion-safe:fade-in`}
										>
											{title}
										</h1>
									) : (
										<Skeleton
											className={`h-9 w-4/5 ${moving ? 'motion-reduce:animate-none' : 'animate-none'}`}
										/>
									)}
									<Skeleton
										className={`h-10 w-40 ${moving ? 'motion-reduce:animate-none' : 'animate-none'}`}
									/>
								</div>
							</div>
							<div className="flex flex-col gap-4 border-t border-border pt-6">
								<Skeleton
									className={`h-4 w-1/3 ${moving ? 'motion-reduce:animate-none' : 'animate-none'}`}
								/>
								<Skeleton
									className={`h-4 w-2/3 ${moving ? 'motion-reduce:animate-none' : 'animate-none'}`}
								/>
							</div>
						</div>
					)}
				</div>
			</Landmark>
		</LayoutClient>
	)
}
