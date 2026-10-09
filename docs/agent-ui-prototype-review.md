# Agent UI prototype review — 2026-10-09

## Safety decision
This prototype is NOT integrated into the production Yemot/Render service. It is a standalone browser application that calls provider APIs directly from the browser and stores provider API keys in localStorage. Publishing it as a production page would expose a larger client-side attack surface and would not improve the IVR's server-side web search by itself.

## Search findings
- Anthropic web search is enabled only when the search toggle is active and the selected model/account supports the specified tool.
- OpenAI search mode hardcodes `gpt-4o-search-preview`, overriding the selected model. Availability and support must be verified before use.
- Gemini search mode adds `google_search`; results and grounding metadata are not surfaced or checked by this UI.
- The UI renders model text but does not independently validate phone numbers, opening hours, dates, or official-source provenance.
- Errors are shown to the user, but a successful HTTP response with no useful text can still look like an empty answer.
- Provider keys are stored in browser localStorage. Do not use this design for production secrets or expose the page publicly without a deliberate security review.

## Recommended server-side search design
1. Keep the existing IVR branch and request flow unchanged by default.
2. Add a separate, opt-in search module on the server.
3. Classify queries that need current facts (business phone numbers, opening hours, addresses, events) and prioritize official domains for the named organization.
4. Extract source URLs, titles, snippets, and retrieval timestamps; distinguish official sources from third-party listings.
5. Answer only from retrieved evidence, cite/link the source when possible, and say clearly when an official source could not be verified.
6. For hours, ask which branch when opening times are branch-specific; never infer "open today" from generic weekly hours.
7. Add bounded timeouts, limited retries, and a fast fallback message; avoid retry loops that make phone callers wait.
8. Test search cases separately from normal branch-1 conversation and retain the production rollback point.

## Current status
This is a review/plan only. No production code, environment variables, or Render settings were changed by this file.
