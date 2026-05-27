const COMMAND_PATH = '/slack/commands';
const INTERACTIONS_PATH = '/slack/interactions';
const OPEN_ACTION = 'open_people_finder_modal';
const SUBMIT_CALLBACK = 'people_finder_submit';
const CATEGORY_ACTION = 'category';
const QUERY_ACTION = 'query';
const CATEGORY_BLOCK = 'search_category';
const QUERY_BLOCK = 'search_query';
const DEFAULT_THRESHOLD = 0.16;

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

let cachedFacets;
let cachedAt = 0;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'slack-people-finder' });
    }

    if (request.method !== 'POST') {
      return new Response('Not found', { status: 404 });
    }

    const rawBody = await request.text();
    const verified = await verifySlackRequest(request, rawBody, env.SLACK_SIGNING_SECRET);
    if (!verified) {
      return new Response('Invalid Slack signature', { status: 401 });
    }

    if (url.pathname === COMMAND_PATH) {
      return handleSlashCommand(rawBody, env, ctx);
    }

    if (url.pathname === INTERACTIONS_PATH) {
      return handleInteraction(rawBody, env, ctx);
    }

    return new Response('Not found', { status: 404 });
  }
};

async function handleSlashCommand(rawBody, env, ctx) {
  const form = new URLSearchParams(rawBody);
  const channelId = form.get('channel_id') || '';
  const triggerId = form.get('trigger_id') || '';
  const query = form.get('text') || '';

  if (!isAllowedChannel(channelId, env.SLACK_CHANNEL_ID_3)) {
    return slackJson({
      response_type: 'ephemeral',
      text: 'このチャンネルではSaiteki People Finderを利用できません。'
    });
  }

  if (query.trim()) {
    ctx.waitUntil(openModal(env, triggerId, buildSearchModal({
      channelId,
      initialQuery: query.trim()
    })));
  }

  return slackJson({
    response_type: 'ephemeral',
    blocks: buttonBlocks({ initialQuery: query.trim() })
  });
}

async function handleInteraction(rawBody, env, ctx) {
  const form = new URLSearchParams(rawBody);
  const payload = JSON.parse(form.get('payload') || '{}');

  if (payload.type === 'block_actions') {
    const action = payload.actions?.[0];
    if (action?.action_id === OPEN_ACTION) {
      const actionValue = parseActionValue(action.value);
      ctx.waitUntil(openModal(env, payload.trigger_id, buildSearchModal({
        channelId: payload.channel?.id,
        initialQuery: actionValue.initialQuery || '',
        initialCategory: actionValue.initialCategory || '興味・人柄'
      })));
    }
    return new Response('', { status: 200 });
  }

  if (payload.type === 'view_submission' && payload.view?.callback_id === SUBMIT_CALLBACK) {
    const category = payload.view.state.values[CATEGORY_BLOCK][CATEGORY_ACTION].selected_option.value;
    const query = (payload.view.state.values[QUERY_BLOCK][QUERY_ACTION].value || '').trim();
    const { channelId } = parseActionValue(payload.view.private_metadata);

    if (!query) {
      return slackJson({
        response_action: 'errors',
        errors: {
          [QUERY_BLOCK]: '検索条件を入力してください。'
        }
      });
    }

    ctx.waitUntil(postSearchResults(env, {
      channel: channelId,
      user: payload.user.id,
      query,
      category
    }));

    return slackJson({ response_action: 'clear' });
  }

  return new Response('', { status: 200 });
}

