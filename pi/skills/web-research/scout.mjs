#!/usr/bin/env node
// web-research scout — generic (non-code-specific) community-traction lookups.
// Covers Hacker News, Reddit, the Stack Exchange network (any site, not just
// programming ones), lobste.rs, and Bluesky. Used to check whether a claim
// or article has real community discussion/vote signal behind it, regardless
// of topic domain.
//
// Usage:
//   node scout.mjs search "<topic>" [--limit N] [--sources hn,reddit,se] [--se-site site1,site2] [--bluesky] [--json]
//   node scout.mjs hn <story_id>                          # top-level HN comments
//   node scout.mjs reddit <post_id> --subreddit <sub>      # top-level reddit comments
//   node scout.mjs so <question_id> --se-site <site>       # SE answers, by votes
//   node scout.mjs lobsters <shortid>                      # lobste.rs comments, by score
//
// No dependencies. Requires Node >= 18 (global fetch).

const args = process.argv.slice(2);
const cmd = args[0];

function flag(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const asJson = args.includes("--json");
const limit = parseInt(flag("limit", "10"), 10);
const seSites = flag("se-site", "").split(",").filter(Boolean);
const sources = flag("sources", "hn,reddit" + (seSites.length ? ",se" : "")).split(",").filter(Boolean);
const includeBluesky = args.includes("--bluesky") || sources.includes("bluesky");

const UA = "pi-web-research-scout/1.0 (+https://github.com/earendil-works/pi)";

function stripHtml(html) {
  return (html || "")
    .replace(/<pre><code>[\s\S]*?<\/code><\/pre>/g, " [code block] ")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/").replace(/\s+/g, " ")
    .trim();
}

function truncate(s, n = 600) {
  return s.length > n ? s.slice(0, n) + " …[truncated]" : s;
}

async function getJson(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { "User-Agent": UA, ...extraHeaders } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

// ---- Hacker News (Algolia) — domain-agnostic, any topic that's been submitted ----
async function searchHN(query) {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${limit}`;
  const data = await getJson(url);
  return data.hits
    .filter((h) => (h.points ?? 0) >= 5)
    .map((h) => ({
      source: "hackernews",
      title: h.title,
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      discussion: `https://news.ycombinator.com/item?id=${h.objectID}`,
      id: h.objectID,
      signal: h.points,
      comments: h.num_comments,
      date: (h.created_at || "").slice(0, 10),
    }));
}

async function hnComments(storyId) {
  const item = await getJson(`https://hn.algolia.com/api/v1/items/${storyId}`);
  const top = (item.children || []).filter((c) => c.text).slice(0, limit);
  return {
    title: item.title,
    url: item.url,
    points: item.points,
    comments: top.map((c) => ({
      author: c.author,
      replies: (c.children || []).length,
      text: truncate(stripHtml(c.text)),
    })),
  };
}

// ---- Reddit — public JSON search, no auth required in principle, but Reddit
// aggressively blocks many datacenter/cloud IP ranges with a 403 regardless of
// headers. Treat this as best-effort: if it fails, fall back to site-scoped
// native-web-search + web-browser (see SKILL.md).
async function searchReddit(query) {
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance&limit=${limit}`;
  const data = await getJson(url);
  return (data.data?.children || []).map((c) => {
    const d = c.data;
    return {
      source: "reddit",
      title: d.title,
      url: `https://reddit.com${d.permalink}`,
      subreddit: d.subreddit_name_prefixed,
      id: d.id,
      signal: d.score,
      comments: d.num_comments,
      date: new Date(d.created_utc * 1000).toISOString().slice(0, 10),
    };
  });
}

async function redditComments(postId, subreddit) {
  if (!subreddit) throw new Error("reddit comments require --subreddit <name>");
  const url = `https://www.reddit.com/r/${subreddit}/comments/${postId}.json?limit=${limit}`;
  const data = await getJson(url);
  const post = data[0]?.data?.children?.[0]?.data;
  const top = (data[1]?.data?.children || [])
    .filter((c) => c.kind === "t1" && c.data?.body)
    .slice(0, limit);
  return {
    title: post?.title,
    url: post ? `https://reddit.com${post.permalink}` : null,
    score: post?.score,
    comments: top.map((c) => ({
      author: c.data.author,
      score: c.data.score,
      replies: (c.data.replies?.data?.children || []).length,
      text: truncate(stripHtml(c.data.body)),
    })),
  };
}

// ---- Stack Exchange network — any site, not just programming ones ----
async function searchSE(query, site) {
  const url =
    `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance` +
    `&q=${encodeURIComponent(query)}&site=${site}&pagesize=${limit}`;
  const data = await getJson(url);
  return (data.items || []).map((q) => ({
    source: site,
    title: stripHtml(q.title),
    url: q.link,
    id: q.question_id,
    signal: q.score,
    answers: q.answer_count,
    accepted: !!q.accepted_answer_id,
    date: new Date(q.creation_date * 1000).toISOString().slice(0, 10),
    tags: q.tags,
  }));
}

async function soAnswers(questionId, site) {
  const url =
    `https://api.stackexchange.com/2.3/questions/${questionId}/answers` +
    `?order=desc&sort=votes&site=${site}&filter=withbody&pagesize=${limit}`;
  const data = await getJson(url);
  return (data.items || []).map((a) => ({
    score: a.score,
    accepted: a.is_accepted,
    date: new Date(a.creation_date * 1000).toISOString().slice(0, 10),
    text: truncate(stripHtml(a.body), 900),
  }));
}

