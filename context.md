# Game Data Enrichment Pipeline — Reference

Durable reference for maintaining/extending this pipeline. For a point-in-time status/changelog of what's been done and what's left, see `Progress_report.md` instead.

## Current architecture: scripted research, agents only for judgment calls

The original design (below, "Superseded design") ran all research through LLM subagents doing their own WebSearch/WebFetch — it worked but cost too many tokens for a 1,399-row run. Metacritic score/genre/year and Steam % score/genre are now fetched deterministically by `.claude/scripts/research.js` (plain Node, run via `Bash`, zero LLM tokens), with two small agents handling only what a script genuinely can't: subtitle-vs-edition judgment and franchise-collision disambiguation.

Per batch:
1. `Agent` tool → `title-cleaner` on the batch's pre-cleaned titles (unchanged).
2. Dedupe by `clean_title` (plain JS).
3. `Bash` → `node .claude/scripts/research.js <input.json> <output.json>` on the unique `{title, hint}` list. For each title: resolves a Steam appid via the `storesearch` API and pulls `steam_score`/genre/review snippets from `appreviews`/`appdetails`; resolves Metacritic by guessing a URL slug and cross-checking against `metacritic.com/search/<title>/` results, then parses the game page's `application/ld+json` block for the real score/genre/year. Flags anything genuinely ambiguous (multiple plausible candidates, or an edition-tag word in the hint that makes even a confident-looking match worth double-checking) instead of guessing — see the "Known collision-detection limits" note below for why the second case exists.
4. If anything was flagged: `Agent` tool → `match-disambiguator` (no tools) picks the right candidate per flagged title using the hint, or returns null. Its resolution (chosen candidate's snippets included) gets merged back into the row before the next step.
5. `Agent` tool → `steam-community-sentiment` (no tools now — see below), once per batch, scoring every unique title from its pre-fetched review snippets.
6. Merge back to every original raw row by `clean_title` (same join logic as the old workflow script), append to the checkpoint file, post a one-line status update.

**Workflow tool is not used for this pipeline anymore.** `Workflow` scripts have no filesystem or network access, so the scraping in step 3 has to run as an ordinary script via `Bash` instead — and once that's true, there's nothing left needing `Workflow`'s parallel fan-out (only 2 small agent calls remain per batch).

### Known collision-detection limits (found while building `research.js`)

Exact-string-match confidence is not sufficient to trust a resolved candidate. Direct test: resolving bare "Saints Row" (hint: "Saints Row-Platinum Edition") against Metacritic returned the **2022 reboot** (year 2022, score 61) as the only "exact" word-match candidate — the classic 2006/2008 original doesn't occupy a competing exact-match slug at all, so there was no second candidate to trigger suspicion. Same result independently on Steam. This is the *same* collision case already documented below under "Disambiguation-hint pattern," now reproduced against real data sources rather than an LLM's search behavior — confirming it's a property of the underlying data (the reboot has taken over the canonical name/slug), not a fixable string-matching bug. Mitigation: `research.js` flags any resolved match as `edition_signal_recheck` whenever the hint contains an edition-tag word (the same vocabulary `title-cleaner` treats as droppable — "edition," "platinum," "deluxe," etc.), even if it was an otherwise-confident single-candidate match, and routes it through `match-disambiguator` rather than trusting it silently. Treat any franchise with a same-named reboot/remake as still-risky even under the new pipeline.

### Data-quality gotchas specific to the Steam/Metacritic APIs (confirmed via direct testing)

- **Steam's own `appdetails.metacritic.score` field is stale/wrong — do not use it.** Tested on Titanfall 2: Steam's mirrored value was 86; the live metacritic.com page's own `aggregateRating.ratingValue` was 89. Always fetch metacritic.com directly for the score.
- **Steam's `appdetails.release_date` is not the true original release year** — it can reflect a re-listing/relaunch date. Same Titanfall 2 test: Steam said "18 Jun, 2020" (its native Steam listing went live then) vs. the real 2016-10-28 release, confirmed via Metacritic's `datePublished`. Always take `year` from Metacritic's `ld+json` block, never from Steam's `release_date`; leave `year` null if a title has no Metacritic match rather than substitute Steam's date.
- **Metacritic game pages embed a clean `application/ld+json` `VideoGame` block** (`aggregateRating.ratingValue`, `genre`, `datePublished`, `name`) — reliable to parse with a simple regex + `JSON.parse`, no HTML scraping needed once you have the right page URL. The hard part is landing on the right URL (see collision-detection limits above), not extracting data once there.
- **Metacritic has no public search API**, but `metacritic.com/search/<query>/` returns plain server-rendered HTML with regex-extractable `href="/game/<slug>/"` links — sufficient for building a candidate list without a real HTML parser.
- **Steam's `storesearch` API sometimes returns zero results for a real, currently-listed game** — confirmed on batch 3: `storesearch` returned `[]` for "Transformers: Devastation" (and even a bare "Transformers" query buried it under unrelated tabletop-RPG products), yet the game has a real, live Steam page at appid 338930 (confirmed via direct web search). This is a genuine gap in the data source itself, not a matching-logic bug in `research.js` — a title can come back with `steam_score: null` even though it's really on Steam. No fallback is implemented for this yet (a direct-appid-guess-and-verify path, or Steam's autocomplete/suggest endpoint, would be the next thing to try if this recurs often enough to matter). Distinguish this from the *correct* null case: some titles (e.g. Warcraft III: Reforged) are genuinely Battle.net/other-launcher exclusives with no Steam listing at all.

## Superseded design: all-agentic research (kept for reference, not deleted — see README)

This was the original implementation, explicitly built as a subagent/Workflow-orchestration learning exercise. `metacritic-researcher.md`, `steam-researcher.md`, and `.claude/workflows/game-data-enrichment.js` still exist in the repo but are no longer invoked by the live pipeline above — left in place as-is rather than deleted.

### Subagent map (original 4; only `title-cleaner` and the repurposed `steam-community-sentiment` are still used — see "Current architecture" above)

| Agent | File | Tools | Role | Output shape |
|---|---|---|---|---|
| `title-cleaner` | `.claude/agents/title-cleaner.md` | none | Turns a pre-stripped repack filename into a canonical game title. Pure judgment call: decides whether a trailing suffix is a real subtitle/expansion (keep, join with `:`) or a cosmetic edition tag (drop). Never fabricates a title for an unrecognized/nonsense entry — echoes it back unchanged instead. | `{raw, clean_title}[]` |
| `metacritic-researcher` *(superseded)* | `.claude/agents/metacritic-researcher.md` | WebSearch, WebFetch | Looked up the real Metacritic critic score, genre, and release year from the actual metacritic.com page. Replaced by `research.js`. | `{title, metacritic_score, genre, year}[]` |
| `steam-researcher` *(superseded)* | `.claude/agents/steam-researcher.md` | WebSearch, WebFetch | Looked up the hard Steam % positive review score from the store.steampowered.com page. Replaced by `research.js`. | `{title, steam_score}[]` |
| `steam-community-sentiment` *(repurposed, still active)* | `.claude/agents/steam-community-sentiment.md` | none (was WebSearch, WebFetch) | Produces a 0-10 **estimate** of community sentiment from review snippets `research.js` now fetches for it, instead of fetching them itself. | `{title, steam_community_sentiment, basis}[]` |

### Data source preferences (learned via direct testing, while the agents did their own WebFetch/WebSearch)

- **metacritic.com** — directly `WebFetch`-able.
- **store.steampowered.com** / **steamcommunity.com** — directly `WebFetch`-able, most reliable of everything tested.
- **reddit.com** — fully blocked. `WebFetch` errors outright; `WebSearch` returns zero results for any reddit-related query, even without a `site:` filter. Do not build anything in this project that depends on Reddit.
- **resetera.com** / **gamefaqs.gamespot.com** — both return `403 Forbidden` on direct `WebFetch` (search pages and individual threads alike), but `WebSearch` queries like `"<title> resetera"` or `"<title> gamefaqs message board"` work and return usable thread titles + synthesized tone summaries. Not currently used, but kept as a note in case a future need justifies adding them back as a fallback chain.

### Cost/performance tweak that came before the scripted rewrite (superseded)

Before replacing the research agents with `research.js` entirely, a smaller optimization was tried first: `model: 'haiku'` on the 3 research agents' `agent()` calls plus a research group size of 20 (was 10), to see if a cheaper model/fewer invocations alone would be enough. It cut cost but not enough for a 1,399-row run, which is what motivated the full scripted rewrite above. Kept here as a record in case the scripted approach ever needs to fall back toward agent-based research for a field the script can't get: gating `steam-community-sentiment` on the other two scores being non-null was tested and rejected (of 5 checkpoint rows with both other scores null, 3 still got real non-null sentiment — gating would silently drop legitimate data ~60% of the time), and a global cross-batch dedup pass was tested and rejected too (checked batches 1-2, zero duplicate clean titles crossed a batch boundary).

## Core guardrails/principles

- **Blank beats a guess, always.** Every research step — script or agent — returns/writes `null` rather than fabricate a plausible-sounding number. This is the single most important property of the pipeline — verify it holds before trusting any change to `research.js` or any agent in this project.
- **Disambiguation-hint pattern is mandatory for anything that strips context before research.** If a cleaning/normalization step removes information that could disambiguate a title (edition names, years, "reboot" markers), that information must still reach whatever resolves identity downstream — today that's `research.js`'s edition-signal check plus `match-disambiguator`, previously it was a hint string passed to 3 separate agents. Canonical example: "Saints Row-Platinum Edition" → cleaned to bare "Saints Row" → collides with the unrelated 2022 reboot of the same name. **This is a known-imperfect mitigation, confirmed twice now** — once against the LLM-agent pipeline (reproduced across multiple test runs) and again directly against `research.js` (the reboot silently won the only "exact match" slot on both Metacritic and Steam, with no competing candidate to raise suspicion — see "Known collision-detection limits" above). Treat any franchise with a same-named reboot/remake as higher-risk and worth manual spot-checking no matter which pipeline version is running.
- **Distinct-but-similar titles should NOT be over-merged.** The title-cleaner correctly keeps genuinely different released SKUs as separate rows (e.g. `Dragon Quest XI` vs. `Dragon Quest XI S` — different years, different scores) rather than collapsing everything that looks similar. Only cosmetic edition tags (Deluxe/Ultimate/Definitive/Platinum/Complete Edition, when they're just a bundling of the same base game) get dropped/merged.

## Known gotchas (runtime-level, not project-logic)

- **`args` arrives as a raw JSON string, not a parsed object**, in a `Workflow` script in this environment. Any workflow using `args.someField` directly will silently get `undefined`. Always guard: `const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args`. (No longer relevant to the live pipeline since it doesn't use `Workflow` anymore, but still true if `Workflow` is used elsewhere.)
- **Whether omitting `tools:` means "no tools" or "inherit everything" depends on how the agent is invoked, and this bit `steam-community-sentiment` for real.** Through `Workflow`'s `agent()`, `tools: []` blocks the injected `StructuredOutput` tool (silently empty result, no error) — omit the line entirely there. But when a custom agent is invoked directly via the plain `Agent` tool (as the scripted pipeline now does, since `Workflow` is no longer used), omitting `tools:` defaults to inheriting the *full* toolset, not none. Confirmed by direct testing: with `tools:` omitted, `steam-community-sentiment` — which is explicitly instructed to only read pre-fetched snippets and never search — used `WebSearch`/`WebFetch` on its own for several titles with thin snippet data (visible in its own `basis` text citing "search results"). Fixed by setting `tools: []` explicitly in its frontmatter, which correctly disables all tools for a direct `Agent`-tool invocation. Any custom agent meant to be pure-reasoning-only needs to be invoked once and checked for `tool_uses > 0` in its usage stats, not just trusted from the prompt wording.
- **Custom-agent registry lag can take more than one retry.** Creating or renaming an agent `.md` file and then immediately invoking it can fail with `agent type 'X' not found`, even though the file exists. Took 3 failed attempts (including a ~15s wait between two of them) before `match-disambiguator` registered in one real run — budget more than a single throwaway retry, and fall back to another agent type with the same instructions embedded inline if it still hasn't shown up after a couple of tries and you don't want to block on it.

### Workflow orchestration shape (superseded — kept for reference)

`.claude/workflows/game-data-enrichment.js` processed one batch (~100 titles) per `Workflow` call:
1. `title-cleaner` ran once for the whole batch.
2. Cleaned titles deduped by `clean_title`, split into groups (10, later 20), each group fanning out to the 3 research agents in parallel via `parallel()`.
3. Results merged back into one row per original input row.
4. The workflow itself had no filesystem access — checkpointing happened in the calling session between `Workflow` calls.
