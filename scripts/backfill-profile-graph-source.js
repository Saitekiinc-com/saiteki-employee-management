const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const EMPLOYEES_FILE = path.join(DATA_DIR, 'employees.json');
const SLACK_MESSAGES_FILE = path.join(DATA_DIR, 'slack-messages.jsonl');
const PROFILE_GRAPH_DIR = path.join(DATA_DIR, 'profile-graph');
const GENERATED_DIRS = {
  people: path.join(PROFILE_GRAPH_DIR, 'nodes/people/generated'),
  topics: path.join(PROFILE_GRAPH_DIR, 'nodes/topics/generated'),
  edges: path.join(PROFILE_GRAPH_DIR, 'edges/people-topics/generated'),
  facts: path.join(PROFILE_GRAPH_DIR, 'facts/people-topics/generated')
};

const UI_CATEGORY_WORK = '仕事・相談';
const UI_CATEGORY_PERSONAL = '興味・人柄';

const FIELD_CONFIGS = [
  {
    category: 'strength',
    uiCategory: UI_CATEGORY_WORK,
    path: 'work_styles_and_strengths.dominant_strengths',
    evidencePath: 'work_styles_and_strengths.summary',
    predicate: 'HAS_STRENGTH',
    topicType: 'work_strength',
    filter: () => true
  },
  {
    category: 'work_style',
    uiCategory: UI_CATEGORY_WORK,
    path: 'work_styles_and_strengths.problem_solving_style',
    evidencePath: 'work_styles_and_strengths.summary',
    predicate: 'HAS_WORK_STYLE',
    topicType: 'work_style',
    filter: () => true
  },
  {
    category: 'work_topic',
    uiCategory: UI_CATEGORY_WORK,
    path: 'current_state.recent_topics_of_interest',
    evidencePath: 'work_styles_and_strengths.summary',
    predicate: 'KNOWS_ABOUT',
    topicType: 'work_topic',
    filter: isWorkTopic
  },
  {
    category: 'interest',
    uiCategory: UI_CATEGORY_PERSONAL,
    path: 'current_state.recent_topics_of_interest',
    evidencePath: 'current_state.summary',
    predicate: 'INTERESTED_IN',
    topicType: 'interest',
    filter: (value) => !isWorkTopic(value)
  },
  {
    category: 'value',
    uiCategory: UI_CATEGORY_PERSONAL,
    path: 'values_and_motivators.core_values',
    evidencePath: 'values_and_motivators.summary',
    predicate: 'VALUES',
    topicType: 'value',
    filter: () => true
  },
  {
    category: 'recent_topic',
    uiCategory: UI_CATEGORY_PERSONAL,
    path: 'values_and_motivators.motivation_triggers',
    evidencePath: 'values_and_motivators.summary',
    predicate: 'MOTIVATED_BY',
    topicType: 'motivation',
    filter: () => true
  }
];

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

function readSourceFiles(dir) {
  return listJsonFiles(dir).map((file) => ({
    ...readJson(file),
    sourceFile: path.relative(path.join(__dirname, '..'), file)
  }));
}

