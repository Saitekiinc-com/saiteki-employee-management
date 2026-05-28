const COMMAND_PATH = '/slack/commands';
const INTERACTIONS_PATH = '/slack/interactions';
const OPEN_ACTION = 'open_people_finder_modal';
const SUBMIT_CALLBACK = 'people_finder_submit';
const CATEGORY_ACTION = 'category';
const QUERY_ACTION = 'query';
const CATEGORY_BLOCK = 'search_category';
const QUERY_BLOCK = 'search_query';
const DEFAULT_THRESHOLD = 0.18;
const DEFAULT_VECTOR_THRESHOLD = 0.22;
const DEFAULT_MESSAGE_VECTOR_THRESHOLD = 0.12;
const DEFAULT_TOP_UNITS = 80;
const DEFAULT_RERANK_CANDIDATES = 12;
const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-001';
const DEFAULT_EMBEDDING_DIMENSIONS = 768;
const DEFAULT_RERANK_MODEL = 'gemini-2.0-flash';

const INTENT_RANK = {
  direct: 4,
  adjacent: 3,
  weak: 2,
  reject: 1
};

const WORK_QUERY_PATTERN = /aws|azure|gcp|react|next|rag|qa|pm|poc|api|db|sql|bi|gemini|cursor|notion|slack|github|開発|運用|監視|設計|要件|技術|テスト|品質|分析|採用|営業|総務|人事|オンボーディング|データ|プロンプト|自動化|インフラ|サーバ|アーキテクチャ|マネジメント|合意形成/i;
const PERSONAL_QUERY_PATTERN = /好き|趣味|休日|映画|音楽|ゲーム|アニメ|漫画|マンガ|ポケモン|ガンダム|トミカ|自炊|料理|楽器|動物|犬|猫|旅行|スポーツ|読書/i;

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
let cachedMessageIndex;
let cachedMessageIndexAt = 0;
let cachedProfileIndex;
let cachedProfileIndexAt = 0;

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
      initialQuery: query.trim(),
      initialCategory: resolveSearchCategory(query.trim(), '仕事・相談').category
    })));
  }

  return slackJson({
    response_type: 'ephemeral',
    blocks: buttonBlocks({
      initialQuery: query.trim(),
      initialCategory: resolveSearchCategory(query.trim(), '仕事・相談').category
    })
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
        initialCategory: resolveSearchCategory(actionValue.initialQuery || '', actionValue.initialCategory || '仕事・相談').category
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
    const categoryResolution = resolveSearchCategory(query, category || '仕事・相談');
    const results = await searchPeople(env, query, categoryResolution);
    const chunks = chunkResults(results);
    const pages = chunks.length ? chunks : [[]];

    for (let index = 0; index < pages.length; index++) {
      await callSlackApi(env, 'chat.postEphemeral', {
        channel,
        user,
        text: `「${query}」に近い社員検索結果`,
        blocks: resultMessageBlocks({
          query,
          category: categoryResolution.category,
          categoryInferred: categoryResolution.inferred,
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

async function searchPeople(env, query, categoryResolution) {
  if (canUseMessageSearch(env)) {
    try {
      return await searchMessageIndex(env, query);
    } catch (error) {
      console.error('Message vector people search failed; falling back to profile search', error);
    }
  }

  if (canUseVectorSearch(env)) {
    try {
      return await searchProfileIndex(env, query, categoryResolution.category);
    } catch (error) {
      console.error('Vector people search failed; falling back to search facets', error);
    }
  }

  const facets = await loadFacets(env);
  return searchFacets(facets, query, {
    category: categoryResolution.category,
    threshold: env.PEOPLE_FINDER_THRESHOLD || DEFAULT_THRESHOLD
  });
}

function canUseMessageSearch(env) {
  return Boolean(env.MESSAGE_SEARCH_INDEX_URL && env.GEMINI_API_KEY);
}

function canUseVectorSearch(env) {
  return Boolean(env.PROFILE_SEARCH_INDEX_URL && env.GEMINI_API_KEY);
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

async function loadProfileIndex(env) {
  const now = Date.now();
  const ttl = Number(env.PROFILE_SEARCH_INDEX_CACHE_SECONDS || env.SEARCH_FACETS_CACHE_SECONDS || 300) * 1000;
  if (cachedProfileIndex && now - cachedProfileIndexAt < ttl) return cachedProfileIndex;

  const response = await fetch(env.PROFILE_SEARCH_INDEX_URL, {
    headers: env.PROFILE_SEARCH_INDEX_TOKEN ? { authorization: `Bearer ${env.PROFILE_SEARCH_INDEX_TOKEN}` } : {}
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch profile search index: ${response.status}`);
  }
  cachedProfileIndex = await response.json();
  cachedProfileIndexAt = now;
  return cachedProfileIndex;
}

async function loadMessageIndex(env) {
  const now = Date.now();
  const ttl = Number(env.MESSAGE_SEARCH_INDEX_CACHE_SECONDS || env.PROFILE_SEARCH_INDEX_CACHE_SECONDS || env.SEARCH_FACETS_CACHE_SECONDS || 300) * 1000;
  if (cachedMessageIndex && now - cachedMessageIndexAt < ttl) return cachedMessageIndex;

  const response = await fetch(env.MESSAGE_SEARCH_INDEX_URL, {
    headers: env.MESSAGE_SEARCH_INDEX_TOKEN ? { authorization: `Bearer ${env.MESSAGE_SEARCH_INDEX_TOKEN}` } : {}
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch message search index: ${response.status}`);
  }
  cachedMessageIndex = await response.json();
  cachedMessageIndexAt = now;
  return cachedMessageIndex;
}

function buildSearchModal({ channelId, initialQuery = '', initialCategory = '仕事・相談' }) {
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
          text: '*探したい方向を選んで、自然文で入力してください。*\n社員データとメッセージ引用から、近い発言やプロフィール根拠を検索します。'
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

function buttonBlocks({ initialQuery = '', initialCategory = '仕事・相談' } = {}) {
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

function resultMessageBlocks({ query, category, categoryInferred = false, results, totalResults, page, totalPages }) {
  const categoryText = categoryInferred
    ? `${escapeMrkdwn(category)} (入力内容から自動判定)`
    : escapeMrkdwn(category);

  if (results.length === 0) {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `「${escapeMrkdwn(query)}」に合う社員は見つかりませんでした。\nカテゴリ: *${categoryText}*`
        }
      }
    ];
  }

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `「${escapeMrkdwn(query)}」に近い社員が *${totalResults}名* 見つかりました。\nカテゴリ: *${categoryText}* / 表示: ${page}/${totalPages}`
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
    .map((reason) => `・${escapeMrkdwn(reason.label)} (${Math.round(reason.score * 100)}%) - ${escapeMrkdwn(reasonSourceLabel(reason))}`)
    .join('\n');
  const detailNotes = result.reasons.flatMap(reasonDetailNotes).join('\n');
  const rerankNote = result.rerankReason
    ? `${escapeMrkdwn(result.rerankReason)} (${Math.round(Number(result.rerankConfidence || 0) * 100)}%)`
    : '';
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
        rerankNote ? `AI判定:\n${rerankNote}` : '',
        detailNotes ? `具体メモ:\n${detailNotes}` : '',
        quotes ? `メッセージ引用:\n${quotes}` : ''
      ].filter(Boolean).join('\n')
    }
  };
}

function reasonDetailNotes(reason) {
  const snippets = (reason.evidenceSnippets || [])
    .map((snippet) => typeof snippet === 'string' ? snippet : snippet.text)
    .filter(Boolean);
  if (snippets.length > 0) {
    return snippets.map((snippet) => `・${escapeMrkdwn(truncate(formatEvidenceSnippet(reason, snippet), 170))}`);
  }
  return [`・${escapeMrkdwn(formatEvidenceSnippet(reason, reason.label))}`];
}

function formatEvidenceSnippet(reason, snippet) {
  const text = String(snippet || '').trim();
  const label = String(reason.label || '').trim();
  const fallbackNote = isWorkReason(reason) ? '具体的な経験内容までは未整理' : '具体的な種類・文脈までは未整理';
  if (!text) return `${label}（${fallbackNote}）`;
  if (normalizeText(text) === normalizeText(label) && !/[（(].+[）)]/.test(text)) {
    return `${text}（${fallbackNote}）`;
  }
  return text;
}

function isWorkReason(reason) {
  return ['strength', 'work_style', 'work_topic'].includes(reason.category);
}

function reasonSourceLabel(reason) {
  if (reason.sourceLabel) return reason.sourceLabel;
  switch (reason.sourceField) {
    case 'work_styles_and_strengths.dominant_strengths':
      return '仕事上の強み';
    case 'work_styles_and_strengths.problem_solving_style':
      return '問題解決スタイル';
    case 'current_state.recent_topics_of_interest':
      return reason.category === 'work_topic' ? '最近の仕事・技術トピック' : '最近の関心・話題';
    case 'values_and_motivators.core_values':
      return '価値観';
    case 'values_and_motivators.motivation_triggers':
      return '動機・嬉しいこと';
    default:
      return '社員データ';
  }
}

async function searchProfileIndex(env, query, uiCategory) {
  const index = await loadProfileIndex(env);
  return searchVectorIndex(env, index, query, {
    uiCategory,
    threshold: env.PEOPLE_FINDER_VECTOR_THRESHOLD || DEFAULT_VECTOR_THRESHOLD
  });
}

async function searchMessageIndex(env, query) {
  const index = await loadMessageIndex(env);
  return searchVectorIndex(env, index, query, {
    threshold: env.PEOPLE_FINDER_MESSAGE_VECTOR_THRESHOLD || DEFAULT_MESSAGE_VECTOR_THRESHOLD
  });
}

async function searchVectorIndex(env, index, query, options = {}) {
  ensureEmbeddedIndex(index);

  const queryText = stripQueryHelpers(query) || normalizeText(query);
  const queryVector = await embedQuery(env, queryText, index.embedding?.model, firstVectorDimensions(index));
  const threshold = parseNumber(options.threshold, DEFAULT_VECTOR_THRESHOLD);
  const topUnits = parseNumber(env.PEOPLE_FINDER_VECTOR_TOP_UNITS, DEFAULT_TOP_UNITS);
  const uiCategory = options.uiCategory;
  const graph = Array.isArray(index['@graph']) ? index['@graph'] : [];

  const scoredUnits = graph
    .filter((unit) => !uiCategory || !unit.uiCategory || unit.uiCategory === uiCategory)
    .map((unit) => ({
      unit,
      score: cosineVectorSimilarity(queryVector, unitVector(unit)) + lexicalLabelBoost(unit, queryText)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topUnits);

  const results = aggregateVectorUnits(scoredUnits, threshold);
  if (results.length === 0 || env.PEOPLE_FINDER_ENABLE_RERANK === 'false') {
    return results;
  }

  try {
    return await rerankVectorResults(env, query, results, {
      candidateLimit: env.PEOPLE_FINDER_RERANK_CANDIDATES,
      includeAdjacent: env.PEOPLE_FINDER_DIRECT_ONLY !== 'true'
    });
  } catch (error) {
    console.error('Vector people rerank failed; returning vector results', error);
    return results;
  }
}

function ensureEmbeddedIndex(index) {
  const graph = Array.isArray(index?.['@graph']) ? index['@graph'] : [];
  const missing = graph.filter((unit) => unitVector(unit).length === 0);
  if (graph.length === 0 || missing.length > 0) {
    throw new Error(`Vector search index is not embedded: ${missing.length || graph.length} units without vectors.`);
  }
}

function unitVector(unit) {
  if (Array.isArray(unit.embedding)) return unit.embedding;
  if (Array.isArray(unit.embedding?.vector)) return unit.embedding.vector;
  if (Array.isArray(unit.embedding?.values)) return unit.embedding.values;
  return [];
}

function firstVectorDimensions(index) {
  for (const unit of index?.['@graph'] || []) {
    const vector = unitVector(unit);
    if (vector.length > 0) return vector.length;
  }
  return 0;
}

function lexicalLabelBoost(unit, queryText) {
  const textParts = [
    unit.relationLabel,
    unit.topicLabel,
    ...(unit.topicAliases || [])
  ];

  if (unit.semanticType === 'slack_message') {
    textParts.push(
      unit.searchText,
      ...(unit.detailBullets || []),
      ...(unit.quotes || []).map((quote) => quote.text)
    );
  }

  const labelText = normalizeText(textParts.filter(Boolean).join(' '));
  if (!labelText) return 0;
  const terms = tokenize(queryText).filter((term) => term.length >= 2);
  const matched = terms.filter((term) => labelText.includes(term)).length;
  const weight = unit.semanticType === 'slack_message' ? 0.09 : 0.06;
  const cap = unit.semanticType === 'slack_message' ? 0.24 : 0.18;
  return Math.min(matched * weight, cap);
}

function aggregateVectorUnits(scoredUnits, threshold) {
  const byEmployee = new Map();
  for (const item of scoredUnits) {
    if (item.score < threshold) continue;
    const key = item.unit.personName;
    if (!key) continue;
    if (!byEmployee.has(key)) {
      byEmployee.set(key, {
        employeeName: key,
        slackIds: item.unit.slackIds || [],
        score: item.score,
        reasons: [],
        messageQuotes: []
      });
    }

    const result = byEmployee.get(key);
    result.score = Math.max(result.score, item.score);
    result.reasons.push(vectorReason(item.unit, item.score));
    result.messageQuotes.push(...(item.unit.quotes || []));
  }

  return [...byEmployee.values()]
    .map((result) => ({
      ...result,
      score: Number(result.score.toFixed(4)),
      reasons: result.reasons.sort((a, b) => b.score - a.score).slice(0, 3),
      messageQuotes: dedupeQuotes(result.messageQuotes).slice(0, 3)
    }))
    .sort((a, b) => b.score - a.score || a.employeeName.localeCompare(b.employeeName, 'ja'));
}

function vectorReason(unit, score) {
  return {
    unitId: unit['@id'],
    category: unit.category,
    label: unit.relationLabel || unit.topicLabel || unit.predicate || 'プロフィール根拠',
    score: Number(score.toFixed(4)),
    sourceField: unit.sourceField || unit.sourceFields?.[0],
    sourceLabel: unit.sourceLabel || unit.uiCategory || 'プロフィールグラフ',
    evidenceSnippets: (unit.detailBullets || []).slice(0, 4),
    detailBullets: unit.detailBullets || [],
    relationLabel: unit.relationLabel,
    topicLabel: unit.topicLabel,
    semanticType: unit.semanticType
  };
}

async function embedQuery(env, text, indexModel, indexDimensions = 0) {
  const model = env.GEMINI_EMBEDDING_MODEL || indexModel || DEFAULT_EMBEDDING_MODEL;
  const dimensions = parseNumber(indexDimensions || env.GEMINI_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_DIMENSIONS);
  const data = await callGemini(env, model, 'embedContent', {
    content: { parts: [{ text }] },
    embedContentConfig: {
      taskType: 'RETRIEVAL_QUERY',
      outputDimensionality: dimensions
    }
  });
  const values = data.embedding?.values;
  if (!Array.isArray(values)) {
    throw new Error('Gemini embedding response did not include embedding.values.');
  }
  return fitVectorDimensions(values, dimensions);
}

function fitVectorDimensions(vector, dimensions) {
  if (!dimensions || !Array.isArray(vector) || vector.length <= dimensions) return vector;
  return vector.slice(0, dimensions);
}

async function rerankVectorResults(env, query, results, options = {}) {
  const candidateLimit = parseNumber(options.candidateLimit, DEFAULT_RERANK_CANDIDATES);
  const candidates = results.slice(0, candidateLimit);
  const decisions = await geminiRerank(env, query, candidates);
  return applyRerankDecisions(candidates, decisions, {
    includeAdjacent: options.includeAdjacent !== false
  });
}

async function geminiRerank(env, query, results) {
  const model = env.GEMINI_RERANK_MODEL || DEFAULT_RERANK_MODEL;
  const data = await callGemini(env, model, 'generateContent', {
    contents: [
      {
        role: 'user',
        parts: [{ text: buildRerankPrompt(query, results) }]
      }
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json'
    }
  });
  const text = (data.candidates || [])
    .flatMap((candidate) => candidate.content?.parts || [])
    .map((part) => part.text)
    .filter(Boolean)
    .join('\n');
  return parseJsonText(text).decisions || [];
}

async function callGemini(env, model, method, payload) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${geminiModelResource(model)}:${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-goog-api-key': env.GEMINI_API_KEY
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Gemini ${method} failed: ${response.status} ${JSON.stringify(data).slice(0, 240)}`);
  }
  return data;
}

function geminiModelResource(model) {
  const value = String(model || '').trim();
  return value.startsWith('models/') ? value : `models/${value}`;
}

function parseJsonText(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error(`AI rerank response is not JSON: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

function buildRerankPrompt(query, results) {
  return `あなたは社員検索の再ランキング担当です。
検索クエリに対して、候補社員が本当に近いかを根拠だけで判定してください。

判定ラベル:
- direct: 検索意図に直接合う
- adjacent: 近いが主目的から少し外れる
- weak: 関連はあるが候補として弱い
- reject: 表示しない

ルール:
- 根拠にない推測はしない
- 職種検索では、AI、エンジニア、影響力だけの候補は reject または weak
- 趣味検索では、具体的な接点がある候補を direct
- Slackメッセージ検索では、関連する実発言がある候補を direct または adjacent
- 発言が質問・引用・雑談だけで相談相手として弱い場合は adjacent または weak
- selectedReasonUnitIds は判定根拠に使ったunitIdだけを入れる
- JSONだけを返す

出力形式:
{
  "decisions": [
    {
      "employeeName": "社員名",
      "intentFit": "direct",
      "confidence": 0.9,
      "reason": "短い理由",
      "selectedReasonUnitIds": ["search-unit:..."]
    }
  ]
}

検索クエリ:
${query}

候補:
${JSON.stringify(results.map(compactVectorResult), null, 2)}`;
}

function compactVectorResult(result) {
  return {
    employeeName: result.employeeName,
    score: result.score,
    reasons: (result.reasons || []).map((reason) => ({
      unitId: reason.unitId,
      semanticType: reason.semanticType,
      relationLabel: reason.relationLabel,
      topicLabel: reason.topicLabel,
      score: reason.score,
      detailBullets: (reason.detailBullets || []).slice(0, 3)
    })),
    quotes: (result.messageQuotes || []).slice(0, 2).map((quote) => ({
      text: quote.text,
      channelName: quote.channelName,
      authorName: quote.authorName
    }))
  };
}

function applyRerankDecisions(results, decisions, options = {}) {
  const includeAdjacent = options.includeAdjacent !== false;
  const decisionByName = new Map((decisions || []).map((decision) => [decision.employeeName, decision]));
  return results
    .map((result) => {
      const decision = decisionByName.get(result.employeeName);
      if (!decision) return null;
      const selectedIds = new Set(decision.selectedReasonUnitIds || []);
      const selectedReasons = selectedIds.size > 0
        ? result.reasons.filter((reason) => selectedIds.has(reason.unitId))
        : result.reasons;
      return {
        ...result,
        intentFit: decision.intentFit,
        rerankConfidence: decision.confidence,
        rerankReason: decision.reason,
        reasons: selectedReasons.length > 0 ? selectedReasons : result.reasons
      };
    })
    .filter(Boolean)
    .filter((result) => result.intentFit === 'direct' || (includeAdjacent && result.intentFit === 'adjacent'))
    .sort((a, b) => {
      const rankDiff = (INTENT_RANK[b.intentFit] || 0) - (INTENT_RANK[a.intentFit] || 0);
      if (rankDiff !== 0) return rankDiff;
      return (b.rerankConfidence || 0) - (a.rerankConfidence || 0) || b.score - a.score;
    });
}

function searchFacets(facets, query, options = {}) {
  const uiCategory = resolveSearchCategory(query, options.category || '興味・人柄').category;
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
  const evidenceScore = cosineSimilarity(queryVector, vectorize(evidenceText));
  const combinedScore = cosineSimilarity(queryVector, vectorize(combinedText));
  const label = normalizeText(labelText);
  const evidence = normalizeText(evidenceText);
  const labelBoost = queryTerms.filter((term) => label.includes(term)).length * 0.08;
  const labelMatched = labelScore > 0.04 || labelBoost > 0;
  const evidenceBoost = labelMatched ? queryTerms.filter((term) => evidence.includes(term)).length * 0.01 : 0;
  const evidenceWeight = labelMatched ? 0.2 : 0.05;
  return Math.min(
    labelScore * 0.8
      + evidenceScore * evidenceWeight
      + combinedScore * 0.05
      + labelBoost
      + evidenceBoost,
    1
  );
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
      sourceField: item.facet.sourceField,
      evidenceSnippets: item.facet.evidenceSnippets || [],
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

function inferCategoryFromQuery(query) {
  const value = normalizeText(query);
  if (PERSONAL_QUERY_PATTERN.test(value)) return '興味・人柄';
  if (WORK_QUERY_PATTERN.test(value)) return '仕事・相談';
  return null;
}

function resolveSearchCategory(query, selectedCategory) {
  const normalizedCategory = normalizeCategory(selectedCategory || '興味・人柄');
  const inferredCategory = inferCategoryFromQuery(query);
  return {
    category: inferredCategory || normalizedCategory,
    inferred: Boolean(inferredCategory && inferredCategory !== normalizedCategory),
    selectedCategory: normalizedCategory
  };
}

function stripQueryHelpers(query) {
  return normalizeText(query)
    .replace(/が好きな人|が好き|好きな人|好きな|興味がある人|詳しい人|得意な人|できる人|話せる人|相談できる人|相談したい|人/g, ' ')
    .replace(/を知っている人|を知っている|知っている人|知っている|知ってる|分かる|わかる|経験者|または|もしくは|あるいは/g, ' ')
    .replace(/について|に関心がある|に興味がある|を探して|探して|教えて欲しい|教えてほしい|教えて|欲しい|ほしい|詳しい|相談/g, ' ')
    .replace(/([a-z0-9+#.])([^a-z0-9+#.\s])/g, '$1 $2')
    .replace(/([^a-z0-9+#.\s])([a-z0-9+#.])/g, '$1 $2')
    .replace(/(^|\s)(に|を|が|は|の|と|で)(?=\s|$)/g, ' ')
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

function cosineVectorSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index];
    aNorm += a[index] * a[index];
    bNorm += b[index] * b[index];
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

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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
