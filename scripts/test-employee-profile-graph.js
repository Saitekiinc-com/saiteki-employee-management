const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  buildEmployeeProfileGraph,
  readProfileGraphSource,
  validateSource
} = require('./build-employee-profile-graph');

const DATA_DIR = path.join(__dirname, '../data');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const employees = readJson(path.join(DATA_DIR, 'employees.json'));
const slackMessages = readJsonl(path.join(DATA_DIR, 'slack-messages.jsonl'));
const source = readProfileGraphSource();

assert(source.people.length >= employees.filter((employee) => employee.isActive !== false).length, 'profile graph should have thin person node files for active employees');
assert(source.topics.some((topic) => topic['@id'] === 'topic:ポケモン'), 'pokemon topic node should exist');
assert(source.topics.some((topic) => topic['@id'] === 'topic:ガンダム'), 'gundam topic node should exist');
assert(source.edges.every((edge) => Array.isArray(edge.facts) && edge.facts.length > 0), 'edges should reference facts');
assert(source.facts.every((fact) => fact.detailBullets?.length > 0), 'facts should carry detail bullets');
assert(source.facts.every((fact) => (
  fact.evidenceMessageIds?.length > 0 || fact.evidenceProfileFields?.length > 0
)), 'facts should carry Slack evidence or profile field evidence');

const graph = buildEmployeeProfileGraph({
  employees,
  slackMessages,
  source,
  generatedAt: '2026-05-27T00:00:00.000Z'
});
const nodes = graph['@graph'];

assert(nodes.some((node) => node['@id'] === 'person:小島遼祐' && node['@type'] === 'saiteki:Person'));
assert(nodes.some((node) => node['@id'] === 'topic:ポケモン' && node['@type'] === 'saiteki:Topic'));
assert(nodes.some((node) => node['@id'] === 'message:primary:C09Q46YA4ER:1772237402.765719'));

const edges = nodes.filter((node) => node['@type'] === 'saiteki:ProfileEdge');
assert(edges.length > 800, 'profile graph should backfill all existing profile facets');
assert.strictEqual(edges.length, source.edges.length, 'built edge count should match source edge files');

const kojima = edges.find((edge) => (
  edge['saiteki:source'] === 'person:小島遼祐'
  && edge['saiteki:target'] === 'topic:ポケモン'
));
assert(kojima, '小島遼祐 edge should exist');
assert.strictEqual(kojima['saiteki:target'], 'topic:ポケモン');
assert.strictEqual(kojima['saiteki:predicate'], 'COLLECTS');
assert(
  kojima['saiteki:detailBullets'].some((bullet) => bullet.includes('ジムバトル')),
  '小島遼祐 edge should preserve concrete pokemon details from facts'
);
assert(
  kojima['saiteki:evidenceMessages'].every((id) => id.startsWith('message:primary:')),
  'evidence message ids should be JSON-LD message node ids'
);

const invalid = JSON.parse(JSON.stringify(source));
invalid.facts.find((fact) => fact['@id'] === 'fact:kojima-ryosuke:pokemon:001').evidenceMessageIds = [];
assert.throws(
  () => validateSource({ employees, slackMessages, source: invalid }),
  /has no evidence messages or profile fields/,
  'validator should reject facts without evidence'
);

console.log('employee profile graph OK');
