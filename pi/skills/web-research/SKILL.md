---
name: web-research
description: "In-depth web research for up-to-date, well-sourced answers on any topic. Use when a question needs current information, multiple corroborating sources, or verification beyond a quick search — comparing products, checking recent events/releases, 'what do people actually think/recommend', or any claim that should be traced to real sources. Filters out SEO-slop content-farm pages and biases toward sources with genuine community traction. Standalone — does not depend on the prior-art skill, and works for non-engineering topics too."
---

# Web Research

A deeper investigation than a single `native-web-search` call: multiple query
angles, explicit filtering of low-trust content, active checking for community
corroboration, and a sourced report at the end — for *any* topic, not just
software engineering (see `prior-art` for that, which has its own SO/SE tooling
and stays separate from this skill).

## Tools this skill composes

- **native-web-search** (`../native-web-search/search.mjs`) — broad recon and
  site-scoped searches.
- **web-browser** (`../web-browser/scripts/*`) — verify claims on primary
  pages, read threads that need in-page vote counts, handle JS-rendered pages.
- **`scout.mjs`** (in this skill directory) — domain-agnostic community-signal
  lookups. See below.
- **`redlib.mjs`** (in this skill directory) — resilient Reddit access via the
  Redlib front-end ecosystem; used automatically by `scout.mjs` as a fallback.
  Run `node redlib.mjs probe` to see live instances.

## Source tiers

**Tier A — Primary/official.** The original document itself: official docs/
changelogs, company press releases, government/regulatory data, standards
specs, academic papers/preprints, source repos. Trusted on authority of origin
— always prefer this over someone's summary of it.

**Tier B — Community-vetted, with a numeric signal.** Queryable via
`scout.mjs` (no auth needed):

| Source | Command | Notes |
|---|---|---|
| Hacker News | `node scout.mjs search "<topic>" --sources hn` | Algolia API, reliable, any topic that's been submitted (not just tech) |
| Stack Exchange network | `node scout.mjs search "<topic>" --se-site <site1,site2>` | Not just `stackoverflow` — pick the SE site matching the topic domain (table below). Reliable, no auth. |
| lobste.rs | `node scout.mjs lobsters <shortid>` | No search API — find the shortid via `native-web-search "site:lobste.rs <topic>"`, then pull comments/scores directly |
| Reddit | `node scout.mjs search "<topic>" --sources reddit` | **Auto-fallbacks.** Reddit's JSON API 403s from cloud/datacenter IPs; `scout.mjs` transparently retries via the Redlib mirror ecosystem (below) and marks results `[via redlib]`. |
| Bluesky | `node scout.mjs search "<topic>" --bluesky` | **Best-effort**, same IP-blocking caveat as Reddit. Lower-trust signal anyway (likes/reposts, not a real vote) — use only as a minor corroborating data point. |

### Reddit access: the Redlib fallback chain

Reddit blocks automated access at every layer (JSON API, web UI, and reader
proxies like r.jina.ai all 403 from datacenter IPs). Redlib instances are
independently hosted Reddit front-ends that serve the *same* content as plain
parseable HTML, including vote counts, and some run on networks Reddit hasn't
blocked. `scout.mjs` handles this automatically; for direct control:

```bash
node redlib.mjs probe                                        # list working instances
node redlib.mjs search "<topic>" [--subreddit <s>] [--limit N] [--json]
node redlib.mjs comments <post_id> --subreddit <s> [--limit N] [--json]
```

Resolution order (what `scout.mjs` does under the hood):

1. Direct `reddit.com` JSON API — usually 403 from here.
2. Fetch the official Redlib instance list (github raw JSON) and probe each in
   parallel, rejecting 403s and JS challenge pages (Anubis, Cloudflare).
3. Use the first working instance for the search/comment request.

Check status at any time with `node redlib.mjs probe` (lists the instances
that are currently serving content).

If every instance is blocked or challenged, the request fails loudly with the
combined error messages — do **not** treat that as "no community discussion
found". As a last resort, use `native-web-search "site:reddit.com ..."` +
`web-browser`, but expect Reddit's own pages to be blocked too.

Common SE sites by topic (pick 1–2 relevant ones, full list at
stackexchange.com/sites):

| Topic domain | SE site |
|---|---|
| Travel | `travel.stackexchange.com` |
| Personal finance | `money.stackexchange.com` |
| Parenting | `parenting.stackexchange.com` |
| Academia/research | `academia.stackexchange.com` |
| Health/fitness (non-medical-advice) | `health.stackexchange.com`, `fitness.stackexchange.com` |
| History | `history.stackexchange.com` |
| Politics/policy | `politics.stackexchange.com` |
| Skepticism/fact-checking claims | `skeptics.stackexchange.com` |
| Cooking | `cooking.stackexchange.com` |
| DIY/home | `diy.stackexchange.com` |
| Law | `law.stackexchange.com` |
| Software/programming | leave to the `prior-art` skill instead |