async function verifySlackRequest(request, rawBody, signingSecret) {
  if (!signingSecret) return false;

  const timestamp = request.headers.get('x-slack-request-timestamp');
  const signature = request.headers.get('x-slack-signature');
  if (!timestamp || !signature) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > 60 * 5) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${await hmacSha256Hex(signingSecret, base)}`;
  return timingSafeEqual(expected, signature);
}

async function hmacSha256Hex(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqual(a, b) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let index = 0; index < left.length; index++) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
}

function isAllowedChannel(channelId, allowedChannelIds) {
  const allowed = String(allowedChannelIds || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return allowed.length === 0 || allowed.includes(channelId);
}

async function openModal(env, triggerId, view) {
  if (!triggerId) return;
  await callSlackApi(env, 'views.open', {
    trigger_id: triggerId,
    view
  });
}

async function postSearchResults(env, { channel, user, query, category }) {
  if (!channel || !user) return;

  try {
    const facets = await loadFacets(env);
    const results = searchFacets(facets, query, {
      category,
      threshold: env.PEOPLE_FINDER_THRESHOLD || DEFAULT_THRESHOLD
    });
    const chunks = chunkResults(results);
    const pages = chunks.length ? chunks : [[]];

    for (let index = 0; index < pages.length; index++) {
      await callSlackApi(env, 'chat.postEphemeral', {
        channel,
        user,
        text: `「${query}」に近い社員検索結果`,
        blocks: resultMessageBlocks({
          query,
          category,
          results: pages[index],
          totalResults: results.length,
          page: index + 1,
          totalPages: pages.length
        })
      });
    }
  } catch (error) {
    console.error(error);
    await postSearchError(env, { channel, user, query }, error);
  }
}

async function postSearchError(env, { channel, user, query }, error) {
  try {
    await callSlackApi(env, 'chat.postEphemeral', {
      channel,
      user,
      text: '社員検索でエラーが発生しました。',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              `「${escapeMrkdwn(query)}」の検索中にエラーが発生しました。`,
              '検索データの取得先、またはSlack API設定を確認してください。'
            ].join('\n')
          }
        }
      ]
    });
  } catch (notifyError) {
    console.error('Failed to notify Slack search error', notifyError, error);
  }
}

async function callSlackApi(env, method, payload) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.SLACK_BOT_TOKEN_3}`,
      'content-type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Slack API ${method} failed: ${data.error}`);
  }
  return data;
}

