---
name: prior-art
description: "First step when approaching a new software engineering problem: search reputable, community-vetted sources (Stack Exchange, Hacker News, curated engineering blogs) for recommended solutions to the same kind of problem, checking high-vote comments/answers that affirm or contradict each recommendation. Use before designing or implementing anything non-trivial."
---

# Prior Art Scout

Before solving a software engineering problem from scratch, find how reputable sources
recommend solving it — and whether the community *agrees* with those recommendations.
The goal is a short, sourced summary of candidate approaches with a confidence signal
for each, not a full implementation plan.

## Source tiers

### Tier 1 — community-vetted (votes + comments, queryable via `scout.mjs`)

| Source | Signal |
|---|---|
| Stack Overflow (`stackoverflow`) | answer votes, accepted answers |
| Software Engineering SE (`softwareengineering`) | design/architecture Q&A, votes |
| Server Fault (`serverfault`), DBA SE (`dba`) | ops/database Q&A, votes |
| Hacker News | story points + expert comment threads (often the best critique of an article) |

### Tier 2 — reputable publications (authoritative, but no vote signal)

Search these with `site:` scoping (see below). Treat as trusted authorship, but look for
a matching HN/lobste.rs discussion for community validation.

- **Official documentation** of the technology in question — always check first for the "blessed" approach
- martinfowler.com — architecture and design patterns
- thoughtworks.com/radar — adopt/trial/hold verdicts on techniques and tools
- infoq.com — practitioner articles and conference talks
- highscalability.com — systems/architecture case studies
- Engineering blogs: netflixtechblog.com, blog.cloudflare.com, stripe.com/blog, github.blog, shopify.engineering, slack.engineering, engineering.fb.com, aws.amazon.com/blogs
- Respected individuals: jvns.ca, brandur.org, newsletter.pragmaticengineer.com

### Tier 3 — community sites without direct API access from this box

- **Reddit** (r/ExperiencedDevs, r/softwarearchitecture, r/programming, r/devops, language subs) — direct API is blocked here; reach via site-scoped search, and read threads with the **web-browser** skill if vote counts matter
- **lobste.rs** — search via `site:lobste.rs`; comments for a story are available as JSON at `https://lobste.rs/s/<id>.json` (includes per-comment `score`)

## Workflow

Given a problem/topic:

1. **Query vetted sources** (run from this skill directory):
   ```bash
   node scout.mjs search "<topic>"                          # HN + stackoverflow + softwareengineering
   node scout.mjs search "<topic>" --se-site dba,serverfault
   ```
   Try 2–3 phrasings (problem-oriented, e.g. "zero downtime schema migration",
   not solution-oriented). Options: `--limit N`, `--json`.

2. **Drill into the top 2–4 hits** to extract recommendations *and* community verdicts:
   ```bash
   node scout.mjs so <question_id> --se-site stackoverflow   # answers sorted by votes
   node scout.mjs hn <story_id>                              # top-level HN comments
   ```
   In HN comments and SE answers, specifically look for:
   - high-vote/accepted answers that name a concrete approach or tool
   - comments that **contradict or caveat** the article/answer ("we tried this and…",
     "this breaks when…", "outdated since vX") — these are as valuable as endorsements
   - dates: discount advice about fast-moving tools that is more than ~3–4 years old

3. **Site-scoped article search** for Tier 2 sources, using the **native-web-search** skill:
   ```bash
   node ../native-web-search/search.mjs "<topic> site:martinfowler.com OR site:infoq.com OR site:highscalability.com" --purpose "prior art research"
   node ../native-web-search/search.mjs "<topic> site:reddit.com/r/ExperiencedDevs OR site:lobste.rs" --purpose "prior art research"
   ```
   To read a promising article, use the **summarize** skill (`to-markdown.mjs`); for
   pages where you need visible vote counts (Reddit, lobste.rs), use the **web-browser** skill.

4. **Cross-validate**: for any Tier 2 article that drives a recommendation, search HN for a
   discussion of it (`node scout.mjs search "<article title>"`) and check whether top comments
   affirm or dispute it.

5. **Fallback — generic web search** (allowed, but always caveated): if the tiers above
   don't cover the topic, use native-web-search without site scoping. Anything sourced this
   way **must** be labelled as unvetted in your output (see below).

## Output format

Produce a short report:

```markdown
## Prior art: <topic>

### Recommended approaches
1. **<approach>** — <one-line summary>
   - Sources: <links>
   - Community signal: e.g. "accepted SO answer, score 412" / "HN 350pts, top comments affirm" 
   - Caveats raised: <dissenting high-vote comments, age warnings, "it depends" conditions>
2. ...

### Unvetted findings (generic web search — treat with caution)
- <finding> — <link> ⚠️ not from the vetted source list; no community validation found
```

## Rules

- **Never present an unvetted finding as a recommendation.** Anything not reliably learned
  from the Tier 1/2/3 list gets an explicit ⚠️ caveat and its URL.
- Always cite full URLs so the user can verify.
- Report disagreement honestly — if high-vote comments dispute an article, say so rather
  than picking a side silently.
- Prefer 2–3 well-sourced candidate approaches over an exhaustive list.
- If vetted sources return nothing, say so explicitly before falling back.
