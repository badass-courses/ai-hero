'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import { ArrowRight } from 'lucide-react'

export function AnimatedArrowCircle() {
	return (
		<span
			aria-hidden
			className="relative flex h-12 w-12 shrink-0 items-center justify-center sm:h-[54px] sm:w-[54px]"
		>
			<svg
				viewBox="0 0 54 54"
				className="absolute inset-0 h-full w-full"
				fill="none"
			>
				<circle
					cx="27"
					cy="27"
					r="26"
					stroke="currentColor"
					strokeWidth="1"
					className="text-foreground/20"
				/>
				<motion.circle
					cx="27"
					cy="27"
					r="26"
					stroke="currentColor"
					strokeWidth="1.5"
					strokeLinecap="round"
					className="text-foreground"
					initial={{ pathLength: 0, opacity: 0 }}
					variants={{
						initial: { pathLength: 0, opacity: 0 },
						hover: { pathLength: 1, opacity: 1 },
					}}
					transition={{
						duration: 0.5,
						ease: [0.65, 0, 0.35, 1],
					}}
					style={{
						rotate: -90,
						transformOrigin: '50% 50%',
					}}
				/>
			</svg>
			<ArrowRight className="relative h-4 w-4 sm:h-5 sm:w-5" />
		</span>
	)
}
