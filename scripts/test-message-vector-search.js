const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildMessageSearchIndex } = require('./build-message-search-index');
const { embedProfileSearchIndex } = require('./embed-profile-search-index');
const { searchProfileVectors } = require('./people-finder-vector-search');
const { createLocalFixtureProvider } = require('./profile-embedding-utils');
const { createReranker, rerankPeopleResults } = require('./rerank-people-finder-results');

async function main() {
  const employees = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/employees.json'), 'utf8'));
  const messages = fs.readFileSync(path.join(__dirname, '../data/slack-messages.jsonl'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const index = buildMessageSearchIndex({ employees, messages, generatedAt: '2026-05-28T00:00:00.000Z' });
  const units = index['@graph'];

  assert(units.length > 1000, 'message index should include employee-authored Slack messages');
  assert(units.every((unit) => unit.semanticType === 'slack_message'));
  assert(units.every((unit) => unit.quotes?.[0]?.text), 'message units should carry display quotes');
  assert(!units.some((unit) => unit.searchText.includes('チャンネルに参加しました')), 'system join messages should be excluded');
  assert(!units.some((unit) => unit.searchText.includes('チャットコピペ')), 'pasted chat transcripts should not be attributed to the poster');

  const provider = createLocalFixtureProvider({ dimensions: 1024 });
  const embedded = await embedProfileSearchIndex(index, provider, {
    outputFile: path.join(os.tmpdir(), `message-search-index-test-${process.pid}.embedded.json`)
  });
  const reranker = await createReranker({ provider: 'local-fixture' });

  const pokemonCandidates = await searchProfileVectors(embedded, 'ポケモン', provider, {
    threshold: 0.12,
    topUnits: 100
  });
  const pokemon = await rerankPeopleResults('ポケモン', pokemonCandidates, reranker, {
    candidateLimit: 12
  });
  const pokemonNames = pokemon.map((result) => result.employeeName);
  assert(pokemonNames.includes('小島遼祐'), 'message vector search should find 小島遼祐 from Pokemon messages');
  assert(pokemonNames.includes('榎本詩織'), 'message vector search should find 榎本詩織 from Pokemon messages');
  assert(
    pokemon.some((result) => result.quotes.some((quote) => quote.text.includes('ポケモン') || quote.text.includes('ポケカ'))),
    'pokemon results should expose concrete matching messages'
  );

  const securityCandidates = await searchProfileVectors(embedded, 'セキュリティについて教えて欲しい', provider, {
    threshold: 0.12,
    topUnits: 120
  });
  const security = await rerankPeopleResults('セキュリティについて教えて欲しい', securityCandidates, reranker, {
    candidateLimit: 12
  });
  assert(security.length > 0, 'message vector search should find security-related speakers');
  assert(
    security.some((result) => result.quotes.some((quote) => quote.text.includes('セキュリティ'))),
    'security results should expose concrete security messages'
  );

  console.log('message vector search OK');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
