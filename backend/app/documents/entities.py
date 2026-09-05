"""Equipment and document tag extraction.

Industrial documentation is held together by identifiers: ``P-103``,
``PSV-2201``, ``SOP-204``. They are the thing an engineer actually searches
for, and they are precisely what semantic similarity is worst at -- the
embedding of "V-103" sits next to "V-104" and "V-113", which is the wrong
answer in the one case where being wrong is most obvious.

So they are pulled out explicitly at ingestion: they feed the exact-identifier
half of hybrid retrieval, and they are the node set for the P&ID equipment
graph in section 7 of the spec.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass

# A prefix of 1-4 letters, a separator, then a number with an optional suffix
# letter (``T-101A`` is a real and common form for a twinned vessel).
TAG_PATTERN = re.compile(r"\b([A-Z]{1,4})[-/](\d{1,5}[A-Z]?)\b")

# Prefix to equipment class, from the ISA-5.1 conventions these plants use.
EQUIPMENT_TYPES: dict[str, str] = {
    "P": "pump",
    "V": "valve",
    "XV": "valve",
    "PSV": "relief_valve",
    "PRV": "relief_valve",
    "T": "tank",
    "TK": "tank",
    "D": "drum",
    "C": "column",
    "K": "compressor",
    "E": "heat_exchanger",
    "H": "heater",
    "F": "furnace",
    "R": "reactor",
    "M": "motor",
    "FIC": "flow_controller",
    "PIC": "pressure_controller",
    "TIC": "temperature_controller",
    "LIC": "level_controller",
    "FT": "flow_transmitter",
    "PT": "pressure_transmitter",
    "TT": "temperature_transmitter",
    "LT": "level_transmitter",
}

# Prefixes that name a document or a standard rather than a piece of plant.
DOCUMENT_PREFIXES = {
    "SOP", "API", "ISO", "IS", "ASME", "ASTM", "OISD", "MSDS", "PID",
    "DOC", "SPEC", "STD", "WI", "QAP", "ITP", "NDT", "HAZOP",
}

# Patterns that match the tag shape but are never equipment. Without these a
# document dated "2024-01" or referring to "COVID-19" grows phantom nodes in
# the equipment graph.
STOPLIST = {"COVID", "IEEE", "RFC", "UTF", "ISBN", "GMT", "UTC", "AM", "PM"}


@dataclass(frozen=True)
class Tag:
    tag: str
    entity_type: str
    page: int


def infer_type(prefix: str) -> str:
    if prefix in DOCUMENT_PREFIXES:
        return "document_ref"
    return EQUIPMENT_TYPES.get(prefix, "unknown")


def extract_tags(pages: list[tuple[int, str]]) -> list[tuple[Tag, int]]:
    """Find identifiers per page, with how often each occurs there.

    Occurrence count is kept because it is the cheapest available signal for
    which equipment a drawing is actually *about*, as opposed to which it
    merely mentions in a cross-reference.
    """
    counts: Counter[Tag] = Counter()

    for page_number, text in pages:
        if not text:
            continue
        for match in TAG_PATTERN.finditer(text.upper()):
            prefix, number = match.group(1), match.group(2)
            if prefix in STOPLIST:
                continue
            # A bare year-like number behind a one-letter prefix is almost
            # always a date fragment, not a tag.
            if len(prefix) == 1 and len(number) == 4 and number.isdigit():
                continue
            counts[
                Tag(
                    tag=f"{prefix}-{number}",
                    entity_type=infer_type(prefix),
                    page=page_number,
                )
            ] += 1

    return sorted(counts.items(), key=lambda item: (item[0].page, item[0].tag))


def co_occurring(
    tags: list[tuple[Tag, int]], *, max_pairs: int = 400
) -> list[tuple[str, str, int]]:
    """Pairs of equipment tags that appear on the same page.

    This is the honest MVP stand-in for reading connection lines off a P&ID:
    it says two items are *related*, not that they are physically connected,
    and the graph edge it produces is labelled accordingly. Real connection
    inference needs symbol and line detection, which section 7 places after
    the core pipeline.
    """
    by_page: dict[int, list[str]] = {}
    for tag, _ in tags:
        if tag.entity_type in {"unknown", "document_ref"}:
            continue
        by_page.setdefault(tag.page, []).append(tag.tag)

    pairs: Counter[tuple[str, str]] = Counter()
    for page_tags in by_page.values():
        unique = sorted(set(page_tags))
        # A page listing dozens of tags is an index or a legend; every pair on
        # it would be noise, so those pages are skipped rather than exploded
        # into hundreds of meaningless edges.
        if len(unique) > 25:
            continue
        for i, left in enumerate(unique):
            for right in unique[i + 1 :]:
                pairs[(left, right)] += 1

    ranked = pairs.most_common(max_pairs)
    return [(left, right, weight) for (left, right), weight in ranked]
