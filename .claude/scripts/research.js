#!/usr/bin/env node
// Deterministic Steam + Metacritic lookups for the game-data-enrichment pipeline.
// Zero LLM tokens: Steam via its public JSON APIs, Metacritic by parsing the
// application/ld+json block every game page embeds. Ambiguous matches (multiple
// plausible candidates, e.g. a franchise original vs. its same-named reboot) are
// flagged for a downstream LLM disambiguation pass rather than guessed here.
//
// Usage: node research.js <input.json> <output.json>
//   input.json: [{ "title": "<clean title>", "hint": "<raw listing(s)>" }, ...]

const fs = require('fs');

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error('Usage: node research.js <input.json> <output.json>');
  process.exit(1);
}

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and']);

// Words title-cleaner treats as droppable cosmetic edition tags (see title-cleaner.md).
// A hint containing one of these means real disambiguating context was stripped from the
// clean title -- an exact-name match alone isn't proof it's the right release (e.g. a
// same-named reboot can silently win the match instead of the classic-era game the edition
// tag was actually hinting at). Route these through confirmation instead of trusting them.
const EDITION_SIGNAL_WORDS = [
  'edition', 'goty', 'definitive', 'remaster', 'remastered', 'deluxe', 'ultimate',
  'platinum', 'gold', 'complete', 'anniversary', "director's cut", 'classic', 'enhanced',
];

function hasEditionSignal(hint) {
  const h = hint.toLowerCase();
  return EDITION_SIGNAL_WORDS.some(w => h.includes(w));
}

function normalizeWords(str) {
  return str
    .toLowerCase()
    .replace(/[®™©]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w && !STOPWORDS.has(w));
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[®™©]/g, '')
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// How well `candidateWords` covers `titleWords` -- 1.0 means every title word is present.
function matchScore(titleWords, candidateWords) {
  if (titleWords.length === 0) return 0;
  const set = new Set(candidateWords);
  const hits = titleWords.filter(w => set.has(w)).length;
  return hits / titleWords.length;
}

function isExactMatch(titleWords, candidateWords) {
  if (titleWords.length !== candidateWords.length) return false;
  const a = [...titleWords].sort().join('|');
  const b = [...candidateWords].sort().join('|');
  return a === b;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) return null;
  return res.text();
}

function parseMetacriticLdJson(html) {
  const m = html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]);
    if (data['@type'] !== 'VideoGame') return null;
    const year = data.datePublished ? parseInt(data.datePublished.slice(0, 4), 10) : null;
    return {
      name: data.name,
      metacritic_score: data.aggregateRating ? Math.round(data.aggregateRating.ratingValue) : null,
      genre: data.genre || null,
      year: Number.isFinite(year) ? year : null,
    };
  } catch {
    return null;
  }
}

async function fetchMetacriticGuess(slug) {
  const html = await fetchText(`https://www.metacritic.com/game/${slug}/`);
  if (!html) return null;
  const parsed = parseMetacriticLdJson(html);
  return parsed ? { slug, ...parsed } : null;
}

async function fetchMetacriticSearchCandidates(title) {
  const html = await fetchText(`https://www.metacritic.com/search/${encodeURIComponent(title)}/`);
  if (!html) return [];
  const slugs = [...new Set([...html.matchAll(/href="\/game\/([a-z0-9-]+)\/"/g)].map(m => m[1]))];
  return slugs;
}

async function resolveMetacritic(title, limit) {
  const titleWords = normalizeWords(title);
  const guessSlug = slugify(title);

  const [guessResult, searchSlugs] = await Promise.all([
    limit(() => fetchMetacriticGuess(guessSlug)),
    limit(() => fetchMetacriticSearchCandidates(title)),
  ]);

  const plausibleSlugs = searchSlugs.filter(slug => matchScore(titleWords, slug.split('-')) >= 0.8);
  const candidateSlugs = [...new Set([guessResult ? guessResult.slug : null, ...plausibleSlugs].filter(Boolean))];

  if (candidateSlugs.length === 0) return { status: 'not_found', siblingCount: 0 };

  // How many OTHER plausible candidates exist besides whichever one we resolve to --
  // real evidence of collision risk (e.g. a franchise original vs. its reboot), unlike
  // the mere presence of an edition-tag word in the hint (see main()'s editionSignal use).
  const siblingCount = candidateSlugs.length - 1;

  // Guess landed on a page whose own title is an exact word-set match -- and no other
  // search candidate is an equally exact match -- treat as confidently resolved.
  if (guessResult && isExactMatch(titleWords, normalizeWords(guessResult.name))) {
    const otherExact = plausibleSlugs.filter(
      slug => slug !== guessResult.slug && isExactMatch(titleWords, slug.split('-'))
    );
    if (otherExact.length === 0) {
      return { status: 'resolved', data: guessResult, siblingCount };
    }
  }

  const exactSlugs = candidateSlugs.filter(slug => isExactMatch(titleWords, slug.split('-')));
  const finalists = exactSlugs.length > 0 ? exactSlugs : candidateSlugs;

  if (finalists.length === 1) {
    const data = finalists[0] === guessResult?.slug ? guessResult : await limit(() => fetchMetacriticGuess(finalists[0]));
    return data ? { status: 'resolved', data, siblingCount } : { status: 'not_found', siblingCount: 0 };
  }

  // Multiple plausible candidates (e.g. a franchise original vs. its reboot) -- fetch
  // each so the disambiguator agent gets real data instead of just a slug guess.
  const candidates = (
    await Promise.all(
      finalists.slice(0, 5).map(slug =>
        limit(() => (slug === guessResult?.slug ? Promise.resolve(guessResult) : fetchMetacriticGuess(slug)))
      )
    )
  ).filter(Boolean);

  if (candidates.length <= 1) {
    return candidates.length === 1
      ? { status: 'resolved', data: candidates[0], siblingCount }
      : { status: 'not_found', siblingCount: 0 };
  }
  return { status: 'ambiguous', candidates, siblingCount };
}

