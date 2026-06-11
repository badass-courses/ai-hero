'use client'

import {
	Children,
	isValidElement,
	useContext,
	useEffect,
	useMemo,
	useRef,
} from 'react'
import Link from 'next/link'
import {
	ActiveHeadingContext,
	type HeadingInfo,
} from '@/hooks/use-active-heading'
import { slugifyHeading } from '@/utils/extract-markdown-headings'
import { motion, useInView } from 'framer-motion'

import { AISummaryContext } from './mdx-components'

interface HeadingProps {
	level: 1 | 2 | 3 | 4 | 5 | 6
	children: React.ReactNode
	className?: string
}

function getTextContent(node: React.ReactNode): string {
	return Children.toArray(node)
		.map((child) => {
			if (typeof child === 'string' || typeof child === 'number') {
				return String(child)
			}

			if (isValidElement<{ children?: React.ReactNode }>(child)) {
				return getTextContent(child.props.children)
			}

			return ''
		})
		.join('')
}

export function Heading({ level, children, ...props }: HeadingProps) {
	const ref = useRef<HTMLHeadingElement>(null)
	const isInView = useInView(ref, {
		amount: 0,
		margin: '-80px 0px -40% 0px',
	})
	const activeHeadingContext = useContext(ActiveHeadingContext)
	const isWithinAISummary = useContext(AISummaryContext)
	const registerVisibility = activeHeadingContext?.registerVisibility

	const text = useMemo(() => getTextContent(children), [children])

	const slug = useMemo(() => slugifyHeading(text), [text])

	const headingInfo = useMemo(
		(): HeadingInfo => ({
			slug,
			text,
			level,
		}),
		[slug, text, level],
	)

	useEffect(() => {
		if (isWithinAISummary || !registerVisibility) return

		registerVisibility(headingInfo, isInView)
		return () => {
			registerVisibility(headingInfo, false)
		}
	}, [isInView, headingInfo, registerVisibility, isWithinAISummary])

	const Component = motion[`h${level}`]

	return (
		<Component ref={ref} id={slug} className="scroll-mt-32">
			<Link
				href={`#${slug}`}
				className="text-inherit! w-full font-semibold no-underline"
			>
				{children}
			</Link>
		</Component>
	)
}
