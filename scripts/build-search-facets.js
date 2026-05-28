const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const EMPLOYEES_FILE = path.join(DATA_DIR, 'employees.json');
const SLACK_MESSAGES_FILE = path.join(DATA_DIR, 'slack-messages.jsonl');
const PROFILE_GRAPH_FILE = path.join(DATA_DIR, 'employee-profile-graph.jsonld');
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
  evidenceSnippets: 'saiteki:evidenceSnippets',
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

function readOptionalJson(file) {
  return fs.existsSync(file) ? readJson(file) : null;
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

function unique(values) {
  return [...new Set(values.filter(Boolean))];
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

function sentenceWithTerm(text, terms) {
  const compact = cleanText(text, 260);
  const sentences = compact.match(/[^。！？!?]+[。！？!?]?/g) || [compact];
  return sentences.find((sentence) => {
    const normalized = normalizeText(sentence);
    return terms.some((term) => normalized.includes(term));
  }) || compact;
}

function snippetScore(snippet, label) {
  const source = snippet.sourceField || '';
  const normalizedSnippet = normalizeText(snippet.text);
  const normalizedLabel = normalizeText(label);
  let score = 0;
  if (source.includes('evidence')) score += 5;
  if (source.includes('summary')) score -= 1;
  if (normalizedSnippet !== normalizedLabel) score += 3;
  if (snippet.text.length > label.length + 6) score += 2;
  if (/[（(].+[）)]/.test(snippet.text)) score += 1;
  return score;
}

function findEvidenceSnippets(employee, label, aliases) {
  const terms = evidenceSearchTerms(label, aliases);
  if (terms.length === 0) return [];
  const seen = new Set();
  const snippets = [];

  for (const field of collectTextFields(employee)) {
    const normalized = normalizeText(field.text);
    if (!terms.some((term) => normalized.includes(term))) continue;

    const text = cleanText(sentenceWithTerm(field.text, terms), 160);
    const key = normalizeText(text);
    if (key === normalizeText(label)) continue;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    snippets.push({ text, sourceField: field.sourceField });
  }

  return snippets
    .sort((a, b) => snippetScore(b, label) - snippetScore(a, label))
    .slice(0, 2);
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

  return [...new Set(terms)]
    .sort((a, b) => b.replace(/\s+/g, '').length - a.replace(/\s+/g, '').length);
}

function messageKey(message) {
  return `${message.workspace || 'primary'}:${message.channelId || message.channel || ''}:${message.ts || message.messageTs || ''}`;
}

function normalizeSlackMessage(message, workspace = 'primary', context = {}) {
  const text = cleanText(message.text || message.rawText, 2000);
  const messageTs = String(message.messageTs || message.ts || '');
  const channelId = message.channelId || message.channel || '';
  const timestamp = message.timestamp || timestampFromSlackTs(messageTs);
  if (!message.user || !messageTs || !text) return null;
  return {
    id: messageKey({ ...message, workspace }),
    workspace,
    channelId,
    channelName: message.channelName || context.channelNameById?.get(channelId) || '',
    user: message.user,
    userName: message.userName || message.username || context.userNameById?.get(message.user) || '',
    userRealName: message.userRealName || context.userRealNameById?.get(message.user) || '',
    text,
    rawText: message.rawText || message.text || '',
    messageTs,
    threadTs: message.threadTs ? String(message.threadTs) : (message.thread_ts ? String(message.thread_ts) : null),
    parentUserId: message.parentUserId || message.parent_user_id || null,
    subtype: message.subtype || null,
    date: message.date || timestamp.slice(0, 10),
    timestamp,
    source: message.source || 'slack_api',
    sourceFile: message.sourceFile || '',
    permalink: message.permalink || null
  };
}

function mergeSlackMessages(existingRows, fetchedMessages) {
  const rowsById = new Map();
  const context = buildSlackMessageContext(existingRows);
  for (const row of existingRows) {
    if (row && row.id) rowsById.set(row.id, row);
  }
  for (const message of fetchedMessages) {
    const row = normalizeSlackMessage(message, message.workspace || 'primary', context);
    if (row) rowsById.set(row.id, row);
  }
  return [...rowsById.values()].sort((a, b) => (a.messageTs || '').localeCompare(b.messageTs || ''));
}

function buildSlackMessageContext(rows) {
  const channelNameById = new Map();
  const userNameById = new Map();
  const userRealNameById = new Map();
  for (const row of rows || []) {
    if (row.channelId && row.channelName && !channelNameById.has(row.channelId)) {
      channelNameById.set(row.channelId, row.channelName);
    }
    if (row.user && row.userName && !userNameById.has(row.user)) {
      userNameById.set(row.user, row.userName);
    }
    if (row.user && row.userRealName && !userRealNameById.has(row.user)) {
      userRealNameById.set(row.user, row.userRealName);
    }
  }
  return { channelNameById, userNameById, userRealNameById };
}

function timestampFromSlackTs(messageTs) {
  const millis = Number.parseFloat(messageTs || '0') * 1000;
  return Number.isFinite(millis) && millis > 0 ? new Date(millis).toISOString() : '';
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
      if (!terms.some((term) => textContainsSearchTerm(text, term))) continue;
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

function textContainsSearchTerm(text, term) {
  if (/^[a-z0-9+#.]+$/.test(term)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9+#.])${escaped}([^a-z0-9+#.]|$)`, 'i').test(text);
  }
  return text.includes(term);
}

function messageQuotesFromEvidence(edge, slackMessageByNodeId) {
  return (edge['saiteki:evidenceMessages'] || [])
    .map((id) => slackMessageByNodeId.get(id))
    .filter(Boolean)
    .map((message) => ({
      text: cleanText(message.text || message.rawText || '', 220),
      channelId: message.channelId,
      messageTs: message.messageTs,
      threadTs: message.threadTs,
      permalink: message.permalink
    }));
}

function profileGraphSearchFacets(profileGraph, employees, slackMessages) {
  if (!profileGraph) return [];

  const graph = profileGraph['@graph'] || [];
  const employeeByName = new Map(employees.map((employee) => [employee.name, employee]));
  const topicById = new Map(graph
    .filter((node) => node['@type'] === 'saiteki:Topic')
    .map((node) => [node['@id'], node]));
  const slackMessageByNodeId = new Map(slackMessages.map((message) => [messageNodeId(message.id), message]));

  return graph
    .filter((node) => node['@type'] === 'saiteki:ProfileEdge')
    .map((edge, index) => {
      const employeeName = String(edge['saiteki:source'] || '').replace(/^person:/, '');
      const employee = employeeByName.get(employeeName);
      const topic = topicById.get(edge['saiteki:target']);
      if (!employee || !topic) return null;

      const detailBullets = edge['saiteki:detailBullets'] || [];
      const topicName = topic['schema:name'] || topic.name || String(edge['saiteki:target']).replace(/^topic:/, '');
      const label = edge['saiteki:relationLabel'] || topicName;
      const aliases = unique([
        topicName,
        ...(topic['saiteki:aliases'] || []),
        ...makeAliases(label)
      ]).slice(0, 16);

      return {
        '@id': `facet:profile-graph:${index + 1}`,
        '@type': 'saiteki:SearchFacet',
        supersedesTerms: unique([topicName, ...(topic['saiteki:aliases'] || [])]),
        person: edge['saiteki:source'],
        employeeName,
        slackIds: [employee.slack_id, employee.slack_id_2].filter(Boolean),
        uiCategory: edge['saiteki:uiCategory'] || UI_CATEGORY_PERSONAL,
        category: edge['saiteki:category'] || 'interest',
        label,
        aliases,
        evidence: detailBullets.join(' / '),
        evidenceSnippets: detailBullets.map((text) => ({
          text,
          sourceField: 'data/profile-graph/facts'
        })),
        messageQuotes: messageQuotesFromEvidence(edge, slackMessageByNodeId),
        sourceField: edge['saiteki:sourceField'] || edge['saiteki:sourceFields']?.[0] || 'data/profile-graph/facts'
      };
    })
    .filter(Boolean);
}

function messageNodeId(messageId) {
  const text = String(messageId || '').trim();
  return text.startsWith('message:') ? text : `message:${text}`;
}

function pruneSupersededFacets(baseFacets, graphFacets) {
  const graphFacetByEmployee = new Map();
  for (const facet of graphFacets) {
    if (!graphFacetByEmployee.has(facet.employeeName)) graphFacetByEmployee.set(facet.employeeName, []);
    graphFacetByEmployee.get(facet.employeeName).push(facet);
  }

  return baseFacets.filter((facet) => {
    const graphItems = graphFacetByEmployee.get(facet.employeeName) || [];
    const label = normalizeText(facet.label);
    return !graphItems.some((graphFacet) => {
      if (graphFacet.uiCategory !== facet.uiCategory) return false;
      return (graphFacet.supersedesTerms || [])
        .map(normalizeText)
        .filter((term) => term.replace(/\s+/g, '').length >= 2)
        .some((term) => label.includes(term));
    });
  });
}

function stripInternalFacetFields(facet) {
  const { supersedesTerms, ...publicFacet } = facet;
  return publicFacet;
}

function buildSearchFacets(employees, slackMessages = [], profileGraph = null) {
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
        const evidenceSnippets = findEvidenceSnippets(employee, label, aliases);
        const messageQuotes = findMessageQuotes(employee, label, aliases, messageIndex);

        const facet = {
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
        };
        if (evidenceSnippets.length > 0) facet.evidenceSnippets = evidenceSnippets;
        graph.push(facet);
      }
    }
  }

  const graphFacets = profileGraphSearchFacets(profileGraph, employees, slackMessages);
  const publicGraph = [
    ...pruneSupersededFacets(graph, graphFacets),
    ...graphFacets
  ].map(stripInternalFacetFields);

  return {
    '@context': CONTEXT,
    generatedAt: new Date().toISOString(),
    sourceFiles: [
      'data/employees.json',
      'data/slack-messages.jsonl',
      ...(profileGraph ? ['data/employee-profile-graph.jsonld'] : [])
    ],
    '@graph': publicGraph
  };
}

function writeSearchFacets(facets, outputFile = OUTPUT_FILE) {
  fs.writeFileSync(outputFile, `${JSON.stringify(facets, null, 2)}\n`);
}

function main() {
  const employees = readJson(EMPLOYEES_FILE);
  const messages = readJsonl(SLACK_MESSAGES_FILE);
  const profileGraph = readOptionalJson(PROFILE_GRAPH_FILE);
  const facets = buildSearchFacets(employees, messages, profileGraph);
  writeSearchFacets(facets);
  console.log(`Generated ${facets['@graph'].length} search facets at ${OUTPUT_FILE}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildSearchFacets,
  buildSlackMessageContext,
  mergeSlackMessages,
  normalizeSlackMessage,
  readJsonl,
  writeJsonl,
  writeSearchFacets
};
