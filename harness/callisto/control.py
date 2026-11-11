"""Loop control: when to stop, continue, or recover from thrashing.

The model alone is a weak controller. These heuristics gate premature
"I'm done" texts, soft-recover from repeated actions, and force a final
answer near the step budget — without rejecting good partial answers.
"""
from __future__ import annotations

import re
from typing import Any

# Pure planning / unfinished openers — only when the WHOLE message is thin.
# Avoid matching "let me know" inside a real answer.
_PLANNING_ONLY = (
    re.compile(
        r"^\s*(i will|i'll|let me|i am going to|i'm going to|next i|going to)\b"
        r"(?! know\b).{0,80}$",
        re.I | re.S,
    ),
    re.compile(r"^\s*(searching|looking for|navigating to|trying to)\b.*$", re.I | re.S),
    re.compile(r"\b(please wait|one moment|hold on)\s*[.!]?\s*$", re.I),
)

# Strong evidence that the model already has an answer worth accepting.
_EVIDENCE_MARKERS = re.compile(
    r"("
    r"https?://|"
    r"\$\d|"
    r"₹\s?\d|"
    r"\b\d{10,}\b|"  # phone-ish
    r"\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b|"
    r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|"  # email
    r"\b(address|phone|email|contact|instagram|whatsapp|pricing|plan|month|year)\b|"
    r"\*\*[^*]+\*\*"  # markdown bold section headers
    r")",
    re.I,
)

# Pages that mean "this path is dead — don't hammer it."
_BLOCKED_MARKERS = (
    "you have been blocked",
    "unable to access",
    "access denied",
    "attention required",
    "cf-browser-verification",
    "captcha",
    "just a moment",
    "enable javascript and cookies",
    "sorry, you have been blocked",
)

STUCK_NUDGE = (
    "You repeated the same tool action. Do NOT run it again. "
    "Either take a clearly different action (new URL from a snapshot link, "
    "different ref, scroll, or switch tab), OR stop with a final answer that "
    "quotes only facts from prior tool results. If blocked, switch site/strategy."
)

CONTINUE_NUDGE = (
    "That was not an acceptable final answer (empty or pure planning). "
    "Continue: take one tool action, OR reply with a complete final answer that "
    "quotes facts/URLs from prior tool results. Partial answers with evidence are OK."
)

BUDGET_NUDGE = (
    "Step budget is almost exhausted. On your next turn either: "
    "(1) one decisive tool action that advances the task, or "
    "(2) stop with a final answer quoting only evidence already in tool results. "
    "Do not explore randomly."
)

FORCE_FINAL_NUDGE = (
    "You are thrashing. STOP using tools. "
    "Reply now with a final answer: summarize what you verified from tool results, "
    "what failed, and any partial answer. Quote evidence. No more page.content loops."
)

CONTENT_THRASH_NUDGE = (
    "You have scraped page HTML/content too many times without navigating or "
    "clicking. STOP. Give a final answer from evidence already collected, or "
    "take one non-scrape action (snapshot once, click a ref, or goto a new page)."
)

PINGPONG_NUDGE = (
    "You are alternating click/snapshot (or similar) without progress. "
    "STOP that loop. Either change strategy (filters, search, new URL from evidence) "
    "or give a final answer from what you already saw (products, prices, colors). "
    "Do not click the same ref again."
)

# Family thrash thresholds (consecutive actions in same family)
FAMILY_THRASH_AT = {
    "repl:goto": 4,
    "repl:snapshot": 4,
    "repl:content": 3,  # page.content / outerHTML mining burns steps fast
    "repl:evaluate": 4,
    "repl:click": 4,  # same-family click spam
    "repl:other": 5,
}

# Alternating A-B-A-B for this many steps counts as thrash (click↔snapshot).
PINGPONG_WINDOW = 6


def has_answer_evidence(text: str) -> bool:
    """True if text looks like it reports concrete findings."""
    if len(text) >= 200 and _EVIDENCE_MARKERS.search(text):
        return True
    if len(text) >= 80 and _EVIDENCE_MARKERS.search(text):
        # multiple evidence hits stronger
        hits = len(_EVIDENCE_MARKERS.findall(text))
        return hits >= 2 or bool(
            re.search(r"https?://|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}", text, re.I)
        )
    return False


