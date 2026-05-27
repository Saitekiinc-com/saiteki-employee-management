const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildSearchFacets, writeSearchFacets } = require('./build-search-facets');
const { resolveSearchCategory, searchFacets, stripQueryHelpers } = require('./people-finder-rag-search');

const employees = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/employees.json'), 'utf8'));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-finder-'));
const tempFacetsFile = path.join(tempDir, 'search-facets.jsonld');

const sampleMessages = [
  {
    id: 'primary:C_TEST:1',
    workspace: 'primary',
    channelId: 'C_TEST',
    user: 'U0AFQUQ1H9R',
    text: 'ゲームでは最近では特にガンダムバトルオペレーション2をプレイしています。',
    messageTs: '1770000000.000000',
    threadTs: null,
    parentUserId: null,
    permalink: null
  }
];

assert.strictEqual(stripQueryHelpers('ポケモンが好きな人'), 'ポケモン');
assert.strictEqual(stripQueryHelpers('AWSに詳しい人、または経験者'), 'aws');
assert.deepStrictEqual(resolveSearchCategory('AWSを知っている人', '興味・人柄'), {
  category: '仕事・相談',
  inferred: true,
  selectedCategory: '興味・人柄'
});

const facets = buildSearchFacets(employees, sampleMessages);
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
    && result.reasons.some((reason) => reason.label === 'ポケモン（ゲーム・カード）')),
  'pokemon result should expose 小島遼祐 specific pokemon context'
);
assert(
  pokemonResults.some((result) => result.employeeName === '藤井芙美子'
    && result.reasons.some((reason) => reason.label === '新しいメンバーとの共通の趣味（ポケモン）')),
  'pokemon result should expose 藤井芙美子 specific pokemon context'
);
assert(
  pokemonResults.some((result) => result.reasons.some((reason) => reason.label.includes('ポケモン') && reason.sourceField)),
  'pokemon results should retain the matched source field for evidence display'
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
