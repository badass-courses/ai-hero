#!/usr/bin/env python3
"""Cut the site's web fonts down to what it draws, in two files per face.

Reads the original files in scripts/fonts/source/ and the crawl in
scripts/fonts/usage.json, and writes to src/app/fonts/:

- `<font>-core-<style>.woff2`: ASCII plus the punctuation most pages use.
  Preloaded on every page, as the whole font is today.
- `<font>-ext-<style>.woff2`: every other character the original file has.
  It joins the same `next/font` family behind `unicode-range`, so it only
  downloads on a page that draws one of its characters.
- `fonts.ts`: the `next/font/local` calls, with each file's `unicode-range`
  read back from the file it describes.

Each file keeps the glyph outlines, metrics, kerning and default-on OpenType
features of the original. Axes are limited to the `font-weight` range in the
`@font-face` rule, the only weights CSS can reach. Unused features (`frac`,
`numr`, `dnom`, `pnum`, `tnum`, `locl`) are dropped. The originals carry no
hinting beyond `gasp`, which stays.

Before writing anything it shapes every pair of characters in each output file
with HarfBuzz at several weights and compares glyph outlines and positions with
the original. Any difference fails the run.

    scripts/fonts/.venv/bin/python scripts/fonts/subset.py

See README.md for setup and when to rerun.
"""

from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path

import freetype
import uharfbuzz as hb
from fontTools import subset
from fontTools.pens.recordingPen import RecordingPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

HERE = Path(__file__).resolve().parent
APP = HERE.parent.parent
SOURCE = HERE / "source"
OUT = APP / "src" / "app" / "fonts"

# Features a browser applies to Latin text without being asked. The crawl in
# usage.json finds no CSS that turns on anything else, and no `lang` attribute
# that would select a `locl` language system (only Turkish, Catalan, Romanian
# and similar systems carry one).
FEATURES = ["ccmp", "liga", "calt", "kern", "mark", "mkmk"]

ASCII = set(range(0x20, 0x7F))
# Spaces and invisible characters, soft hyphen included: tiny glyphs, and a
# run that switches files on one would lose kerning for nothing.
SPACES = {0x0D, 0xA0, 0xAD, 0x2002, 0x2009, 0x200B, 0xFEFF}
# Punctuation the crawl finds on many pages, plus the ellipsis that
# `text-overflow: ellipsis` draws (over 3,000 elements across the crawl).
CORE_PUNCTUATION = {
    0x00B7,  # · mono labels, about half of all pages
    0x2013,  # –
    0x2014,  # — about half of all pages
    0x2018,  # ‘
    0x2019,  # ’ about a quarter of all pages
    0x201C,  # “
    0x201D,  # ”
    0x2022,  # • cohort pages
    0x2026,  # … every page
}
# FreeType's autohinter, which Chrome on Linux runs on unhinted fonts at the
# usual `hintslight` setting, measures blue zones and stems from these
# letters (afblue.dat, Latin) in the same file. Without them the extended
# file's accented letters would snap differently. They sit in its cmap but not
# in its `unicode-range`, so the browser never draws them from it.
AUTOHINT_REFERENCE = set(map(ord, "THEZOCQSLUfijkdbhxzroescpqgjyO0o"))
LATIN_1 = set(range(0xA0, 0x100))
LATIN_1_LETTERS = set(range(0xC0, 0x100)) - {0xD7, 0xF7}
LATIN_EXT_A = set(range(0x100, 0x180))

# One entry per `next/font/local` family. `var` is the binding name, which
# Turbopack uses as the CSS family name; the extended faces declare it.
FAMILIES = [
    {
        "usage": "sans",
        "var": "geist",
        "cssVar": "--font-geist",
        "out": "dm-sans",
        "weight": (400, 700),
        "fallback": "Arial",
        "faces": {
            "normal": "dm-sans-latin-normal.woff2",
            "italic": "dm-sans-latin-italic.woff2",
        },
    },
    {
        "usage": "mono",
        "var": "geistMono",
        "cssVar": "--font-geist-mono",
        "out": "jetbrains-mono",
        "weight": (400, 500),
        "fallback": "Arial",
        "faces": {"normal": "jetbrains-mono-latin-normal.woff2"},
    },
    {
        "usage": "serif",
        "var": "sourceSerif",
        "cssVar": "--font-source-serif",
        # OFL Reserved Font Name "Source": a modified copy can't use it.
        "out": "aih-serif",
        "rename": [("Source Serif 4", "AIH Serif"), ("SourceSerif4", "AIHSerif")],
        "weight": (400, 600),
        "fallback": "Times New Roman",
        "faces": {
            "normal": "source-serif-4-latin-normal.woff2",
            "italic": "source-serif-4-latin-italic.woff2",
        },
    },
]

