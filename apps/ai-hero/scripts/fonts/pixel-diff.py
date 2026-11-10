#!/usr/bin/env python3
"""Diff the screenshots pixel-diff.mjs took, and print a Markdown table.

For each page, viewport and colour scheme it compares before with after (the
font change) and before with before2 (live content changing between loads,
the noise floor). A difference that shows up in after but not in before2 is
the fonts' doing. It writes `<shot>-diff.png` next to each pair that differs:
changed pixels in red over a faded copy of the before shot.

    scripts/fonts/.venv/bin/python scripts/fonts/pixel-diff.py /path/to/pixel-diff
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageChops


def regions(mask: Image.Image, gap: int = 24) -> list[tuple[int, int]]:
    """Vertical bands of changed rows, merged when closer than `gap` px."""
    w, h = mask.size
    rows = [y for y in range(h) if mask.crop((0, y, w, y + 1)).getbbox()]
    bands: list[list[int]] = []
    for y in rows:
        if bands and y - bands[-1][1] <= gap:
            bands[-1][1] = y
        else:
            bands.append([y, y])
    return [(a, b) for a, b in bands]


def compare(a_path: Path, b_path: Path, out: Path | None) -> dict:
    a, b = Image.open(a_path).convert("RGB"), Image.open(b_path).convert("RGB")
    if a.size != b.size:
        return {"size": f"{a.size[0]}x{a.size[1]} vs {b.size[0]}x{b.size[1]}", "pixels": None}
    diff = ImageChops.difference(a, b)
    bbox = diff.getbbox()
    if not bbox:
        return {"size": f"{a.size[0]}x{a.size[1]}", "pixels": 0, "max": 0, "bands": []}
    gray = diff.convert("L")
    mask = gray.point(lambda v: 255 if v else 0)
    pixels = mask.histogram()[255]
    if out:
        faded = Image.blend(a, Image.new("RGB", a.size, "white"), 0.7)
        faded.paste(Image.new("RGB", a.size, (255, 0, 0)), mask=mask)
        faded.save(out)
    return {
        "size": f"{a.size[0]}x{a.size[1]}",
        "pixels": pixels,
        "max": gray.getextrema()[1],
        "bands": regions(mask),
    }


def fmt(r: dict) -> str:
    if r["pixels"] is None:
        return f"size differs ({r['size']})"
    if r["pixels"] == 0:
        return "identical"
    bands = ", ".join(f"y{a}-{b}" for a, b in r["bands"][:4])
    more = f" +{len(r['bands']) - 4}" if len(r["bands"]) > 4 else ""
    return f"{r['pixels']} px (max Δ{r['max']}) at {bands}{more}"


def labelled(r: dict, lines: list[dict]) -> list[str]:
    """The glyph sheet's lines that a diff's bands touch."""
    hit = []
    for a, b in r.get("bands") or []:
        for line in lines:
            if line["top"] <= b and a <= line["bottom"] and line["label"] not in hit:
                hit.append(line["label"])
    return hit


def main() -> int:
    root = Path(sys.argv[1])
    print("| page | shot | before → after | before → before2 (noise) |")
    print("|---|---|---|---|")
    for d in sorted(p for p in root.iterdir() if p.is_dir()):
        for before in sorted(d.glob("*-before.png")):
            key = before.name.removesuffix("-before.png")
            after = d / f"{key}-after.png"
            again = d / f"{key}-before2.png"
            if not after.exists():
                # A run that stopped part way.
                print(f"| {d.name} | {key} | no after shot | - |")
                continue
            r1 = compare(before, after, d / f"{key}-diff.png")
            r2 = compare(before, again, d / f"{key}-noise.png") if again.exists() else None
            print(f"| {d.name} | {key} | {fmt(r1)} | {fmt(r2) if r2 else '-'} |")
            if (d / "lines.json").exists() and r1["pixels"]:
                lines = json.loads((d / "lines.json").read_text())
                print(f"\n{d.name}: changed lines ({len(labelled(r1, lines))} of {len(lines)}):")
                for label in labelled(r1, lines):
                    print(f"- {label}")
                print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
