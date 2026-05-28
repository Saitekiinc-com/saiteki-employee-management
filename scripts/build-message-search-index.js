const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const EMPLOYEES_FILE = path.join(DATA_DIR, 'employees.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'slack-messages.jsonl');
const OUTPUT_FILE = path.join(DATA_DIR, 'message-search-index.json');

const CONTEXT = {
  saiteki: 'https://saiteki.example/schema#',
  schema: 'https://schema.org/',
  person: 'saiteki:person',
  message: 'saiteki:message',
  searchText: 'saiteki:searchText'
};
const PASTED_TRANSCRIPT_PATTERN = /(meet|ミート|zoom|teams).{0,20}(チャット|chat).{0,20}(コピペ|コピー|ログ)|チャットコピペ/i;

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

function cleanText(value, maxLength = 2000) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function employeeBySlackId(employees) {
  const byId = new Map();
  for (const employee of employees.filter((item) => item.isActive !== false)) {
    for (const slackId of [employee.slack_id, employee.slack_id_2].filter(Boolean)) {
      byId.set(slackId, employee);
    }
  }
  return byId;
}

function messageAuthor(message, employee) {
  const name = cleanText(employee?.name || message.userRealName || message.userName || '', 120);
  if (!name) return null;
  return {
    person: employee ? `person:${employee.name}` : `slack-user:${message.user}`,
    personName: name,
    slackIds: employee
      ? [employee.slack_id, employee.slack_id_2].filter(Boolean)
      : [message.user].filter(Boolean),
    job: employee?.job || ''
  };
}

function isSearchableMessage(message) {
  const text = cleanText(message.text || message.rawText || '');
  if (!message.id || !message.user || !text) return false;
  if (message.subtype && !['thread_broadcast'].includes(message.subtype)) return false;
  if (/さんがチャンネルに参加しました|joined the channel/i.test(text)) return false;
  if (PASTED_TRANSCRIPT_PATTERN.test(text)) return false;
  return text.replace(/\s+/g, '').length >= 8;
}

function messageQuote(message) {
  return {
    messageId: `message:${message.id}`,
    text: cleanText(message.text || message.rawText || '', 700),
    channelId: message.channelId || '',
    channelName: message.channelName || '',
    messageTs: message.messageTs || '',
    threadTs: message.threadTs || null,
    authorName: message.userName || message.userRealName || '',
    permalink: message.permalink || null
  };
}

function buildSearchText(message, employee) {
  return [
    message.text || message.rawText || '',
    message.channelName || '',
    employee?.job || ''
  ].map((item) => cleanText(item, 1200)).filter(Boolean).join('\n');
}

function buildMessageSearchIndex({ employees, messages, generatedAt = new Date().toISOString() }) {
  const bySlackId = employeeBySlackId(employees);
  const units = [];

  for (const message of messages) {
    if (!isSearchableMessage(message)) continue;
    const employee = bySlackId.get(message.user);
    const author = messageAuthor(message, employee);
    if (!author) continue;

    const quote = messageQuote(message);
    const text = cleanText(message.text || message.rawText || '', 500);
    units.push({
      '@id': `search-message:${message.id}`,
      '@type': 'saiteki:MessageSearchUnit',
      person: author.person,
      personName: author.personName,
      slackIds: author.slackIds,
      message: quote.messageId,
      semanticType: 'slack_message',
      category: 'message',
      sourceField: 'data/slack-messages.jsonl',
      sourceLabel: 'Slackメッセージ',
      relationLabel: `Slack発言: ${message.channelName || 'unknown'}`,
      topicLabel: message.channelName || 'Slack',
      messageTs: message.messageTs || '',
      timestamp: message.timestamp || '',
      detailBullets: [text],
      quotes: [quote],
      searchText: buildSearchText(message, author)
    });
  }

  return {
    '@context': CONTEXT,
    generatedAt,
    sourceFiles: ['data/slack-messages.jsonl', 'data/employees.json'],
    embedding: {
      status: 'not_generated',
      nextStep: 'Run scripts/embed-profile-search-index.js with message-search-index.json as input.'
    },
    '@graph': units
  };
}

function writeMessageSearchIndex(index, outputFile = OUTPUT_FILE) {
  fs.writeFileSync(outputFile, `${JSON.stringify(index, null, 2)}\n`);
}

function main() {
  const index = buildMessageSearchIndex({
    employees: readJson(EMPLOYEES_FILE),
    messages: readJsonl(MESSAGES_FILE)
  });
  writeMessageSearchIndex(index);
  console.log(`Generated ${index['@graph'].length} message search units at ${OUTPUT_FILE}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildMessageSearchIndex,
  messageAuthor,
  writeMessageSearchIndex
};
