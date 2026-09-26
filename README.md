# Generic AI Phone Line — Gemini Audio

This package is a sanitized generic version of the AI phone-line architecture.

Core flow:
Yemot recording -> raw audio -> Gemini -> answer -> Yemot/TTS playback.

There are no personal phone numbers, passwords, API keys, tokens, personal repository URLs, or personal Render URLs in this package.

Set the values in `.env` / Render Environment Variables before deployment.


## Security hardening

The server now applies:
- HTTP security headers and disables Express fingerprinting.
- Conservative JSON/form request-size limits.
- Rate limiting for the dashboard API and Yemot entry point.
- Bearer-token protection for `/api/conversations` using `DASHBOARD_ACCESS_TOKEN`.
- Safe error messages for Supabase and Yemot automatic setup.
- HTTPS-only validation for `PUBLIC_BASE_URL`.
- Supabase RLS for the conversations table; the server should use a Supabase service-role key.

Before production use:
1. Rotate any credentials that were previously exposed.
2. Set a strong `DASHBOARD_ACCESS_TOKEN` in Render; do not commit it.
3. Set valid Yemot credentials/API token in Render and verify the automatic IVR update.
4. If Supabase is enabled, run `supabase.sql` and use the server-side service-role key.
5. Generate and commit a `package-lock.json`, then run `npm audit` and resolve remaining high/critical findings before treating the dependency supply chain as clean.
