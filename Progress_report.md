# Game List Enrichment — Progress Report

Status as of this session: **pipeline built and validated end-to-end on a hand-picked edge-case batch. The full 1,399-row batch has NOT been run yet — that's the next step, in a fresh session.**

## What exists and where

| Artifact | Path | Purpose |
|---|---|---|
| Source spreadsheet | `C:\Users\USER\OneDrive\Claude\Book1 (3).xlsx` | `Sheet1`, 1,399 raw filenames in column A. Rows 1–3 are junk (blank cell, "Name" header, "Parent Directory" leftover from the scrape) — real data starts at row 4. |
| Pre-clean script | `C:\Users\USER\AppData\Local\Temp\claude\C--Users-USER-OneDrive-Claude\fe454be7-e092-463b-abad-ccf005197cc8\scratchpad\preclean.py` | Python/openpyxl. Strips repack-group tags (DODI, ElAmigos, FitGirl, GOG, RELOADED, P2P, CODEX, SKIDROW, PLAZA, HOODLUM, TENOKE, EMPRESS, CPY, FLT, RUNE, Xatab, KaOs, R.G. Mechanics, DARKSiDERS, PROPHET, TiNYiSO, SiMPLEX, Repack), `(PC)`, and bracketed notes (`[No Crack]` etc.) via regex. |
| Pre-cleaned title list | `.../scratchpad/pre_cleaned_titles.json` | 1,399 `{raw, pre_cleaned}` objects — output of the script above, verified count matches source. **This is the input the fresh session should batch and feed to the workflow.** |
| Custom subagents | `.claude/agents/title-cleaner.md`, `metacritic-researcher.md`, `steam-researcher.md`, `steam-community-sentiment.md` | See `context.md` for the full subagent map. |
| Saved workflow | `.claude/workflows/game-data-enrichment.js` | Takes `{titles: [...pre-cleaned filenames for one batch...]}`. Cleans titles, dedupes, fans out research in groups of ~10, merges, returns per-row JSON. |
| This plan | `C:\Users\USER\.claude\plans\concurrent-spinning-catmull.md` | Full history of the session's decisions, in case more detail than this report is needed. |

## Bugs and gotchas found (all fixed or worked around)

1. **`tools: []` blocks structured output.** `title-cleaner.md` originally declared `tools: []` in frontmatter. This silently blocked the workflow's injected `StructuredOutput` tool, so the agent always returned `{items: []}` with no error. Fix: removed the `tools:` line entirely (omit it rather than set it empty).

2. **`args` arrives as a raw JSON string, not a parsed object.** Confirmed via an isolated debug workflow (`typeof args === "string"`). Any workflow relying on `args.someField` will silently get `undefined` and cascade into empty results without an obvious error. Fix, already baked into `game-data-enrichment.js`:
   ```js
   const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args
   const rawTitles = (parsedArgs && parsedArgs.titles) || []
   ```
   Apply this pattern in any future workflow that takes `args`.

3. **Disambiguation-context loss causes cross-agent mismatches.** The title-cleaner correctly strips edition tags (e.g. "Platinum Edition") before research — but that strips away the context that disambiguates franchise collisions. "Saints Row-Platinum Edition" cleans to bare "Saints Row", which collides with the 2022 reboot of the same name. Left unguarded, the 3 research agents can each independently resolve the ambiguous name to a *different* real game, producing a row that mixes data from two unrelated releases. Fix: the workflow threads the original raw listing(s) through to every research agent as a parenthetical hint — `"Saints Row" (original listing: "Saints Row-Platinum Edition")` — so all agents see the same disambiguating context, while merge/output logic still keys on the canonical clean_title.
   - **Known limitation, not fully solved**: even with the hint, this specific case (Saints Row-Platinum-Edition vs. the 2022 reboot) reproduced across two separate full-batch test runs, resolving to the 2022 reboot (year 2022) rather than the classic 2006 game (year 2006) that an isolated single-title test correctly identified. The hint measurably helps (in the latest run all 3 agents at least agreed with *each other*, unlike an earlier run where they split across two different games) but doesn't reliably win once this title is batched alongside ~10 others. If this recurs across the full 1,399-row run, consider a stronger hint (e.g. explicitly stating "Platinum Edition was a classic-era THQ budget re-release label, never used for the 2022 reboot") or a dedicated disambiguation pass for known-collision franchises.

4. **Reddit is fully blocked in this environment.** `WebFetch` to any `reddit.com` URL errors outright; `WebSearch` returns zero results for any reddit-related query (tested directly). This ruled out the originally-planned Reddit sentiment agent entirely — not a bug to fix, just an unavailable source.

5. **Custom-agent registry lag.** After deleting an agent `.md` file and creating a replacement in the same turn, the *next* `Workflow` call still failed with `agent type 'X' not found` — the runtime's agent-type registry hadn't picked up the file change yet. A system notification ("New agent types are now available: X") arrived only *after* that first call failed. This happened twice in a row (once for `community-sentiment`, once for `steam-community-sentiment`) — it's a consistent timing gotcha, not a fluke. **Always budget one throwaway retry** after creating or renaming a custom agent file, right before the workflow that depends on it.

