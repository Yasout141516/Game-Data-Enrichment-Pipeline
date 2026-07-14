export const meta = {
  name: 'game-data-enrichment',
  description: 'Cleans a batch of pre-stripped game repack filenames and researches Metacritic/Steam/Steam-Community-sentiment data per title',
  phases: [
    { title: 'Clean titles' },
    { title: 'Research' },
  ],
}

const CLEAN_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          raw: { type: 'string' },
          clean_title: { type: 'string' },
        },
        required: ['raw', 'clean_title'],
      },
    },
  },
  required: ['items'],
}

const METACRITIC_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          metacritic_score: { type: ['number', 'null'] },
          genre: { type: ['string', 'null'] },
          year: { type: ['number', 'null'] },
        },
        required: ['title', 'metacritic_score', 'genre', 'year'],
      },
    },
  },
  required: ['items'],
}

const STEAM_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          steam_score: { type: ['number', 'null'] },
        },
        required: ['title', 'steam_score'],
      },
    },
  },
  required: ['items'],
}

const STEAM_COMMUNITY_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          steam_community_sentiment: { type: ['number', 'null'] },
          basis: { type: 'string' },
        },
        required: ['title', 'steam_community_sentiment', 'basis'],
      },
    },
  },
  required: ['items'],
}

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

phase('Clean titles')
const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args
const rawTitles = (parsedArgs && parsedArgs.titles) || []
log(`Cleaning ${rawTitles.length} titles...`)
const cleanResult = await agent(
  `Clean these pre-stripped game filenames into canonical titles per your instructions. Return one output item per input item, same order. Input JSON array:\n${JSON.stringify(rawTitles)}`,
  { agentType: 'title-cleaner', schema: CLEAN_SCHEMA, phase: 'Clean titles' }
)
const cleaned = cleanResult.items

// Dedupe by clean_title before researching, so identical titles (e.g. the same base
// game re-listed under a different repack group) only get researched once per batch.
// Every raw row still gets its own output row via the join at the end. Keep the raw
// listing(s) behind each clean_title as a disambiguation hint (e.g. "Platinum Edition"
// tells the researchers this is the classic game, not a same-named reboot) -- otherwise
// the 3 research agents can independently resolve an ambiguous title to *different*
// real games and produce a row that mixes data from two unrelated releases.
const rawsByTitle = {}
for (const c of cleaned) {
  (rawsByTitle[c.clean_title] ||= new Set()).add(c.raw)
}
const uniqueTitles = Object.keys(rawsByTitle)
const titleContexts = uniqueTitles.map(t => ({
  title: t,
  hint: [...rawsByTitle[t]].join(' / '),
}))

phase('Research')
const groups = chunk(titleContexts, 10)
log(`Researching ${uniqueTitles.length} unique titles (of ${cleaned.length} rows) in ${groups.length} groups...`)

function formatContexts(group) {
  return group.map(g => `"${g.title}" (original listing: "${g.hint}")`).join('\n')
}

const groupResults = await parallel(groups.map(group => async () => {
  const [mc, steam, steamCommunity] = await parallel([
    () => agent(
      `Research Metacritic score, genre, and year for these titles per your instructions. Each line gives the canonical title plus the original scraped listing in parentheses -- use the listing to disambiguate (e.g. edition/subtitle hints) when the title alone could match more than one real game, but report results keyed by the canonical title (the quoted part before the parenthetical):\n${formatContexts(group)}`,
      { agentType: 'metacritic-researcher', schema: METACRITIC_SCHEMA, phase: 'Research' }
    ),
    () => agent(
      `Research Steam user score for these titles per your instructions. Each line gives the canonical title plus the original scraped listing in parentheses -- use the listing to disambiguate (e.g. edition/subtitle hints) when the title alone could match more than one real game, but report results keyed by the canonical title (the quoted part before the parenthetical):\n${formatContexts(group)}`,
      { agentType: 'steam-researcher', schema: STEAM_SCHEMA, phase: 'Research' }
    ),
    () => agent(
      `Estimate Steam Community sentiment for these titles per your instructions. Each line gives the canonical title plus the original scraped listing in parentheses -- use the listing to disambiguate (e.g. edition/subtitle hints) when the title alone could match more than one real game, but report results keyed by the canonical title (the quoted part before the parenthetical):\n${formatContexts(group)}`,
      { agentType: 'steam-community-sentiment', schema: STEAM_COMMUNITY_SCHEMA, phase: 'Research' }
    ),
  ])
  return { mc, steam, steamCommunity }
}))

const dataByTitle = {}
for (const title of uniqueTitles) dataByTitle[title] = {}
for (const r of groupResults) {
  if (!r) continue
  if (r.mc) for (const item of r.mc.items) {
    dataByTitle[item.title] = {
      ...dataByTitle[item.title],
      metacritic_score: item.metacritic_score,
      genre: item.genre,
      year: item.year,
    }
  }
  if (r.steam) for (const item of r.steam.items) {
    dataByTitle[item.title] = { ...dataByTitle[item.title], steam_score: item.steam_score }
  }
  if (r.steamCommunity) for (const item of r.steamCommunity.items) {
    dataByTitle[item.title] = {
      ...dataByTitle[item.title],
      steam_community_sentiment: item.steam_community_sentiment,
      steam_community_sentiment_basis: item.basis,
    }
  }
}

const rows = cleaned.map(c => {
  const d = dataByTitle[c.clean_title] || {}
  return {
    raw: c.raw,
    clean_title: c.clean_title,
    metacritic_score: d.metacritic_score ?? null,
    steam_score: d.steam_score ?? null,
    steam_community_sentiment: d.steam_community_sentiment ?? null,
    steam_community_sentiment_basis: d.steam_community_sentiment_basis ?? null,
    genre: d.genre ?? null,
    year: d.year ?? null,
  }
})

log(`Batch done: ${rows.length} rows, ${rows.filter(r => r.metacritic_score != null).length} with Metacritic scores.`)
return rows
