"""What an uploaded file is, as opposed to what it says it is (Part 05).

The upload endpoint used to decide a file's type from ``content_type`` on the
multipart part. That header is written by whatever sent the request, so it is a
claim, not a measurement: ``curl`` will happily label a Windows executable
``application/pdf`` and the check passes.

Nothing here trusts the sender. The type is read from the bytes, the name is
rebuilt rather than accepted, and anything that disagrees with itself is
refused and recorded. None of this makes a parser safe -- that is what the
sandbox is for -- but it removes the cheapest way in.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

# The first bytes of each format we accept. Written out rather than pulled from
# libmagic because the accepted set is small and fixed, and a dependency that
# has to be installed as a system package is one more thing to get right on an
# air-gapped machine.
#
# Office formats and any other zip container share the PK signature, so they
# are distinguished further down by what the archive holds.
_SIGNATURES: list[tuple[bytes, str]] = [
    (b"%PDF-", "application/pdf"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"II*\x00", "image/tiff"),
    (b"MM\x00*", "image/tiff"),
    (b"PK\x03\x04", "application/zip"),
    (b"PK\x05\x06", "application/zip"),
    (b"PK\x07\x08", "application/zip"),
]

# Signatures of things that must never be stored, whatever they claim to be.
# This list is short on purpose: it names the formats that execute, and its job
# is to make the refusal explicit and auditable rather than to be exhaustive.
_EXECUTABLE_SIGNATURES: list[tuple[bytes, str]] = [
    (b"MZ", "a Windows executable"),
    (b"\x7fELF", "a Linux executable"),
    (b"\xca\xfe\xba\xbe", "a Mach-O or Java class file"),
    (b"#!", "a shell script"),
]

_ZIP_MEMBERS = {
    "word/": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xl/": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "ppt/": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

# Types whose content is text and therefore has no signature to read. They are
# accepted on the declared type, but only after the bytes are shown to decode
# and to carry no executable header.
_TEXTUAL = {"text/plain", "text/csv", "application/json"}

# Enough to cover every signature above and the first zip entry name.
SNIFF_BYTES = 512

_UNSAFE_NAME = re.compile(r"[^A-Za-z0-9._ -]")
MAX_FILENAME = 120


@dataclass(frozen=True)
class Verdict:
    ok: bool
    mime_type: str = ""
    reason: str = ""


def sniff(head: bytes) -> str:
    """The type the bytes themselves indicate, or an empty string."""
    for signature, mime in _SIGNATURES:
        if head.startswith(signature):
            if mime != "application/zip":
                return mime
            # Which Office format, if any. The member names appear in the
            # archive's first entry, which is within the sniffed window.
            window = head.decode("latin-1", errors="ignore")
            for member, office_mime in _ZIP_MEMBERS.items():
                if member in window:
                    return office_mime
            return "application/zip"
    return ""


def executable_kind(head: bytes) -> str:
    """What kind of executable this is, if it is one."""
    for signature, description in _EXECUTABLE_SIGNATURES:
        if head.startswith(signature):
            return description
    return ""


def check(head: bytes, declared: str, accepted: set[str]) -> Verdict:
    """Decide what this file is, and whether we will keep it.

    ``declared`` is the sender's claim and is used only to catch a mismatch;
    the type that comes back is the one measured from the bytes, and it is what
    the rest of the system should store and act on.
    """
    if not head:
        return Verdict(False, reason="The uploaded file is empty.")

    executable = executable_kind(head)
    if executable:
        return Verdict(
            False,
            reason=f"This file is {executable}, which is never accepted.",
        )

    measured = sniff(head)

    if not measured:
        # No signature. Only the textual formats are allowed to look like this,
        # and only if they really are text.
        if declared not in _TEXTUAL:
            return Verdict(
                False,
                reason=(
                    f"The file does not look like {declared}. Its contents do "
                    "not match any accepted document format."
                ),
            )
        try:
            head.decode("utf-8")
        except UnicodeDecodeError:
            # A truncated multi-byte character at the sniff boundary is not a
            # binary file, so only a failure early in the window counts.
            try:
                head[:-4].decode("utf-8")
            except UnicodeDecodeError:
                return Verdict(
                    False,
                    reason=f"The file claims to be {declared} but is not text.",
                )
        return Verdict(True, mime_type=declared)

    if measured not in accepted:
        return Verdict(
            False,
            reason=(
                f"The file is actually {measured}, which is not an accepted "
                "document type."
            ),
        )

    # A mismatch between claim and content is the interesting case: it is what
    # an attacker does deliberately, and what a misconfigured browser does by
    # accident. The measured type wins, and the disagreement is reported so it
    # can be recorded.
    if declared and declared != measured:
        return Verdict(
            True,
            mime_type=measured,
            reason=f"declared {declared}, is actually {measured}",
        )

    return Verdict(True, mime_type=measured)


def safe_filename(name: str | None) -> str:
    """A display name that cannot escape a directory or confuse a shell.

    The stored path is generated elsewhere and never derived from this, so
    the name is presentation only -- but a name is rendered in the interface,
    written into audit metadata and put in front of a model, and all three are
    better off without control characters, right-to-left overrides or "..".
    """
    candidate = (name or "").strip() or "upload"
    candidate = candidate.replace("\\", "/").rsplit("/", 1)[-1]
    # Strip the invisible characters used to disguise an extension, e.g. a
    # right-to-left override that makes "exe.pdf" render as "fdp.exe".
    candidate = "".join(
        ch for ch in candidate if unicodedata.category(ch) not in {"Cf", "Cc"}
    )
    candidate = _UNSAFE_NAME.sub("_", candidate).strip(". ")
    if not candidate:
        candidate = "upload"
    if len(candidate) > MAX_FILENAME:
        stem, _, suffix = candidate.rpartition(".")
        keep = MAX_FILENAME - len(suffix) - 1
        if stem and keep > 0:
            candidate = f"{stem[:keep]}.{suffix}"
        else:
            candidate = candidate[:MAX_FILENAME]
    return candidate
