import type { Redraws } from '../redraws'
import * as S from './data'
import { Pairs, Quote, Stack } from './slide'

const id = (hash: string) => `ai-hero-images/${hash}`

const reviewKinds = () => <Stack slide={S.REVIEW_KINDS} />
const localRemote = () => <Stack slide={S.LOCAL_REMOTE} />
const tacticalStrategic = () => <Stack slide={S.TACTICAL_STRATEGIC} />
const checksAndData = () => <Stack slide={S.CHECKS_AND_DATA} />
const wayfinder = () => <Stack slide={S.WAYFINDER} />
/** Speed and Priority on screen, before Make It Matter appears. */
const speedAndPriority = () => <Stack slide={S.REVIEW_LEVERS} shown={2} />

export const slideRedraws: Redraws = {
	[id('22fdbfbf1e49c56d5a3d6ea33899a91d')]: () => <Stack slide={S.ANY_AGENT} />,
	[id('01d4221dd9d1f6dc5334659acf746aec')]: () => <Stack slide={S.NPM_SCRIPTS} />,
	[id('cxwdwxlqhglz7gwoigip')]: () => <Pairs slide={S.QUESTION_KINDS} />,
	[id('oaywuxednosc9rbdfjr6')]: wayfinder,
	[id('huejlmjzaoopodursqqe')]: wayfinder,
	[id('bgdn8d9xgjazgdasxufe')]: () => <Stack slide={S.DESTINATION} />,
	[id('uxfk25ewp5fvgdlyb1be')]: () => <Stack slide={S.WAYFINDER_MODES} />,
	[id('j3yiuudanvoryeta8k0g')]: () => <Stack slide={S.PLANNING_MODES} />,
	[id('g3tfc1ihhihd61ntzqh8')]: reviewKinds,
	[id('53a02670069ad8032ed7c827020d304c')]: () => (
		<Stack slide={S.REVIEW_KINDS} lit={['Automated Review', 'Human Review']} />
	),
	[id('99ba9ce533a25eda7a33c12626f16b0c')]: speedAndPriority,
	[id('27e67c19ea55a4ae43d1e75c34083465')]: () => <Stack slide={S.DOORS} />,
	[id('7f2ba92ed970ee102788dc1f4fbdcd4d')]: reviewKinds,
	[id('4f0163319b5b9675126159dd2024ffb1')]: speedAndPriority,
	[id('bcc00d8672a42327e39e860aa9eda378')]: reviewKinds,
	[id('6b759bd19acd8cdc5f7840de636a2ddd')]: () => <Pairs slide={S.SKILL_FILES} />,
	[id('8a415a7750d55708b02d9db5ee17ab6c')]: () => <Pairs slide={S.SKILL_JOBS} />,
	[id('2435b8e740900b398c83711a8c8650fb')]: speedAndPriority,
	[id('0b440955302b7fdce70134de507fa7e2')]: reviewKinds,
	[id('d2163199ab56e6d3c39a56ee2eaaf848')]: () => <Stack slide={S.REVIEW_LEVERS} />,
	[id('f91e6e3a33e7dc5c618898521aae42b3')]: () => <Quote slide={S.VIBE_CODING} />,
	[id('3327eb0da4c70ca2db30f17f41be7c31')]: tacticalStrategic,
	[id('663f028decd8e514f10699262491e0ca')]: () => <Quote slide={S.TACTICAL_TORNADO} />,
	[id('1cc005f25f863a3b4616d48a772a9e33')]: () => (
		<Stack slide={S.SHOULD_AGENTS_WRITE_TESTS} />
	),
	[id('eb6630e86385000889c237d447007b02')]: () => (
		<Stack slide={S.MAKE_BAD_TESTS_IMPOSSIBLE} />
	),
	[id('b3cc941e347864a6075cdbcd301ab9e2')]: tacticalStrategic,
	[id('536a3c9870da430328e4cf0cc96a6435')]: reviewKinds,
	[id('a77fc1f4932e8a423fb24fe33f91ba7a')]: reviewKinds,
	[id('6de6befa569b106a838d58dec872c0e9')]: checksAndData,
	[id('7edda8ea22abcfb5ca363c3b58823122')]: checksAndData,
	[id('e2efa905d3875f708bd25e4b964faf48')]: () => (
		<Stack slide={S.BRAKES_ACCELERATORS} />
	),
	[id('8a144f80cd9f96eb6939d5fce16ee6bf')]: localRemote,
	[id('0eaa5dae4a2c6e82592dac3720bf29b8')]: localRemote,
	[id('13b62452b3a96e5d0ebaf7a5e6780894')]: localRemote,
	/** The reset and cherry-pick lines, before pull appears. */
	[id('16c2bd864e876889a3120aa5be6e9a9a')]: () => (
		<Stack slide={S.NPM_SCRIPTS} shown={2} />
	),
	[id('379cb8f93c56945dd6cc493df01d5af5')]: reviewKinds,
	[id('ebb476e0c4bb39c25a7680606af22f19')]: localRemote,
	[id('f505aa9596d552a21f12eb7300500d45')]: reviewKinds,
	[id('439fe74a1ae0c8b399c1731897a9e6b4')]: localRemote,
}