def is_acceptable_final(text: str | None, *, step: int, min_chars: int = 8) -> bool:
    """
    True if `text` looks like a real task answer rather than empty/planning filler.

    Substantial answers with URLs/contacts/prices always pass — even if they also
    say "let me know if you want more" (common false positive before).
    """
    if text is None:
        return False
    cleaned = " ".join(text.strip().split())
    if not cleaned:
        return False
    if len(cleaned) < 3:
        return False
    if len(cleaned) < min_chars and step < 1:
        return False

    # Evidence-rich answers win — never bounce a good partial result.
    if has_answer_evidence(cleaned):
        return True

    # Thin planning-only messages
    for pat in _PLANNING_ONLY:
        if pat.search(cleaned):
            return False

    # Short planning phrases embedded as the whole message
    lower = cleaned.lower()
    if len(cleaned) < 100 and any(
        lower.startswith(p)
        for p in ("i will ", "i'll ", "let me ", "going to ", "i am going to ")
    ):
        if "let me know" not in lower:
            return False

    return True


def result_looks_blocked(result: dict[str, Any]) -> bool:
    """Detect bot-wall / block interstitial text in a tool result."""
    chunks: list[str] = []
    if isinstance(result.get("error"), str):
        chunks.append(result["error"])
    val = result.get("value")
    if isinstance(val, str):
        chunks.append(val)
    elif isinstance(val, dict):
        chunks.append(json_dumps_safe(val))
    blob = " ".join(chunks).lower()
    return any(m in blob for m in _BLOCKED_MARKERS)


def json_dumps_safe(obj: Any) -> str:
    import json

    try:
        return json.dumps(obj, default=str)
    except Exception:
        return str(obj)


_BLANK_URLS = frozenset({
    "",
    "about:blank",
    "chrome://newtab/",
    "chrome://new-tab-page/",
    "edge://newtab/",
})


def is_blank_url(url: str | None) -> bool:
    if url is None:
        return True
    u = url.strip().lower()
    return u in _BLANK_URLS or u.startswith("chrome://newtab")


def blank_page_noop_reason(call: dict[str, Any], current_url: str | None) -> str | None:
    """If the agent is about to waste a turn on about:blank, return an error string."""
    if not is_blank_url(current_url):
        return None
    if call.get("name") != "repl":
        return None
    args = call.get("arguments") or {}
    code = str(args.get("code", "")) if isinstance(args, dict) else ""

    if "page.goto" in code.lower():
        return None

    if "accessibility.snapshot" in code.lower():
        return (
            "Page is about:blank — snapshot is empty and useless. "
            "Navigate first: await page.goto('https://…') for a site relevant to the task, "
            "then snapshot."
        )

    if "page.url" in code.lower() and "page.goto" not in code.lower() and ".click" not in code.lower():
        return (
            f"Already on {current_url or 'about:blank'}. "
            "Do not re-query the URL. Call page.goto to a relevant site for the task."
        )

    if "page.title" in code.lower() and "page.goto" not in code.lower():
        return (
            "Blank page has no useful title. Navigate with page.goto before inspecting the page."
        )

    return None


def extract_url_from_result(result: dict[str, Any]) -> str | None:
    """Best-effort URL from a tool result value."""
    val = result.get("value")
    if isinstance(val, str):
        if val.startswith("http://") or val.startswith("https://") or val == "about:blank":
            return val.strip()
        m = re.search(r"https?://[^\s'\"<>]+", val)
        if m:
            return m.group(0).rstrip(".,);]")
    if isinstance(val, dict):
        u = val.get("url")
        if isinstance(u, str) and u:
            return u
    return None


# Hosts the agent may always open for discovery (search), without prior grounding.
_SEARCH_HOSTS = frozenset({
    "www.google.com",
    "google.com",
    "www.bing.com",
    "bing.com",
    "duckduckgo.com",
    "www.duckduckgo.com",
    "search.yahoo.com",
    "www.google.co.in",
})

_GOTO_RE = re.compile(
    r"""page\.goto\(\s*(['"])(?P<url>.*?)\1""",
    re.I | re.S,
)

_URL_IN_TEXT_RE = re.compile(r"https?://[^\s\"'<>\]\)]+", re.I)