OFL_NOTICE = (
    "This Font Software is licensed under the SIL Open Font License, Version 1.1. "
    "This is a modified (subset) version."
)
OFL_URL = "https://openfontlicense.org"
CHECK_WEIGHTS = (400, 450, 500, 550, 600, 650, 700)


def ranges(cps: set[int]) -> str:
    out, cps_ = [], sorted(cps)
    i = 0
    while i < len(cps_):
        j = i
        while j + 1 < len(cps_) and cps_[j + 1] == cps_[j] + 1:
            j += 1
        out.append(f"U+{cps_[i]:04X}" + (f"-{cps_[j]:04X}" if j > i else ""))
        i = j + 1
    return ",".join(out)


def font_bytes(font: TTFont, flavor: str | None = None) -> bytes:
    buf = io.BytesIO()
    # Keep the source's `head.modified`, so a rerun writes identical bytes.
    font.recalcTimestamp = False
    font.flavor = flavor
    font.save(buf)
    return buf.getvalue()


def limit_axes(data: bytes, weight: tuple[int, int]) -> TTFont:
    """Drop the part of the weight axis below the CSS range, losslessly.

    Only the side of the axis below the default goes. Moving the top master
    down to the CSS maximum would save nothing (a master is a master) and
    would round its deltas to whole units. And the instancer rounds gvar
    deltas it infers even when it only drops tuples, so gvar is rebuilt here
    from the original tuples instead: one that peaks below the default
    contributes exactly zero at every weight the CSS can reach.
    """
    src = TTFont(io.BytesIO(data))
    axes = {a.axisTag: a for a in src["fvar"].axes}
    assert set(axes) == {"wght"}, f"unexpected axes {sorted(axes)}"
    a = axes["wght"]
    assert a.defaultValue == weight[0] and a.maxValue >= weight[1], (
        f"wght {a.minValue}-{a.maxValue} default {a.defaultValue} doesn't fit CSS {weight}"
    )
    font = instancer.instantiateVariableFont(
        src, {"wght": (a.defaultValue, a.maxValue)}, inplace=False, optimize=False
    )
    original = TTFont(io.BytesIO(data))["gvar"].variations
    gvar = font["gvar"]
    for glyph, tuples in original.items():
        kept = []
        for tv in tuples:
            start, peak, end = tv.axes["wght"]
            assert (peak > 0) == (start >= 0), f"{glyph}: tuple spans the default"
            if peak > 0:
                kept.append(tv)
        gvar.variations[glyph] = kept
    return font


def cut(instanced: bytes, unicodes: set[int], rename, features=FEATURES, flavor="woff2") -> bytes:
    font = TTFont(io.BytesIO(instanced))
    opts = subset.Options()
    opts.layout_features = features
    opts.hinting = False
    opts.notdef_outline = True  # the tofu box looks the same as today
    opts.name_IDs = ["*"]
    opts.name_languages = ["*"]
    opts.glyph_names = False
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=unicodes)
    sub.subset(font)
    name = font["name"]
    for rec in list(name.names):
        if rename and rec.nameID not in (0, 7, 13, 14):
            text = rec.toUnicode()
            for old, new in rename:
                text = text.replace(old, new)
            rec.string = text
    if not name.getDebugName(13):
        name.setName(OFL_NOTICE, 13, 3, 1, 0x409)
    if not name.getDebugName(14):
        name.setName(OFL_URL, 14, 3, 1, 0x409)
    return font_bytes(font, flavor)


def same_glyph(cmap: dict[int, str], cps: set[int]) -> set[int]:
    """Add every codepoint that maps to a glyph already in the set.

    The autohinter files a glyph under a script by its codepoints: Source
    Serif's ’ shares a glyph with ʼ (Latin), and without ʼ it is hinted as
    punctuation.
    """
    glyphs = {cmap[c] for c in cps}
    return cps | {c for c, g in cmap.items() if g in glyphs}


