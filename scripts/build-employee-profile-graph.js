const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const EMPLOYEES_FILE = path.join(DATA_DIR, 'employees.json');
const SLACK_MESSAGES_FILE = path.join(DATA_DIR, 'slack-messages.jsonl');
const PROFILE_GRAPH_DIR = path.join(DATA_DIR, 'profile-graph');
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
  fact: 'saiteki:fact/',
  name: 'schema:name',
  source: 'saiteki:source',
  target: 'saiteki:target',
  predicate: 'saiteki:predicate',
  facts: 'saiteki:facts',
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

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) return listJsonFiles(file);
      return /\.(json|jsonld)$/.test(entry.name) ? [file] : [];
    })
    .sort();
}

function readCollection(dir) {
  return listJsonFiles(dir).map((file) => ({
    ...readJson(file),
    sourceFile: path.relative(path.join(__dirname, '..'), file)
  }));
}

function readProfileGraphSource(profileDir = PROFILE_GRAPH_DIR) {
  return {
    people: readCollection(path.join(profileDir, 'nodes/people')),
    topics: readCollection(path.join(profileDir, 'nodes/topics')),
    edges: readCollection(path.join(profileDir, 'edges/people-topics')),
    facts: readCollection(path.join(profileDir, 'facts/people-topics'))
  };
}

function normalizeNodeId(prefix, value) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`Missing ${prefix} id value`);
  return text.startsWith(`${prefix}:`) ? text : `${prefix}:${text}`;
}

function messageNodeId(messageId) {
  return normalizeNodeId('message', messageId);
}

function compactText(value, maxLength = 260) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
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
    '@id': normalizeNodeId('topic', topic['@id'] || topic.id || topic.name),
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
    'saiteki:authorName': message.userName || message.userRealName || '',
    'saiteki:textPreview': compactText(message.text || message.rawText || '')
  };
}

function buildFactNode(fact) {
  return {
    '@id': fact['@id'] || fact.id,
    '@type': 'saiteki:ProfileFact',
    'saiteki:edge': fact.edge,
    'saiteki:relationLabel': fact.relationLabel,
    'saiteki:detailBullets': fact.detailBullets || [],
    'saiteki:evidenceMessages': (fact.evidenceMessageIds || []).map(messageNodeId),
    'saiteki:confidence': fact.confidence,
    'saiteki:extractionMethod': fact.extractionMethod || 'curated_seed',
    'saiteki:firstSeenAt': fact.firstSeenAt || null,
    'saiteki:updatedAt': fact.updatedAt || null
  };
}

function buildProfileEdge(edge, facts) {
  const detailBullets = unique(facts.flatMap((fact) => fact.detailBullets || []));
  const evidenceMessages = unique(facts.flatMap((fact) => fact.evidenceMessageIds || [])).map(messageNodeId);
  const confidenceValues = facts.map((fact) => fact.confidence).filter((value) => typeof value === 'number');
  const confidence = confidenceValues.length ? Math.max(...confidenceValues) : edge.confidence;
  const relationLabel = edge.relationLabel || facts.find((fact) => fact.relationLabel)?.relationLabel || edge.predicate;

  return {
    '@id': edge['@id'] || edge.id,
    '@type': 'saiteki:ProfileEdge',
    'saiteki:source': normalizeNodeId('person', edge.source),
    'saiteki:target': normalizeNodeId('topic', edge.target),
    'saiteki:predicate': edge.predicate,
    'saiteki:relationLabel': relationLabel,
    'saiteki:uiCategory': edge.uiCategory || facts.find((fact) => fact.uiCategory)?.uiCategory || '興味・人柄',
    'saiteki:category': edge.category || facts.find((fact) => fact.category)?.category || 'interest',
    'saiteki:facts': facts.map((fact) => fact['@id'] || fact.id),
    'saiteki:detailBullets': detailBullets,
    'saiteki:evidenceMessages': evidenceMessages,
    'saiteki:confidence': confidence,
    'saiteki:extractionMethod': unique(facts.map((fact) => fact.extractionMethod || 'curated_seed')).join(','),
    'saiteki:firstSeenAt': facts.map((fact) => fact.firstSeenAt).filter(Boolean).sort()[0] || null,
    'saiteki:updatedAt': facts.map((fact) => fact.updatedAt).filter(Boolean).sort().at(-1) || null
  };
}

