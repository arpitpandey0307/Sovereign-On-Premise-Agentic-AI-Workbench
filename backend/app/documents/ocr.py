"""OCR for pages that arrive as pixels rather than text.

Tesseract is an external binary, not a Python package, so it can be absent on
a machine that has every dependency installed. That is treated as a degraded
mode rather than a crash: a scanned page without OCR is recorded honestly as
having no extractable text, the document still ingests, and the reason is
visible on the page record instead of buried in a traceback.

Confidence is kept per page because it is the one number that tells a reader
whether to trust a quotation from a scan. It is surfaced in the citation UI.
"""

from __future__ import annotations

import io
import logging
from dataclasses import dataclass
from functools import lru_cache

from app.core.config import settings

logger = logging.getLogger("workbench.ocr")

# Page segmentation 3 is "fully automatic, no orientation detection", which is
# the right default for inspection reports and scanned SOPs. OEM 3 lets
# Tesseract pick between its legacy and LSTM engines.
TESSERACT_CONFIG = "--oem 3 --psm 3"

# Words below this confidence are still kept -- dropping them would silently
# edit the document -- but they do not count towards the page's score.
WORD_CONFIDENCE_FLOOR = 40.0


@dataclass
class OcrResult:
    text: str
    confidence: float
    status: str  # "ocr" | "empty" | "unavailable" | "failed"
    detail: str = ""


@lru_cache(maxsize=1)
def availability() -> tuple[bool, str]:
    """Whether the Tesseract binary can actually be run, and its version.

    Cached: this shells out to a subprocess, and ingestion asks once per page.
    """
    try:
        import pytesseract
    except ImportError as exc:  # pragma: no cover - dependency is pinned
        return False, f"pytesseract is not installed ({exc})"

    if settings.tesseract_cmd:
        pytesseract.pytesseract.tesseract_cmd = settings.tesseract_cmd

    try:
        version = pytesseract.get_tesseract_version()
    except Exception as exc:
        return False, (
            f"Tesseract binary not runnable ({type(exc).__name__}). "
            "Install it and set TESSERACT_CMD if it is not on PATH."
        )
    return True, f"tesseract {version}"


def recognise(image: bytes, *, language: str = "eng") -> OcrResult:
    """Read text out of a rendered page."""
    ready, detail = availability()
    if not ready:
        return OcrResult(text="", confidence=0.0, status="unavailable", detail=detail)

    try:
        import pytesseract
        from PIL import Image

        with Image.open(io.BytesIO(image)) as handle:
            # Tesseract is materially more accurate on greyscale than on a
            # colour scan, and this costs one pass over the pixels.
            prepared = handle.convert("L")
            data = pytesseract.image_to_data(
                prepared,
                lang=language,
                config=TESSERACT_CONFIG,
                output_type=pytesseract.Output.DICT,
            )
    except Exception as exc:
        logger.warning("OCR failed: %s", exc)
        return OcrResult(
            text="", confidence=0.0, status="failed", detail=type(exc).__name__
        )

    text = _reflow(data)
    confidence = _confidence(data)

    if not text.strip():
        return OcrResult(
            text="", confidence=0.0, status="empty", detail="no glyphs recognised"
        )
    return OcrResult(text=text, confidence=confidence, status="ocr", detail=detail)


def _reflow(data: dict) -> str:
    """Rebuild lines from Tesseract's per-word output.

    ``image_to_string`` would give a string directly, but it discards the line
    and block ids. Industrial documents are full of tabulated readings where
    losing the line break turns two columns into one unreadable run, so the
    layout is reconstructed from the structural ids instead.
    """
    words = data.get("text", [])
    if not words:
        return ""

    lines: dict[tuple[int, int, int], list[str]] = {}
    for index, word in enumerate(words):
        cleaned = (word or "").strip()
        if not cleaned:
            continue
        key = (
            data["block_num"][index],
            data["par_num"][index],
            data["line_num"][index],
        )
        lines.setdefault(key, []).append(cleaned)

    return "\n".join(" ".join(words) for _, words in sorted(lines.items())).strip()


def _confidence(data: dict) -> float:
    """Mean confidence over the words Tesseract was reasonably sure of.

    Averaging every word would let a page of noise drag a good scan down;
    averaging only confident words reports how good the readable part is,
    which is what a reader deciding whether to trust a quote needs.
    """
    scores = [
        float(value)
        for value, word in zip(data.get("conf", []), data.get("text", []), strict=False)
        if (word or "").strip() and float(value) >= WORD_CONFIDENCE_FLOOR
    ]
    if not scores:
        return 0.0
    return round(sum(scores) / len(scores), 2)