def raster_diffs(original: bytes, cut_: bytes, cps: set[int]) -> str:
    """Characters whose FreeType bitmap differs, unhinted or light-hinted."""
    faces = []
    for data in (original, cut_):
        f = TTFont(io.BytesIO(data))
        faces.append(freetype.Face(io.BytesIO(font_bytes(f))))
    lo, hi = _wght_range(cut_)
    out = set()
    for size in (13, 16, 21):
        for weight in sorted({lo, min(hi, 700)}):
            for flags in (freetype.FT_LOAD_NO_HINTING, freetype.FT_LOAD_TARGET_LIGHT):
                for face in faces:
                    face.set_char_size(size * 64)
                    face.set_var_design_coords((weight,))
                for c in cps:
                    if c <= 0x20 or chr(c) in out:
                        continue
                    seen = []
                    for face in faces:
                        face.load_char(chr(c), freetype.FT_LOAD_RENDER | flags)
                        g = face.glyph
                        seen.append((g.bitmap_left, g.bitmap_top, g.bitmap.width,
                                     g.bitmap.rows, bytes(g.bitmap.buffer), g.advance.x))
                    if seen[0] != seen[1]:
                        out.add(chr(c))
    return "".join(sorted(out))


class Shaper:
    def __init__(self, data: bytes):
        font = TTFont(io.BytesIO(data))
        self.cmap = font.getBestCmap()
        # HarfBuzz reads sfnt, not woff2: handed woff2 it shapes an empty face
        # and every comparison passes.
        self.font = hb.Font(hb.Face(font_bytes(font)))
        assert self.font.face.upem == font["head"].unitsPerEm
        assert self.font.face.glyph_count == font["maxp"].numGlyphs

    def shape(self, text: str, weight: int):
        self.font.set_variations({"wght": weight})
        buf = hb.Buffer()
        buf.add_str(text)
        buf.guess_segment_properties()
        hb.shape(self.font, buf, {})
        out = []
        for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
            pen = RecordingPen()
            self.font.draw_glyph_with_pen(info.codepoint, pen)
            out.append((info.cluster, pos.x_advance, pos.x_offset, pos.y_offset, pen.value))
        return out


def check(original: bytes, cut_: bytes, cps: set[int], label: str) -> dict:
    """Shape every character the file serves, and every ordered pair, in both."""
    a, b = Shaper(original), Shaper(cut_)
    chars = sorted(cps)
    missing = [c for c in chars if c not in a.cmap]
    assert not missing, f"{label}: characters the original lacks: {ranges(set(missing))}"
    lo, hi = _wght_range(cut_)
    weights = [w for w in CHECK_WEIGHTS if lo <= w <= hi] or [lo]
    texts = [chr(c) for c in chars] + [chr(x) + chr(y) for x in chars for y in chars]
    # Ligatures and contextual alternates need longer runs.
    texts += ["fi fl ff ffi ffl", "->", "=>", "!=", "===", "<=", ">=", "...", "//", "/*", "www"]
    texts = [t for t in texts if all(ord(c) in cps for c in t)]
    diffs = 0
    for w in weights:
        for t in texts:
            if a.shape(t, w) != b.shape(t, w):
                diffs += 1
                if diffs <= 5:
                    print(f"  DIFF {label} wght={w} {t!r}", file=sys.stderr)
    return {"texts": len(texts), "weights": weights, "diffs": diffs}


def _wght_range(data: bytes):
    axis = next(a for a in TTFont(io.BytesIO(data))["fvar"].axes if a.axisTag == "wght")
    return int(axis.minValue), int(axis.maxValue)


def boundary_kerning(original: bytes, core: set[int], ext: set[int]) -> int:
    """Pairs that kern in the original but straddle the core/ext split.

    A browser shapes each file separately, so such a pair loses its kerning
    wherever it appears. Zero means the split changes nothing.
    """
    s = Shaper(original)
    n = 0
    for x in core & set(s.cmap):
        for y in ext & set(s.cmap):
            for t in (chr(x) + chr(y), chr(y) + chr(x)):
                pair = s.shape(t, 400)
                alone = s.shape(t[0], 400)
                if len(pair) == 2 and pair[0][1] != alone[0][1]:
                    n += 1
    return n


def describe(data: bytes) -> dict:
    f = TTFont(io.BytesIO(data))
    feats = lambda tag: sorted(  # noqa: E731
        {r.FeatureTag for r in f[tag].table.FeatureList.FeatureRecord}
    ) if tag in f else []
    return {
        "bytes": len(data),
        "glyphs": f["maxp"].numGlyphs,
        "codepoints": len(f.getBestCmap()),
        "axes": {a.axisTag: [a.minValue, a.defaultValue, a.maxValue] for a in f["fvar"].axes},
        "features": feats("GSUB") + feats("GPOS"),
        "hinting": sorted(t for t in ("fpgm", "prep", "cvt ", "hdmx", "VDMX", "LTSH") if t in f),
        "family": f["name"].getDebugName(1),
    }


