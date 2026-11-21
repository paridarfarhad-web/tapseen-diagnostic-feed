import test from "node:test";
import assert from "node:assert/strict";
import { validateDraft, deterministicRequestId } from "./import-draft.mjs";

const sample = {
  slug: "tendo-nagenda-proximity-media-2026-11-19",
  title: "تندو ناگندا رئیس جدید پروکسیمیتی مدیا شد",
  body_md: "متن آزمایشی فارسی با ذکر منبع.",
  excerpt: "خلاصه خبر",
  category: "news",
  locale: "fa",
  audience: "ir",
  seo_title: "تندو ناگندا رئیس جدید پروکسیمیتی مدیا شد",
  seo_description: "توضیح کوتاه",
  hashtags: ["#تندو_ناگندا"],
};

const sampleEn = {
  slug: "batman-one-joker-catwoman-first-appearances",
  title: "Batman #1 Introduced Joker and Catwoman Without Featuring Them on Its Cover",
  body_md: "One of the most influential superhero comics ever printed concealed its biggest historical surprise.",
  excerpt: "The landmark 1940 comic launched two defining Batman relationships.",
  category: "feature",
  locale: "en",
  audience: "com",
  seo_title: "Batman #1 Introduced Joker and Catwoman",
  seo_description: "The landmark 1940 comic launched two defining Batman relationships.",
  hashtags: [],
};

test("valid Persian draft passes", () => assert.equal(validateDraft(sample), sample));

test("valid English draft passes with locale=en and audience=com", () => {
  const res = validateDraft({ ...sampleEn });
  assert.equal(res.locale, "en");
  assert.equal(res.audience, "com");
});

test("English draft with audience=global normalizes to com", () => {
  const res = validateDraft({ ...sampleEn, audience: "global" });
  assert.equal(res.locale, "en");
  assert.equal(res.audience, "com");
});

test("publication control never allowed in payload", () =>
  assert.throws(() => validateDraft({ ...sample, status: "published" }), /Unsupported field/));

test("invalid audience or locale pairs rejected", () => {
  assert.throws(() => validateDraft({ ...sample, audience: "both" }), /Invalid locale\/audience pair/);
  assert.throws(() => validateDraft({ ...sample, audience: "com" }), /Invalid locale\/audience pair/);
  assert.throws(() => validateDraft({ ...sampleEn, audience: "ir" }), /Invalid locale\/audience pair/);
  assert.throws(() => validateDraft({ ...sampleEn, locale: "fa" }), /Invalid locale\/audience pair/);
});

test("invalid URL rejected", () =>
  assert.throws(() => validateDraft({ ...sample, cover_url: "http://example.org" }), /cover URL/));

test("idempotent request ID is deterministic and a UUID", () => {
  const a = deterministicRequestId("publish-test/articles/sample.json", sample);
  assert.equal(a, deterministicRequestId("publish-test/articles/sample.json", sample));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, deterministicRequestId("publish-test/articles/other.json", sample));
  assert.notEqual(a, deterministicRequestId("publish-test/articles-en/sample.json", sample));
});