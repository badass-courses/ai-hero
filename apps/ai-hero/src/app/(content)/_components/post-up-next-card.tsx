'use client'

import Link from 'next/link'
import { AnimatedArrowCircle } from '@/components/landing/animated-arrow-circle'
import { ResourceHoverFrame } from '@/components/resource-hover-frame'
import { motion } from 'framer-motion'
import { useSession } from 'next-auth/react'

import { cn } from '@coursebuilder/utils/cn'

export function PostUpNextCard({
	heading = 'Up Next',
	title,
	href,
	onClick,
	showLoginPrompt,
	surfaceClassName = 'bg-card',
	ariaLabel,
	className,
}: {
	heading?: string
	title: string
	href: string
	onClick?: () => void | Promise<void>
	showLoginPrompt?: boolean
	surfaceClassName?: string
	ariaLabel: string
	className?: string
}) {
	return (
		<>
			<motion.nav
				initial="initial"
				whileHover="hover"
				animate="initial"
				aria-label={ariaLabel}
				className={cn(
					'group/resource border-border relative flex w-full flex-col items-center overflow-hidden border-y py-16 text-center transition',
					surfaceClassName,
					className,
				)}
			>
				<ResourceHoverFrame
					surfaceClassName="bg-inherit"
					className="flex w-full flex-col items-center px-5"
				>
					<h2 className="mb-5 text-xl font-semibold tracking-tight sm:text-3xl">
						{heading}
					</h2>
					<h3 className="text-balance text-lg font-medium leading-tight tracking-tight lg:text-xl">
						{title}
					</h3>
					<span className="mt-5">
						<AnimatedArrowCircle />
					</span>
				</ResourceHoverFrame>
				<Link
					href={href}
					className="focus-visible:ring-ring focus-visible:ring-offset-background absolute inset-0 z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
					aria-label={title}
					onClick={onClick}
				/>
			</motion.nav>
			{showLoginPrompt && <LoginToSaveProgress />}
		</>
	)
}

/** Full-width "log in to save progress" prompt. Self-gates on session. */
export function LoginToSaveProgress({ className }: { className?: string }) {
	const { data: session } = useSession()
	if (session?.user) return null
	return (
		<div
			className={cn(
				'dark:text-muted-foreground bg-background flex w-full items-center justify-center gap-1 px-5 py-4 text-center text-sm sm:text-base',
				className,
			)}
		>
			<Link
				href="/login"
				target="_blank"
				className="hover:text-foreground inline-flex items-center gap-1.5 text-center underline"
			>
				<LoginIcon />
				Log in
			</Link>
			<span>to save progress.</span>
		</div>
	)
}

function LoginIcon() {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			className="size-4"
			fill="none"
			viewBox="0 0 24 24"
			aria-hidden
		>
			<path
				stroke="currentColor"
				strokeWidth="1.5"
				d="M2.5 12c0-4.478 0-6.718 1.391-8.109S7.521 2.5 12 2.5c4.478 0 6.718 0 8.109 1.391S21.5 7.521 21.5 12c0 4.478 0 6.718-1.391 8.109C18.717 21.5 16.479 21.5 12 21.5c-4.478 0-6.718 0-8.109-1.391C2.5 18.717 2.5 16.479 2.5 12Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeWidth="1.5"
				d="M7.5 17c2.332-2.442 6.643-2.557 9 0m-2.005-7.5c0 1.38-1.12 2.5-2.503 2.5a2.502 2.502 0 0 1-2.504-2.5c0-1.38 1.12-2.5 2.504-2.5a2.502 2.502 0 0 1 2.503 2.5Z"
			/>
		</svg>
	)
}
