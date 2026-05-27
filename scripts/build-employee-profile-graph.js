const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const EMPLOYEES_FILE = path.join(DATA_DIR, 'employees.json');
const SLACK_MESSAGES_FILE = path.join(DATA_DIR, 'slack-messages.jsonl');
const OVERRIDES_FILE = path.join(DATA_DIR, 'profile-graph-overrides.json');
const OUTPUT_FILE = path.join(DATA_DIR, 'employee-profile-graph.jsonld');

const ALLOWED_PREDICATES = new Set([
  'LIKES',
  'INTERESTED_IN',
  'PLAYS',
  'COLLECTS',
  'WATCHES',
  'LISTENS_TO',
  'CREATES',
  'FAMILY_CONTEXT',
  'CONNECTS_PEOPLE_ON',
  'HAS_EXPERIENCE_IN',
  'KNOWS_ABOUT',
  'CAN_ADVISE_ON',
  'LEARNING',
  'OPERATES',
  'BUILDS',
  'SUPPORTS'
]);

const CONTEXT = {
  saiteki: 'https://saiteki.example/schema#',
  schema: 'https://schema.org/',
  person: 'saiteki:person/',
  topic: 'saiteki:topic/',
  message: 'saiteki:message/',
  edge: 'saiteki:edge/',
  name: 'schema:name',
  source: 'saiteki:source',
  target: 'saiteki:target',
  predicate: 'saiteki:predicate',
  detailBullets: 'saiteki:detailBullets',
  evidenceMessages: 'saiteki:evidenceMessages'
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function normalizeNodeId(prefix, value) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`Missing ${prefix} id value`);
  return text.startsWith(`${prefix}:`) ? text : `${prefix}:${text}`;
}

function messageNodeId(messageId) {
  return normalizeNodeId('message', messageId);
}

function edgeId(edge) {
  return edge.id || [
    'edge',
    edge.source.replace(/^person:/, ''),
    edge.predicate,
    edge.target.replace(/^topic:/, '')
  ].join(':');
}

function compactText(value, maxLength = 260) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function buildPersonNode(employee) {
  return {
    '@id': normalizeNodeId('person', employee.name),
    '@type': 'saiteki:Person',
    'schema:name': employee.name,
    'saiteki:slackIds': [employee.slack_id, employee.slack_id_2].filter(Boolean),
    'saiteki:job': employee.job || '',
    'saiteki:isActive': employee.isActive !== false
  };
}

function buildTopicNode(topic) {
  return {
    '@id': normalizeNodeId('topic', topic.id || topic.name),
    '@type': 'saiteki:Topic',
    'schema:name': topic.name,
    'saiteki:topicType': topic.topicType || 'interest',
    'saiteki:aliases': topic.aliases || [],
    ...(topic.parentTopic ? { 'saiteki:parentTopic': normalizeNodeId('topic', topic.parentTopic) } : {})
  };
}

function buildMessageNode(message) {
  return {
    '@id': messageNodeId(message.id),
    '@type': 'saiteki:SlackMessage',
    'saiteki:workspace': message.workspace || 'primary',
    'saiteki:channelId': message.channelId || '',
    'saiteki:channelName': message.channelName || '',
    'saiteki:messageTs': message.messageTs || '',
    'saiteki:threadTs': message.threadTs || null,
    'saiteki:authorSlackId': message.user || '',
    'saiteki:authorName': message.userName || '',
    'saiteki:textPreview': compactText(message.text || message.rawText || '')
  };
}

function buildProfileEdge(edge) {
  return {
    '@id': edgeId(edge),
    '@type': 'saiteki:ProfileEdge',
    'saiteki:source': normalizeNodeId('person', edge.source),
    'saiteki:target': normalizeNodeId('topic', edge.target),
    'saiteki:predicate': edge.predicate,
    'saiteki:relationLabel': edge.relationLabel || edge.predicate,
    'saiteki:detailBullets': edge.detailBullets || [],
    'saiteki:evidenceMessages': (edge.evidenceMessageIds || []).map(messageNodeId),
    'saiteki:confidence': edge.confidence,
    'saiteki:extractionMethod': edge.extractionMethod || 'curated_seed',
    'saiteki:firstSeenAt': edge.firstSeenAt || null,
    'saiteki:updatedAt': edge.updatedAt || new Date().toISOString()
  };
}