function validateSource({ employees, slackMessages, source }) {
  const employeeNames = new Set(employees.filter((employee) => employee.isActive !== false).map((employee) => employee.name));
  const topicIds = new Set(source.topics.map((topic) => normalizeNodeId('topic', topic['@id'] || topic.id || topic.name)));
  const messageIds = new Set(slackMessages.map((message) => messageNodeId(message.id)));
  const factsById = new Map(source.facts.map((fact) => [fact['@id'] || fact.id, fact]));
  const edgeKeys = new Set();
  const errors = [];

  for (const person of source.people) {
    const name = String(person.name || person.employeeName || person['@id'] || '').replace(/^person:/, '');
    if (!employeeNames.has(name)) errors.push(`${person.sourceFile} person is missing in employees.json: ${name}`);
  }

  for (const edge of source.edges) {
    const edgeId = edge['@id'] || edge.id;
    const sourceName = String(edge.source || '').replace(/^person:/, '');
    const source = normalizeNodeId('person', edge.source);
    const target = normalizeNodeId('topic', edge.target);
    const key = `${source}|${edge.predicate}|${target}`;
    const factIds = edge.facts || [];

    if (!employeeNames.has(sourceName)) errors.push(`${edge.sourceFile} source is missing in employees.json: ${edge.source}`);
    if (!topicIds.has(target)) errors.push(`${edge.sourceFile} target topic is missing: ${target}`);
    if (!ALLOWED_PREDICATES.has(edge.predicate)) errors.push(`${edge.sourceFile} predicate is not allowed: ${edge.predicate}`);
    if (edgeKeys.has(key)) errors.push(`${edge.sourceFile} duplicates edge key: ${key}`);
    edgeKeys.add(key);
    if (factIds.length === 0) errors.push(`${edge.sourceFile} has no facts`);

    for (const factId of factIds) {
      const fact = factsById.get(factId);
      if (!fact) {
        errors.push(`${edge.sourceFile} fact is missing: ${factId}`);
        continue;
      }
      if (fact.edge && fact.edge !== edgeId) errors.push(`${fact.sourceFile} points to another edge: ${fact.edge}`);
      if (!Array.isArray(fact.detailBullets) || fact.detailBullets.length === 0) {
        errors.push(`${fact.sourceFile} has no detail bullets`);
      }
      if (!Array.isArray(fact.evidenceMessageIds) || fact.evidenceMessageIds.length === 0) {
        errors.push(`${fact.sourceFile} has no evidence messages`);
      }
      if (typeof fact.confidence !== 'number' || fact.confidence < 0 || fact.confidence > 1) {
        errors.push(`${fact.sourceFile} confidence must be between 0 and 1`);
      }
      for (const messageId of fact.evidenceMessageIds || []) {
        const id = messageNodeId(messageId);
        if (!messageIds.has(id)) errors.push(`${fact.sourceFile} evidence message is missing: ${id}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid employee profile graph source:\n${errors.join('\n')}`);
  }
}

function buildEmployeeProfileGraph({
  employees,
  slackMessages,
  source = readProfileGraphSource(),
  generatedAt = new Date().toISOString()
}) {
  validateSource({ employees, slackMessages, source });

  const factsByEdge = new Map();
  for (const fact of source.facts) {
    const edgeId = fact.edge;
    if (!factsByEdge.has(edgeId)) factsByEdge.set(edgeId, []);
    factsByEdge.get(edgeId).push(fact);
  }

  const profileEdges = source.edges.map((edge) => buildProfileEdge(edge, factsByEdge.get(edge['@id'] || edge.id) || []));
  const referencedMessageIds = new Set(profileEdges.flatMap((edge) => edge['saiteki:evidenceMessages']));
  const messageByNodeId = new Map(slackMessages.map((message) => [messageNodeId(message.id), message]));
  const graph = [
    ...employees.filter((employee) => employee.isActive !== false).map(buildPersonNode),
    ...source.topics.map(buildTopicNode),
    ...[...referencedMessageIds].map((id) => messageByNodeId.get(id)).filter(Boolean).map(buildMessageNode),
    ...source.facts.map(buildFactNode),
    ...profileEdges
  ];

  return {
    '@context': CONTEXT,
    generatedAt,
    sourceFiles: [
      'data/employees.json',
      'data/slack-messages.jsonl',
      'data/profile-graph/nodes',
      'data/profile-graph/edges',
      'data/profile-graph/facts'
    ],
    '@graph': graph
  };
}

function writeEmployeeProfileGraph(graph, outputFile = OUTPUT_FILE) {
  fs.writeFileSync(outputFile, `${JSON.stringify(graph, null, 2)}\n`);
}

function main() {
  const graph = buildEmployeeProfileGraph({
    employees: readJson(EMPLOYEES_FILE),
    slackMessages: readJsonl(SLACK_MESSAGES_FILE)
  });
  writeEmployeeProfileGraph(graph);
  console.log(`Generated ${graph['@graph'].length} profile graph items at ${OUTPUT_FILE}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  ALLOWED_PREDICATES,
  buildEmployeeProfileGraph,
  readProfileGraphSource,
  validateSource,
  writeEmployeeProfileGraph
};
