const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { buildProfileSearchIndex } = require('./build-profile-search-index');
const { embedProfileSearchIndex } = require('./embed-profile-search-index');
const { searchProfileVectors } = require('./people-finder-vector-search');
const { createLocalFixtureProvider } = require('./profile-embedding-utils');
const { applyDecisions, createReranker, rerankPeopleResults } = require('./rerank-people-finder-results');

async function main() {
  const profileGraph = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/employee-profile-graph.jsonld'), 'utf8'));
  const index = buildProfileSearchIndex(profileGraph, '2026-05-27T00:00:00.000Z');
  const embeddingProvider = createLocalFixtureProvider({ dimensions: 1024 });
  const embedded = await embedProfileSearchIndex(index, embeddingProvider, {
    outputFile: path.join('/tmp', 'missing-profile-search-index.embedded.json')
  });
  const reranker = await createReranker({ provider: 'local-fixture' });

  const qaVectorResults = await searchProfileVectors(embedded, 'QAエンジニア', embeddingProvider, {
    threshold: 0.15,
    topUnits: 100
  });
  assert(
    qaVectorResults.some((result) => result.employeeName === '小松田真伍'),
    'vector candidates should still contain adjacent/noisy engineer results before reranking'
  );

  const qaReranked = await rerankPeopleResults('QAエンジニア', qaVectorResults, reranker, {
    candidateLimit: 12
  });
  const qaNames = qaReranked.map((result) => result.employeeName);
  assert(qaNames.includes('開米 敦則'), 'rerank should keep direct QA result');
  assert(qaNames.includes('上原基臣'), 'rerank should keep adjacent test experience result');
  assert(!qaNames.includes('小松田真伍'), 'rerank should drop engineer-only results for QA query');
  const kaimai = qaReranked.find((result) => result.employeeName === '開米 敦則');
  assert.strictEqual(kaimai.intentFit, 'direct');
  assert(kaimai.reasons.some((reason) => reason.relationLabel.includes('QAエンジニアリング')));

  const pokemonVectorResults = await searchProfileVectors(embedded, 'ポケカが好きな人', embeddingProvider, {
    threshold: 0.15,
    topUnits: 80
  });
  const pokemonReranked = await rerankPeopleResults('ポケカが好きな人', pokemonVectorResults, reranker, {
    candidateLimit: 10
  });
  const pokemonNames = pokemonReranked.map((result) => result.employeeName);
  assert(pokemonNames.includes('小島遼祐'), 'rerank should keep concrete Pokemon card result');
  assert(pokemonNames.includes('榎本詩織'), 'rerank should keep concrete Pokemon result');
  assert(
    pokemonReranked.every((result) => ['direct', 'adjacent'].includes(result.intentFit)),
    'rerank should only return displayable intent fits'
  );

  const awsMessageResults = [
    {
      employeeName: 'AWS 太郎',
      score: 0.8,
      reasons: [
        {
          unitId: 'search-message:primary:C1:123.456',
          semanticType: 'slack_message',
          relationLabel: 'Slack発言: 自己紹介',
          topicLabel: '自己紹介',
          detailBullets: ['AWS運用構築の経験があります']
        }
      ],
      quotes: [
        {
          unitId: 'search-message:primary:C1:123.456',
          messageId: 'message:primary:C1:123.456',
          text: 'AWS運用構築の経験があります'
        }
      ]
    }
  ];
  const idMismatchKept = applyDecisions(awsMessageResults, [
    {
      employeeName: 'AWS 太郎',
      intentFit: 'direct',
      confidence: 0.9,
      reason: 'AWS経験の根拠がある',
      evidenceSupported: true,
      selectedReasonUnitIds: ['提示されたunitId']
    }
  ]);
  assert.strictEqual(idMismatchKept.length, 1, 'LLM-supported Slack message result should survive when only the returned reason id format is invalid');

  const unsupportedDropped = applyDecisions(awsMessageResults, [
    {
      employeeName: 'AWS 太郎',
      intentFit: 'reject',
      confidence: 0.1,
      reason: '根拠がない',
      evidenceSupported: false,
      selectedReasonUnitIds: []
    }
  ]);
  assert.strictEqual(unsupportedDropped.length, 0, 'unsupported Slack message result should still be dropped');

  console.log('people finder rerank OK');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
