
# Game Data Enrichment — a Claude Code agent-building exercise

Honestly, the point of this repo wasn't the spreadsheet. It was a hands-on lesson in building custom Claude Code subagents, wiring them together first with the `Workflow` tool and later with plain scripting, and iterating on the whole thing through `/plan`. The game-list enrichment pipeline is just the practical vehicle that forced real design decisions instead of toy ones.

## What the pipeline actually does

Input: a scraped directory listing of 1,399 PC game repack filenames (e.g. `Saints Row IV-Game of the Century Edition-DODI (PC)`).

For each row, it:
1. Strips repack-group tags, `(PC)`, and bracketed junk (regex, no LLM needed for this part)
2. Cleans the remainder into a real canonical title — deciding whether a trailing suffix is a genuine subtitle/expansion (keep it) or a cosmetic edition tag (drop it)
3. Looks up, per title: Metacritic critic score, Steam % positive score, genre, and release year (deterministic script, zero LLM tokens), flagging anything genuinely ambiguous for a disambiguation agent to resolve
4. Estimates a 0–10 Steam-Community-sentiment score with a one-line rationale, from pre-fetched review snippets
5. Leaves any field blank rather than guessing when it can't find reliable data
6. Sorts the full result by Metacritic score (Steam score as tiebreaker, blanks last) and writes it to `Game.xlsx`

## What this was actually practice for

- **Designing single-responsibility custom subagents** (`.claude/agents/*.md`) — frontmatter (`name`, `description`, `tools`) plus guardrail-heavy system prompts: evidentiary bars before scoring anything, capped search/fetch budgets per title, and "blank beats a guess" as the non-negotiable default.
- **Orchestrating them with the `Workflow` tool, then discovering its limits.** The original design ran all research (Metacritic + Steam + sentiment) through three separate WebSearch/WebFetch subagents, batched via `Workflow` with `parallel()` fan-out. That worked and passed a full edge-case test battery, but was too token-expensive to run 1,399 rows through. It got replaced with `.claude/scripts/research.js` — a plain Node script hitting Steam's `storesearch`/`appreviews` APIs and Metacritic's server-rendered search + embedded `ld+json` game data directly, for zero LLM cost. Since `Workflow` scripts have no filesystem or network access of their own, and only 2 small judgment-call agents remained once the script did the fetching, the pipeline moved off `Workflow` entirely — each batch now runs as a plain sequence of `Bash`/`Agent` tool calls in the calling session instead.
- **Adding a disambiguation agent once a script couldn't safely resolve identity alone.** `research.js` can find several plausible candidates for one title (DLC packs, remasters, unrelated same-named products) or a single suspiciously-confident match riding on an edition-tag word in the hint. `match-disambiguator` — a tools-less agent — picks the right one from the actual candidate data, or returns null rather than guess.
- **Using `/plan` iteratively, not as a one-shot** — designing an approach, showing the actual drafted agent definitions for approval *before* creating anything, then genuinely revising scope mid-project as real constraints surfaced (the sentiment source went Reddit → a ResetEra/Steam-Community/GameFAQs fallback chain → Steam-Community-only; the research approach went all-agentic → scripted; each pivot driven by something discovered while testing, not planned in advance).
- **Debugging real runtime gotchas**, the kind you only find by actually running things:
  - `args` passed to a `Workflow` call arrives as a raw JSON *string* in this environment, not a parsed object — silently breaks anything that does `args.someField` without guarding for it.
  - Whether omitting `tools:` in an agent's frontmatter means "no tools" or "inherit everything" depends on *how* the agent gets invoked — through `Workflow`'s `agent()` it blocks the injected structured-output tool (silent empty result); called directly via the plain `Agent` tool it inherits the full toolset instead, which let a supposedly tools-less sentiment agent quietly start using `WebSearch` on its own until `tools: []` was set explicitly.
  - Creating or renaming a custom agent file and immediately invoking it can hit a registry-lag race — failed 3 times in a row once, including a ~15s wait, before it registered.
  - Two checkpoint schema variants exist across the run's history (early batches vs. later batches used different field names for the same data) — the final workbook-build script has to normalize both or silently produces blank columns for half the rows.
  - A descending sort with `-Infinity` as the "no score" sentinel put blank rows *first* instead of *last* — the sentinel needs to be `+Infinity` for a descending sort, caught by a monotonicity check before trusting the output.
- **A design lesson worth its own bullet**: stripping context for cleanliness can silently break disambiguation downstream. Dropping "Platinum Edition" while cleaning a title is correct in isolation, but it also strips the one clue that the title might refer to a classic-era release rather than an unrelated modern reboot of the same name — independent research steps can each confidently resolve the same bare title to a *different* real game. The fix (threading the original raw listing through as a disambiguation hint) helped but didn't fully solve it, confirmed against both the old agentic pipeline and the new scripted one — a good reminder that multi-agent/multi-step pipelines need their context deliberately preserved, not just cleaned.
- **A live spot-check found real errors even after "blank beats a guess" and disambiguation were both working as designed** — a small 5-row sample checked against actual Metacritic/Steam pages after the full run finished turned up 2 wrong values (one fabricated-looking score, one real score that got wrongly left blank). Both got fixed, but the sample was too small to call the other ~1,394 rows verified — a reminder that automated guardrails reduce error rate, they don't guarantee zero, and spot-checking against ground truth is still worth doing even after a pipeline "passes."

## Repo structure

```
.claude/
  agents/
    title-cleaner.md              # no tools — pure judgment call, edition vs. subtitle
    match-disambiguator.md        # no tools — picks the right candidate from research.js's output, or null
    metacritic-researcher.md      # superseded by research.js, kept for reference
    steam-researcher.md           # superseded by research.js, kept for reference
    steam-community-sentiment.md  # repurposed: scores from pre-fetched snippets, tools: []
  scripts/
    research.js                   # deterministic Metacritic + Steam lookups, zero LLM tokens
  workflows/
    game-data-enrichment.js       # superseded all-agentic Workflow version, kept for reference
Progress_report.md                # what's done, bugs found/fixed, batch-by-batch log
context.md                        # durable reference: architecture, data sources, gotchas
Game.xlsx                         # the final output: all 1,399 rows, enriched and sorted
game_enrichment_checkpoint.jsonl  # raw per-row results, appended batch by batch as the run progressed
```

## Status

Done. All 1,399 rows are enriched and in `Game.xlsx`, sorted by Metacritic score (Steam score as tiebreaker, blanks last), with columns for Metacritic score, Steam % positive, a 0–10 sentiment estimate plus its one-line rationale, genre, and year. `Progress_report.md` has the full batch-by-batch log, including every bug found and how it was fixed.

## Known limitations

- **Franchise-collision risk (e.g. a classic game vs. an unrelated modern reboot sharing the same name) is a real, only-partially-mitigated failure mode.** The disambiguation-hint pattern helps but doesn't fully solve it — see `context.md`'s "Known collision-detection limits" for the specifics of why, and treat any franchise with a same-named reboot/remake as worth a manual check.
- **Only a small sample was spot-checked against live data**, and it wasn't clean — 2 of 5 checked rows had real errors, both now fixed. The rest of the dataset is un-audited beyond the pipeline's own guardrails; a systematic recheck (especially of blank Metacritic/Steam scores for well-known titles, which is where both found errors clustered) would be the natural next step if higher confidence in the full 1,399 rows is ever needed.
