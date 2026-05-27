const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  buildEmployeeProfileGraph,
  validateProfileGraph
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
const overrides = readJson(path.join(DATA_DIR, 'profile-graph-overrides.json'));

const graph = buildEmployeeProfileGraph({
  employees,
  slackMessages,
  overrides,
  generatedAt: '2026-05-27T00:00:00.000Z'
});
const nodes = graph['@graph'];

assert(nodes.some((node) => node['@id'] === 'person:小島遼祐' && node['@type'] === 'saiteki:Person'));
assert(nodes.some((node) => node['@id'] === 'topic:ポケモン' && node['@type'] === 'saiteki:Topic'));
assert(nodes.some((node) => node['@id'] === 'message:primary:C09Q46YA4ER:1772237402.765719'));

const edges = nodes.filter((node) => node['@type'] === 'saiteki:ProfileEdge');
assert.strictEqual(edges.length, 3, 'seed graph should have three pokemon profile edges');

const kojima = edges.find((edge) => edge['saiteki:source'] === 'person:小島遼祐');
assert(kojima, '小島遼祐 edge should exist');
assert.strictEqual(kojima['saiteki:target'], 'topic:ポケモン');
assert.strictEqual(kojima['saiteki:predicate'], 'COLLECTS');
assert(
  kojima['saiteki:detailBullets'].some((bullet) => bullet.includes('ジムバトル')),
  '小島遼祐 edge should preserve concrete pokemon details'
);
assert(
  kojima['saiteki:evidenceMessages'].every((id) => id.startsWith('message:primary:')),
  'evidence message ids should be JSON-LD message node ids'
);

const invalid = JSON.parse(JSON.stringify(graph));
invalid['@graph'].find((node) => node['@type'] === 'saiteki:ProfileEdge')['saiteki:evidenceMessages'] = [];
assert.throws(
  () => validateProfileGraph(invalid, slackMessages),
  /has no evidence messages/,
  'validator should reject edges without evidence'
);

console.log('employee profile graph OK');