**Special case — Wikipedia.** Fast for a factual baseline and for finding
citations, but never cite Wikipedia itself as the source — follow through to
what it cites.

**Tier C — Reputable editorial, no vote signal.** Established journalism (wire
services, major mastheads), recognized trade/industry press, named experts/
authors with a track record, review outlets with a transparent methodology.
Found via `native-web-search`, ideally `site:`-scoped. Cross-check by searching
Tier B (especially HN) for a discussion of the specific article — agreement or
pushback in comments is valuable signal either way.

**Domain-conditional sources** — reach for these via `site:`-scoped
`native-web-search` + `web-browser` (no bulk API) when the topic matches:

| Topic | Site | Caveat |
|---|---|---|
| General life advice / how-to | `site:ask.metafilter.com` | Moderated, less spammy than most forums |
| Software/product launches | Product Hunt | Upvotes/comments, view via browser |
| B2B software comparisons | G2, Capterra | Vendor-gameable — one data point among several |
| Books / film / TV | Goodreads, IMDb | Community rating, watch for review-bombing |
| Company/product reputation, complaints | Trustpilot, BBB | Gameable both directions — corroborate, don't rely on alone |
| Academic paper / study claims | OpenReview, PubPeer | Post-publication community review |

**Avoid or heavily discount:**
- **Quora** — dominated by spam/AI-generated answers now; Tier D unless a specific answer is clearly from a verifiable expert.
- **Twitter/X** — search is largely inaccessible programmatically; skip unless the user explicitly wants social sentiment and accepts browser-only access.
- **YouTube comments/view counts** — too easily brigaded or bought; weak signal.

**Tier D — Generic web / unvetted.** Everything else, including SEO-farm
content. Allowed only as a last resort, and must be flagged ⚠️ in the output.

## Slop filter — heuristics for dropping/flagging Tier D noise

Before using a page as a source, check for:
- Generic listicle titles ("Top 10 X in 2025", "Ultimate Guide to Y")
- No named author/organization, or a boilerplate author bio
- Heavy ad density / affiliate-link farms / "sponsored" content dominating the page
- No dates, or a suspiciously "freshness-washed" update date on otherwise generic/stale content
- Near-duplicate phrasing across multiple "independent" domains (classic programmatic content sign)
- Thin content that circles keyword-stuffed paragraphs without actually answering the specific question

When a snippet looks borderline, open the page with `web-browser` and read it
rather than trusting the search snippet.

## Workflow

1. **Scope the question.** Note today's date and what "current" means here
   (a version number, an event date, "as of" framing).

2. **Broad recon** — 2–3 differently-phrased `native-web-search` queries
   (include at least one non-solution-oriented phrasing). Triage every hit
   into Tier A/B/C/D as you go.

3. **Slop filter** — drop or flag Tier D hits using the heuristics above.

4. **Community traction pass** — run `scout.mjs search` (HN + relevant SE
   site(s), Reddit/Bluesky best-effort) for the topic itself, and again for
   any specific Tier C article that's driving a conclusion. Reddit access
   auto-falls back to Redlib; if you need raw control use `node redlib.mjs
   search "<topic>"` / `node redlib.mjs comments <id> --subreddit <s>`. Only
   if Redlib is also down should you fall back to site-scoped
   `native-web-search` + `web-browser` to read a thread.

5. **Deep dive with web-browser** as needed: verify a primary source directly,
   check real publish/update dates, or read a thread that needs in-page vote
   counts.

6. **Cross-source corroboration** — require ≥2 independent sources per claim
   in the final answer. If genuinely only one source exists (e.g. a lone
   vendor announcement), say so explicitly rather than padding with weak
   duplicates.

## Output format

```markdown
## Research: <topic>
_As of <date>_

### Findings
1. **<claim/answer>**
   - Sources: [Title](url) [Tier A], [Title](url) [Tier C]
   - Community signal: e.g. "HN 410pts/103 comments, top comments affirm" / "no community discussion found"
   - Confidence: high/medium/low — why

### Sources consulted
- Full list of URLs actually used, tiered

### Filtered out
- Notable low-trust hits excluded and why (brief — only if it shows relevant diligence)

### Open questions / unable to verify
- Anything left unresolved, and what would resolve it
```

## Rules

- Every source is a real, full URL the user can click.
- Never present a Tier D / unvetted finding as settled fact — flag it with ⚠️.
- Report disagreement honestly: if sources or community comments conflict,
  say so rather than silently picking a side.
- Prefer 2–3 well-corroborated findings over an exhaustive but shallow list.
- If community-vetted sources return nothing, say so explicitly before
  relying on Tier C/D.
- If Reddit scripted access fails, `scout.mjs` already retries via the Redlib
  mirror ecosystem; only if that also fails should you fall back to site-scoped
  search + `web-browser` — never conclude "no community discussion found"
  without checking `node redlib.mjs probe` for live instances first.
