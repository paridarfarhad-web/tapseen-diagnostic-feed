#!/usr/bin/env node
/**
 * TapSeen draft-only handoff. Never publishes an article.
 *
 * Usage:
 *   node publish-test/bridge/import-draft.mjs publish-test/articles/example.json
 *   TAPSEEN_DRAFT_WRITE=true ... node publish-test/bridge/import-draft.mjs publish-test/articles/example.json
 *
 * Writes through an authenticated, least-privilege TapSeen blog author's
 * Supabase Auth JWT, not service_role, SQL admin tools, or impersonation.
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FIELDS = new Set(["slug", "title", "body_md", "excerpt", "category", "locale",
  "audience", "seo_title", "seo_description", "hashtags", "cover_url",
  "tmdb_id", "tmdb_type"]);
const CATEGORIES = new Set(["movies", "series", "animation", "documentary",
  "entertainment", "news", "interviews", "feature", "trailer", "review"]);
const FILE_PATTERN = /^publish-test\/articles\/[a-z0-9][a-z0-9-]{1,110}\.json$/;

export function validateDraft(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Expected one JSON object");
  for (const key of Object.keys(value)) {
    if (!FIELDS.has(key)) throw Error("Unsupported field: " + key);
  }
  for (const key of ["slug", "title", "body_md", "excerpt", "category", "locale",
      "audience", "seo_title", "seo_description"]) {
    if (typeof value[key] !== "string") throw Error("Missing or invalid " + key);
  }
  if (!/^[a-z0-9][a-z0-9-]{1,119}$/.test(value.slug)) throw Error("Invalid slug");
  if (!value.title.trim() || value.title.length > 200 ||
      !value.body_md.trim() || value.body_md.length > 100000) throw Error("Invalid title/body length");
  if (value.excerpt.length > 400 || value.seo_title.length > 70 ||
      value.seo_description.length > 160) throw Error("SEO or excerpt too long");
  if (value.locale !== "fa" || value.audience !== "ir" ||
      !CATEGORIES.has(value.category)) throw Error("Only approved Persian ir blog categories");
  if (!Array.isArray(value.hashtags) || value.hashtags.length > 20 ||
      !value.hashtags.every(tag => typeof tag === "string" &&
        /^#[\p{L}\p{N}_]{1,40}$/u.test(tag))) throw Error("Invalid hashtags");
  if (value.cover_url !== undefined && value.cover_url !== null &&
      (typeof value.cover_url !== "string" || !/^https:\/\/\S+$/i.test(value.cover_url)))
    throw Error("Invalid cover URL");
  if ((value.tmdb_id === undefined) !== (value.tmdb_type === undefined)) throw Error("Incomplete TMDB pair");
  if (value.tmdb_id !== undefined && (!/^[1-9][0-9]*$/.test(String(value.tmdb_id)) ||
      !["movie", "tv"].includes(value.tmdb_type))) throw Error("Invalid TMDB pair");
  return value;
}

export function deterministicRequestId(filePath, draft) {
  const digest = createHash("sha256").update(filePath).update("\n")
    .update(JSON.stringify(draft)).digest("hex").split("");
  digest[12] = "5";
  digest[16] = "89ab"[parseInt(digest[16], 16) % 4];
  const s = digest.slice(0, 32).join("");
  return [s.slice(0, 8), s.slice(8, 12), s.slice(12, 16), s.slice(16, 20), s.slice(20, 32)].join("-");
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw Error("Missing environment configuration: " + name);
  return value;
}

async function postJSON(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST", redirect: "error",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  // Do not echo remote body, auth tokens or credentials into action logs.
  if (!response.ok) throw Error("Remote draft API returned HTTP " + response.status);
  return await response.json();
}

export async function run(filePath) {
  if (!FILE_PATTERN.test(filePath)) throw Error("File must be under publish-test/articles/");
  const raw = await readFile(resolve(process.cwd(), filePath), "utf8");
  if (raw.length > 120000) throw Error("Article file too large");
  const draft = validateDraft(JSON.parse(raw));
  const requestId = deterministicRequestId(filePath, draft);
  if (process.env.TAPSEEN_DRAFT_WRITE !== "true") {
    console.log(JSON.stringify({ mode: "dry-run", valid: true, file: filePath,
      slug: draft.slug, request_id: requestId, publication_enabled: false }));
    return;
  }
  const origin = requireEnv("TAPSEEN_SUPABASE_URL");
  if (!/^https:\/\//.test(origin) || new URL(origin).username || new URL(origin).password)
    throw Error("Invalid HTTPS Supabase origin");
  const base = origin.replace(/\/+$/, "");
  const apiKey = requireEnv("TAPSEEN_SUPABASE_PUBLISHABLE_KEY");
  const email = requireEnv("TAPSEEN_BLOG_AUTHOR_EMAIL");
  const password = requireEnv("TAPSEEN_BLOG_AUTHOR_PASSWORD");
  const auth = await postJSON(base + "/auth/v1/token?grant_type=password",
    { email, password }, { apikey: apiKey });
  if (!auth.access_token || typeof auth.access_token !== "string")
    throw Error("Supabase author login failed");
  const result = await postJSON(base + "/rest/v1/rpc/blog_submit_handoff_draft",
    { p_request_id: requestId, p_payload: draft, p_post_id: null,
      p_expected_updated_at: null },
    { apikey: apiKey, authorization: "Bearer " + auth.access_token });
  if (result.status === "discarded") {
    console.log(JSON.stringify({ mode: "draft-discarded", slug: draft.slug,
      reason: "tombstoned", publication_enabled: false }));
    return;
  }
  if (result.status !== "draft" || !result.post_id || result.slug !== draft.slug)
    throw Error("Unexpected draft creation response");
  console.log(JSON.stringify({ mode: "draft-created", slug: result.slug,
    post_id: result.post_id, status: "draft", publication_enabled: false }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(process.argv[2] || "").catch(error => {
    console.error("Draft handoff failed: " + error.message);
    process.exitCode = 1;
  });
}
