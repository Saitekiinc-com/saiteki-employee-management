const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const PROFILE_GRAPH_FILE = path.join(DATA_DIR, 'employee-profile-graph.jsonld');
const OUTPUT_FILE = path.join(DATA_DIR, 'profile-search-index.json');

const CONTEXT = {
  saiteki: 'https://saiteki.example/schema#',
  schema: 'https://schema.org/',
  person: 'saiteki:person',
  topic: 'saiteki:topic',
  edge: 'saiteki:edge',
  fact: 'saiteki:fact',
  message: 'saiteki:message',
  searchText: 'saiteki:searchText',
  semanticType: 'saiteki:semanticType'
};

const CATEGORY_TO_SEMANTIC_TYPE = {
  strength: 'work_strength',
  work_style: 'work_style',
  work_topic: 'technical_skill',
  interest: 'interest',
  value: 'personal_value',
  recent_topic: 'personal_value'
};

const TOPIC_TYPE_TO_SEMANTIC_TYPE = {
  work_strength: 'work_strength',
  work_style: 'work_style',
  work_topic: 'technical_skill',
  interest: 'interest',
  value: 'personal_value',
  motivation: 'personal_value'
};

const ROLE_PATTERN = /qa|pm|pmo|em|人事|総務|採用|営業|経理|労務|エンジニア|デザイナー|マネージャ|マネージャー|リーダー|sv|職種|担当|役割/i;
const BUSINESS_DOMAIN_PATTERN = /採用|営業|経理|労務|総務|人事|オンボーディング|福利厚生|契約|請求|広報|ブランディング|教育|研修/i;
const TECHNICAL_PATTERN = /ai|aws|azure|gcp|react|next|rag|qa|api|db|sql|bi|github|slack|notion|cursor|gemini|テスト|品質|開発|運用|監視|設計|要件|インフラ|サーバ|プロンプト|自動化|アーキテクチャ/i;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function cleanText(value, maxLength = 2000) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function nodeName(node) {
  return node?.['schema:name'] || node?.name || '';
}

function stripPrefix(value, prefix) {
  return String(value || '').replace(new RegExp(`^${prefix}:`), '');
}

function buildIndexes(graph) {
  return {
    peopleById: new Map(graph.filter((node) => node['@type'] === 'saiteki:Person').map((node) => [node['@id'], node])),
    topicsById: new Map(graph.filter((node) => node['@type'] === 'saiteki:Topic').map((node) => [node['@id'], node])),
    factsById: new Map(graph.filter((node) => node['@type'] === 'saiteki:ProfileFact').map((node) => [node['@id'], node])),
    messagesById: new Map(graph.filter((node) => node['@type'] === 'saiteki:SlackMessage').map((node) => [node['@id'], node]))
  };
}

function inferSemanticType(edge, topic) {
  const category = edge['saiteki:category'];
  const topicType = topic?.['saiteki:topicType'];
  const text = [
    edge['saiteki:relationLabel'],
    nodeName(topic),
    ...(topic?.['saiteki:aliases'] || [])
  ].join(' ');

  if (edge['saiteki:uiCategory'] === '興味・人柄') {
    return TOPIC_TYPE_TO_SEMANTIC_TYPE[topicType] || CATEGORY_TO_SEMANTIC_TYPE[category] || 'interest';
  }

  if (ROLE_PATTERN.test(text)) return 'role_experience';
  if (BUSINESS_DOMAIN_PATTERN.test(text)) return 'business_domain';
  if (TECHNICAL_PATTERN.test(text)) return 'technical_skill';
  return TOPIC_TYPE_TO_SEMANTIC_TYPE[topicType] || CATEGORY_TO_SEMANTIC_TYPE[category] || 'work_strength';
}

function factEvidenceProfileFields(facts) {
  return facts.flatMap((fact) => fact['saiteki:evidenceProfileFields'] || [])
    .map((field) => ({
      sourceField: field.sourceField,
      text: cleanText(field.text, 500)
    }))
    .filter((field) => field.sourceField && field.text);
}

