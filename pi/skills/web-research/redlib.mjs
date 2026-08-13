#!/usr/bin/env node
// redlib.mjs — resilient Reddit access via the Redlib front-end ecosystem.
//
// Reddit's own JSON API and web UI aggressively block datacenter/cloud IPs with
// a 403, and the usual reader proxies (r.jina.ai etc.) are blocked the same way
// because they also sit on datacenter IPs. Redlib instances are independently
// hosted front-ends; some run on networks Reddit hasn't blocked, and they serve
// plain HTML that is parseable with no auth and no API key.
//
// This module:
//   1. Fetches the official, machine-readable instance list (github raw JSON).
//   2. Probes instances in parallel and keeps the ones that serve real content
//      (rejecting 403s, and JS challenge pages like Anubis / Cloudflare).
//   3. Provides `search()` and `comments()` with the same shape as scout.mjs's
//      direct-Reddit functions, so it can be dropped in as a fallback.
//
// No dependencies. Node >= 18 (global fetch, AbortController).
//
// Usage:
//   node redlib.mjs probe                              # list working instances
//   node redlib.mjs search "<topic>" [--subreddit <s>] [--limit N] [--json]
//   node redlib.mjs comments <post_id> --subreddit <s> [--limit N] [--json]

const INSTANCES_URL =
  "https://raw.githubusercontent.com/redlib-org/redlib-instances/main/instances.json";

const UA = "pi-web-research-redlib/1.0 (+https://github.com/earendil-works/pi)";

// ---------------------------------------------------------------- helpers

function match1(html, re) {
  const m = html.match(re);
  return m ? m[1] : null;
}

function stripHtml(html) {
  return (html || "")
    .replace(/<pre><code>[\s\S]*?<\/code><\/pre>/g, " [code block] ")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/").replace(/&nbsp;/g, " ").replace(/\s+/g, " ")
    .trim();
}

function truncate(s, n = 600) {
  return s.length > n ? s.slice(0, n) + " …[truncated]" : s;
}

function parseNum(s) {
  const n = parseInt((s || "").replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------- instances

export async function fetchInstances() {
  const res = await fetch(INSTANCES_URL, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`instance list ${res.status} for ${INSTANCES_URL}`);
  const data = await res.json();
  return (data.instances || [])
    .map((i) => i.url)
    .filter((u) => u && u.startsWith("https://"));
}

// Anubis ("Making sure you're not a bot!"), Cloudflare ("Just a moment...") and
// other JS challenges all return HTTP 200 but with a challenge body. Detect them
// by title/marker so we don't mistake them for working instances.
const CHALLENGE_MARKERS = /making sure you'?re not a bot|just a moment|attention required|cf-browser-verification|checking your browser/i;

export async function probeInstances(timeoutMs = 6000) {
  const urls = await fetchInstances();
  const results = await Promise.all(
    urls.map(async (url) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url + "/", {
          signal: ctrl.signal,
          redirect: "follow",
          headers: { "User-Agent": UA },
        });
        const text = await res.text();
        const challenged = CHALLENGE_MARKERS.test(text.slice(0, 4000));
        // A real redlib page links to /r/... or carries its own settings UI.
        const looksReal = /href="\/(r|u|settings|search)/i.test(text);
        return { url, ok: res.ok && looksReal && !challenged };
      } catch {
        return { url, ok: false };
      } finally {
        clearTimeout(t);
      }
    })
  );
  return results.filter((r) => r.ok).map((r) => r.url);
}

let cachedInstances = null;

async function getWorkingInstances() {
  if (!cachedInstances) {
    cachedInstances = await probeInstances();
  }
  return cachedInstances;
}

async function fetchOne(instance, path, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(instance + path, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": UA },
    });
    const text = await res.text();
    if (!res.ok || CHALLENGE_MARKERS.test(text.slice(0, 4000))) {
      throw new Error(`${instance} blocked for ${path} (HTTP ${res.status})`);
    }
    return { html: text, instance };
  } finally {
    clearTimeout(t);
  }
}

async function fetchRedlib(path, timeoutMs = 15000) {
  const instances = await getWorkingInstances();
  let lastErr = null;
  for (const instance of instances) {
    try {
      return await fetchOne(instance, path, timeoutMs);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("no working Redlib instance found (all blocked or challenged)");
}

// ---------------------------------------------------------------- parsing

function parsePosts(html, instance) {
  const posts = [];
  const segments = html.split('<div class="post"');
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const m = seg.match(/<h2 class="post_title">[\s\S]*?<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!m) continue;
    const href = m[1];
    const idMatch = href.match(/comments\/([a-z0-9]+)\//);
    if (!idMatch) continue; // flair/search links aren't real posts
    const subreddit = match1(seg, /class="post_subreddit"[^>]*>([^<]+)/)?.trim();
    posts.push({
      source: "reddit",
      title: stripHtml(m[2]),
      url: `https://www.reddit.com${href}`,
      mirror: `${instance}${href}`,
      subreddit: subreddit || null,
      id: idMatch ? idMatch[1] : null,
      signal: parseNum(match1(seg, /class="post_score"[^>]*title="(\d+)"/)) ?? 0,
      comments: parseNum(match1(seg, /class="post_comments"[^>]*title="([^"]+)/)) ?? 0,
      date: match1(seg, /class="created"[^>]*title="([^"]+)"/),
      via: "redlib",
    });
  }
  return posts;
}

