import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const PRIMARY_API = "https://tapseen.com/api/news/feed.json?limit=50";
const FALLBACK_API = "https://tapseen.ir/api/news/feed.json?limit=50";
const MAX_ARTICLES = 50;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

async function fetchWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
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

function cleanHtml(text) {
  if (!text) return "";
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;|&#8217;|&#x2019;/g, "'")
    .replace(/&#x201C;|&#x201D;|&ldquo;|&rdquo;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function extractSourceArticleText(sourceSlug, url) {
  if (!url || !url.startsWith("http")) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) return null;
    const html = await res.text();

    let paragraphs = [];

    if (sourceSlug === "cinemablend") {
      const elkMatches = [...html.matchAll(/<p[^>]+id=["']elk-[^"']*["'][^>]*>(.*?)<\/p>/gis)];
      if (elkMatches.length > 0) {
        paragraphs = elkMatches
          .map((m) => cleanHtml(m[1]))
          .filter((p) => p.length > 30 && !p.startsWith("Image credit") && !p.includes("newsletter"));
      }
      if (paragraphs.length < 3) {
        const allP = [...html.matchAll(/<p[^>]*>(.*?)<\/p>/gis)];
        const candidateP = allP.map((m) => cleanHtml(m[1])).filter((p) => {
          return (
            p.length > 50 &&
            !p.includes("Privacy Policy") &&
            !p.includes("Cookies") &&
            !p.includes("membership") &&
            !p.includes("affiliate commission") &&
            !p.includes("confirm you are aged") &&
            !p.includes("display name before commenting") &&
            !p.startsWith("By submitting")
          );
        });
        if (candidateP.length > paragraphs.length) {
          paragraphs = candidateP;
        }
      }
    } else if (sourceSlug === "comicbook" || sourceSlug === "cbr") {
      const articleMatch =
        html.match(/<article[^>]*>(.*?)<\/article>/is) ||
        html.match(/<div[^>]+class=["'][^"']*article-body[^"']*["'][^>]*>(.*?)<\/div>/is) ||
        html.match(/<div[^>]+class=["'][^"']*article-content[^"']*["'][^>]*>(.*?)<\/div>/is);
      const searchIn = articleMatch ? articleMatch[1] : html;
      paragraphs = [...searchIn.matchAll(/<p[^>]*>(.*?)<\/p>/gis)]
        .map((m) => cleanHtml(m[1]))
        .filter(
          (p) =>
            p.length > 30 &&
            !p.startsWith("Share on") &&
            !p.startsWith("Image Courtesy") &&
            !p.startsWith("Add Us On") &&
            !p.includes("Disclosure:") &&
            !p.includes("newsletter")
        );
    } else if (sourceSlug === "theplaylist") {
      const entryMatch = html.match(/<div[^>]+class=["'][^"']*entry-content[^"']*["'][^>]*>(.*?)<\/div>/is);
      const searchIn = entryMatch ? entryMatch[1] : html;
      paragraphs = [...searchIn.matchAll(/<p[^>]*>(.*?)<\/p>/gis)]
        .map((m) => cleanHtml(m[1]))
        .filter((p) => p.length > 30 && !p.startsWith("READ MORE") && !p.startsWith("Continue reading"));
    } else {
      // PMC sites: Deadline, Variety, The Hollywood Reporter
      const larvaMatches = [...html.matchAll(/<p class=["']paragraph larva[^"']*["'][^>]*>(.*?)<\/p>/gis)];
      if (larvaMatches.length > 0) {
        paragraphs = larvaMatches
          .map((m) => cleanHtml(m[1]))
          .filter(
            (p) =>
              p.length > 30 &&
              !p.startsWith("Must Read") &&
              !p.startsWith("Watch on") &&
              !p.startsWith("RELATED:")
          );
      }
      if (paragraphs.length === 0) {
        const articleMatch =
          html.match(/<article[^>]*>(.*?)<\/article>/is) ||
          html.match(/<div[^>]+class=["'][^"']*a-content[^"']*["'][^>]*>(.*?)<\/div>/is);
        const searchIn = articleMatch ? articleMatch[1] : html;
        paragraphs = [...searchIn.matchAll(/<p[^>]*>(.*?)<\/p>/gis)]
          .map((m) => cleanHtml(m[1]))
          .filter((p) => p.length > 35 && !p.includes("copyright") && !p.includes("newsletter"));
      }
    }

    if (paragraphs.length > 0) {
      return paragraphs.join("\n\n");
    }

    return null;
  } catch {
    return null;
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
  const itemsXml = articles
    .map((a) => {
      return `    <item>
      <title>${escapeXml(a.title)}</title>
      <link>${escapeXml(a.source_url)}</link>
      <guid isPermaLink="false">${escapeXml(a.id)}</guid>
      <pubDate>${formatRfc822(a.published_at)}</pubDate>
      <source url="${escapeXml(a.source_url)}">${escapeXml(a.source)}</source>
      <description>${escapeXml(a.summary)}</description>
    </item>`;
    })
    .join("\n");

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
    text += `============================================================\n`;
    text += `[${idx + 1}] ${a.title}\n`;
    text += `Source: ${a.source} | Status: ${a.content_status} | Words: ${a.word_count}\n`;
    text += `Published: ${a.published_at}\n`;
    text += `URL: ${a.source_url}\n`;
    text += `------------------------------------------------------------\n`;
    text += `SUMMARY:\n${a.summary || "(No summary available)"}\n\n`;
    text += `CONTENT / EXTRACTED DETAILS:\n${a.content || "(No expanded content available)"}\n\n`;
  });

  return text;
}

function computeArticlesHash(articles) {
  const simple = articles
    .map((a) => `${a.id}|${a.title}|${a.source_url}|${a.content_status}|${a.word_count}`)
    .join("\n");
  return crypto.createHash("sha256").update(simple, "utf8").digest("hex");
}

async function main() {
  const rootDir = process.cwd();
  const feedJsonPath = path.join(rootDir, "feed.json");
  const feedTxtPath = path.join(rootDir, "feed.txt");
  const feedXmlPath = path.join(rootDir, "feed.xml");

  console.log(`[sync] Starting TapSeen feed synchronization...`);
  const rawItems = await loadRawNews();

  // Load existing feed to avoid re-extracting articles that are already enriched
  const existingArticlesMap = new Map();
  if (fs.existsSync(feedJsonPath)) {
    try {
      const oldJson = JSON.parse(fs.readFileSync(feedJsonPath, "utf8"));
      if (Array.isArray(oldJson.articles)) {
        for (const art of oldJson.articles) {
          if (art.id) existingArticlesMap.set(art.id, art);
        }
      }
    } catch {}
  }

  // Deduplicate and process items
  const seenIds = new Set();
  const seenUrls = new Set();
  const candidateArticles = [];

  for (const raw of rawItems) {
    if (!raw.title || !raw.id) continue;
    if (seenIds.has(raw.id)) continue;

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

    candidateArticles.push(raw);
  }

  // Sort descending by published_at
  candidateArticles.sort(
    (a, b) =>
      new Date(b.publishedAt || b.published_at).getTime() -
      new Date(a.publishedAt || a.published_at).getTime()
  );

  const top50 = candidateArticles.slice(0, MAX_ARTICLES);
  console.log(`[sync] Processing ${top50.length} articles for full content enrichment...`);

  const finalArticles = [];

  for (let i = 0; i < top50.length; i++) {
    const raw = top50[i];
    const sourceSlug = (raw.source?.slug || raw.source || "unknown").toLowerCase();
    const sourceName = raw.source?.name || raw.source || "TapSeen";
    const canonicalUrl = raw.url || raw.source_url || "";
    const summaryText = cleanHtml(raw.summary || "");

    // Check if we already have an enriched version
    const cached = existingArticlesMap.get(raw.id);
    let contentText = "";
    let contentStatus = "summary_only";
    let extractedAt = raw.updated_at || raw.discovered_at || raw.published_at || new Date().toISOString();

    if (raw.content && raw.content.trim().length > 80) {
      contentText = raw.content.trim();
      contentStatus = raw.content_status || "expanded";
    } else if (cached && cached.content && cached.content.length > 80) {
      contentText = cached.content;
      contentStatus = cached.content_status || "expanded";
      extractedAt = cached.extracted_at || extractedAt;
    } else {
      // Attempt live extraction from source
      console.log(`[sync] Enriching article (${i + 1}/${top50.length}): [${sourceSlug}] ${raw.title.slice(0, 50)}...`);
      const extracted = await extractSourceArticleText(sourceSlug, canonicalUrl);
      if (extracted && extracted.length > 80) {
        contentText = extracted;
        contentStatus = "expanded";
        extractedAt = new Date().toISOString();
      } else {
        contentText = summaryText;
        contentStatus = "summary_only";
      }
      // Polite delay between extraction requests
      await new Promise((r) => setTimeout(r, 150));
    }

    const wordCount = contentText.split(/\s+/).filter(Boolean).length;

    finalArticles.push({
      id: String(raw.id),
      title: cleanHtml(raw.title),
      summary: summaryText,
      content: contentText,
      source: sourceName,
      source_url: canonicalUrl,
      published_at: String(raw.publishedAt || raw.published_at || new Date().toISOString()),
      image_url: raw.imageUrl || raw.image_url || null,
      language: "en",
      content_status: contentStatus,
      word_count: wordCount,
      extracted_at: extractedAt,
      updated_at: extractedAt,
    });
  }

  const newHash = computeArticlesHash(finalArticles);

  let existingHash = "";
  if (fs.existsSync(feedJsonPath)) {
    try {
      const oldJson = JSON.parse(fs.readFileSync(feedJsonPath, "utf8"));
      if (Array.isArray(oldJson.articles)) {
        existingHash = computeArticlesHash(oldJson.articles);
      }
    } catch {}
  }

  if (existingHash && existingHash === newHash) {
    console.log(`[sync] Content hash matches existing feed (${newHash}). No changes needed.`);
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, "has_changes=false\n");
    }
    return;
  }

  console.log(`[sync] Updating feed files with ${finalArticles.length} enriched articles...`);

  const updatedFeedJson = {
    feed: {
      title: "TapSeen News - ChatGPT Feed",
      description: "Auto-synced latest 50 verified cinema & entertainment news articles with full context for TapSeen & ChatGPT",
      home_page_url: "https://tapseen.com",
      feed_url: "https://paridarfarhad-web.github.io/tapseen-diagnostic-feed/feed.json",
      count: finalArticles.length,
      updated_at: new Date().toISOString(),
    },
    articles: finalArticles,
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

main().catch((err) => {
  console.error(`[sync ERROR]:`, err);
  process.exit(1);
});
