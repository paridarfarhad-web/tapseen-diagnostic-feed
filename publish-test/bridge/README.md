# ChatGPT Plus → GitHub → TapSeen blog draft bridge

**Current state: manual test only. No article is auto-published.**

The scheduled ChatGPT Plus task writes content-only JSON under
`publish-test/articles/`. A manually dispatched GitHub Actions workflow validates
the JSON and, only when explicitly opted in, creates a **draft** in the existing
TapSeen blog with a dedicated writer's real Supabase Auth session.

## Existing backend contract (tapseen2)

- RPC: `public.blog_submit_handoff_draft(p_request_id uuid, p_payload jsonb, p_post_id uuid, p_expected_updated_at timestamptz)`
- Migration: `supabase/migrations/20261023183542_blog_draft_handoff.sql`
- Only `auth.uid()` with `can_write_blog(auth.uid())` can write.
- Always inserts `status=draft`; cannot publish, feature, or change author.
- Request UUID is idempotent, duplicate slugs fail, max 20 handoffs per hour per writer.
- The migration must be deployed in the target environment before an authenticated test; its presence in GitHub does not prove deployment.

## 1. Dry run (no credentials)

In GitHub, open Actions → **TapSeen draft-only bridge (test)** → Run workflow.
Leave `apply_draft = false`. The action runs unit tests, then checks the
sample article. No requests to TapSeen or Supabase occur.

You can also run:
- `node --test publish-test/bridge/import-draft.test.mjs`
- `node publish-test/bridge/import-draft.mjs publish-test/articles/tendo-nagenda-proximity-media-2026-11-19.json`

## 2. Separate least-privilege author account

Provision a **dedicated email/password writer account** via the normal TapSeen
account management flow. Grant only `profiles.blog_author` (or the existing
equivalent capability granted by `can_write_blog`); do not make it admin.
Use the scoped login only for blog draft imports. Disable/revoke the author
when terminating the integration. Confirm password login is permitted in the
target Supabase Auth deployment. Use a staging environment first, if available.

Create GitHub Actions environment **tapseen-draft-writer**. Protect it with
required reviewers where supported; do not place credentials in the repo,
article JSON, ChatGPT prompt, or workflow file.

Configure these environment secrets:

- `TAPSEEN_SUPABASE_URL` — HTTPS origin for the authorized target environment
- `TAPSEEN_SUPABASE_PUBLISHABLE_KEY` — anon/publishable key (not service_role)
- `TAPSEEN_BLOG_AUTHOR_EMAIL` — dedicated author login
- `TAPSEEN_BLOG_AUTHOR_PASSWORD` — dedicated author password

There is intentionally no service_role, direct SQL, developer Supabase
connector write, or untrusted `author_id` field. The script uses the author
JWT from `/auth/v1/token?grant_type=password` to call
`/rest/v1/rpc/blog_submit_handoff_draft`.

## 3. Test a real draft (never publish)

After confirming the RPC exists and the dedicated account has permission,
dispatch the workflow with:

- `article_path = publish-test/articles/tendo-nagenda-proximity-media-2026-11-19.json`
- `apply_draft = true`
- `confirmation = DRAFT_ONLY`

The environment protection may request review. Successful output is a
`post_id`, `slug`, `status=draft`. Inspect it in the TapSeen admin blog editor.
Repeated executions with the same unchanged file reuse the deterministic
request ID; a changed body needs a new slug and path.

## Safeguards

- Workflow currently uses `workflow_dispatch` only: no scheduled writes
  can automatically start the authenticated job.
- File path must match `publish-test/articles/<slug>.json`; no traversal.
- Payload has strict allowlisted fields. `status`, `author_id`, `published_at`,
  and `is_featured` are rejected.
- Only `locale=fa` and `audience=ir` are enabled during testing.
- GitHub Actions GITHUB_TOKEN permission is `contents:read`.
- Avoid secrets in logs; never echo auth responses.
- If auth, RPC, permissions, or deployment fail, stop. Do not escalate to
  SQL admin credentials or bypass the author session.

## Not yet implemented

Automatic event-based dispatch, content queue, publication on the live site,
image upload, and monitoring/retry are intentionally not enabled. Enable these
only after a successful no-secrets dry run and reviewed draft-creation test.