function readCuratedSource() {
  const withoutGenerated = (items) => items.filter((item) => !item.sourceFile.includes('/generated/'));
  return {
    people: withoutGenerated(readSourceFiles(path.join(PROFILE_GRAPH_DIR, 'nodes/people'))),
    topics: withoutGenerated(readSourceFiles(path.join(PROFILE_GRAPH_DIR, 'nodes/topics'))),
    edges: withoutGenerated(readSourceFiles(path.join(PROFILE_GRAPH_DIR, 'edges/people-topics'))),
    facts: withoutGenerated(readSourceFiles(path.join(PROFILE_GRAPH_DIR, 'facts/people-topics')))
  };
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function cleanGeneratedDirs() {
  for (const dir of Object.values(GENERATED_DIRS)) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getPath(object, dottedPath) {
  return dottedPath.split('.').reduce((value, key) => (value == null ? undefined : value[key]), object);
}

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function cleanText(value, maxLength = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[・、。,.!?！？:：;；()[\]{}「」『』"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isWorkTopic(value) {
  return /ai|aws|react|next|rag|qa|pm|poc|gemini|cursor|notion|slack|api|db|sql|bi|開発|運用|監視|設計|要件|技術|テスト|品質|分析|採用|営業|総務|人事|オンボーディング|データ|プロンプト|自動化|インフラ|サーバ/i.test(value);
}

function makeAliases(label) {
  const normalized = normalizeText(label);
  const parts = normalized
    .split(/[\s/／|、。・,，]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && part !== normalized);
  const ascii = normalized.match(/[a-z0-9+#.]{2,}/g) || [];
  return [...new Set([...parts, ...ascii])].slice(0, 8);
}

function hash(value, length = 12) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, length);
}

function filename(...parts) {
  return `${parts.map((part) => hash(part, 10)).join('__')}.json`;
}

function personSlug(employeeName) {
  return hash(`person:${employeeName}`, 10);
}

function topicId(label) {
  return `topic:auto:${hash(normalizeText(label), 16)}`;
}

function edgeId(employeeName, predicate, topic) {
  return `edge:auto:${hash(`${employeeName}|${predicate}|${topic}`, 16)}`;
}

function factId(edge) {
  return `fact:auto:${hash(edge, 16)}:001`;
}

function messageNodeId(messageId) {
  const text = String(messageId || '').trim();
  return text.startsWith('message:') ? text : `message:${text}`;
}

function messagesBySlackId(messages) {
  const index = new Map();
  for (const message of messages) {
    if (!message.user) continue;
    if (!index.has(message.user)) index.set(message.user, []);
    index.get(message.user).push(message);
  }
  return index;
}

function findMessageIds(employee, label, aliases, messageIndex) {
  const ids = [employee.slack_id, employee.slack_id_2].filter(Boolean);
  const terms = [label, ...aliases].map(normalizeText).filter((term) => term.length >= 2);
  const messageIds = [];

  for (const id of ids) {
    const messages = messageIndex.get(id) || [];
    for (const message of messages) {
      const text = normalizeText(message.text || message.rawText || '');
      if (!terms.some((term) => textContainsSearchTerm(text, term))) continue;
      messageIds.push(message.id);
      if (messageIds.length >= 2) return messageIds;
    }
  }

  return messageIds;
}

function textContainsSearchTerm(text, term) {
  if (/^[a-z0-9+#.]+$/.test(term)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9+#.])${escaped}([^a-z0-9+#.]|$)`, 'i').test(text);
  }
  return text.includes(term);
}

function collectTextFields(value, pathParts = [], rows = []) {
  if (typeof value === 'string') {
    const text = cleanText(value, 1000);
    if (text) rows.push({ sourceField: pathParts.join('.'), text });
    return rows;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectTextFields(item, pathParts.concat(index), rows));
    return rows;
  }

  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      collectTextFields(item, pathParts.concat(key), rows);
    }
  }

  return rows;
}

function evidenceSearchTerms(label, aliases) {
  const terms = [];
  const normalizedLabel = normalizeText(label);
  const compactLabel = normalizedLabel.replace(/\s+/g, '');
  if (compactLabel.length >= 2 && compactLabel.length <= 16) terms.push(normalizedLabel);

  for (const alias of aliases) {
    const term = normalizeText(alias);
    const compactTerm = term.replace(/\s+/g, '');
    if (compactTerm.length < 3 || compactTerm.length > 16) continue;
    terms.push(term);
  }

  return [...new Set(terms)].sort((a, b) => b.length - a.length);
}

function sentenceWithTerm(text, terms) {
  const compact = cleanText(text, 260);
  const sentences = compact.match(/[^。！？!?]+[。！？!?]?/g) || [compact];
  return sentences.find((sentence) => {
    const normalized = normalizeText(sentence);
    return terms.some((term) => normalized.includes(term));
  }) || compact;
}

function findEvidenceSnippets(employee, label, aliases) {
  const terms = evidenceSearchTerms(label, aliases);
  if (terms.length === 0) return [];
  const seen = new Set();
  const snippets = [];

  for (const field of collectTextFields(employee)) {
    const normalized = normalizeText(field.text);
    if (!terms.some((term) => normalized.includes(term))) continue;

    const text = cleanText(sentenceWithTerm(field.text, terms), 180);
    const key = normalizeText(text);
    if (!key || key === normalizeText(label) || seen.has(key)) continue;
    seen.add(key);
    snippets.push({ text, sourceField: field.sourceField });
  }

  return snippets.slice(0, 3);
}

function detailBullets(employee, label, config, aliases) {
  const snippets = findEvidenceSnippets(employee, label, aliases).map((snippet) => snippet.text);
  const evidence = cleanText(getPath(employee, config.evidencePath) || employee.overall_summary || '', 180);
  const bullets = [label, ...snippets];
  if (bullets.length === 1 && evidence) bullets.push(evidence);
  return [...new Set(bullets.map((item) => cleanText(item, 180)).filter(Boolean))].slice(0, 4);
}

function evidenceProfileFields(employee, label, config, aliases) {
  const fields = [
    { sourceField: config.path, text: label },
    ...findEvidenceSnippets(employee, label, aliases)
  ];
  const evidence = cleanText(getPath(employee, config.evidencePath) || employee.overall_summary || '', 220);
  if (evidence) fields.push({ sourceField: config.evidencePath, text: evidence });

  const seen = new Set();
  return fields.filter((field) => {
    const key = `${field.sourceField}:${normalizeText(field.text)}`;
    if (!field.text || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 4);
}

function curatedTermsByEmployee(source) {
  const topicById = new Map(source.topics.map((topic) => [topic['@id'] || topic.id, topic]));
  const result = new Map();

  for (const edge of source.edges) {
    const employeeName = String(edge.source || '').replace(/^person:/, '');
    const topic = topicById.get(edge.target);
    if (!employeeName || !topic) continue;
    const terms = [topic.name, ...(topic.aliases || [])]
      .map(normalizeText)
      .filter((term) => term.replace(/\s+/g, '').length >= 2);
    if (!result.has(employeeName)) result.set(employeeName, []);
    result.get(employeeName).push(...terms);
  }

  return result;
}

function isSupersededByCurated(employeeName, label, curatedTerms) {
  const normalizedLabel = normalizeText(label);
  return (curatedTerms.get(employeeName) || []).some((term) => (
    normalizedLabel.includes(term) || term.includes(normalizedLabel)
  ));
}

function collectGeneratedItems(employees, slackMessages, curatedSource) {
  const activeEmployees = employees.filter((employee) => employee.isActive !== false);
  const existingPeople = new Set(curatedSource.people.map((person) => person.name || String(person['@id']).replace(/^person:/, '')));
  const curatedTerms = curatedTermsByEmployee(curatedSource);
  const messageIndex = messagesBySlackId(slackMessages);
  const topics = new Map();
  const edges = [];
  const facts = [];

  const people = activeEmployees
    .filter((employee) => !existingPeople.has(employee.name))
    .map((employee) => ({
      '@id': `person:${employee.name}`,
      '@type': 'saiteki:PersonNode',
      name: employee.name
    }));

  const seenEdges = new Set();
  for (const employee of activeEmployees) {
    for (const config of FIELD_CONFIGS) {
      for (const rawValue of toArray(getPath(employee, config.path))) {
        const label = cleanText(rawValue, 120);
        if (!label || label === '-' || !config.filter(label)) continue;
        if (isSupersededByCurated(employee.name, label, curatedTerms)) continue;

        const aliases = makeAliases(label);
        const target = topicId(label);
        const source = `person:${employee.name}`;
        const edgeKey = `${source}|${config.predicate}|${target}`;
        if (seenEdges.has(edgeKey)) continue;
        seenEdges.add(edgeKey);

        if (!topics.has(target)) {
          topics.set(target, {
            '@id': target,
            '@type': 'saiteki:TopicNode',
            name: label,
            topicType: config.topicType,
            aliases,
            generatedFrom: 'employees.json'
          });
        }

        const edge = edgeId(employee.name, config.predicate, target);
        const messageIds = findMessageIds(employee, label, aliases, messageIndex);
        edges.push({
          '@id': edge,
          '@type': 'saiteki:ProfileEdge',
          source,
          predicate: config.predicate,
          target,
          uiCategory: config.uiCategory,
          category: config.category,
          sourceField: config.path,
          facts: [factId(edge)]
        });
        facts.push({
          '@id': factId(edge),
          '@type': 'saiteki:ProfileFact',
          edge,
          uiCategory: config.uiCategory,
          category: config.category,
          sourceField: config.path,
          relationLabel: label,
          detailBullets: detailBullets(employee, label, config, aliases),
          evidenceMessageIds: messageIds,
          evidenceProfileFields: evidenceProfileFields(employee, label, config, aliases),
          confidence: messageIds.length > 0 ? 0.66 : 0.5,
          extractionMethod: messageIds.length > 0 ? 'profile_field_backfill_with_message' : 'profile_field_backfill',
          firstSeenAt: employee.createdAt || null,
          updatedAt: employee.updatedAt || employee.last_updated || employee.slack_synced_at || null
        });
      }
    }
  }

  return { people, topics: [...topics.values()], edges, facts };
}

function writeGeneratedItems(items) {
  cleanGeneratedDirs();
  for (const person of items.people) {
    writeJson(path.join(GENERATED_DIRS.people, `${personSlug(person.name)}.jsonld`), person);
  }
  for (const topic of items.topics) {
    writeJson(path.join(GENERATED_DIRS.topics, filename(topic['@id'])), topic);
  }
  for (const edge of items.edges) {
    writeJson(path.join(GENERATED_DIRS.edges, filename(edge['@id'])), edge);
  }
  for (const fact of items.facts) {
    writeJson(path.join(GENERATED_DIRS.facts, filename(fact['@id'])), fact);
  }
}

function main() {
  const employees = readJson(EMPLOYEES_FILE);
  const slackMessages = readJsonl(SLACK_MESSAGES_FILE);
  const curatedSource = readCuratedSource();
  const generated = collectGeneratedItems(employees, slackMessages, curatedSource);
  writeGeneratedItems(generated);
  console.log([
    `Generated ${generated.people.length} people files`,
    `${generated.topics.length} topic files`,
    `${generated.edges.length} edge files`,
    `${generated.facts.length} fact files`
  ].join(', '));
}

if (require.main === module) {
  main();
}

module.exports = {
  collectGeneratedItems,
  FIELD_CONFIGS
};