function quoteFromMessage(message) {
  if (!message) return null;
  const text = cleanText(message['saiteki:textPreview'], 500);
  if (!text) return null;
  return {
    messageId: message['@id'],
    text,
    channelId: message['saiteki:channelId'] || '',
    channelName: message['saiteki:channelName'] || '',
    messageTs: message['saiteki:messageTs'] || '',
    threadTs: message['saiteki:threadTs'] || null,
    authorName: message['saiteki:authorName'] || ''
  };
}

function buildSearchText({ edge, topic, facts }) {
  const evidenceFields = factEvidenceProfileFields(facts);
  return unique([
    edge['saiteki:relationLabel'],
    nodeName(topic),
    ...(topic?.['saiteki:aliases'] || []),
    edge['saiteki:predicate'],
    edge['saiteki:category'],
    ...(edge['saiteki:detailBullets'] || []),
    ...facts.flatMap((fact) => fact['saiteki:detailBullets'] || []),
    ...evidenceFields.map((field) => field.text)
  ]).map((text) => cleanText(text, 1000)).join('\n');
}

function buildProfileSearchIndex(profileGraph, generatedAt = new Date().toISOString()) {
  const graph = profileGraph['@graph'] || [];
  const { peopleById, topicsById, factsById, messagesById } = buildIndexes(graph);
  const edges = graph.filter((node) => node['@type'] === 'saiteki:ProfileEdge');
  const units = edges.map((edge) => {
    const person = peopleById.get(edge['saiteki:source']);
    const topic = topicsById.get(edge['saiteki:target']);
    const facts = (edge['saiteki:facts'] || []).map((id) => factsById.get(id)).filter(Boolean);
    const evidenceMessageIds = unique([
      ...(edge['saiteki:evidenceMessages'] || []),
      ...facts.flatMap((fact) => fact['saiteki:evidenceMessages'] || [])
    ]);
    const quotes = evidenceMessageIds.map((id) => quoteFromMessage(messagesById.get(id))).filter(Boolean);
    const evidenceProfileFields = factEvidenceProfileFields(facts);

    return {
      '@id': `search-unit:${stripPrefix(edge['@id'], 'edge')}`,
      '@type': 'saiteki:ProfileSearchUnit',
      person: edge['saiteki:source'],
      personName: nodeName(person) || stripPrefix(edge['saiteki:source'], 'person'),
      slackIds: person?.['saiteki:slackIds'] || [],
      edge: edge['@id'],
      facts: edge['saiteki:facts'] || [],
      topic: edge['saiteki:target'],
      topicLabel: nodeName(topic) || stripPrefix(edge['saiteki:target'], 'topic'),
      topicAliases: topic?.['saiteki:aliases'] || [],
      uiCategory: edge['saiteki:uiCategory'],
      category: edge['saiteki:category'],
      semanticType: inferSemanticType(edge, topic),
      semanticTypeSource: 'profile_graph_metadata',
      predicate: edge['saiteki:predicate'],
      relationLabel: edge['saiteki:relationLabel'],
      sourceField: edge['saiteki:sourceField'] || null,
      sourceFields: edge['saiteki:sourceFields'] || [],
      confidence: edge['saiteki:confidence'],
      extractionMethod: edge['saiteki:extractionMethod'],
      firstSeenAt: edge['saiteki:firstSeenAt'] || null,
      updatedAt: edge['saiteki:updatedAt'] || null,
      detailBullets: edge['saiteki:detailBullets'] || [],
      evidenceMessageIds,
      evidenceProfileFields,
      quotes,
      searchText: buildSearchText({ edge, topic, facts })
    };
  });

  return {
    '@context': CONTEXT,
    generatedAt,
    sourceFiles: ['data/employee-profile-graph.jsonld'],
    embedding: {
      status: 'not_generated',
      nextStep: 'Run the embedding generation step to add vectors for searchText.'
    },
    '@graph': units
  };
}

function writeProfileSearchIndex(index, outputFile = OUTPUT_FILE) {
  fs.writeFileSync(outputFile, `${JSON.stringify(index, null, 2)}\n`);
}

function main() {
  const profileGraph = readJson(PROFILE_GRAPH_FILE);
  const index = buildProfileSearchIndex(profileGraph);
  writeProfileSearchIndex(index);
  console.log(`Generated ${index['@graph'].length} profile search units at ${OUTPUT_FILE}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildProfileSearchIndex,
  inferSemanticType,
  writeProfileSearchIndex
};
