
# Game Data Enrichment — a Claude Code agent-building exercise

Honestly, the point of this repo wasn't the spreadsheet. It was a hands-on lesson in building custom Claude Code subagents, wiring them together with the `Workflow` tool, and iterating on the whole thing through `/plan`. The game-list enrichment pipeline is just the practical vehicle that forced real design decisions instead of toy ones.

## What the pipeline actually does

Input: a scraped directory listing of ~1,399 PC game repack filenames (e.g. `Saints Row IV-Game of the Century Edition-DODI (PC)`).

For each row, it:
1. Strips repack-group tags, `(PC)`, and bracketed junk (regex, no LLM needed for this part)
2. Cleans the remainder into a real canonical title — deciding whether a trailing suffix is a genuine subtitle/expansion (keep it) or a cosmetic edition tag (drop it)
3. Researches, per title: Metacritic critic score, Steam % positive score, a 0–10 Steam-Community-sentiment estimate, genre, and release year
4. Leaves any field blank rather than guessing when it can't find reliable data
5. Sorts the result by Metacritic score (Steam score as tiebreaker) and writes it to a new spreadsheet

## What this was actually practice for

- **Designing single-responsibility custom subagents** (`.claude/agents/*.md`) — frontmatter (`name`, `description`, `tools`) plus guardrail-heavy system prompts: evidentiary bars before scoring anything, capped search/fetch budgets per title, and "blank beats a guess" as the non-negotiable default. Four agents, each doing exactly one job: `title-cleaner`, `metacritic-researcher`, `steam-researcher`, `steam-community-sentiment`.
- **Orchestrating them with the `Workflow` tool** — batching ~100 titles at a time, `parallel()` fan-out across research agents, schema-forced structured output so results come back as validated JSON instead of parsed prose, and checkpointing between calls since workflow scripts have no filesystem access of their own.
- **Using `/plan` iteratively, not as a one-shot** — designing an approach, showing the actual drafted agent definitions for approval *before* creating anything, then genuinely revising scope mid-project as real constraints surfaced (the sentiment source went Reddit → a ResetEra/Steam-Community/GameFAQs fallback chain → Steam-Community-only, each pivot driven by something discovered while testing, not planned in advance).
- **Debugging real runtime gotchas**, the kind you only find by actually running things:
  - `args` passed to a `Workflow` call arrives as a raw JSON *string* in this environment, not a parsed object — silently breaks anything that does `args.someField` without guarding for it.
  - An empty `tools: []` in a custom agent's frontmatter silently blocks the workflow's injected structured-output tool — the agent just returns an empty result, no error.
  - Creating or renaming a custom agent file and immediately launching a workflow that depends on it hits a registry-lag race — fails once, works on retry.
- **A design lesson worth its own bullet**: stripping context for cleanliness can silently break disambiguation downstream. Dropping "Platinum Edition" while cleaning a title is correct in isolation, but it also strips the one clue that the title refers to the classic 2006 *Saints Row*, not its unrelated 2022 reboot of the same name — three independent research agents can then each confidently resolve the same bare title to a *different* real game. The fix (threading the original raw listing through as a disambiguation hint) helped but didn't fully solve it — a good reminder that multi-agent pipelines need their context deliberately preserved, not just cleaned.

## Repo structure

```
.claude/
  agents/
    title-cleaner.md              # no tools — pure judgment call, edition vs. subtitle
    metacritic-researcher.md      # WebSearch + WebFetch, metacritic.com only
    steam-researcher.md           # WebSearch + WebFetch, store.steampowered.com only
    steam-community-sentiment.md  # WebSearch + WebFetch, steamcommunity.com only
  workflows/
    game-data-enrichment.js       # batches titles, fans out research, merges results
Progress_report.md                # what's done, bugs found/fixed, exact resume steps
context.md                        # durable reference: subagent map, data sources, gotchas
```

## Status

Built and validated — not yet fully run. The 4 subagents and the workflow are done and passed a 17-title edge-case battery (fan-made mods with no commercial page, duplicate listings, subtitle-vs-edition judgment calls, a deliberately-fake title to check for fabrication, and more). The full 1,399-row batch run and the final sorted spreadsheet haven't been executed yet — that was left for a fresh session on purpose, to avoid burning context mid-build. `Progress_report.md` has the exact resume steps.

## Known limitation

The franchise-collision case above (Saints Row 2006 vs. its 2022 reboot) reproduced across multiple test runs even with the disambiguation-hint fix in place. It's flagged, not silently papered over — see `Progress_report.md` for the specifics.
