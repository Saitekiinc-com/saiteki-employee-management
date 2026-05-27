const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildProfileSearchIndex } = require('./build-profile-search-index');
const { embedProfileSearchIndex, writeEmbeddedIndex } = require('./embed-profile-search-index');
const { searchProfileVectors } = require('./people-finder-vector-search');
const { createLocalFixtureProvider } = require('./profile-embedding-utils');

async function main() {
  const profileGraph = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/employee-profile-graph.jsonld'), 'utf8'));
  const index = buildProfileSearchIndex(profileGraph, '2026-05-27T00:00:00.000Z');
  const provider = createLocalFixtureProvider({ dimensions: 1024 });
  const embedded = await embedProfileSearchIndex(index, provider, {
    outputFile: path.join(os.tmpdir(), 'missing-profile-search-index.embedded.json')
  });

  assert.strictEqual(embedded.embedding.status, 'generated');
  assert.strictEqual(embedded.embedding.provider, 'local-fixture');
  assert.strictEqual(embedded['@graph'].length, index['@graph'].length);
  assert(embedded['@graph'].every((unit) => unit.embedding?.vector?.length === 1024));

  const pokemon = await searchProfileVectors(embedded, 'ポケカが好きな人', provider, {
    threshold: 0.15,
    topUnits: 60
  });
  const pokemonNames = pokemon.map((result) => result.employeeName);
  assert(pokemonNames.includes('小島遼祐'), '小島遼祐 should match Pokemon card query');
  assert(pokemonNames.includes('榎本詩織'), '榎本詩織 should match Pokemon card query');
  assert(
    pokemon.some((result) => result.quotes.some((quote) => quote.text.includes('ポケカ'))),
    'pokemon vector results should preserve concrete message quotes'
  );

  const qa = await searchProfileVectors(embedded, 'QAエンジニア', provider, {
    threshold: 0.18,
    topUnits: 80
  });
  const kaimai = qa.find((result) => result.employeeName === '開米 敦則');
  assert(kaimai, '開米 敦則 should match QA engineer query');
  assert(
    kaimai.reasons.some((reason) => reason.relationLabel.includes('QAエンジニアリング')),
    'QA result should expose the direct QA engineering reason'
  );
  assert(
    kaimai.quotes.some((quote) => quote.text.includes('QAエンジニア')),
    'QA result should include a QA quote'
  );

  const testWork = await searchProfileVectors(embedded, 'テスト業務の経験者', provider, {
    threshold: 0.18,
    topUnits: 80
  });
  assert(
    testWork.some((result) => result.employeeName === '上原基臣'),
    '上原基臣 should match test work experience query'
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-vector-search-'));
  const tempFile = path.join(tempDir, 'profile-search-index.embedded.json');
  writeEmbeddedIndex(embedded, tempFile);
  const written = JSON.parse(fs.readFileSync(tempFile, 'utf8'));
  assert.strictEqual(written['@graph'].length, embedded['@graph'].length);

  console.log('profile vector search OK');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
