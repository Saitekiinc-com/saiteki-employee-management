const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildProfileSearchIndex, writeProfileSearchIndex } = require('./build-profile-search-index');

const profileGraph = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/employee-profile-graph.jsonld'), 'utf8'));
const index = buildProfileSearchIndex(profileGraph, '2026-05-27T00:00:00.000Z');
const graph = profileGraph['@graph'];
const units = index['@graph'];
const edges = graph.filter((node) => node['@type'] === 'saiteki:ProfileEdge');

assert.strictEqual(units.length, edges.length, 'search index should create one unit per profile edge');
assert(units.length > 800, 'search index should include the full generated profile graph');
assert.strictEqual(index.embedding.status, 'not_generated', 'Phase 2 index should not claim embeddings exist');

for (const unit of units) {
  assert.strictEqual(unit['@type'], 'saiteki:ProfileSearchUnit');
  assert(unit.person, 'unit should reference a person');
  assert(unit.personName, 'unit should include a person name');
  assert(unit.edge, 'unit should reference a profile edge');
  assert(unit.topic, 'unit should reference a topic');
  assert(unit.topicLabel, 'unit should include a topic label');
  assert(unit.uiCategory, 'unit should include the Slack UI category');
  assert(unit.category, 'unit should include the graph category');
  assert(unit.semanticType, 'unit should include a semantic type for vector reranking');
  assert(unit.searchText.includes(unit.topicLabel), 'searchText should include the topic label');
}

const pokemon = units.find((unit) => unit.personName === '小島遼祐' && unit.searchText.includes('ポケカ'));
assert(pokemon, 'pokemon search unit should preserve concrete Pokemon context');
assert.strictEqual(pokemon.semanticType, 'interest');
assert(pokemon.quotes.some((quote) => quote.text.includes('ポケカ')), 'pokemon unit should include a matching quote');

const kaimaiQa = units.find((unit) => unit.personName === '開米 敦則'
  && unit.relationLabel === 'QAエンジニアリングの専門知識と長年の経験');
assert(kaimaiQa, 'QA search unit should preserve Kaimai QA context');
assert.strictEqual(kaimaiQa.semanticType, 'role_experience');
assert(kaimaiQa.quotes.some((quote) => quote.text.includes('QAエンジニア')), 'QA unit should include a QA quote');

const ueharaTest = units.find((unit) => unit.personName === '上原基臣' && unit.searchText.includes('テスト業務'));
assert(ueharaTest, 'Uehara test experience should be searchable');
assert(['role_experience', 'technical_skill'].includes(ueharaTest.semanticType));

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-search-index-'));
const tempFile = path.join(tempDir, 'profile-search-index.json');
writeProfileSearchIndex(index, tempFile);
const written = JSON.parse(fs.readFileSync(tempFile, 'utf8'));
assert.strictEqual(written['@graph'].length, units.length, 'written search index should be readable');

console.log('profile search index OK');
