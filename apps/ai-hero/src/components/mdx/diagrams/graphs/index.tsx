import type { Redraws } from '../redraws'
import { exploreInputs } from './explore'
import { Graph, type GraphDiagram } from './graph'
import { depthPayoff, JSON_PARSE, moduleAnatomy, moduleDepth } from './modules'
import { loaderToDatabase, seamMap, seamSwap } from './seams'
import { KINDS, mapTree, roadmap } from './wayfinder'

/**
 * Every frame is built once, here, so a drawing hands `Graph` the same
 * object on every render and its arrows are measured only when it resizes.
 */
const FRAMES = {
	// Charting the Way: the map as a tree, then resolved, then turned into a spec.
	ehjyz6tnmkyanm0v66dh: mapTree(),
	tsvyswrzcu9uuje5tcmk: mapTree({ done: [1, 2, 3, 4] }),
	dm81mptylfrxywvm6vzz: mapTree({ done: [1, 2, 3, 4], toSpec: true }),
	// The map as a dependency graph, found step by step.
	wsn4bmgwdsjndqfzlnmw: roadmap({ route: 'unknown' }),
	axmtmznubwqmlo1pwf7x: roadmap({ route: 'unknown', done: [2, 3] }),
	zccvb2e3ycn73scxaeus: roadmap({ route: 'unknown', blocked: [4] }),
	nw24rroqp17jowjd3enm: roadmap({ route: 'found-one', done: [2] }),
	wydcpycfxsz8ux1gtl15: roadmap({ route: 'found-all', done: [2, 3, 4, 5, 6] }),
	iww6s3ei4dzeg49nwgxe: roadmap({ route: 'found-all', labels: KINDS }),
	ldpruxxbnjylexkhkif3: roadmap({
		route: 'found-all',
		labels: KINDS,
		done: [3],
	}),
	izx4qr6gi0qkj7oxifou: roadmap({
		route: 'found-all',
		labels: KINDS,
		done: [3],
	}),
	// A Language for Good Codebases.
	'264b9683a228f3d72170cb5759966ea0': moduleAnatomy(),
	b18d74c42eb15365ea5be4d976a09928: moduleAnatomy({ head: 'JSON.parse' }),
	b3c4ea0fb7f5a967a986b8e67b368ddb: moduleAnatomy({
		head: 'JSON.parse',
		items: JSON_PARSE,
	}),
	'99f7f18218fa4f9cecb1d610aa680aa8': moduleDepth({
		head: 'JSON.parse',
		items: JSON_PARSE,
	}),
	bbea45a1d02452219d75f3184cf2446f: depthPayoff,
	d5a5091b03c9ef476521512ec247cc4b: moduleDepth(),
	// Seams & Adapters, and the Improve Codebase Architecture skill.
	'47dfa9ddf3033254a9c63dda5a4277c7': seamMap,
	'4b98871f89fe985d710df47aaec6c9f9': loaderToDatabase,
	b9d281888ad318f693775d4aca55c884: seamSwap({
		caller: 'Loader',
		module: 'access.server.ts',
		live: 'Live Database',
		fake: 'Test Database',
	}),
	b274c7b4f2338cc70f4d830799f4fc1e: seamSwap({
		module: 'daysSince',
		live: 'Real Time',
		fake: 'Fake Time',
	}),
	ffe41150c034a7acb8abcd0e764131c0: seamSwap({
		module: 'daysSince',
		live: 'Real Time',
		fake: 'Fake Time',
	}),
	// Explore Before You Commit.
	'0ab7518d79cf297fe3374f81312f9040': exploreInputs,
	'8db411a5f876e8177b47d5416f9bfbbf': exploreInputs,
} satisfies Record<string, GraphDiagram>

export const graphRedraws: Redraws = Object.fromEntries(
	Object.entries(FRAMES).map(([id, diagram]) => [
		`ai-hero-images/${id}`,
		() => <Graph diagram={diagram} />,
	]),
)
