"""Input validation for values that reach the Kubernetes API.

The image check used to be `image.startswith("cloudhelm/")`, which accepted
`cloudhelm/../../../etc/passwd:latest`, `cloudhelm/ai:1; rm -rf /` and
`cloudhelm/../evil:1`. That is not a real allowlist: an operator-visible
"approved registry" guarantee has to constrain the whole reference, not a prefix.
"""

from __future__ import annotations

import re

# A single repository path segment, e.g. "ai-agent" or "guide_service".
_SEGMENT = r"[a-z0-9]+(?:[._-][a-z0-9]+)*"
_TAG = r"[A-Za-z0-9_][A-Za-z0-9._-]{0,127}"
_DIGEST = r"sha256:[a-f0-9]{64}"

_IMAGE_RE = re.compile(
    rf"^(?P<registry>{_SEGMENT})/"
    rf"(?P<path>{_SEGMENT}(?:/{_SEGMENT})*)"
    rf"(?::(?P<tag>{_TAG}))?"
    rf"(?:@(?P<digest>{_DIGEST}))?$"
)

MAX_IMAGE_LENGTH = 256


def parse_approved_image(image: str, registries: set[str]) -> tuple[bool, str]:
    """Return (ok, reason). Only well-formed references from approved registries pass."""
    if not image or not image.strip():
        return False, "image must not be empty"
    if len(image) > MAX_IMAGE_LENGTH:
        return False, f"image reference is longer than {MAX_IMAGE_LENGTH} characters"
    if image != image.strip() or any(ch.isspace() for ch in image):
        return False, "image must not contain whitespace"

    match = _IMAGE_RE.fullmatch(image)
    if not match:
        return False, "image is not a valid reference (expected [registry/]repository[:tag][@digest])"

    if any(segment in (".", "..") for segment in image.split("/")):
        return False, "image must not contain relative path segments"

    registry = match.group("registry")
    if registry not in registries:
        return False, f"registry '{registry}' is not approved (allowed: {', '.join(sorted(registries)) or 'none'})"
    return True, ""