async function loadFacets(env) {
  const now = Date.now();
  const ttl = Number(env.SEARCH_FACETS_CACHE_SECONDS || 300) * 1000;
  if (cachedFacets && now - cachedAt < ttl) return cachedFacets;

  const response = await fetch(env.SEARCH_FACETS_URL, {
    headers: env.SEARCH_FACETS_TOKEN ? { authorization: `Bearer ${env.SEARCH_FACETS_TOKEN}` } : {}
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch search facets: ${response.status}`);
  }
  const data = await response.json();
  cachedFacets = data['@graph'] || [];
  cachedAt = now;
  return cachedFacets;
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

function searchFacets(facets, query, options = {}) {
  const uiCategory = normalizeCategory(options.category || '興味・人柄');
  const parsedThreshold = Number(options.threshold ?? DEFAULT_THRESHOLD);
  const threshold = Number.isFinite(parsedThreshold) ? parsedThreshold : DEFAULT_THRESHOLD;
  const queryText = stripQueryHelpers(query) || normalizeText(query);
  const queryVector = vectorize(queryText);
  const queryTerms = tokenize(queryText);

  const scoredFacets = facets
    .filter((facet) => facet.uiCategory === uiCategory)
    .map((facet) => ({
      facet,
      score: scoreFacet(facet, queryVector, queryTerms)
    }));

  return aggregateByEmployee(scoredFacets, threshold);
}

function scoreFacet(facet, queryVector, queryTerms) {
  const labelText = [
    facet.label,
    ...(facet.aliases || [])
  ].filter(Boolean).join(' ');
  const evidenceText = [
    facet.evidence,
    ...(facet.messageQuotes || []).map((quote) => quote.text)
  ].filter(Boolean).join(' ');
  const combinedText = [labelText, evidenceText].filter(Boolean).join(' ');
  const labelScore = cosineSimilarity(queryVector, vectorize(labelText));
  const combinedScore = cosineSimilarity(queryVector, vectorize(combinedText));
  const label = normalizeText(labelText);
  const evidence = normalizeText(evidenceText);
  const labelBoost = queryTerms.filter((term) => label.includes(term)).length * 0.08;
  const evidenceBoost = queryTerms.filter((term) => evidence.includes(term)).length * 0.015;
  return Math.min(combinedScore * 0.75 + labelScore * 0.35 + labelBoost + evidenceBoost, 1);
}

function aggregateByEmployee(scoredFacets, threshold) {
  const byEmployee = new Map();
  for (const item of scoredFacets) {
    if (item.score < threshold) continue;
    const key = item.facet.employeeName;
    if (!byEmployee.has(key)) {
      byEmployee.set(key, {
        employeeName: key,
        slackIds: item.facet.slackIds || [],
        score: item.score,
        reasons: [],
        messageQuotes: []
      });
    }

    const result = byEmployee.get(key);
    result.score = Math.max(result.score, item.score);
    result.reasons.push({
      category: item.facet.category,
      label: item.facet.label,
      score: Number(item.score.toFixed(4)),
      evidence: item.facet.evidence
    });
    result.messageQuotes.push(...(item.facet.messageQuotes || []));
  }

  return [...byEmployee.values()]
    .map((result) => ({
      ...result,
      reasons: result.reasons.sort((a, b) => b.score - a.score).slice(0, 3),
      messageQuotes: dedupeQuotes(result.messageQuotes).slice(0, 3)
    }))
    .sort((a, b) => b.score - a.score || a.employeeName.localeCompare(b.employeeName, 'ja'));
}

function normalizeCategory(category) {
  const value = normalizeText(category);
  if (['work', 'job', 'consult', '仕事', '相談', normalizeText('仕事・相談')].includes(value)) {
    return '仕事・相談';
  }
  if (['interest', 'personal', 'personality', '興味', '人柄', normalizeText('興味・人柄')].includes(value)) {
    return '興味・人柄';
  }
  return category;
}

function stripQueryHelpers(query) {
  return normalizeText(query)
    .replace(/が好きな人|が好き|好きな人|好きな|興味がある人|詳しい人|得意な人|できる人|話せる人|相談できる人|相談したい|人/g, ' ')
    .replace(/について|に関心がある|に興味がある|を探して|探して|教えて|詳しい|相談/g, ' ')
    .replace(/([a-z0-9+#.])([^a-z0-9+#.\s])/g, '$1 $2')
    .replace(/([^a-z0-9+#.\s])([a-z0-9+#.])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value) {
  const normalized = normalizeText(value);
  const tokens = [];
  tokens.push(...normalized.split(/\s+/).filter((word) => word.length >= 2));
  tokens.push(...(normalized.match(/[a-z0-9+#.]{2,}/g) || []));

  const japaneseSegments = normalized
    .replace(/[a-z0-9+#.]+/g, ' ')
    .split(/\s+/)
    .filter((segment) => segment.length >= 2);
  for (const segment of japaneseSegments) {
    addNgrams(tokens, segment, 2);
    addNgrams(tokens, segment, 3);
  }

  return [...new Set(tokens)];
}

function addNgrams(tokens, text, size) {
  const chars = [...text.replace(/\s+/g, '')];
  if (chars.length < size) return;
  for (let index = 0; index <= chars.length - size; index++) {
    tokens.push(chars.slice(index, index + size).join(''));
  }
}

function vectorize(value) {
  const vector = new Map();
  for (const token of tokenize(value)) {
    vector.set(token, (vector.get(token) || 0) + 1);
  }
  return vector;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;

  for (const value of a.values()) aNorm += value * value;
  for (const value of b.values()) bNorm += value * value;
  for (const [key, value] of a.entries()) {
    dot += value * (b.get(key) || 0);
  }

  if (!aNorm || !bNorm) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

function dedupeQuotes(quotes) {
  const seen = new Set();
  const unique = [];
  for (const quote of quotes) {
    const key = `${quote.channelId}:${quote.messageTs}:${quote.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(quote);
  }
  return unique;
}

function chunkResults(results, size = 12) {
  const chunks = [];
  for (let index = 0; index < results.length; index += size) {
    chunks.push(results.slice(index, index + size));
  }
  return chunks;
}

function parseActionValue(value) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
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

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function slackJson(payload) {
  return json(payload);
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[・、。,.!?！？:：;；()[\]{}「」『』"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
