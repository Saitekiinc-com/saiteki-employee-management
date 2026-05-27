const fs = require('fs');
const path = require('path');
const { App } = require('@slack/bolt');
require('dotenv').config();

const { buildSearchFacets, readJsonl, writeSearchFacets } = require('./build-search-facets');
const { loadFacets, normalizeCategory, searchFacets } = require('./people-finder-rag-search');

const COMMAND = '/saiteki-people';
const OPEN_ACTION = 'open_people_finder_modal';
const SUBMIT_CALLBACK = 'people_finder_submit';
const CATEGORY_ACTION = 'category';
const QUERY_ACTION = 'query';
const CATEGORY_BLOCK = 'search_category';
const QUERY_BLOCK = 'search_query';
const DEFAULT_THRESHOLD = 0.16;

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN_3 || process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN_3 || process.env.SLACK_APP_TOKEN;
const ALLOWED_CHANNEL_IDS = (process.env.SLACK_CHANNEL_ID_3 || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const EMPLOYEES_FILE = process.env.PEOPLE_FINDER_EMPLOYEES_FILE || path.join(__dirname, '../data/employees.json');
const SLACK_MESSAGES_FILE = process.env.PEOPLE_FINDER_MESSAGES_FILE || path.join(__dirname, '../data/slack-messages.jsonl');
const FACETS_FILE = process.env.PEOPLE_FINDER_FACETS_FILE || path.join(__dirname, '../data/search-facets.jsonld');

const CATEGORY_OPTIONS = [
  {
    value: '仕事・相談',
    text: '仕事・相談',
    description: '技術、業務経験、強み、仕事の進め方から、相談できそうな社員を探します。'
  },
  {
    value: '興味・人柄',
    text: '興味・人柄',
    description: '趣味、好きなこと、最近の関心、価値観から、話しかけるきっかけになる社員を探します。'
  }
];

function requireValue(name, value) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

function escapeMrkdwn(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(value, maxLength = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function plainText(text) {
  return { type: 'plain_text', text, emoji: true };
}

function option(category) {
  return {
    text: plainText(category.text),
    value: category.value,
    description: plainText(category.description)
  };
}

function parseActionValue(value) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

function ensureFacetsFile() {
  if (fs.existsSync(FACETS_FILE)) return;
  const employees = JSON.parse(fs.readFileSync(EMPLOYEES_FILE, 'utf8'));
  const messages = readJsonl(SLACK_MESSAGES_FILE);
  writeSearchFacets(buildSearchFacets(employees, messages), FACETS_FILE);
}

function loadCurrentFacets() {
  ensureFacetsFile();
  return loadFacets(FACETS_FILE);
}

function buildSearchModal({ channelId, initialQuery = '', initialCategory = '興味・人柄' }) {
  const selectedCategory = normalizeCategory(initialCategory);
  const initialOption = CATEGORY_OPTIONS.find((item) => item.value === selectedCategory) || CATEGORY_OPTIONS[1];
  const queryElement = {
    type: 'plain_text_input',
    action_id: QUERY_ACTION,
    placeholder: plainText('例: ポケモンが好きな人 / AWS運用に詳しい人')
  };
  if (initialQuery) queryElement.initial_value = initialQuery;

  return {
    type: 'modal',
    callback_id: SUBMIT_CALLBACK,
    private_metadata: JSON.stringify({ channelId }),
    title: plainText('社員を探す'),
    submit: plainText('検索'),
    close: plainText('閉じる'),
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*探したい方向を選んで、自然文で入力してください。*\nカテゴリで絞ってから、社員データとメッセージ引用を類似検索します。'
        }
      },
      {
        type: 'input',
        block_id: CATEGORY_BLOCK,
        label: plainText('探したい方向'),
        element: {
          type: 'static_select',
          action_id: CATEGORY_ACTION,
          initial_option: option(initialOption),
          options: CATEGORY_OPTIONS.map(option)
        }
      },
      {
        type: 'context',
        elements: CATEGORY_OPTIONS.map((item) => ({
          type: 'mrkdwn',
          text: `*${escapeMrkdwn(item.text)}*: ${escapeMrkdwn(item.description)}`
        }))
      },
      {
        type: 'input',
        block_id: QUERY_BLOCK,
        label: plainText('探したい人の条件'),
        element: queryElement
      }
    ]
  };
}

function buttonBlocks({ initialQuery = '', initialCategory = '興味・人柄' } = {}) {
  const text = initialQuery
    ? `「${escapeMrkdwn(initialQuery)}」で社員検索を開きます。`
    : '社員データから、相談できそうな人や話しかけるきっかけになる人を探します。';

  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: plainText('社員を探す'),
          action_id: OPEN_ACTION,
          value: JSON.stringify({ initialQuery, initialCategory })
        }
      ]
    }
  ];
}

