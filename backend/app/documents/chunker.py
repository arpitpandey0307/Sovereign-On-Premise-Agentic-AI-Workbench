"""Page-aware chunking.

Two rules drive the design, and both come from what the evidence panel has to
be able to do:

1. A chunk never spans a page boundary. If it did, a citation could not name
   a single page, and "jump to the source" would be a lie.
2. A chunk carries the section heading it fell under, so a citation can read
   ``[Maintenance SOP, p.7, section 4.2]`` rather than just a page number.

Splitting is done on paragraph then sentence boundaries, with a small overlap
so that a fact stated across a paragraph break is still retrievable whole.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Sized for the 4k-8k context windows Part 02's catalogue targets: a handful
# of chunks has to fit alongside the question and the answer.
TARGET_CHARS = 1200
MIN_CHARS = 200
OVERLAP_CHARS = 150

# Headings as they actually appear in refinery documentation: numbered
# clauses ("4.2 Isolation"), section markers, and short all-caps titles.
_HEADING_PATTERNS = (
    re.compile(r"^\s*(?:§\s*)?(\d+(?:\.\d+)*)\s+([A-Z][^\n]{2,80})$"),
    re.compile(
        r"^\s*(SECTION|CLAUSE|APPENDIX|ANNEXURE)\s+([A-Z0-9.\-]+)[:\s]*(.*)$", re.I
    ),
    re.compile(r"^\s*([A-Z][A-Z0-9 &/\-]{4,60})\s*$"),
)

_SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9])")


@dataclass
class Chunk:
    text: str
    page: int
    section: str | None
    ordinal: int


def detect_heading(line: str) -> str | None:
    """Return a normalised section label if this line reads as a heading."""
    stripped = line.strip()
    if not stripped or len(stripped) > 100:
        return None

    numbered = _HEADING_PATTERNS[0].match(stripped)
    if numbered:
        return f"{numbered.group(1)} {numbered.group(2).strip()}"

    labelled = _HEADING_PATTERNS[1].match(stripped)
    if labelled:
        tail = labelled.group(3).strip()
        label = f"{labelled.group(1).title()} {labelled.group(2)}"
        return f"{label} {tail}".strip()

    # An all-caps line is only a heading if it is not a sentence: a run-on of
    # capitals with terminal punctuation is shouting, not a title.
    caps = _HEADING_PATTERNS[2].match(stripped)
    if caps and not stripped.endswith((".", ":", ";")):
        return caps.group(1).strip().title()
    return None


def chunk_pages(pages: list[tuple[int, str]]) -> list[Chunk]:
    """Chunk a whole document, carrying section context across pages.

    ``pages`` is ``(page_number, text)`` in order. The current heading is kept
    between pages deliberately: a section that starts on page 6 still governs
    the text at the top of page 7.
    """
    chunks: list[Chunk] = []
    section: str | None = None

    for page_number, text in pages:
        if not text or not text.strip():
            continue
        for body, heading in _split_page(text, section):
            section = heading
            chunks.append(
                Chunk(
                    text=body,
                    page=page_number,
                    section=section,
                    ordinal=len(chunks),
                )
            )

    return chunks


def _split_page(text: str, inherited: str | None) -> list[tuple[str, str | None]]:
    """Split one page into chunk bodies, each tagged with its section."""
    section = inherited
    blocks: list[tuple[str, str | None]] = []
    buffer: list[str] = []

    def flush() -> None:
        body = "\n".join(buffer).strip()
        buffer.clear()
        if body:
            blocks.append((body, section))

    for raw_paragraph in re.split(r"\n\s*\n", text):
        paragraph = raw_paragraph.strip()
        if not paragraph:
            continue

        lines = paragraph.splitlines()
        heading = detect_heading(lines[0]) if lines else None
        if heading is not None:
            # A new heading closes the previous chunk: mixing text from two
            # sections into one chunk produces a citation that points at the
            # wrong clause.
            flush()
            section = heading
            remainder = "\n".join(lines[1:]).strip()
            if not remainder:
                continue
            paragraph = remainder

        pending = "\n".join([*buffer, paragraph])
        if len(pending) <= TARGET_CHARS:
            buffer.append(paragraph)
            continue

        flush()
        if len(paragraph) <= TARGET_CHARS:
            buffer.append(paragraph)
        else:
            for piece in _split_long(paragraph):
                blocks.append((piece, section))

    flush()
    return _merge_runts(blocks)


def _split_long(paragraph: str) -> list[str]:
    """Break an oversized paragraph on sentence boundaries, with overlap."""
    sentences = _SENTENCE_END.split(paragraph)
    pieces: list[str] = []
    current: list[str] = []
    length = 0

    for sentence in sentences:
        if length + len(sentence) > TARGET_CHARS and current:
            pieces.append(" ".join(current).strip())
            # Carry the tail of the previous piece forward so a statement
            # split across the boundary is still retrievable as a unit.
            tail = " ".join(current)[-OVERLAP_CHARS:]
            current = [tail] if tail else []
            length = len(tail)
        current.append(sentence)
        length += len(sentence) + 1

    if current:
        pieces.append(" ".join(current).strip())

    # A single sentence longer than the target has no boundary to split on;
    # fall back to a hard cut rather than emitting one enormous chunk.
    expanded: list[str] = []
    for piece in pieces:
        if len(piece) <= TARGET_CHARS * 2:
            expanded.append(piece)
            continue
        step = TARGET_CHARS - OVERLAP_CHARS
        expanded.extend(
            piece[start : start + TARGET_CHARS]
            for start in range(0, len(piece), step)
        )
    return [piece for piece in expanded if piece.strip()]


def _merge_runts(blocks: list[tuple[str, str | None]]) -> list[tuple[str, str | None]]:
    """Fold undersized chunks into their neighbour within the same section.

    A 30-character chunk is noise in a vector index: it matches everything
    weakly and cites nothing usefully.
    """
    merged: list[tuple[str, str | None]] = []
    for body, section in blocks:
        if (
            merged
            and len(body) < MIN_CHARS
            and merged[-1][1] == section
            and len(merged[-1][0]) + len(body) <= TARGET_CHARS * 1.5
        ):
            merged[-1] = (f"{merged[-1][0]}\n{body}", section)
            continue
        merged.append((body, section))
    return merged