# Chrome interstitial / dead-nav patterns in a11y or body text.
_NAV_FAILURE_MARKERS = (
    "err_cert",
    "err_name_not_resolved",
    "err_connection",
    "err_timed_out",
    "err_ssl",
    "this site can’t be reached",
    "this site can't be reached",
    "this webpage is not available",
    "dns_probe",
    "404",
    "page not found",
    "not found",
    "does not exist",
    "net::err_",
)


def normalize_url_key(url: str) -> str:
    """Lowercase host+path without trailing slash (except root)."""
    from urllib.parse import urlparse, urlunparse

    try:
        p = urlparse(url.strip())
        if not p.scheme:
            return url.strip().lower().rstrip("/")
        path = p.path or "/"
        if path != "/" and path.endswith("/"):
            path = path[:-1]
        netloc = p.netloc.lower()
        return urlunparse((p.scheme.lower(), netloc, path, "", "", "")).lower()
    except Exception:
        return url.strip().lower().rstrip("/")


# Bare hostnames in tasks ("open wikipedia.org") — no scheme required.
_HOST_IN_TEXT_RE = re.compile(
    r"\b(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b",
    re.I,
)
# Tokens that look like hostnames but are prose abbreviations / loopback.
_HOST_DENY = frozenset({
    "e.g", "i.e", "etc", "localhost",
})


def extract_urls_from_text(text: str) -> set[str]:
    found: set[str] = set()
    for m in _URL_IN_TEXT_RE.findall(text or ""):
        cleaned = m.rstrip(".,);]}>\"'")
        found.add(normalize_url_key(cleaned))
        # Also allow host root as grounded once any URL from that host appears
        try:
            from urllib.parse import urlparse

            p = urlparse(cleaned)
            if p.scheme and p.netloc:
                found.add(normalize_url_key(f"{p.scheme}://{p.netloc}/"))
                found.add(normalize_url_key(f"{p.scheme}://{p.netloc}"))
        except Exception:
            pass
    # Seed bare domains from user tasks so "go to wikipedia.org" grounds navigation.
    for host in _HOST_IN_TEXT_RE.findall(text or ""):
        h = host.lower().rstrip(".")
        if h in _HOST_DENY or h.endswith(".e.g") or h.endswith(".i.e"):
            continue
        if h.count(".") < 1:
            continue
        found.add(normalize_url_key(f"https://{h}/"))
        found.add(normalize_url_key(f"https://{h}"))
        if not h.startswith("www."):
            found.add(normalize_url_key(f"https://www.{h}/"))
    return found


def _base_domain(host: str) -> str:
    """Best-effort registrable domain (last two labels). Good enough for agent grounding."""
    host = host.lower().removeprefix("www.")
    parts = [p for p in host.split(".") if p]
    if len(parts) >= 2:
        return ".".join(parts[-2:])
    return host


def host_is_grounded(host: str, grounded_urls: set[str], grounded_text: str = "") -> bool:
    """True if host (or its base domain / a sibling subdomain) was seen in evidence."""
    host = (host or "").lower()
    if not host:
        return False
    bare = host.removeprefix("www.")
    blob = (grounded_text or "").lower()
    if host in blob or bare in blob:
        return True
    base = _base_domain(host)
    if base and (base in blob or f".{base}" in blob):
        return True
    for g in grounded_urls:
        gl = g.lower()
        if any(
            marker in gl
            for marker in (
                f"://{host}",
                f"://www.{bare}",
                f"://{bare}",
            )
        ):
            return True
        if base and base in gl:
            return True
    return False


def parse_goto_url(code: str) -> str | None:
    m = _GOTO_RE.search(code or "")
    return m.group("url") if m else None


