import {
	SandcastleDocsView,
	sandcastleDocsMetadata,
} from './_components/sandcastle-docs'

export const revalidate = 3600

export function generateMetadata() {
	return sandcastleDocsMetadata('')
}

export default function SandcastleDocsIndexPage() {
	return <SandcastleDocsView slug="" />
}
