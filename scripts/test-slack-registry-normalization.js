const assert = require('assert');

const {
  mergeSlackMessages,
  normalizeSlackMessage
} = require('./build-search-facets');
const {
  collectSlackUserCandidates,
  registerSlackUsersFromMessages
} = require('./sync-slack');

const existing = [
  {
    id: 'primary:C123:100.000001',
    workspace: 'primary',
    channelId: 'C123',
    channelName: '自己紹介',
    user: 'UKNOWN',
    userName: '既存 太郎',
    userRealName: '既存 太郎',
    text: '既存メッセージ',
    rawText: '既存メッセージ',
    messageTs: '100.000001',
    date: '2026-01-01',
    timestamp: '2026-01-01T00:00:00.001Z',
    source: 'slack_export'
  }
];

const normalized = normalizeSlackMessage({
  workspace: 'primary',
  channelId: 'C123',
  channel: 'C123',
  user: 'UNEWUSER01',
  text: 'ホラーゲームにハマっています。',
  ts: '200.000002'
}, 'primary', {
  channelNameById: new Map([['C123', '自己紹介']]),
  userNameById: new Map([['UNEWUSER01', '新規 太郎']]),
  userRealNameById: new Map([['UNEWUSER01', '新規 太郎']])
});

assert.strictEqual(normalized.channelName, '自己紹介');
assert.strictEqual(normalized.userName, '新規 太郎');
assert.strictEqual(normalized.source, 'slack_api');
assert.strictEqual(normalized.date, '1970-01-01');

const merged = mergeSlackMessages(existing, [
  {
    workspace: 'primary',
    channelId: 'C123',
    user: 'UNEWUSER01',
    text: 'ゲーセンが好きです。',
    ts: '300.000003'
  }
]);
const added = merged.find((message) => message.user === 'UNEWUSER01');
assert.strictEqual(added.channelName, '自己紹介');
assert.strictEqual(added.source, 'slack_api');

const candidates = collectSlackUserCandidates([
  { workspace: 'primary', user: 'UNEWUSER01', userName: '新規 太郎' },
  { workspace: 'primary', user: 'B123BOT', userName: 'bot' },
  { workspace: 'primary', user: 'UKNOWN', userName: '既存 太郎' }
], new Set(['UKNOWN']));
assert.deepStrictEqual(candidates.map((candidate) => candidate.userId), ['UNEWUSER01']);

(async () => {
  const employees = [];
  const result = await registerSlackUsersFromMessages(employees, [
    {
      workspace: 'primary',
      user: 'UNEWUSER01',
      userName: '新規 太郎',
      text: '自己紹介です。'
    }
  ]);
  assert.strictEqual(result.createdCount, 1);
  assert.strictEqual(employees[0].name, '新規 太郎');
  console.log('slack registry normalization OK');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