def invented_goto_reason(
    code: str,
    grounded_urls: set[str],
    *,
    grounded_text: str = "",
) -> str | None:
    """
    Block page.goto targets that were never seen in tool evidence.

    Allowed:
      - search-engine URLs
      - URLs whose normalized form is in grounded_urls
      - URLs whose host+path (or full string) appears as a substring of grounded_text
      - homepage (path /) of a host already present in grounded_urls
    """
    url = parse_goto_url(code)
    if not url:
        return None
    if not url.startswith("http://") and not url.startswith("https://"):
        return None

    from urllib.parse import urlparse

    try:
        p = urlparse(url)
    except Exception:
        return None

    host = (p.netloc or "").lower()
    if host in _SEARCH_HOSTS:
        return None

    key = normalize_url_key(url)
    if key in grounded_urls:
        return None

    path = (p.path or "/").rstrip("/") or "/"
    blob = grounded_text.lower()
    # Substring grounding: path or full URL must have appeared in tool text
    if blob:
        candidates = [
            url.lower(),
            key,
            f"{host}{path}".lower(),
            f"{host}{p.path or ''}".lower(),
        ]
        if path != "/" and path.lower().lstrip("/") in blob:
            # weak: only if multi-char path token appears — still require host nearby
            if host_is_grounded(host, grounded_urls, blob):
                return None
        if any(c and c in blob for c in candidates):
            return None

    # Homepage of a host (or known sibling subdomain, e.g. en.wikipedia.org
    # after wikipedia.org) is OK once the site is grounded.
    root_key = normalize_url_key(f"{p.scheme}://{p.netloc}/")
    root_key2 = normalize_url_key(f"{p.scheme}://{p.netloc}")
    host_seen = host_is_grounded(host, grounded_urls, blob)

    if path == "/" and (root_key in grounded_urls or root_key2 in grounded_urls or host_seen):
        return None

    if path != "/" and host_seen:
        return (
            f"Invented path not in evidence: {url}. Host {host} was seen, but this "
            f"path never appeared in tool results. Click an in-page link/ref "
            f"(Contact, About, …) or scroll — do not guess /contact or /pages/…."
        )

    return (
        f"Ungrounded navigation to {url}. This URL never appeared in a tool "
        f"result. Do not invent domains or paths. Use a search engine, or "
        f"click a link ref from the latest snapshot/search results."
    )


def navigation_failure_note(result: dict[str, Any], requested_url: str | None = None) -> str | None:
    """If the page looks like a Chrome error / dead nav, return a clear agent note."""
    chunks: list[str] = []
    val = result.get("value")
    if isinstance(val, str):
        chunks.append(val)
    elif isinstance(val, dict):
        chunks.append(json_dumps_safe(val))
    if isinstance(result.get("error"), str):
        chunks.append(result["error"])
    blob = " ".join(chunks).lower()
    if not any(m in blob for m in _NAV_FAILURE_MARKERS):
        return None
    where = f" for {requested_url}" if requested_url else ""
    return (
        f" [callisto] Navigation appears to have FAILED{where} "
        f"(certificate error, DNS, connection, or not-found page). "
        f"This URL is invalid or unreachable. Do not invent similar paths. "
        f"Go back to a working page from evidence and click real links."
    )


def action_family(call: dict[str, Any]) -> str:
    """
    Coarser than full fingerprint: groups snapshot, goto, content-scrape, etc.

    Content/HTML mining is its own family so thrash detection can cut long loops.
    """
    name = call.get("name") or ""
    args = call.get("arguments") or {}
    if name != "repl":
        return f"{name}:{sorted(args.keys()) if isinstance(args, dict) else type(args).__name__}"
    code = str(args.get("code", "")) if isinstance(args, dict) else ""
    c = code.lower()
    # Content mining first — often combined with evaluate
    if (
        "page.content" in c
        or "outerhtml" in c
        or "innerhtml" in c
        or "document.body.innertext" in c
        or "document.documentelement" in c
        or (".match(" in c and ("html" in c or "content" in c))
    ):
        return "repl:content"
    # Click wins over snapshot when both appear in one code block
    if ".click(" in c:
        return "repl:click"
    if "accessibility.snapshot" in c:
        return "repl:snapshot"
    if "page.goto" in c:
        return "repl:goto"
    if "page.evaluate" in c:
        return "repl:evaluate"
    return "repl:other"


_REF_RE = re.compile(r"""callisto-ref=["']?(ax-\d+)["']?|locator\(\s*['"]\[?(ax-\d+)""", re.I)


def extract_click_ref(code: str) -> str | None:
    """Best-effort ax-N target from click code."""
    m = _REF_RE.search(code or "")
    if not m:
        return None
    return m.group(1) or m.group(2)


def is_pingpong(family_history: list[str], window: int = PINGPONG_WINDOW) -> bool:
    """True if the last `window` families strictly alternate between two values."""
    if len(family_history) < window:
        return False
    recent = family_history[-window:]
    a, b = recent[0], recent[1]
    if a == b:
        return False
    for i, f in enumerate(recent):
        if f != (a if i % 2 == 0 else b):
            return False
    return True