async function fetchSteamCandidates(title) {
  const data = await fetchJson(
    `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(title)}&cc=us&l=en`
  );
  if (!data || !data.items) return [];
  return data.items.filter(item => item.type === 'app' && item.platforms && item.platforms.windows);
}

async function fetchSteamDetails(appid) {
  const [reviews, details] = await Promise.all([
    fetchJson(
      `https://store.steampowered.com/appreviews/${appid}?json=1&language=all&purpose=histogram&num_per_page=0`
    ),
    fetchJson(`https://store.steampowered.com/api/appdetails?appids=${appid}`),
  ]);

  const snippetsData = await fetchJson(
    `https://store.steampowered.com/appreviews/${appid}?json=1&filter=all&language=english&num_per_page=10&purpose=print`
  );

  const summary = reviews && reviews.query_summary;
  const steam_score =
    summary && summary.total_reviews > 0 ? Math.round((100 * summary.total_positive) / summary.total_reviews) : null;

  const appDetails = details && details[String(appid)] && details[String(appid)].data;
  const genre = appDetails && appDetails.genres ? appDetails.genres.map(g => g.description).join('/') : null;
  const name = appDetails ? appDetails.name : null;

  const review_snippets = snippetsData && snippetsData.reviews ? snippetsData.reviews.map(r => r.review.slice(0, 300)) : [];

  return { appid, name, steam_score, genre, review_snippets };
}

async function resolveSteam(title, limit) {
  const titleWords = normalizeWords(title);
  const candidates = await limit(() => fetchSteamCandidates(title));
  if (candidates.length === 0) return { status: 'not_found', siblingCount: 0 };

  const plausible = candidates.filter(c => matchScore(titleWords, normalizeWords(c.name)) >= 0.8);
  if (plausible.length === 0) return { status: 'not_found', siblingCount: 0 };

  // Real evidence of collision risk (distinct plausible entries beyond the chosen one),
  // as opposed to just an edition-tag word appearing in the hint -- see main().
  const siblingCount = plausible.length - 1;

  const exact = plausible.filter(c => isExactMatch(titleWords, normalizeWords(c.name)));
  const finalists = exact.length > 0 ? exact : plausible;

  if (finalists.length === 1) {
    const data = await limit(() => fetchSteamDetails(finalists[0].id));
    return { status: 'resolved', data, siblingCount };
  }

  const details = await Promise.all(finalists.slice(0, 5).map(c => limit(() => fetchSteamDetails(c.id))));
  return { status: 'ambiguous', candidates: details, siblingCount };
}

// Small concurrency limiter -- no external deps available to this script.
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return fn =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

async function main() {
  const items = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const limit = createLimiter(8);
  let errors = 0;

  const rows = await Promise.all(
    items.map(async ({ title, hint }) => {
      try {
        const [mc, steam] = await Promise.all([resolveMetacritic(title, limit), resolveSteam(title, limit)]);
        const editionSignal = hasEditionSignal(hint);

        const row = {
          clean_title: title,
          hint,
          metacritic_score: null,
          genre: null,
          year: null,
          steam_score: null,
          review_snippets: [],
          ambiguous: {},
        };

        if (mc.status === 'resolved') {
          row.metacritic_score = mc.data.metacritic_score;
          row.genre = mc.data.genre;
          row.year = mc.data.year;
          if (editionSignal && mc.siblingCount > 0) {
            row.ambiguous.metacritic = { reason: 'edition_signal_recheck', candidates: [mc.data] };
          }
        } else if (mc.status === 'ambiguous') {
          row.ambiguous.metacritic = { reason: 'multiple_candidates', candidates: mc.candidates };
        }

        if (steam.status === 'resolved') {
          row.steam_score = steam.data.steam_score;
          row.review_snippets = steam.data.review_snippets;
          if (!row.genre) row.genre = steam.data.genre;
          if (editionSignal && steam.siblingCount > 0) {
            row.ambiguous.steam = { reason: 'edition_signal_recheck', candidates: [steam.data] };
          }
        } else if (steam.status === 'ambiguous') {
          row.ambiguous.steam = { reason: 'multiple_candidates', candidates: steam.candidates };
        }

        return row;
      } catch (e) {
        errors++;
        console.error(`Error resolving "${title}": ${e.message}`);
        return { clean_title: title, hint, metacritic_score: null, genre: null, year: null, steam_score: null, review_snippets: [], ambiguous: {}, error: e.message };
      }
    })
  );

  fs.writeFileSync(outputPath, JSON.stringify(rows, null, 2));

  const resolvedMc = rows.filter(r => r.metacritic_score !== null).length;
  const resolvedSteam = rows.filter(r => r.steam_score !== null).length;
  const ambiguousCount = rows.filter(r => r.ambiguous.metacritic || r.ambiguous.steam).length;
  console.log(
    `${rows.length} titles: ${resolvedMc} metacritic resolved, ${resolvedSteam} steam resolved, ${ambiguousCount} ambiguous, ${errors} errors.`
  );
}

main();
