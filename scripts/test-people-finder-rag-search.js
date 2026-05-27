const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildSearchFacets, writeSearchFacets } = require('./build-search-facets');
const { buildEmployeeProfileGraph, readProfileGraphSource } = require('./build-employee-profile-graph');
const { resolveSearchCategory, searchFacets, stripQueryHelpers } = require('./people-finder-rag-search');

const employees = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/employees.json'), 'utf8'));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-finder-'));
const tempFacetsFile = path.join(tempDir, 'search-facets.jsonld');

const slackMessages = fs.readFileSync(path.join(__dirname, '../data/slack-messages.jsonl'), 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const profileGraph = buildEmployeeProfileGraph({
  employees,
  slackMessages,
  source: readProfileGraphSource(),
  generatedAt: '2026-05-27T00:00:00.000Z'
});

assert.strictEqual(stripQueryHelpers('ポケモンが好きな人'), 'ポケモン');
assert.strictEqual(stripQueryHelpers('AWSに詳しい人、または経験者'), 'aws');
assert.deepStrictEqual(resolveSearchCategory('AWSを知っている人', '興味・人柄'), {
  category: '仕事・相談',
  inferred: true,
  selectedCategory: '興味・人柄'
});

const facets = buildSearchFacets(employees, slackMessages, profileGraph);
writeSearchFacets(facets, tempFacetsFile);

const graph = JSON.parse(fs.readFileSync(tempFacetsFile, 'utf8'))['@graph'];
assert(graph.length > employees.length, 'facets should be generated for employees');
assert(
  graph.some((facet) => facet.employeeName === '上原基臣' && facet.messageQuotes.length > 0),
  'message quotes should be attached to matching facets'
);

const pokemonResults = searchFacets(graph, 'ポケモンが好きな人', { category: '興味・人柄', threshold: 0.16 });
const pokemon = pokemonResults.map((result) => result.employeeName);
assert(pokemon.includes('小島遼祐'), '小島遼祐 should match pokemon');
assert(pokemon.includes('藤井芙美子'), '藤井芙美子 should match pokemon');
assert(pokemon.includes('榎本詩織'), '榎本詩織 should match pokemon');
assert(
  pokemonResults.some((result) => result.employeeName === '小島遼祐'
    && result.reasons.some((reason) => reason.label === 'ポケモンのゲーム・ポケカ収集')),
  'pokemon result should expose 小島遼祐 specific pokemon context'
);
assert(
  pokemonResults.some((result) => result.employeeName === '藤井芙美子'
    && result.reasons.some((reason) => reason.label === '家族と社員交流のポケモン文脈')),
  'pokemon result should expose 藤井芙美子 specific pokemon context'
);
assert(
  pokemonResults.some((result) => result.reasons.some((reason) => reason.evidenceSnippets?.some((snippet) => snippet.text.includes('ジムバトル')))),
  'pokemon results should expose concrete graph fact bullets'
);
assert(
  pokemonResults.some((result) => result.messageQuotes.some((quote) => quote.text.includes('ポケカ'))),
  'pokemon results should include saved Slack message quotes from graph evidence'
);

const aws = searchFacets(graph, 'AWS運用に詳しい人', { category: '仕事・相談', threshold: 0.16 })
  .map((result) => result.employeeName);
assert(aws.includes('真栄城則明'), '真栄城則明 should match AWS operations');

const inferredAws = searchFacets(graph, 'AWSに詳しい人、または経験者', { category: '興味・人柄' })
  .map((result) => result.employeeName);
assert(inferredAws.includes('真栄城則明'), 'AWS query should infer work category');
assert(!inferredAws.includes('榎本詩織'), 'AWS query should not match broad personal experience facets');

const gundam = searchFacets(graph, 'ガンダムが好きな人', { category: '興味・人柄', threshold: 0.16 });
const uehara = gundam.find((result) => result.employeeName === '上原基臣');
assert(uehara, '上原基臣 should match Gundam');
assert(uehara.messageQuotes.length > 0, 'Gundam result should include a message quote');

console.log('people finder RAG search OK');
