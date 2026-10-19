import {
	SandcastleDocsView,
	sandcastleDocsMetadata,
	sandcastleDocsStaticParams,
} from '../_components/sandcastle-docs'

export const revalidate = 3600

type Props = {
	params: Promise<{ slug: string }>
}

export const generateStaticParams = sandcastleDocsStaticParams

export async function generateMetadata({ params }: Props) {
	return sandcastleDocsMetadata((await params).slug)
}

export default async function SandcastleDocsPage({ params }: Props) {
	return <SandcastleDocsView slug={(await params).slug} />
}