function parseComments(html, instance) {
  // Title: the text of the h1, excluding the flair badge <a> that precedes it.
  const h1 = match1(html, /<h1 class="post_title">([\s\S]*?)<\/h1>/);
  const title = h1
    ? stripHtml(h1.replace(/<a\s+[^>]*class="post_flair"[^>]*>[\s\S]*?<\/a>/g, " "))
    : null;
  // Canonical path from og:url (relative), used for both reddit.com and the mirror.
  const urlPath = match1(html, /<meta property="og:url" content="([^"]+)"/);
  const score = parseNum(match1(html, /<div class="post_score"[^>]*title="(\d+)"/));

  // Depth tracking: nested replies live inside <blockquote class="replies">.
  // Plain <blockquote> (a quote inside a comment body) is rare and self-balanced,
  // so counting only the replies-class openers against </blockquote> closers
  // yields correct depths for all but pathological cases.
  const depths = [];
  let stack = 0;
  for (const t of html.matchAll(/<blockquote class="replies">|<\/blockquote>|<div class="comment_left">/g)) {
    if (t[0] === '<blockquote class="replies">') stack++;
    else if (t[0] === "</blockquote>") stack = Math.max(0, stack - 1);
    else depths.push(stack);
  }

  const segments = html.split('<div class="comment_left">').slice(1);
  const comments = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const depth = depths[i] ?? 0;
    const scoreRaw = match1(seg, /<p class="comment_score"[^>]*title="([^"]+)"/);
    const author = match1(seg, /<a class="comment_author[^"]*"[^>]*>([^<]+)<\/a>/)?.trim()?.replace(/^u\//, "");
    const bodyStart = seg.indexOf('<div class="comment_body');
    const repliesIdx = seg.indexOf('<blockquote class="replies">');
    const bodyHtml = seg.slice(
      bodyStart === -1 ? 0 : bodyStart,
      repliesIdx === -1 ? seg.length : repliesIdx
    );
    comments.push({
      author: author || "[deleted]",
      score: scoreRaw === "Hidden" ? null : parseNum(scoreRaw),
      depth,
      replies: 0, // filled in below from the depth map
      text: truncate(stripHtml(bodyHtml)),
    });
  }

  // A comment's reply count is how many later comments sit directly one level deeper.
  for (let i = 0; i < comments.length; i++) {
    const d = comments[i].depth;
    let j = i + 1;
    while (j < comments.length && comments[j].depth > d) {
      if (comments[j].depth === d + 1) comments[i].replies++;
      j++;
    }
  }

  const top = comments.filter((c) => c.depth === 0).slice(0, 100);
  return {
    title: stripHtml(title),
    url: urlPath ? `https://www.reddit.com${urlPath}` : null,
    mirror: urlPath ? `${instance}${urlPath}` : null,
    score,
    via: "redlib",
    comments: top,
  };
}

// ---------------------------------------------------------------- public API

export async function search(query, { subreddit = null, limit = 10 } = {}) {
  const scope = subreddit ? `/r/${subreddit}` : "";
  const restrict = subreddit ? "&restrict_sr=on" : "";
  const path =
    `${scope}/search?q=${encodeURIComponent(query)}` +
    `&sort=relevance&t=year${restrict}&limit=${limit}`;
  const { html, instance } = await fetchRedlib(path);
  return parsePosts(html, instance).slice(0, limit);
}

export async function comments(postId, subreddit, limit = 10) {
  if (!subreddit) throw new Error("redlib comments require a subreddit");
  const { html, instance } = await fetchRedlib(`/r/${subreddit}/comments/${postId}/`);
  const out = parseComments(html, instance);
  out.comments = out.comments.slice(0, limit);
  return out;
}

// ---------------------------------------------------------------- CLI

const args = process.argv.slice(2);
const cmd = args[0];
const asJson = args.includes("--json");
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const limit = parseInt(flag("limit", "10"), 10);

async function cli() {
  if (cmd === "probe") {
    const urls = await probeInstances();
    if (asJson) return console.log(JSON.stringify(urls, null, 2));
    if (!urls.length) console.log("no working instances");
    for (const u of urls) console.log(u);
  } else if (cmd === "search") {
    const query = args[1];
    if (!query) throw new Error('usage: search "<topic>" [--subreddit <s>]');
    const results = await search(query, { subreddit: flag("subreddit"), limit });
    if (asJson) return console.log(JSON.stringify(results, null, 2));
    for (const r of results) {
      console.log(`[reddit${r.subreddit ? " " + r.subreddit : ""}] score ${r.signal}, ${r.comments} comments — ${r.title}`);
      console.log(`     ${r.url}   (mirror: ${r.mirror})`);
    }
  } else if (cmd === "comments") {
    const subreddit = flag("subreddit");
    const out = await comments(args[1], subreddit, limit);
    if (asJson) return console.log(JSON.stringify(out, null, 2));
    console.log(`${out.title} (score ${out.score})\n${out.url || ""}\n`);
    out.comments.forEach((c, i) =>
      console.log(`--- comment ${i + 1} by ${c.author} (score ${c.score}, ${c.replies} replies) ---\n${c.text}\n`));
  } else {
    console.error("usage: redlib.mjs probe | search \"<topic>\" [--subreddit <s>] | comments <post_id> --subreddit <s>");
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli().catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
}