## Source-selection history (for context)

Reddit → tried a ResetEra/Steam-Community/GameFAQs 3-source fallback chain → user simplified to **Steam Community only**, since it's the most reliable of the three (direct `WebFetch` access, real review/discussion text) and the user is more familiar with it. ResetEra and GameFAQs both return `403 Forbidden` on direct `WebFetch` but work via `WebSearch` snippets — noted in `context.md` in case a future need justifies revisiting them.

## Edge-case test results (final run, all passing except the noted limitation)

Ran a hand-picked 17-title batch (not the full list) covering:

| Case | Result |
|---|---|
| Fan-made mod, no commercial release (`S.T.A.L.K.E.R-Anomaly`) | Metacritic/Steam score correctly blank. Steam Community sentiment came back **7** — the agent found genuine discussion of the mod within the base games' Steam Community forums (a legitimate, non-fabricated source) rather than returning blank; a defensible call, not a violation of "blank over guess." |
| Duplicate raw rows, same clean title (`S.T.A.L.K.E.R. 2` DODI + ElAmigos) | Both rows got identical, consistent enrichment data — dedup logic working as designed. |
| Franchise reboot collision (`Saints Row-Platinum Edition`) | **Known limitation** — see bug #3 above. Resolved to the 2022 reboot consistently across all 3 agents this run (internally consistent, but likely the wrong game). |
| Subtitle-vs-edition judgment | `Saints Row-Gat out of Hell` → subtitle kept (correct, real expansion). `Saints Row IV-Game of the Century Edition` → edition dropped, clean title = "Saints Row IV" (correct). `Dying Light 2-Stay Human` → subtitle kept. `Dragon's Dogma-Dark Arisen` → subtitle kept. `Dynasty Warriors-Origins`/`Dynasty Warriors 9-Empires` → subtitles kept. All correct. |
| Multiple editions collapsing to one base game (`Dying Light-Definitive/Enhanced/Platinum Edition`) | All 3 correctly collapsed to clean title "Dying Light" with identical, consistent data — correct, since Steam/Metacritic treat these as the same underlying release. |
| Genuinely distinct same-franchise releases (`Dragon Quest XI` vs. `Dragon Quest XI S`) | Correctly kept as two **separate** rows/titles (different years, different Steam scores) rather than incorrectly merged — the title-cleaner recognized "XI S" as a distinct edition of the series, not just a cosmetic tag. |
| Niche/JRPG/fighting-game coverage (`Samurai Shodown`, `Dragon Quest XI` cluster, `Dynasty Warriors` cluster) | All returned real, plausible scores and sentiment — Steam Community had enough discussion in every case tested; the "return null if thin" path wasn't exercised here (worth watching during the full run for a truly obscure/niche title). |
| Synthetic nonsense title (`Zorbaxian Fortress Quest 7-Ultra Deluxe Edition`) | Every field correctly returned null, with an honest basis note ("No real game by this name found on Steam or elsewhere") — no fabrication anywhere in the pipeline, including the title-cleaner itself. |

Overall: the pipeline is solid. The one flagged limitation (Saints Row-style franchise collisions) should be watched during the full run rather than assumed fixed.

## Resume steps for a fresh session

1. Read `.../scratchpad/pre_cleaned_titles.json` (1,399 `{raw, pre_cleaned}` objects).
2. Split into batches of 100 (~14 batches; adjust if the user prefers a different size).
3. For each batch, call:
   ```
   Workflow({
     scriptPath: 'C:\Users\USER\OneDrive\Claude\.claude\workflows\game-data-enrichment.js',
     args: { titles: batch.map(x => x.pre_cleaned) }
   })
   ```
   (If a custom agent file was just touched, expect the registry-lag gotcha above — retry once after the "new agent types available" notification.)
4. On each batch's completion, the workflow returns rows keyed by its own echoed `raw` field — that's actually the *pre-cleaned* string, not the true original filename. Zip the batch's input array back to the workflow's output **by index** (order is preserved end-to-end) to recover the true original filename for the "Original Filename" column. Append the joined rows to a checkpoint file (e.g. `game_enrichment_checkpoint.jsonl`) immediately, so a crash mid-run only loses the in-flight batch.
5. Post a brief status update in chat after each batch (e.g. "Batch 4/14 done — 400/1,399 processed, N blanks so far").
6. After all batches: read the full checkpoint, build the final workbook with columns `Original Filename`, `Clean Title`, `Metacritic Score`, `Steam User Score`, `Steam Community Sentiment (Est., 0-10)`, `Genre`, `Year of Release`. Sort descending by Metacritic Score (blanks last), Steam Score as tiebreaker. Save as `C:\Users\USER\OneDrive\Claude\Game.xlsx` (new file — do not overwrite `Book1 (3).xlsx`).
7. Spot-check ~10 random rows against Metacritic/Steam directly, and specifically re-check any other "Saints Row"-style franchise-collision titles in the full list given the known limitation above.