def metrics(data: bytes) -> tuple:
    f = TTFont(io.BytesIO(data))
    h, o = f["hhea"], f["OS/2"]
    return (f["head"].unitsPerEm, h.ascent, h.descent, h.lineGap, o.sTypoAscender,
            o.sTypoDescender, o.sTypoLineGap, o.usWinAscent, o.usWinDescent, o.fsSelection)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--usage", default=str(HERE / "usage.json"))
    p.add_argument(
        "--strict-cut",
        action="store_true",
        help="drop glyphs outside Latin-1 and Latin Extended-A that the crawl "
        "never saw (U+02C6, ‹ ›, €, ™, ↑ ↓, − and the like) instead of keeping "
        "them in the extended file",
    )
    p.add_argument(
        "--core-latin1-letters",
        action="store_true",
        help="put À-ÿ in the core file, so accented letters keep their kerning "
        "against ASCII neighbours, at the cost of a bigger preload",
    )
    p.add_argument("--dry-run", action="store_true", help="check and report, write nothing")
    args = p.parse_args()

    usage = json.loads(Path(args.usage).read_text())
    used: dict[str, set[int]] = {}
    for key, face in usage["faces"].items():
        used.setdefault(key.split("|")[0], set()).update(face["codepoints"])

    manifest = {"usageMeasuredAt": usage["measuredAt"], "families": {}}
    outputs: dict[Path, bytes] = {}
    failed = False
    for fam in FAMILIES:
        entry = {"var": fam["var"], "weight": fam["weight"], "faces": {}}
        core_ranges, ext_ranges = set(), set()
        for style, src_name in fam["faces"].items():
            original = (SOURCE / src_name).read_bytes()
            have = set(TTFont(io.BytesIO(original)).getBestCmap())
            cmap = TTFont(io.BytesIO(original)).getBestCmap()
            core = same_glyph(cmap, have & (
                ASCII | SPACES | CORE_PUNCTUATION
                | (LATIN_1_LETTERS if args.core_latin1_letters else set())
            ))
            keep = have if not args.strict_cut else have & (
                LATIN_1 | LATIN_EXT_A | used.get(fam["usage"], set()) | core
            )
            ext = same_glyph(cmap, keep - core) - core
            missing_used = sorted(c for c in used.get(fam["usage"], set()) - have if c > 0x7E)
            instanced = font_bytes(limit_axes(original, fam["weight"]))
            files = {}
            for part, cps in (("core", core), ("ext", ext)):
                extra = AUTOHINT_REFERENCE & have if part == "ext" else set()
                # No extended character takes part in a ligature or contextual
                # alternate (the shaping check below would catch one), and
                # keeping them would pull in ligature glyphs for the hinting
                # reference letters.
                features = FEATURES if part == "core" else [
                    f for f in FEATURES if f not in ("liga", "calt")
                ]
                data = cut(instanced, cps | extra, fam.get("rename"), features)
                got = set(TTFont(io.BytesIO(data)).getBestCmap())
                assert got == cps | extra, f"{src_name} {part}: cmap differs from request"
                label = f"{fam['out']}-{part}-{style}"
                result = check(original, data, cps, label)
                result["rasterDiffs"] = raster_diffs(original, data, cps)
                # Core files must match everywhere. An extended file may differ
                # only under hinting, for characters listed in the manifest.
                if (result["diffs"] or metrics(data) != metrics(original)
                        or (part == "core" and result["rasterDiffs"])):
                    failed = True
                    print(f"FAIL {label}: {result['diffs']} shaping diffs, raster diffs "
                          f"{result['rasterDiffs'] or '-'}, metrics equal="
                          f"{metrics(data) == metrics(original)}", file=sys.stderr)
                name = f"{label}.woff2"
                outputs[OUT / name] = data
                files[part] = {"file": name, "unicodeRange": ranges(cps), **describe(data),
                               "check": result}
            core_ranges.add(files["core"]["unicodeRange"])
            ext_ranges.add(files["ext"]["unicodeRange"])
            entry["faces"][style] = {
                "source": {"file": src_name, **describe(original)},
                **files,
                "boundaryKerningPairs": boundary_kerning(original, core, ext),
                "usedButNotInFont": ranges(set(missing_used)),
            }
        # One `next/font` call shares its `unicode-range` across styles.
        assert len(core_ranges) == 1 and len(ext_ranges) == 1, f"{fam['var']}: styles differ"
        entry["coreUnicodeRange"], entry["extUnicodeRange"] = core_ranges.pop(), ext_ranges.pop()
        manifest["families"][fam["var"]] = entry

    print_report(manifest)
    if failed:
        print("checks failed, nothing written", file=sys.stderr)
        return 1
    if args.dry_run:
        return 0
    for path, data in outputs.items():
        path.write_bytes(data)
    (OUT / "fonts.ts").write_text(fonts_ts(manifest))
    (HERE / "manifest.json").write_text(json.dumps(manifest, indent="\t") + "\n")
    print(f"wrote {len(outputs)} fonts, {OUT / 'fonts.ts'} and {HERE / 'manifest.json'}")
    return 0


