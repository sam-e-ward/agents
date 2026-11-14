---
name: product-research
description: "Research and recommend products or services using current, sourced evidence and community experience. Use for buying advice, category comparisons, or choosing a product/service: maps price and capability tiers first, identifies features owners value, and recommends a small shortlist with trade-offs. Defaults to the UK market; includes second-hand/refurbished options where relevant. Focuses on ballpark prices, not individual listings."
---

# Product Research

Help the user choose the right kind of product or service, then a small shortlist
within it — not just a list of popular brands or today's deals.

Read `../web-research/SKILL.md` first. Inherit its source tiers, slop filter,
community-verification workflow, corroboration requirements, and access-failure
rules. Use the buying-focused workflow and output below instead of its generic
report format. Product/price tiers below are distinct from source-quality tiers
A–D.

## Defaults and scope

- **Default region: UK**, unless the user specifies otherwise. Search with UK
  context and report approximate prices in GBP, including VAT where applicable.
  Check UK availability, model variants, service coverage, and relevant terms;
  don't assume US recommendations or prices transfer directly.
- Note today's date, the intended use, budget, and any explicit must-haves or
  deal-breakers. Ask only for missing information that would materially change
  the recommendation; otherwise state assumptions and proceed.
- **Research categories and models/plans, not individual listings.** A sourced
  ballpark price or range is enough. Do not spend time hunting the cheapest
  seller, live stock, coupons, or a particular used item unless asked.
- For services, distinguish introductory from ongoing prices, billing period,
  minimum commitment, renewal/cancellation terms, and material usage limits.
  For products, consider necessary accessories, consumables, subscriptions, and
  maintenance where they change the value comparison.

## Tools

Reuse the existing research tools; resolve these paths from this skill directory:

- `../native-web-search/search.mjs` — broad and site-scoped searches. Read its
  `SKILL.md` before use.
- `../web-research/scout.mjs` — community searches and vote/comment lookups.
- `../web-research/redlib.mjs` — best-effort Reddit fallback, normally invoked
  automatically by the scout.
- `../web-browser/SKILL.md` — read before using its browser tools to verify
  primary pages, review methodology, or community threads.

Example search angles (adapt to the category and region):

```bash
node ../native-web-search/search.mjs "<category> UK budget mid-range premium differences" --purpose "map product tiers"
node ../native-web-search/search.mjs "<category> long term ownership problems features worth paying for" --purpose "identify owner priorities and trade-offs"
node ../web-research/scout.mjs search "<category> recommendations problems" --sources reddit --json
```

## Workflow

### 1. Map the market into meaningful tiers first

Before picking winners, identify the available price/capability tiers. Use
category-appropriate names: entry-level, mid-range, premium, specialist, or
service plan levels. Don't force a three-tier structure if the evidence suggests
something else, and distinguish genuine capability jumps from branding.

For each tier, summarise:
- Approximate UK price range (or recurring cost and billing basis).
- What it gets you: meaningful capabilities, performance, durability, support,
  service levels, or limits compared with the tier below.
- What remains compromised, and who would actually benefit from paying more.

Ground these boundaries in current sources. Ranges may overlap; treat them as a
useful buying framework, not precise market cut-offs. Explain diminishing
returns and identify the likely sweet spot for the user's needs. If the user
already named a model or plan, situate it within this map.

### 2. Find what the community thinks matters

Search relevant enthusiast communities, owner forums, and long-term usage
reports, not only "best <category>" articles. Use topic-appropriate sources;
HN or Stack Exchange need not be relevant to every consumer category.

Identify and summarise recurring priorities: which features make a real
practical difference, which are marketing, common failure modes, reliability,
repairability, usability, support, and ownership costs. Keep the user's explicit
requirements visible alongside these community-derived criteria; popularity
must not silently override a must-have.

