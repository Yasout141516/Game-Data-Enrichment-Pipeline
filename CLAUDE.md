# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Not a software project with a build/test/lint toolchain — there's no package.json, no test suite, no linter. It's a Claude Code agent-building exercise: a `Workflow`-orchestrated pipeline of custom subagents that enriches a scraped list of ~1,399 PC game repack filenames with Metacritic/Steam data, and writes the result to a spreadsheet. Treat "development" here as designing/editing agent definitions and the workflow script, not writing application code.

## Running the pipeline

There is no CLI entrypoint — the workflow is invoked directly via the `Workflow` tool, one batch (~100 titles) at a time:

```
Workflow({
  scriptPath: '.claude/workflows/game-data-enrichment.js',
  args: { titles: batch.map(x => x.pre_cleaned) }
})
```

`Progress_report.md` has the exact current resume state (which batches are done, where the pre-cleaned input list lives, what's left). Read it before starting or continuing a run — do not re-derive batching state from scratch.

After each batch completes, results must be joined back to the input **by array index** (the workflow echoes the pre-cleaned string, not the true original filename) and appended to `game_enrichment_checkpoint.jsonl` immediately, so a crash only loses the in-flight batch.

## Architecture

**Four single-responsibility subagents** in `.claude/agents/`, each doing exactly one job and returning schema-validated structured output (never parsed prose):

| Agent | Tools | Job |
|---|---|---|
| `title-cleaner` | none (frontmatter omits `tools:` entirely) | Turns a pre-stripped filename into a canonical title; decides subtitle-vs-edition-tag |
| `metacritic-researcher` | WebSearch, WebFetch | metacritic.com only — score/genre/year |
| `steam-researcher` | WebSearch, WebFetch | store.steampowered.com only — % positive score |
| `steam-community-sentiment` | WebSearch, WebFetch | steamcommunity.com only — 0–10 sentiment estimate from real discussion |

These agents assume the input shapes `.claude/workflows/game-data-enrichment.js` constructs for them and aren't meant to be invoked standalone outside that workflow.

**Orchestration** (`.claude/workflows/game-data-enrichment.js`), per batch:
1. `title-cleaner` runs once for the whole batch.
2. Cleaned titles are deduped by `clean_title` (so re-listed editions of one game aren't researched twice), grouped in 10s, and each group fans the 3 research agents out via `parallel()`.
3. Results merge back to **one row per original input row** (not per unique title) — duplicate raw filenames sharing a canonical title each still get their own output row.
4. The workflow has no filesystem access of its own — checkpointing to disk happens in the calling session between `Workflow` calls.

**Disambiguation-hint pattern (mandatory when adding anything that strips context before research):** if a cleaning step removes information that could disambiguate a title (edition names, years, "reboot" markers), that information must still reach every downstream research agent, or independent agents can resolve the same bare title to *different real games*. The workflow does this by threading the original raw listing(s) through as a parenthetical hint (`"Saints Row" (original listing: "Saints Row-Platinum Edition")`) to every research agent, while merge/output logic still keys on the canonical clean title. This mitigation is known-imperfect — see the Saints Row 2006-vs-2022-reboot case in `context.md` — treat any franchise with a same-named reboot/remake as higher risk and worth a manual spot-check.

**Core guardrail across all four agents: blank beats a guess, always.** Every research agent returns `null` rather than fabricate a plausible-sounding number, and has a capped search/fetch budget per title (2–3 searches/fetches) so it fails toward `null` instead of spiraling into open-ended search loops. Preserve this property in any new agent added to this project.

## Runtime gotchas specific to this environment

- `args` passed to a `Workflow` call arrives as a **raw JSON string**, not a parsed object. Always guard: `const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args`.
- An empty `tools: []` in a custom agent's frontmatter silently blocks the workflow's injected `StructuredOutput` tool — the agent just returns an empty result with no error. Omit the `tools:` line entirely for agents that need no tools.
- Creating or renaming a custom agent `.md` file and immediately launching a `Workflow` that depends on it can hit a registry-lag race (fails once with "agent type not found", works on retry after a "new agent types are now available" notification). Budget one throwaway retry after touching an agent file.

## Reference docs (read these, don't duplicate them)

- `context.md` — durable reference: full subagent map, data-source reliability notes (metacritic.com and steamcommunity.com/store.steampowered.com are directly `WebFetch`-able; reddit.com is fully blocked; resetera.com/gamefaqs.gamespot.com are 403 on WebFetch but usable via WebSearch), and the guardrails above in more detail.
- `Progress_report.md` — point-in-time status: what's been run, exact resume steps, known bugs and how they were fixed, edge-case test results.
- `README.md` — narrative summary of the project and what it was practice for.
