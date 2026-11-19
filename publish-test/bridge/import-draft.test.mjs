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
test("valid Persian draft passes", () => assert.equal(validateDraft(sample), sample));
test("publication control never allowed in payload", () =>
  assert.throws(() => validateDraft({ ...sample, status: "published" }), /Unsupported field/));
test("only Iranian Persian audience allowed in bridge", () =>
  assert.throws(() => validateDraft({ ...sample, audience: "both" }), /Only approved/));
test("invalid URL rejected", () =>
  assert.throws(() => validateDraft({ ...sample, cover_url: "http://example.org" }), /cover URL/));
test("idempotent request ID is deterministic and a UUID", () => {
  const a = deterministicRequestId("publish-test/articles/sample.json", sample);
  assert.equal(a, deterministicRequestId("publish-test/articles/sample.json", sample));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, deterministicRequestId("publish-test/articles/other.json", sample));
});