Read substantive comments, including highly rated dissent and reports from
people with similar use cases. Record votes/comment counts where verifiable,
thread dates, and relevant usage context. Repeated independent owner experience
is stronger than one viral post; a vote count or star rating alone is not proof
of quality. Distinguish broad agreement from niche preferences or disputed
claims. Never invent consensus or numeric signals.

### 3. Build and verify a small shortlist

Choose roughly 2–4 products, model families, or service plans that satisfy the
criteria, spanning tiers only where it helps the decision. For each, explain
who it suits, its meaningful advantages, drawbacks, and approximate UK price.
Identify the best fit for the stated needs, not a universal "best".

- Verify specifications, compatibility, availability, and contractual terms
  against primary sources. Vendor claims establish advertised capabilities,
  not independent evidence of performance or reliability.
- Use reputable hands-on reviews with transparent methods for comparative
  performance, and owner reports for longer-term experience. Look for
  contradictory evidence as actively as endorsements.
- Affiliate funding alone doesn't invalidate a review, but thin affiliate
  roundups, undisclosed sponsorship, copied comparisons, and freshness-washed
  listicles deserve the inherited slop filter. Treat vendor-gameable review
  sites and retailer ratings as corroborating signals only.
- Require at least two independent sources per substantive conclusion as in
  `web-research`; copied articles and syndicated reviews are not independent.
  If only one source exists, label that limitation rather than padding evidence.
- Cite every material factual claim, including price ranges and tier
  differences. Separate sourced facts, owner sentiment, and your own reasoned
  recommendation. Do not fill gaps with remembered specs or invented prices.

### 4. Consider second-hand and refurbished options where relevant

Include a short comparison when there is a meaningful used/refurbished market.
Compare approximate price tiers with buying new — no specific listings needed.
Older high-end models may compete with new entry-level products; explain when
that is a good trade and when it isn't.

Distinguish private used, retailer refurbished, and manufacturer refurbished
rather than treating "refurbished" as a uniform standard. Cover relevant
trade-offs: condition and grading, battery/consumable wear, warranty and returns,
remaining software/security support, parts and repairs, missing accessories,
compatibility, and fraud or lock risks. Verify UK seller-specific policies or
legal protections before asserting them; do not imply private sales carry the
same protection as buying from a business. If this route isn't relevant (for
example, many services), omit it or briefly explain why.

## Output format

Keep the report decision-oriented and start with the tier map, not a winner.
Use linked citations next to claims; keep tables readable rather than exhaustive.

```markdown
## Product research: <category or service>
_As of <date> · Region: UK (or specified region) · <key assumptions>_

### Available tiers
| Tier | Approximate price | What you gain / compromise | Best suited to |
|---|---|---|---|
<Source the ranges and capability differences; explain the likely sweet spot.>

### What matters in practice
- **<criterion>** — why owners value it; community evidence and any disagreement.
- **User requirements** — how the explicit must-haves constrain the choice.

### Recommendations
1. **<model/family/plan> — <who it's for>**
   - Approximate price; why it fits; key drawbacks and when not to choose it.
   - Sources: [Title](full-url) [source tier]; community signal and confidence.
<Finish with a clear best-fit recommendation and when to step up or down.>

### Used / refurbished vs new (if relevant)
- Approximate savings/price tiers, worthwhile alternatives, and key trade-offs.

### Sources and limitations
- URLs actually used, with source-quality tiers (A–D).
- Missing evidence, conflicting reports, unavailable communities, or uncertain prices.
- Notable low-trust sources excluded and why, only if useful.
```

## Rules

- Only present sourced information as fact; use real, full, clickable URLs.
- Prefer a few well-supported recommendations over an exhaustive catalogue.
- Flag Tier D evidence with ⚠️; never present it as settled fact.
- Report disagreement and uncertainty rather than manufacturing a winner.
- Failed searches or blocked Reddit/Redlib access mean **unavailable evidence**,
  not "no discussion found". State coverage limits and use independent sources.
- If the evidence is too weak to recommend confidently, say so and explain what
  the user should verify before buying.
