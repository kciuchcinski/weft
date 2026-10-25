"""Errors caused by the user's input, as opposed to faults in Weft itself.

Their messages are surfaced verbatim to the client via the job ``error`` field,
so they must read as clear, actionable explanations.
"""

from __future__ import annotations


class InputError(ValueError):
    """The uploaded input can't be processed as given."""


class InputTooLarge(InputError):
    """Parsed input exceeds a configured resource guard."""


def brief(exc: BaseException, limit: int = 200) -> str:
    """A one-line summary of an exception message. Biopython appends the whole
    offending feature (translation included) to some errors; the first two lines
    name the problem and its location."""
    lines = [line.strip() for line in str(exc).splitlines() if line.strip()]
    text = " ".join(lines[:2]) or type(exc).__name__
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"