// ---- lobste.rs — no search API; fetch a known story's comments by shortid ----
// (comments come back as a flat list with a `depth` field, not nested)
async function lobstersComments(shortid) {
  const data = await getJson(`https://lobste.rs/s/${shortid}.json`);
  const comments = (data.comments || [])
    .slice()
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, limit)
    .map((c) => ({
      author: c.commenting_user,
      score: c.score,
      depth: c.depth,
      text: truncate(stripHtml(c.comment_plain || c.comment)),
    }));
  return { title: data.title, url: data.url, score: data.score, comments };
}

// ---- Bluesky — public search API, no auth. Lower-trust signal (likes/reposts, no
// true "vote"). Also frequently blocked by IP/ASN like Reddit — best-effort only.
async function searchBluesky(query) {
  const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(query)}&limit=${limit}`;
  const data = await getJson(url);
  return (data.posts || []).map((p) => ({
    source: "bluesky",
    title: truncate(p.record?.text || "", 200),
    url: `https://bsky.app/profile/${p.author?.handle}/post/${p.uri.split("/").pop()}`,
    author: p.author?.handle,
    signal: (p.likeCount ?? 0) + (p.repostCount ?? 0),
    comments: p.replyCount ?? 0,
    date: (p.record?.createdAt || "").slice(0, 10),
  }));
}

function printSearch(results) {
  for (const r of results) {
    if (r.source === "hackernews") {
      console.log(`[HN] ${r.signal}pts, ${r.comments} comments (${r.date}) — ${r.title}`);
      console.log(`     article:    ${r.url}`);
      console.log(`     discussion: ${r.discussion}   (comments: node scout.mjs hn ${r.id})`);
    } else if (r.source === "reddit") {
      console.log(`[reddit ${r.subreddit}] score ${r.signal}, ${r.comments} comments (${r.date}) — ${r.title}`);
      console.log(`     ${r.url}   (comments: node scout.mjs reddit ${r.id} --subreddit ${r.subreddit.replace(/^r\//, "")})`);
    } else if (r.source === "bluesky") {
      console.log(`[bluesky @${r.author}] ${r.signal} likes+reposts, ${r.comments} replies (${r.date}) — ${r.title}`);
      console.log(`     ${r.url}`);
    } else {
      const acc = r.accepted ? ", accepted answer" : "";
      console.log(`[${r.source}] score ${r.signal}, ${r.answers} answers${acc} (${r.date}) — ${r.title}`);
      console.log(`     ${r.url}   (answers: node scout.mjs so ${r.id} --se-site ${r.source})`);
    }
    console.log();
  }
}

async function main() {
  if (cmd === "search") {
    const query = args[1];
    if (!query) throw new Error('usage: search "<topic>"');
    const tasks = [];
    if (sources.includes("hn")) tasks.push(searchHN(query).catch((e) => ({ error: `hackernews: ${e.message}` })));
    if (sources.includes("reddit")) tasks.push(searchReddit(query).catch((e) => ({ error: `reddit: ${e.message}` })));
    for (const s of seSites) tasks.push(searchSE(query, s).catch((e) => ({ error: `${s}: ${e.message}` })));
    if (includeBluesky) tasks.push(searchBluesky(query).catch((e) => ({ error: `bluesky: ${e.message}` })));

    const settled = await Promise.all(tasks);
    const errors = settled.filter((r) => !Array.isArray(r)).map((r) => r.error);
    const results = settled.filter(Array.isArray).flat();
    results.sort((a, b) => (b.signal ?? 0) - (a.signal ?? 0));

    if (asJson) return console.log(JSON.stringify({ results, errors }, null, 2));
    if (!results.length) {
      console.log("No results from community-vetted sources queried here.");
      console.log("Try: different phrasing, --se-site <relevant-se-site>, --bluesky, or fall back to native-web-search");
      console.log("(caveat any generic-web finding as unvetted — see SKILL.md).");
    }
    printSearch(results);
    for (const e of errors) console.error(`warning: ${e}`);
  } else if (cmd === "hn") {
    const out = await hnComments(args[1]);
    if (asJson) return console.log(JSON.stringify(out, null, 2));
    console.log(`${out.title} (${out.points}pts)\n${out.url || ""}\n`);
    out.comments.forEach((c, i) =>
      console.log(`--- comment ${i + 1} by ${c.author} (${c.replies} replies) ---\n${c.text}\n`));
  } else if (cmd === "reddit") {
    const subreddit = flag("subreddit");
    const out = await redditComments(args[1], subreddit);
    if (asJson) return console.log(JSON.stringify(out, null, 2));
    console.log(`${out.title} (score ${out.score})\n${out.url || ""}\n`);
    out.comments.forEach((c, i) =>
      console.log(`--- comment ${i + 1} by ${c.author} (score ${c.score}, ${c.replies} replies) ---\n${c.text}\n`));
  } else if (cmd === "so") {
    const site = seSites[0] || flag("se-site");
    if (!site) throw new Error("usage: so <question_id> --se-site <site>");
    const out = await soAnswers(args[1], site);
    if (asJson) return console.log(JSON.stringify(out, null, 2));
    out.forEach((a, i) =>
      console.log(`--- answer ${i + 1}: score ${a.score}${a.accepted ? " [ACCEPTED]" : ""} (${a.date}) ---\n${a.text}\n`));
  } else if (cmd === "lobsters") {
    const out = await lobstersComments(args[1]);
    if (asJson) return console.log(JSON.stringify(out, null, 2));
    console.log(`${out.title} (score ${out.score})\n${out.url || ""}\n`);
    out.comments.forEach((c, i) =>
      console.log(`--- comment ${i + 1} by ${c.author} (score ${c.score}) ---\n${c.text}\n`));
  } else {
    console.error("usage: scout.mjs search \"<topic>\" | hn <story_id> | reddit <post_id> --subreddit <sub> | so <question_id> --se-site <site> | lobsters <shortid>");
    process.exit(1);
  }
}

main().catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