function formatResult(result) {
  const mention = result.slackIds?.[0] ? `<@${result.slackIds[0]}>` : escapeMrkdwn(result.employeeName);
  const reasons = result.reasons
    .map((reason) => `・${escapeMrkdwn(reason.label)} (${Math.round(reason.score * 100)}%)`)
    .join('\n');
  const evidence = result.reasons.find((reason) => reason.evidence)?.evidence;
  const quotes = result.messageQuotes
    .map((quote) => {
      const quoteText = `「${escapeMrkdwn(truncate(quote.text, 140))}」`;
      return quote.permalink ? `<${quote.permalink}|${quoteText}>` : quoteText;
    })
    .join('\n');

  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        `*${mention}*`,
        `選出理由:\n${reasons || '関連する検索facetが閾値を超えました。'}`,
        evidence ? `根拠要約: ${escapeMrkdwn(truncate(evidence, 180))}` : '',
        quotes ? `メッセージ引用:\n${quotes}` : 'メッセージ引用: 保存済み引用はまだありません。'
      ].filter(Boolean).join('\n')
    }
  };
}

function chunkResults(results, size = 12) {
  const chunks = [];
  for (let index = 0; index < results.length; index += size) {
    chunks.push(results.slice(index, index + size));
  }
  return chunks;
}

function resultMessageBlocks({ query, category, results, totalResults, page, totalPages }) {
  if (results.length === 0) {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `「${escapeMrkdwn(query)}」に合う社員は見つかりませんでした。\nカテゴリ: *${escapeMrkdwn(category)}*`
        }
      }
    ];
  }

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `「${escapeMrkdwn(query)}」に近い社員が *${totalResults}名* 見つかりました。\nカテゴリ: *${escapeMrkdwn(category)}* / 表示: ${page}/${totalPages}`
      }
    },
    { type: 'divider' }
  ];

  for (const result of results) {
    blocks.push(formatResult(result));
  }

  return blocks;
}

async function postResultMessages({ client, channel, user, query, category, results }) {
  const resultChunks = chunkResults(results);
  const chunks = resultChunks.length ? resultChunks : [[]];

  for (let index = 0; index < chunks.length; index++) {
    await client.chat.postEphemeral({
      channel,
      user,
      text: `「${query}」に近い社員検索結果`,
      blocks: resultMessageBlocks({
        query,
        category,
        results: chunks[index],
        totalResults: results.length,
        page: index + 1,
        totalPages: chunks.length
      })
    });
  }
}

function runSearch(query, category) {
  return searchFacets(loadCurrentFacets(), query, {
    category,
    threshold: process.env.PEOPLE_FINDER_THRESHOLD || DEFAULT_THRESHOLD
  });
}

function isAllowedChannel(channelId) {
  return ALLOWED_CHANNEL_IDS.length === 0 || ALLOWED_CHANNEL_IDS.includes(channelId);
}

requireValue('SLACK_BOT_TOKEN_3 or SLACK_BOT_TOKEN', SLACK_BOT_TOKEN);
requireValue('SLACK_APP_TOKEN_3 or SLACK_APP_TOKEN', SLACK_APP_TOKEN);

const app = new App({
  token: SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: SLACK_APP_TOKEN
});

app.command(COMMAND, async ({ ack, body, client }) => {
  if (!isAllowedChannel(body.channel_id)) {
    await ack({
      response_type: 'ephemeral',
      text: 'このチャンネルではSaiteki People Finderを利用できません。'
    });
    return;
  }

  await ack({
    response_type: 'ephemeral',
    blocks: buttonBlocks({ initialQuery: body.text || '' })
  });

  if (body.text) {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildSearchModal({ channelId: body.channel_id, initialQuery: body.text })
    });
  }
});

app.action(OPEN_ACTION, async ({ ack, body, client, action }) => {
  await ack();
  const actionValue = parseActionValue(action.value);
  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildSearchModal({
      channelId: body.channel?.id,
      initialQuery: actionValue.initialQuery || '',
      initialCategory: actionValue.initialCategory || '興味・人柄'
    })
  });
});

app.view(SUBMIT_CALLBACK, async ({ ack, body, view, client }) => {
  await ack();
  const category = view.state.values[CATEGORY_BLOCK][CATEGORY_ACTION].selected_option.value;
  const query = view.state.values[QUERY_BLOCK][QUERY_ACTION].value.trim();
  const { channelId } = JSON.parse(view.private_metadata || '{}');

  if (!channelId) {
    app.logger.warn('No channel id found for people finder result');
    return;
  }

  const results = runSearch(query, category);
  await postResultMessages({
    client,
    channel: channelId,
    user: body.user.id,
    query,
    category,
    results
  });
});

(async () => {
  await app.start();
  app.logger.info('Saiteki People Finder started');
})();
