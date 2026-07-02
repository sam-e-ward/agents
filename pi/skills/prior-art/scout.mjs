#!/usr/bin/env node
// prior-art scout — search community-vetted sources (Hacker News, Stack Exchange)
// for prior art on a software engineering problem, with vote/comment signals.
//
// Usage:
//   node scout.mjs search "<topic>" [--limit N] [--se-site site1,site2] [--json]
//   node scout.mjs hn <story_id> [--limit N]        # top-level HN comments for a story
//   node scout.mjs so <question_id> [--se-site X]   # answers for a SE question, by votes
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
const seSites = flag("se-site", "stackoverflow,softwareengineering").split(",");

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

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "pi-prior-art-scout/1.0" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

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
      points: h.points,
      comments: h.num_comments,
      date: (h.created_at || "").slice(0, 10),
    }));
}

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
    score: q.score,
    answers: q.answer_count,
    accepted: !!q.accepted_answer_id,
    date: new Date(q.creation_date * 1000).toISOString().slice(0, 10),
    tags: q.tags,
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

function printSearch(results) {
  for (const r of results) {
    if (r.source === "hackernews") {
      console.log(`[HN] ${r.points}pts, ${r.comments} comments (${r.date}) — ${r.title}`);
      console.log(`     article:    ${r.url}`);
      console.log(`     discussion: ${r.discussion}   (comments: node scout.mjs hn ${r.id})`);
    } else {
      const acc = r.accepted ? ", accepted answer" : "";
      console.log(`[${r.source}] score ${r.score}, ${r.answers} answers${acc} (${r.date}) — ${r.title}`);
      console.log(`     ${r.url}   (answers: node scout.mjs so ${r.id} --se-site ${r.source})`);
    }
    console.log();
  }
}

async function main() {
  if (cmd === "search") {
    const query = args[1];
    if (!query) throw new Error('usage: search "<topic>"');
    const tasks = [
      searchHN(query).catch((e) => ({ error: `hackernews: ${e.message}` })),
      ...seSites.map((s) => searchSE(query, s).catch((e) => ({ error: `${s}: ${e.message}` }))),
    ];
    const settled = await Promise.all(tasks);
    const errors = settled.filter((r) => !Array.isArray(r)).map((r) => r.error);
    const results = settled.filter(Array.isArray).flat();
    // Sort: SE by score, HN by points, interleaved by a rough signal metric
    results.sort((a, b) => (b.points ?? b.score * 10) - (a.points ?? a.score * 10));
    if (asJson) return console.log(JSON.stringify({ results, errors }, null, 2));
    if (!results.length) console.log("No results from vetted sources. Fall back to site-scoped or generic web search (see SKILL.md) and caveat accordingly.");
    printSearch(results);
    for (const e of errors) console.error(`warning: ${e}`);
  } else if (cmd === "hn") {
    const out = await hnComments(args[1]);
    if (asJson) return console.log(JSON.stringify(out, null, 2));
    console.log(`${out.title} (${out.points}pts)\n${out.url || ""}\n`);
    out.comments.forEach((c, i) =>
      console.log(`--- comment ${i + 1} by ${c.author} (${c.replies} replies) ---\n${c.text}\n`));
  } else if (cmd === "so") {
    const site = seSites[0];
    const out = await soAnswers(args[1], site);
    if (asJson) return console.log(JSON.stringify(out, null, 2));
    out.forEach((a, i) =>
      console.log(`--- answer ${i + 1}: score ${a.score}${a.accepted ? " [ACCEPTED]" : ""} (${a.date}) ---\n${a.text}\n`));
  } else {
    console.error('usage: scout.mjs search "<topic>" | hn <story_id> | so <question_id>');
    process.exit(1);
  }
}

main().catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