def print_report(manifest: dict) -> None:
    print(f"{'file':40} {'bytes':>7} {'glyphs':>6} {'cps':>4}  axes / features")
    for fam in manifest["families"].values():
        for style, face in fam["faces"].items():
            for part in ("source", "core", "ext"):
                d = face[part]
                print(f"{d['file']:40} {d['bytes']:7} {d['glyphs']:6} {d['codepoints']:4}  "
                      f"{d['axes']} {','.join(d['features'])}")
            print(f"{'':40} boundary kerning pairs: {face['boundaryKerningPairs']}; "
                  f"used but not in font: {face['usedButNotInFont'] or '-'}; "
                  f"hinted raster diffs: {face['ext']['check']['rasterDiffs'] or '-'}")


TS_HEADER = """\
// Generated by scripts/fonts/subset.py. Don't edit by hand: change the script
// and rerun it (see scripts/fonts/README.md).
//
// Each font is split in two. The core file (ASCII and common punctuation) is
// preloaded on every page. The extended file joins the same family behind
// `unicode-range`, so it downloads only on a page that draws one of its
// characters. It declares the core family by name and has no fallback face of
// its own: a second generated fallback face would sit between the core and the
// extended file and draw those characters first. Turbopack names a
// `next/font/local` family after its binding, so the core bindings keep the
// names the rest of the app was built against.
import localFont from 'next/font/local'
"""

DOCS = {
    "geist": """\
/**
 * DM Sans + JetBrains Mono, per the redesign's token spec (`aihero.css`).
 * The CSS variables keep their `--font-geist*` names so the hundreds of
 * existing `font-sans` / `font-mono` call sites and the `@theme` mapping keep
 * working — the families behind them are what changed, not the plumbing.
 * Self-hosted (OFL) so builds never fetch from Google. Cut from the latin
 * woff2 files Google serves, kept in scripts/fonts/source.
 */
""",
    "sourceSerif": """\
/**
 * Source Serif 4 — testimonials only. A quote set in the same DM Sans as the
 * page around it has to lean on italics and quote marks to read as someone
 * else talking; a serif does that on its own. Its stems survive the dark
 * background better than a display serif would. Renamed "AIH Serif" inside
 * the files: the OFL reserves the name "Source" for unmodified copies.
 */
""",
}


def fonts_ts(manifest: dict) -> str:
    parts = [TS_HEADER]
    for fam_cfg in FAMILIES:
        fam = manifest["families"][fam_cfg["var"]]
        weight = f"{fam['weight'][0]} {fam['weight'][1]}"
        src = lambda part: "".join(  # noqa: E731
            f"\t\t{{\n\t\t\tpath: './{face[part]['file']}',\n\t\t\tweight: '{weight}',\n"
            f"\t\t\tstyle: '{style}',\n\t\t}},\n"
            for style, face in fam["faces"].items()
        )
        var = fam_cfg["var"]
        parts.append(
            "\n" + DOCS.get(var, "")
            + f"export const {var} = localFont({{\n\tsrc: [\n{src('core')}\t],\n"
            f"\tvariable: '{fam_cfg['cssVar']}',\n\tdisplay: 'swap',\n"
            f"\tadjustFontFallback: '{fam_cfg['fallback']}',\n"
            f"\tdeclarations: [\n\t\t{{\n\t\t\tprop: 'unicode-range',\n"
            f"\t\t\tvalue: '{fam['coreUnicodeRange']}',\n\t\t}},\n\t],\n}})\n"
            f"\nexport const {var}Extended = localFont({{\n\tsrc: [\n{src('ext')}\t],\n"
            f"\tdisplay: 'swap',\n\tpreload: false,\n\tadjustFontFallback: false,\n"
            f"\tdeclarations: [\n\t\t{{ prop: 'font-family', value: '{var}' }},\n"
            f"\t\t{{\n\t\t\tprop: 'unicode-range',\n"
            f"\t\t\tvalue: '{fam['extUnicodeRange']}',\n\t\t}},\n\t],\n}})\n"
        )
    return "".join(parts)


if __name__ == "__main__":
    sys.exit(main())