function validateProfileGraph(graph, slackMessages) {
  const nodes = graph['@graph'] || [];
  const nodeIds = new Set(nodes.map((node) => node['@id']));
  const messageIds = new Set(slackMessages.map((message) => messageNodeId(message.id)));
  const edgeKeys = new Set();
  const errors = [];

  for (const node of nodes.filter((item) => item['@type'] === 'saiteki:ProfileEdge')) {
    const source = node['saiteki:source'];
    const target = node['saiteki:target'];
    const predicate = node['saiteki:predicate'];
    const key = `${source}|${predicate}|${target}`;
    const evidence = node['saiteki:evidenceMessages'] || [];
    const confidence = node['saiteki:confidence'];

    if (!nodeIds.has(source)) errors.push(`${node['@id']} source is missing: ${source}`);
    if (!nodeIds.has(target)) errors.push(`${node['@id']} target is missing: ${target}`);
    if (!ALLOWED_PREDICATES.has(predicate)) errors.push(`${node['@id']} predicate is not allowed: ${predicate}`);
    if (edgeKeys.has(key)) errors.push(`${node['@id']} duplicates edge key: ${key}`);
    edgeKeys.add(key);
    if (!Array.isArray(node['saiteki:detailBullets']) || node['saiteki:detailBullets'].length === 0) {
      errors.push(`${node['@id']} has no detail bullets`);
    }
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
      errors.push(`${node['@id']} confidence must be between 0 and 1`);
    }
    if (evidence.length === 0) errors.push(`${node['@id']} has no evidence messages`);
    for (const id of evidence) {
      if (!messageIds.has(id)) errors.push(`${node['@id']} evidence message is missing: ${id}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid employee profile graph:\n${errors.join('\n')}`);
  }
}

function buildEmployeeProfileGraph({ employees, slackMessages, overrides, generatedAt = new Date().toISOString() }) {
  const activeEmployees = employees.filter((employee) => employee.isActive !== false);
  const referencedMessageIds = new Set((overrides.edges || [])
    .flatMap((edge) => edge.evidenceMessageIds || [])
    .map(messageNodeId));
  const messageByNodeId = new Map(slackMessages.map((message) => [messageNodeId(message.id), message]));

  const graph = [
    ...activeEmployees.map(buildPersonNode),
    ...(overrides.topics || []).map(buildTopicNode),
    ...[...referencedMessageIds]
      .map((id) => messageByNodeId.get(id))
      .filter(Boolean)
      .map(buildMessageNode),
    ...(overrides.edges || []).map(buildProfileEdge)
  ];

  const payload = {
    '@context': CONTEXT,
    generatedAt,
    sourceFiles: [
      'data/employees.json',
      'data/slack-messages.jsonl',
      'data/profile-graph-overrides.json'
    ],
    '@graph': graph
  };
  validateProfileGraph(payload, slackMessages);
  return payload;
}

function main() {
  const employees = readJson(EMPLOYEES_FILE);
  const slackMessages = readJsonl(SLACK_MESSAGES_FILE);
  const overrides = readJson(OVERRIDES_FILE);
  const graph = buildEmployeeProfileGraph({ employees, slackMessages, overrides });
  fs.writeFileSync(OUTPUT_FILE, `${JSON.stringify(graph, null, 2)}\n`);
  console.log(`Generated ${graph['@graph'].length} profile graph nodes at ${OUTPUT_FILE}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  ALLOWED_PREDICATES,
  buildEmployeeProfileGraph,
  validateProfileGraph
};
