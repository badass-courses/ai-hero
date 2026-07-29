/**
 * The hub-sidebar MDX parser: body text in, ordered blocks out.
 *
 * Split out of `hub-sidebar-ia.ts` because that module is `server-only` and
 * reaches `db`/`next-auth` through its query imports, which made this pure
 * string→data function unreachable from a unit test. Nothing here may import a
 * server module — that is the point of the split. `hub-sidebar-ia.ts`
 * re-exports everything below, so existing import paths keep working.
 *
 * This is the SINGLE-SOURCE vocabulary for both nav surfaces: the desktop
 * sidebar compiles the same MDX as real components, and the mobile menu reads
 * the blocks this produces. The two must stay in lockstep.
 */

export type HubNavLink = { label: string; href: string }

export type ParsedBlock =
	| { kind: 'static'; title: string; links: HubNavLink[] }
	| { kind: 'category'; title: string }
	| { kind: 'whatsNew'; title: string }
	| { kind: 'skillsNav'; title: string }
	| {
			kind: 'topic'
			tag: string
			label?: string
			limit?: number
			curated: HubNavLink[]
	  }

function stringAttr(attrs: string, name: string): string | undefined {
	const m = attrs.match(new RegExp(`${name}="([^"]*)"`))
	return m ? m[1] : undefined
}

function numberAttr(attrs: string, name: string): number | undefined {
	const m = attrs.match(new RegExp(`${name}=\\{(\\d+)\\}`))
	return m ? Number(m[1]) : undefined
}

/** Markdown (`- [L](/h)`) and `<SidebarLink href>` links inside a section. */
function parseLinks(inner: string): HubNavLink[] {
	const links: HubNavLink[] = []
	const md = /-\s*\[([^\]]+)\]\(([^)]+)\)/g
	let m: RegExpExecArray | null
	while ((m = md.exec(inner))) {
		links.push({ label: m[1]!.trim(), href: m[2]!.trim() })
	}
	const jsx = /<SidebarLink\s+href="([^"]+)"\s*>([\s\S]*?)<\/SidebarLink>/g
	while ((m = jsx.exec(inner))) {
		links.push({ label: m[2]!.trim(), href: m[1]!.trim() })
	}
	return links
}

/**
 * Parse the hub-sidebar MDX body into ordered blocks. The vocabulary is the
 * small, controlled set the sidebar map registers (SidebarSection, WhatsNew,
 * SkillsNav, TopicSection — none of which nest), so a match-and-order pass is
 * sufficient and stays in lockstep with the MDX. Anything unrecognized is
 * simply skipped — never a throw (nav must survive a weird edit).
 */
export function parseHubSidebarBlocks(rawBody: string): ParsedBlock[] {
	// Strip MDX comments first — the CMS page carries an authoring comment whose
	// examples (`<SidebarSection title="…">`, `- [Label](/href)`) would
	// otherwise be parsed as real blocks. The MDX compiler ignores them; so do
	// we.
	const body = rawBody.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

	const found: {
		index: number
		kind: ParsedBlock['kind']
		attrs: string
		inner: string
	}[] = []

	const scan = (re: RegExp, kind: ParsedBlock['kind'], hasInner: boolean) => {
		let m: RegExpExecArray | null
		while ((m = re.exec(body))) {
			found.push({
				index: m.index,
				kind,
				attrs: m[1] ?? '',
				inner: hasInner ? (m[2] ?? '') : '',
			})
		}
	}

	scan(
		/<SidebarSection\s+([^>]*?)>([\s\S]*?)<\/SidebarSection>/g,
		'static',
		true,
	)
	// The paired form (curated links as children) and the self-closing form (a
	// purely tag-fed group, no curated links) are BOTH valid MDX, so both must
	// parse — the desktop sidebar renders real components and accepts either,
	// and a form only this parser rejects would silently drop the group from
	// the mobile menu while the sidebar still showed it.
	//
	// The `[^/]` before the closing `>` is what keeps the paired pattern off a
	// self-closing tag: without it, `<TopicSection tag="a" />` followed later by
	// a paired `<TopicSection tag="b">…</TopicSection>` matched as ONE block
	// spanning from the first to the second's closing tag — reporting tag "a"
	// carrying b's links, and swallowing b's block entirely.
	scan(
		/<TopicSection\s+([^>]*?[^/])>([\s\S]*?)<\/TopicSection>/g,
		'topic',
		true,
	)
	scan(/<TopicSection\s+([^>]*?)\/>/g, 'topic', false)
	scan(/<WhatsNew\b([^>]*?)\/>/g, 'whatsNew', false)
	scan(/<SkillsNav\b([^>]*?)\/>/g, 'skillsNav', false)

	// `## Heading` category blocks (the two-tier desktop IA): a heading followed
	// by an OPTIONAL markdown list captured up to the first non-list line. A
	// heading with a list (Explore, Guides) becomes a flat `static` section; a
	// bare heading whose next content is a component (Topics → `<TopicSection>`s)
	// becomes a `category` label. The list group only matches consecutive
	// `- [..](..)` lines, so it never swallows a following component's links.
	const heading =
		/^##[ \t]+(.+?)[ \t]*\r?\n+((?:[ \t]*-[ \t]*\[[^\]]+\]\([^)]+\)[ \t]*\r?\n?)*)/gm
	let hm: RegExpExecArray | null
	while ((hm = heading.exec(body))) {
		const links = parseLinks(hm[2] ?? '')
		found.push({
			index: hm.index,
			kind: links.length > 0 ? 'static' : 'category',
			attrs: `title="${hm[1]!.trim()}"`,
			inner: hm[2] ?? '',
		})
	}

	found.sort((a, b) => a.index - b.index)

	return found.map((f): ParsedBlock => {
		switch (f.kind) {
			case 'static':
				return {
					kind: 'static',
					title: stringAttr(f.attrs, 'title') ?? '',
					links: parseLinks(f.inner),
				}
			case 'category':
				return {
					kind: 'category',
					title: stringAttr(f.attrs, 'title') ?? '',
				}
			case 'topic':
				return {
					kind: 'topic',
					tag: stringAttr(f.attrs, 'tag') ?? '',
					label: stringAttr(f.attrs, 'label'),
					limit: numberAttr(f.attrs, 'limit'),
					curated: parseLinks(f.inner),
				}
			case 'whatsNew':
				return {
					kind: 'whatsNew',
					title: stringAttr(f.attrs, 'title') ?? "What's New",
				}
			case 'skillsNav':
				return {
					kind: 'skillsNav',
					title: stringAttr(f.attrs, 'title') ?? 'Skills',
				}
		}
	})
}
