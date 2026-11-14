import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const PRIMARY_API = "https://tapseen.com/api/news/feed.json?limit=50";
const FALLBACK_API = "https://tapseen.ir/api/news/feed.json?limit=50";
const MAX_ARTICLES = 50;

async function fetchWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "TapSeen-FeedSync/1.0 (+https://github.com/paridarfarhad-web/tapseen-diagnostic-feed)",
        "Accept": "application/json",
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadRawNews() {
  try {
    console.log(`[sync] Fetching from primary API: ${PRIMARY_API}`);
    const data = await fetchWithTimeout(PRIMARY_API);
    if (data?.items && Array.isArray(data.items) && data.items.length > 0) {
      console.log(`[sync] Received ${data.items.length} items from primary API.`);
      return data.items;
    }
    throw new Error("Invalid payload or empty items array from primary API");
  } catch (err) {
    console.warn(`[sync] Primary API failed: ${err.message}. Trying fallback API: ${FALLBACK_API}`);
    const data = await fetchWithTimeout(FALLBACK_API);
    if (data?.items && Array.isArray(data.items) && data.items.length > 0) {
      console.log(`[sync] Received ${data.items.length} items from fallback API.`);
      return data.items;
    }
    throw new Error("Both primary and fallback APIs failed to return news items.");
  }
}

function escapeXml(unsafe) {
  if (!unsafe) return "";
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatRfc822(dateStr) {
  try {
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? new Date().toUTCString() : d.toUTCString();
  } catch {
    return new Date().toUTCString();
  }
}

function generateRssXml(articles) {
  const now = new Date().toUTCString();
  const itemsXml = articles.map(a => {
    return `    <item>
      <title>${escapeXml(a.title)}</title>
      <link>${escapeXml(a.source_url)}</link>
      <guid isPermaLink="false">${escapeXml(a.id)}</guid>
      <pubDate>${formatRfc822(a.published_at)}</pubDate>
      <source url="${escapeXml(a.source_url)}">${escapeXml(a.source)}</source>
      <description>${escapeXml(a.summary)}</description>
    </item>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>TapSeen News Feed</title>
    <link>https://tapseen.com</link>
    <description>Latest 50 verified cinema and TV news articles aggregated by TapSeen.</description>
    <language>en</language>
    <lastBuildDate>${now}</lastBuildDate>
${itemsXml}
  </channel>
</rss>
`;
}

function generatePlainText(articles) {
  const now = new Date().toISOString();
  let text = `# TapSeen Verified News Feed (Latest ${articles.length} Articles)\n`;
  text += `Last Updated: ${now}\n`;
  text += `Website: https://tapseen.com\n\n`;

  articles.forEach((a, idx) => {
    text += `------------------------------------------------------------\n`;
    text += `${idx + 1}. ${a.title}\n`;
    text += `Source: ${a.source}\n`;
    text += `Published: ${a.published_at}\n`;
    text += `URL: ${a.source_url}\n`;
    text += `Summary:\n${a.summary || "(No summary available)"}\n`;
    if (a.content && a.content !== a.summary) {
      text += `\nFull Content:\n${a.content}\n`;
    }
    text += `\n`;
  });

  return text;
}

function computeArticlesHash(articles) {
  const simple = articles.map(a => `${a.id}|${a.title}|${a.source_url}|${a.published_at}`).join("\n");
  return crypto.createHash("sha256").update(simple, "utf8").digest("hex");
}

async function main() {
  const rootDir = process.cwd();
  const feedJsonPath = path.join(rootDir, "feed.json");
  const feedTxtPath = path.join(rootDir, "feed.txt");
  const feedXmlPath = path.join(rootDir, "feed.xml");

  console.log(`[sync] Starting TapSeen feed synchronization...`);
  const rawItems = await loadRawNews();

  // Deduplicate and sanitize
  const seenIds = new Set();
  const seenUrls = new Set();
  const validArticles = [];

  for (const raw of rawItems) {
    if (!raw.title || !raw.id) continue;
    if (seenIds.has(raw.id)) continue;
    
    // Normalize URL
    let normUrl = "";
    try {
      const u = new URL(raw.url || raw.source_url);
      u.search = "";
      u.hash = "";
      normUrl = u.toString().toLowerCase().replace(/\/+$/, "");
    } catch {
      normUrl = String(raw.url || raw.source_url || "").toLowerCase();
    }

    if (normUrl && seenUrls.has(normUrl)) continue;
    seenIds.add(raw.id);
    if (normUrl) seenUrls.add(normUrl);

    validArticles.push({
      id: String(raw.id),
      title: String(raw.title).trim(),
      summary: String(raw.summary || "").trim(),
      content: String(raw.content || raw.summary || "").trim(),
      source: String(raw.source?.name || raw.source || "TapSeen").trim(),
      source_url: String(raw.url || raw.source_url || "").trim(),
      published_at: String(raw.publishedAt || raw.published_at || new Date().toISOString()),
      image_url: raw.imageUrl || raw.image_url || null,
      language: "en",
      updated_at: String(raw.updatedAt || raw.discoveredAt || raw.publishedAt || new Date().toISOString())
    });
  }

  // Sort descending by published_at
  validArticles.sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());
  const finalArticles = validArticles.slice(0, MAX_ARTICLES);

  console.log(`[sync] Processed ${finalArticles.length} unique sorted articles.`);

  const newHash = computeArticlesHash(finalArticles);

  // Check existing hash
  let existingHash = "";
  if (fs.existsSync(feedJsonPath)) {
    try {
      const oldJson = JSON.parse(fs.readFileSync(feedJsonPath, "utf8"));
      if (Array.isArray(oldJson.articles)) {
        existingHash = computeArticlesHash(oldJson.articles);
      }
    } catch {
      // Ignore parse error on old file
    }
  }

  if (existingHash && existingHash === newHash) {
    console.log(`[sync] Content hash matches existing feed (${newHash}). No changes needed.`);
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, "has_changes=false\n");
    }
    return;
  }

  console.log(`[sync] New articles detected (Old: ${existingHash || "none"}, New: ${newHash}). Updating feeds...`);

  const updatedFeedJson = {
    feed: {
      title: "TapSeen News - ChatGPT Feed",
      description: "Auto-synced latest 50 verified cinema & entertainment news articles for TapSeen & ChatGPT",
      home_page_url: "https://tapseen.com",
      feed_url: "https://paridarfarhad-web.github.io/tapseen-diagnostic-feed/feed.json",
      count: finalArticles.length,
      updated_at: new Date().toISOString()
    },
    articles: finalArticles
  };

  const xmlContent = generateRssXml(finalArticles);
  const textContent = generatePlainText(finalArticles);

  fs.writeFileSync(feedJsonPath, JSON.stringify(updatedFeedJson, null, 2), "utf8");
  fs.writeFileSync(feedTxtPath, textContent, "utf8");
  fs.writeFileSync(feedXmlPath, xmlContent, "utf8");

  console.log(`[sync] Successfully wrote feed.json, feed.txt, and feed.xml!`);

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, "has_changes=true\n");
  }
}

main().catch(err => {
  console.error(`[sync ERROR]:`, err);
  process.exit(1);
});
