const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const EMPLOYEES_FILE = path.join(DATA_DIR, 'employees.json');
const SLACK_MESSAGES_FILE = path.join(DATA_DIR, 'slack-messages.jsonl');
const OUTPUT_FILE = path.join(DATA_DIR, 'search-facets.jsonld');

const UI_CATEGORY_WORK = '仕事・相談';
const UI_CATEGORY_PERSONAL = '興味・人柄';

const CONTEXT = {
  saiteki: 'https://saiteki.example/schema#',
  person: 'saiteki:person',
  uiCategory: 'saiteki:uiCategory',
  category: 'saiteki:category',
  label: 'saiteki:label',
  aliases: 'saiteki:aliases',
  evidence: 'saiteki:evidence',
  messageQuotes: 'saiteki:messageQuotes',
  sourceField: 'saiteki:sourceField'
};

const FIELD_CONFIGS = [
  {
    category: 'strength',
    uiCategory: UI_CATEGORY_WORK,
    path: 'work_styles_and_strengths.dominant_strengths',
    evidencePath: 'work_styles_and_strengths.summary'
  },
  {
    category: 'work_style',
    uiCategory: UI_CATEGORY_WORK,
    path: 'work_styles_and_strengths.problem_solving_style',
    evidencePath: 'work_styles_and_strengths.summary'
  },
  {
    category: 'work_topic',
    uiCategory: UI_CATEGORY_WORK,
    path: 'current_state.recent_topics_of_interest',
    evidencePath: 'work_styles_and_strengths.summary',
    filter: isWorkTopic
  },
  {
    category: 'interest',
    uiCategory: UI_CATEGORY_PERSONAL,
    path: 'current_state.recent_topics_of_interest',
    evidencePath: 'current_state.summary',
    filter: isPersonalTopic
  },
  {
    category: 'value',
    uiCategory: UI_CATEGORY_PERSONAL,
    path: 'values_and_motivators.core_values',
    evidencePath: 'values_and_motivators.summary'
  },
  {
    category: 'recent_topic',
    uiCategory: UI_CATEGORY_PERSONAL,
    path: 'values_and_motivators.motivation_triggers',
    evidencePath: 'values_and_motivators.summary'
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

function writeJsonl(file, rows) {
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
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

function isWorkTopic(value) {
  return /ai|aws|react|next|rag|qa|pm|poc|gemini|cursor|notion|slack|api|db|sql|bi|開発|運用|監視|設計|要件|技術|テスト|品質|分析|採用|営業|総務|人事|オンボーディング|データ|プロンプト|自動化|インフラ|サーバ/i.test(value);
}

function isPersonalTopic(value) {
  return !isWorkTopic(value);
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[・、。,.!?！？:：;；()[\]{}「」『』"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function messageKey(message) {
  return `${message.workspace || 'primary'}:${message.channelId || message.channel || ''}:${message.ts || message.messageTs || ''}`;
}

function normalizeSlackMessage(message, workspace = 'primary') {
  const text = String(message.text || '').trim();
  if (!message.user || !message.ts || !text) return null;
  return {
    id: messageKey({ ...message, workspace }),
    workspace,
    channelId: message.channelId || message.channel || '',
    user: message.user,
    text,
    messageTs: String(message.ts),
    threadTs: message.thread_ts ? String(message.thread_ts) : null,
    parentUserId: message.parent_user_id || null,
    permalink: message.permalink || null
  };
}

function mergeSlackMessages(existingRows, fetchedMessages) {
  const rowsById = new Map();
  for (const row of existingRows) {
    if (row && row.id) rowsById.set(row.id, row);
  }
  for (const message of fetchedMessages) {
    const row = normalizeSlackMessage(message, message.workspace || 'primary');
    if (row) rowsById.set(row.id, row);
  }
  return [...rowsById.values()].sort((a, b) => (a.messageTs || '').localeCompare(b.messageTs || ''));
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

function findMessageQuotes(employee, label, aliases, messageIndex) {
  const ids = [employee.slack_id, employee.slack_id_2].filter(Boolean);
  const terms = [label, ...aliases].map(normalizeText).filter((term) => term.length >= 2);
  const quotes = [];

  for (const id of ids) {
    const messages = messageIndex.get(id) || [];
    for (const message of messages) {
      const text = normalizeText(message.text);
      if (!terms.some((term) => text.includes(term))) continue;
      quotes.push({
        text: cleanText(message.text, 180),
        channelId: message.channelId,
        messageTs: message.messageTs,
        threadTs: message.threadTs,
        permalink: message.permalink
      });
      if (quotes.length >= 2) return quotes;
    }
  }

  return quotes;
}

function buildSearchFacets(employees, slackMessages = []) {
  const messageIndex = messagesBySlackId(slackMessages);
  const graph = [];
  const seen = new Set();

  for (const employee of employees.filter((item) => item.isActive !== false)) {
    for (const config of FIELD_CONFIGS) {
      const values = toArray(getPath(employee, config.path));
      const evidence = cleanText(getPath(employee, config.evidencePath) || employee.overall_summary || '');

      for (const value of values) {
        const label = cleanText(value, 120);
        if (!label || label === '-') continue;
        if (config.filter && !config.filter(label)) continue;

        const key = `${employee.name}:${config.category}:${config.path}:${label}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const aliases = makeAliases(label);
        const messageQuotes = findMessageQuotes(employee, label, aliases, messageIndex);

        graph.push({
          '@id': `facet:${encodeURIComponent(employee.name)}:${config.category}:${graph.length + 1}`,
          '@type': 'saiteki:SearchFacet',
          person: `person:${employee.name}`,
          employeeName: employee.name,
          slackIds: [employee.slack_id, employee.slack_id_2].filter(Boolean),
          uiCategory: config.uiCategory,
          category: config.category,
          label,
          aliases,
          evidence,
          messageQuotes,
          sourceField: config.path
        });
      }
    }
  }

  return {
    '@context': CONTEXT,
    generatedAt: new Date().toISOString(),
    sourceFiles: ['data/employees.json', 'data/slack-messages.jsonl'],
    '@graph': graph
  };
}

function writeSearchFacets(facets, outputFile = OUTPUT_FILE) {
  fs.writeFileSync(outputFile, `${JSON.stringify(facets, null, 2)}\n`);
}

function main() {
  const employees = readJson(EMPLOYEES_FILE);
  const messages = readJsonl(SLACK_MESSAGES_FILE);
  const facets = buildSearchFacets(employees, messages);
  writeSearchFacets(facets);
  console.log(`Generated ${facets['@graph'].length} search facets at ${OUTPUT_FILE}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildSearchFacets,
  mergeSlackMessages,
  normalizeSlackMessage,
  readJsonl,
  writeJsonl,
  writeSearchFacets
};
