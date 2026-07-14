# Game Data Enrichment Pipeline — Reference

Durable reference for maintaining/extending this pipeline. For a point-in-time status/changelog of what's been done and what's left, see `Progress_report.md` instead.

## Subagent map

| Agent | File | Tools | Role | Output shape |
|---|---|---|---|---|
| `title-cleaner` | `.claude/agents/title-cleaner.md` | none | Turns a pre-stripped repack filename into a canonical game title. Pure judgment call: decides whether a trailing suffix is a real subtitle/expansion (keep, join with `:`) or a cosmetic edition tag (drop). Never fabricates a title for an unrecognized/nonsense entry — echoes it back unchanged instead. | `{raw, clean_title}[]` |
| `metacritic-researcher` | `.claude/agents/metacritic-researcher.md` | WebSearch, WebFetch | Looks up the real Metacritic critic score, genre, and release year from the actual metacritic.com page. Never substitutes a user score or an aggregator-mirror number. | `{title, metacritic_score, genre, year}[]` |
| `steam-researcher` | `.claude/agents/steam-researcher.md` | WebSearch, WebFetch | Looks up the hard Steam % positive review score from the store.steampowered.com page. | `{title, steam_score}[]` |
| `steam-community-sentiment` | `.claude/agents/steam-community-sentiment.md` | WebSearch, WebFetch | Produces a 0-10 **estimate** of community sentiment, grounded in real Steam Community reviews/discussion threads (not the hard % score above — a qualitative read of tone). No fallback source; returns null if Steam Community discussion is too thin. | `{title, steam_community_sentiment, basis}[]` |

All four are invoked only from `.claude/workflows/game-data-enrichment.js` — they assume the input formats that workflow constructs (see below) and aren't meant to be called standalone.

## Data source preferences (learned this session, via direct testing)

- **metacritic.com** — directly `WebFetch`-able. Preferred, use exclusively for Metacritic data.
- **store.steampowered.com** / **steamcommunity.com** — directly `WebFetch`-able, most reliable of everything tested. Preferred for both the hard Steam score and the community sentiment estimate.
- **reddit.com** — fully blocked. `WebFetch` errors outright; `WebSearch` returns zero results for any reddit-related query, even without a `site:` filter. Do not build anything in this project that depends on Reddit.
- **resetera.com** / **gamefaqs.gamespot.com** — both return `403 Forbidden` on direct `WebFetch` (search pages and individual threads alike), but `WebSearch` queries like `"<title> resetera"` or `"<title> gamefaqs message board"` work and return usable thread titles + synthesized tone summaries. Not currently used (pipeline is Steam-Community-only per user preference), but kept as a note in case a future need justifies adding them back as a fallback chain.

## Core guardrails/principles

- **Blank beats a guess, always.** Every research agent is explicitly instructed to return `null` rather than fabricate a plausible-sounding number. This is the single most important property of the pipeline — verify it holds before trusting any new agent added to this project.
- **Capped search/fetch budgets per title.** Every research agent has an explicit per-title cap (2-3 searches/fetches) so it fails toward `null` instead of spiraling into open-ended search loops.
- **Disambiguation-hint pattern is mandatory for anything that strips context before research.** If a cleaning/normalization step removes information that could disambiguate a title (edition names, years, "reboot" markers), that information must still reach every downstream research agent as a hint, or independent agents can resolve an ambiguous name to *different real games* and produce an internally-inconsistent row. Canonical example: "Saints Row-Platinum Edition" → cleaned to bare "Saints Row" → collides with the unrelated 2022 reboot of the same name. The fix threads the original raw listing through as a parenthetical hint (`"Saints Row" (original listing: "Saints Row-Platinum Edition")`) to every research agent, while merge/output logic still keys on the canonical clean title. **This is a known-imperfect mitigation** — it reproduced as a genuine mismatch even with the hint in place across multiple test runs; treat any franchise with a same-named reboot/remake as higher-risk and worth manual spot-checking.
- **Distinct-but-similar titles should NOT be over-merged.** The title-cleaner correctly keeps genuinely different released SKUs as separate rows (e.g. `Dragon Quest XI` vs. `Dragon Quest XI S` — different years, different scores) rather than collapsing everything that looks similar. Only cosmetic edition tags (Deluxe/Ultimate/Definitive/Platinum/Complete Edition, when they're just a bundling of the same base game) get dropped/merged.

## Known gotchas (runtime-level, not project-logic)

- **`args` arrives as a raw JSON string, not a parsed object**, in this environment. Any workflow using `args.someField` directly will silently get `undefined`. Always guard: `const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args`.
- **`tools: []` in a custom agent's frontmatter blocks the workflow's injected `StructuredOutput` tool**, causing the agent to silently return an empty result with no error. Omit the `tools:` line entirely for agents that don't need any tools, rather than setting it to an empty list.
- **Custom-agent registry lag.** Creating or renaming an agent `.md` file and then immediately launching a `Workflow` that depends on it can fail with `agent type 'X' not found`, even though the file exists — the runtime's registry hadn't caught up yet. A "New agent types are now available" notification arrives shortly after. Budget one throwaway retry whenever a custom agent was just added/renamed.

## Workflow orchestration shape

`.claude/workflows/game-data-enrichment.js` processes one batch (~100 titles) per `Workflow` call:
1. `title-cleaner` runs once for the whole batch (pure reasoning, no search needed, so no need to sub-batch it).
2. Cleaned titles are deduped by `clean_title` (so re-listed editions of the same game aren't researched twice), split into groups of ~10, and each group fans out to the 3 research agents in parallel via `parallel()`.
3. Results merge back into one row per **original input row** (not per unique title) — every raw filename still gets its own output row even when several share one canonical title.
4. The workflow itself has no filesystem access — checkpointing/writing to the spreadsheet happens in the calling session between `Workflow` calls, one call per outer batch.
