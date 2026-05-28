const fs = require('fs');
const path = require('path');
require('dotenv').config({ quiet: true });

const {
  cosineSimilarity,
  createEmbeddingProvider,
  normalizeText,
  stripQueryHelpers,
  tokenize
} = require('./profile-embedding-utils');
const { createReranker, rerankPeopleResults } = require('./rerank-people-finder-results');

const DEFAULT_INDEX_FILE = path.join(__dirname, '../data/profile-search-index.embedded.json');
const DEFAULT_THRESHOLD = 0.22;
const DEFAULT_TOP_UNITS = 80;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      index++;
    }
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function unitVector(unit) {
  if (Array.isArray(unit.embedding)) return unit.embedding;
  return unit.embedding?.vector || [];
}

function ensureEmbedded(index) {
  const missing = (index['@graph'] || []).filter((unit) => unitVector(unit).length === 0);
  if (missing.length > 0) {
    throw new Error(`Embedded index has ${missing.length} units without vectors. Run scripts/embed-profile-search-index.js first.`);
  }
}

function aggregateByEmployee(scoredUnits, threshold) {
  const byEmployee = new Map();
  for (const item of scoredUnits) {
    if (item.score < threshold) continue;
    const key = item.unit.personName;
    if (!byEmployee.has(key)) {
      byEmployee.set(key, {
        employeeName: key,
        slackIds: item.unit.slackIds || [],
        score: item.score,
        reasons: [],
        quotes: []
      });
    }
    const result = byEmployee.get(key);
    result.score = Math.max(result.score, item.score);
    result.reasons.push({
      unitId: item.unit['@id'],
      edge: item.unit.edge,
      semanticType: item.unit.semanticType,
      uiCategory: item.unit.uiCategory,
      category: item.unit.category,
      relationLabel: item.unit.relationLabel,
      topicLabel: item.unit.topicLabel,
      score: Number(item.score.toFixed(4)),
      detailBullets: item.unit.detailBullets || []
    });
    result.quotes.push(...(item.unit.quotes || []).map((quote) => ({
      ...quote,
      unitId: item.unit['@id']
    })));
  }

  return [...byEmployee.values()]
    .map((result) => ({
      ...result,
      score: Number(result.score.toFixed(4)),
      reasons: result.reasons.sort((a, b) => b.score - a.score).slice(0, 3),
      quotes: dedupeQuotes(result.quotes).slice(0, 3)
    }))
    .sort((a, b) => b.score - a.score || a.employeeName.localeCompare(b.employeeName, 'ja'));
}

function dedupeQuotes(quotes) {
  const seen = new Set();
  const unique = [];
  for (const quote of quotes) {
    const key = `${quote.messageId}:${quote.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(quote);
  }
  return unique;
}

function lexicalLabelBoost(unit, queryText) {
  const textParts = [
    unit.relationLabel,
    unit.topicLabel,
    ...(unit.topicAliases || [])
  ];

  if (unit.semanticType === 'slack_message') {
    textParts.push(
      unit.searchText,
      ...(unit.detailBullets || []),
      ...(unit.quotes || []).map((quote) => quote.text)
    );
  }

  const labelText = normalizeText(textParts.filter(Boolean).join(' '));
  if (!labelText) return 0;
  const terms = tokenize(queryText).filter((term) => term.length >= 2);
  const matched = terms.filter((term) => labelText.includes(term)).length;
  const weight = unit.semanticType === 'slack_message' ? 0.09 : 0.06;
  const cap = unit.semanticType === 'slack_message' ? 0.24 : 0.18;
  return Math.min(matched * weight, cap);
}

async function searchProfileVectors(index, query, provider, options = {}) {
  ensureEmbedded(index);
  const threshold = Number(options.threshold ?? DEFAULT_THRESHOLD);
  const topUnits = Number(options.topUnits || DEFAULT_TOP_UNITS);
  const queryText = stripQueryHelpers(query) || normalizeText(query);
  const queryVector = await provider.embed(queryText, 'query');

  const scoredUnits = (index['@graph'] || [])
    .map((unit) => ({
      unit,
      score: cosineSimilarity(queryVector, unitVector(unit)) + lexicalLabelBoost(unit, queryText)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topUnits);

  return aggregateByEmployee(scoredUnits, threshold);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const query = args.query || args.q;
  if (!query) {
    console.error('Usage: node scripts/people-finder-vector-search.js --query "QAエンジニア" --file data/profile-search-index.embedded.json');
    process.exit(1);
  }
  const file = args.file || DEFAULT_INDEX_FILE;
  const index = readJson(file);
  const provider = await createEmbeddingProvider({
    provider: args.provider || index.embedding?.provider,
    model: args.model || index.embedding?.model,
    dimensions: args.dimensions
  });
  const results = await searchProfileVectors(index, query, provider, {
    threshold: args.threshold,
    topUnits: args['top-units']
  });
  const finalResults = args.rerank
    ? await rerankPeopleResults(query, results, await createReranker({
      provider: args.reranker,
      model: args['rerank-model']
    }), {
      candidateLimit: args['rerank-candidates'],
      includeAdjacent: !args['direct-only'] && args['include-adjacent'] !== 'false'
    })
    : results;
  console.log(JSON.stringify({ query, results: finalResults }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  aggregateByEmployee,
  searchProfileVectors
};
