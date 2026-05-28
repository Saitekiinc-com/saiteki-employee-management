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
const DEFAULT_SEARCH_TIMEOUT_MS = 25000;
const DEFAULT_PROFILE_FALLBACK_MIN = 4;
const DEFAULT_ENABLE_PROFILE_FALLBACK = false;
const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-001';
const DEFAULT_EMBEDDING_DIMENSIONS = 768;
const DEFAULT_RERANK_MODEL = 'gemini-2.5-flash';
const DEFAULT_MESSAGE_VIEWER_URL = 'https://saitekiinc-com.github.io/saiteki-employee-management/slack-export/';

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
    const startedAt = Date.now();
    const categoryResolution = resolveSearchCategory(query, category || '仕事・相談');
    console.log('People finder search started', {
      category: categoryResolution.category,
      queryLength: String(query || '').length
    });
    const response = await searchPeopleAnswerWithTimeout(env, query, categoryResolution);
    console.log('People finder search response ready', {
      elapsedMs: Date.now() - startedAt,
      hasBlocks: Boolean(response.blocks),
      resultCount: response.results?.length || 0
    });

    if (response.blocks) {
      await callSlackApi(env, 'chat.postEphemeral', {
        channel,
        user,
        text: `「${query}」への社員検索回答`,
        blocks: response.blocks
      });
      return;
    }

    const chunks = chunkResults(response.results || []);
    const pages = chunks.length ? chunks : [[]];
    const totalResults = response.results?.length || 0;
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
          totalResults,
          page: index + 1,
          totalPages: pages.length,
          messageViewerUrl: env.MESSAGE_VIEWER_URL || DEFAULT_MESSAGE_VIEWER_URL
        })
      });
    }
  } catch (error) {
    console.error(error);
    await postSearchError(env, { channel, user, query }, error);
  }
}

async function searchPeopleAnswerWithTimeout(env, query, categoryResolution) {
  const timeoutMs = parseNumber(env.PEOPLE_FINDER_SEARCH_TIMEOUT_MS, DEFAULT_SEARCH_TIMEOUT_MS);
  const timeout = createSearchTimeout(timeoutMs, {
    blocks: answerMessageBlocks({
      query,
      category: categoryResolution.category,
      categoryInferred: categoryResolution.inferred,
      plan: simpleSearchPlan(query, categoryResolution.category),
      answer: `検索処理が${Math.round(timeoutMs / 1000)}秒以内に完了しませんでした。回答なしで止まらないよう、いったん処理を中断しました。検索語を少し具体化して再実行するか、時間を置いて試してください。`,
      selected: [],
      candidates: [],
      messageViewerUrl: env.MESSAGE_VIEWER_URL || DEFAULT_MESSAGE_VIEWER_URL
    })
  });
  const searchPromise = searchPeopleAnswer(env, query, categoryResolution);
  searchPromise.catch((error) => {
    console.error('People finder search failed after timeout race', error);
  });

  try {
    return await Promise.race([searchPromise, timeout.promise]);
  } finally {
    timeout.cancel();
  }
}

function createSearchTimeout(timeoutMs, response) {
  let timeoutId;
  const promise = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      console.warn('People finder search timed out', { timeoutMs });
      resolve(response);
    }, timeoutMs);
  });
  return {
    promise,
    cancel() {
      clearTimeout(timeoutId);
    }
  };
}

async function searchPeopleAnswer(env, query, categoryResolution) {
  const messageViewerUrl = env.MESSAGE_VIEWER_URL || DEFAULT_MESSAGE_VIEWER_URL;
  let plan = simpleSearchPlan(query, categoryResolution.category);
  if (shouldUseQueryPlanning(env)) {
    try {
      plan = await planSearchIntent(env, query, categoryResolution.category);
    } catch (error) {
      console.error('Search intent planning failed; using simple plan', error);
    }
  }

  const candidates = await collectSearchCandidates(env, query, categoryResolution, plan);
  if (candidates.length === 0) {
    return {
      blocks: answerMessageBlocks({
        query,
        category: categoryResolution.category,
        categoryInferred: categoryResolution.inferred,
        plan,
        answer: '該当しそうな社員は見つかりませんでした。検索語を少し広げると見つかる可能性があります。',
        selected: [],
        candidates,
        messageViewerUrl
      })
    };
  }

  if (canUseAnswerGeneration(env)) {
    try {
      const answer = await generatePeopleAnswer(env, query, categoryResolution.category, plan, candidates);
      return {
        blocks: answerMessageBlocks({
          query,
          category: categoryResolution.category,
          categoryInferred: categoryResolution.inferred,
          plan,
          answer: answer.answer,
          selected: answer.selected || [],
          candidates,
          messageViewerUrl
        })
      };
    } catch (error) {
      console.error('People answer generation failed', answerGenerationErrorDetails(error));
      const diagnosticsNote = answerFailureDiagnosticsNote(env, error);
      return {
        blocks: answerMessageBlocks({
          query,
          category: categoryResolution.category,
          categoryInferred: categoryResolution.inferred,
          plan,
          answer: [
            'AI回答生成に失敗しました。検索候補は取得できていますが、質問意図に沿った根拠判定が完了しなかったため、候補一覧の表示を止めました。少し時間を置いて再実行してください。',
            diagnosticsNote
          ].filter(Boolean).join('\n\n'),
          selected: [],
          candidates: [],
          messageViewerUrl
        })
      };
    }
  }

  return { results: candidates };
}

async function collectSearchCandidates(env, originalQuery, categoryResolution, plan) {
  const vectorQuery = plan.searchQuery || originalQuery;
  const rerankQuery = buildRerankQuery(originalQuery, plan);
  const profileFallbackMin = parseNumber(env.PEOPLE_FINDER_PROFILE_FALLBACK_MIN, DEFAULT_PROFILE_FALLBACK_MIN);
  const skipCollectionRerank = env.PEOPLE_FINDER_COLLECTION_RERANK !== 'true';
  const resultSets = [];
  let attemptedVectorSearch = false;

  if (canUseMessageSearch(env)) {
    attemptedVectorSearch = true;
    try {
      const messageResults = await searchMessageIndex(env, vectorQuery, {
        rerankQuery,
        skipRerank: skipCollectionRerank
      });
      console.log('People finder message candidates collected', { count: messageResults.length });
      if (messageResults.length > 0) {
        resultSets.push(messageResults);
        if (!shouldUseProfileFallback(env) || messageResults.length >= profileFallbackMin) {
          return mergeSearchResults(resultSets.flat()).slice(0, DEFAULT_RERANK_CANDIDATES);
        }
      }
    } catch (error) {
      console.error('Message vector candidate collection failed', error);
    }
  }

  if (shouldUseProfileFallback(env) && canUseVectorSearch(env)) {
    attemptedVectorSearch = true;
    try {
      const profileResults = await searchProfileIndex(env, vectorQuery, categoryResolution.category, {
        rerankQuery,
        skipRerank: skipCollectionRerank
      });
      console.log('People finder profile candidates collected', { count: profileResults.length });
      if (profileResults.length > 0) resultSets.push(profileResults);
    } catch (error) {
      console.error('Profile vector candidate collection failed', error);
    }
  }

  if (resultSets.length === 0) {
    if (attemptedVectorSearch) return [];
    const facets = await loadFacets(env);
    resultSets.push(searchFacets(facets, originalQuery, {
      category: categoryResolution.category,
      threshold: env.PEOPLE_FINDER_THRESHOLD || DEFAULT_THRESHOLD
    }));
  }

  return mergeSearchResults(resultSets.flat()).slice(0, DEFAULT_RERANK_CANDIDATES);
}

function buildRerankQuery(originalQuery, plan) {
  const lines = [
    `元の入力: ${originalQuery}`,
    plan?.interpretedQuestion ? `解釈した質問: ${plan.interpretedQuestion}` : '',
    plan?.relationIntent ? `関係性意図: ${plan.relationIntent}` : '',
    plan?.mustHaveEvidence?.length ? `必要な根拠: ${plan.mustHaveEvidence.join('、')}` : '',
    plan?.rejectEvidence?.length ? `除外する根拠: ${plan.rejectEvidence.join('、')}` : ''
  ].filter(Boolean);
  return lines.join('\n');
}

function mergeSearchResults(results) {
  const byName = new Map();
  for (const result of results || []) {
    const key = result.employeeName;
    if (!key) continue;
    if (!byName.has(key)) {
      byName.set(key, {
        ...result,
        slackIds: result.slackIds || [],
        reasons: [],
        messageQuotes: []
      });
    }
    const merged = byName.get(key);
    merged.score = Math.max(Number(merged.score || 0), Number(result.score || 0));
    merged.slackIds = [...new Set([...(merged.slackIds || []), ...(result.slackIds || [])])];
    merged.reasons.push(...(result.reasons || []));
    merged.messageQuotes.push(...(result.messageQuotes || []));
  }

  return [...byName.values()]
    .map((result) => ({
      ...result,
      reasons: dedupeBy(result.reasons, (reason) => reason.unitId || `${reason.label}:${reason.sourceField}`).slice(0, 5),
      messageQuotes: dedupeQuotes(result.messageQuotes).slice(0, 5)
    }))
    .sort((a, b) => b.score - a.score || a.employeeName.localeCompare(b.employeeName, 'ja'));
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const unique = [];
  for (const item of items || []) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function canUseMessageSearch(env) {
  return Boolean(env.MESSAGE_SEARCH_INDEX_URL && env.GEMINI_API_KEY);
}

function canUseVectorSearch(env) {
  return Boolean(env.PROFILE_SEARCH_INDEX_URL && env.GEMINI_API_KEY);
}

function canUseAnswerGeneration(env) {
  return Boolean(env.GEMINI_API_KEY);
}

function shouldUseQueryPlanning(env) {
  return env.PEOPLE_FINDER_ENABLE_QUERY_PLANNING === 'true' && canUseAnswerGeneration(env);
}

function shouldUseProfileFallback(env) {
  const value = env.PEOPLE_FINDER_ENABLE_PROFILE_FALLBACK;
  if (value === undefined || value === null || value === '') return DEFAULT_ENABLE_PROFILE_FALLBACK;
  return value === 'true';
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
          text: '*探したい方向を選んで、自然文で入力してください。*\n社員データと根拠メッセージから、近い発言やプロフィール根拠を検索します。'
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

function resultMessageBlocks({ query, category, categoryInferred = false, results, totalResults, page, totalPages, messageViewerUrl }) {
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
    blocks.push(formatResult(result, { messageViewerUrl }));
  }

  return blocks;
}

function answerMessageBlocks({ query, category, categoryInferred = false, plan, answer, selected, candidates, messageViewerUrl }) {
  const categoryText = categoryInferred
    ? `${escapeMrkdwn(category)} (入力内容から自動判定)`
    : escapeMrkdwn(category);
  const interpreted = plan?.interpretedQuestion && normalizeText(plan.interpretedQuestion) !== normalizeText(query)
    ? `\n解釈: ${escapeMrkdwn(plan.interpretedQuestion)}`
    : '';
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `「${escapeMrkdwn(query)}」への回答\nカテゴリ: *${categoryText}*${interpreted}`
      }
    },
    { type: 'divider' }
  ];

  for (const chunk of splitMrkdwn(answer || '回答を生成できませんでした。')) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: chunk }
    });
  }

  const evidenceLines = answerEvidenceLines(selected, candidates, messageViewerUrl);
  if (evidenceLines.length > 0) {
    blocks.push({ type: 'divider' });
    for (const chunk of splitMrkdwn(`*根拠メッセージ*\n${evidenceLines.join('\n')}`)) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: chunk }
      });
    }
  }

  return blocks.slice(0, 20);
}

function splitMrkdwn(text, maxLength = 2800) {
  const chunks = [];
  let rest = String(text || '').trim();
  while (rest.length > maxLength) {
    const cut = Math.max(rest.lastIndexOf('\n', maxLength), rest.lastIndexOf('。', maxLength));
    const index = cut > maxLength * 0.5 ? cut + 1 : maxLength;
    chunks.push(rest.slice(0, index).trim());
    rest = rest.slice(index).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function answerEvidenceLines(selected, candidates, messageViewerUrl) {
  const byName = new Map((candidates || []).map((result) => [result.employeeName, result]));
  const selectedItems = Array.isArray(selected)
    ? selected
    : (candidates || []).slice(0, 5).map((result) => ({ employeeName: result.employeeName }));
  const lines = [];
  const seen = new Set();

  for (const item of selectedItems) {
    const result = byName.get(item.employeeName);
    if (!result) continue;
    const selectedIds = new Set(item.reasonUnitIds || item.selectedReasonUnitIds || []);
    const quotes = selectedIds.size > 0
      ? filterMessageQuotesByReasonIds(result.messageQuotes || [], selectedIds)
      : result.messageQuotes || [];
    const displayQuotes = (quotes.length > 0 ? quotes : result.messageQuotes || []).slice(0, 2);
    for (const quote of displayQuotes) {
      const reference = formatMessageReference(quote, messageViewerUrl).replace(/^・/, '');
      if (!reference) continue;
      const key = `${item.employeeName}:${reference}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`・${escapeMrkdwn(item.employeeName)}: ${reference}`);
      if (lines.length >= 8) return lines;
    }
  }

  return lines;
}

function formatResult(result, options = {}) {
  const mention = result.slackIds?.[0] ? `<@${result.slackIds[0]}>` : escapeMrkdwn(result.employeeName);
  const reasons = result.reasons
    .map((reason) => `・${escapeMrkdwn(reason.label)} (${Math.round(reason.score * 100)}%) - ${escapeMrkdwn(reasonSourceLabel(reason))}`)
    .join('\n');
  const detailNotes = resultDetailNotes(result.reasons).join('\n');
  const rerankNote = result.rerankReason
    ? `${escapeMrkdwn(result.rerankReason)} (${Math.round(Number(result.rerankConfidence || 0) * 100)}%)`
    : '';
  const messageLinks = result.messageQuotes
    .map((quote) => formatMessageReference(quote, options.messageViewerUrl))
    .filter(Boolean)
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
        messageLinks ? `根拠メッセージ:\n${messageLinks}` : ''
      ].filter(Boolean).join('\n')
    }
  };
}

function formatMessageReference(quote, viewerBaseUrl) {
  const url = messageReferenceUrl(quote, viewerBaseUrl);
  if (!url) return '';
  return `・<${url}|${escapeMrkdwn(messageReferenceLabel(quote))}>`;
}

function messageReferenceUrl(quote, viewerBaseUrl) {
  const messageId = normalizeMessagePageId(quote.messageId) || messagePageIdFromQuote(quote);
  const baseUrl = String(viewerBaseUrl || '').trim();
  if (baseUrl && messageId) {
    try {
      const url = new URL(baseUrl);
      url.searchParams.set('message', messageId);
      return url.toString();
    } catch (error) {
      console.error('Invalid message viewer URL', error);
    }
  }
  return quote.permalink || '';
}

function messagePageIdFromQuote(quote) {
  if (!quote.channelId || !quote.messageTs) return '';
  return `${quote.workspace || 'primary'}:${quote.channelId}:${quote.messageTs}`;
}

function normalizeMessagePageId(messageId) {
  return String(messageId || '').replace(/^message:/, '').trim();
}

function messageReferenceLabel(quote) {
  return [
    quote.channelName ? `#${quote.channelName}` : quote.channelId ? `#${quote.channelId}` : 'Slackメッセージ',
    quote.authorName,
    formatMessageDate(quote.messageTs)
  ].filter(Boolean).join(' / ');
}

function formatMessageDate(messageTs) {
  const millis = Number.parseFloat(messageTs || '0') * 1000;
  if (!Number.isFinite(millis) || millis <= 0) return '';
  try {
    return new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(millis));
  } catch {
    return '';
  }
}

function resultDetailNotes(reasons) {
  const notes = [];
  const seen = new Set();
  for (const reason of reasons || []) {
    for (const note of reasonDetailNotes(reason).slice(0, 2)) {
      const key = normalizeText(note.replace(/^・/, ''));
      if (!key || seen.has(key)) continue;
      seen.add(key);
      notes.push(note);
      if (notes.length >= 4) return notes;
    }
  }
  return notes;
}

function reasonDetailNotes(reason) {
  const snippets = (reason.evidenceSnippets || [])
    .map((snippet) => typeof snippet === 'string' ? snippet : snippet.text)
    .filter(Boolean);
  if (snippets.length > 0) {
    const usefulSnippets = snippets.filter((snippet) => {
      if (snippets.length === 1) return true;
      return normalizeText(snippet) !== normalizeText(reason.label);
    });
    return usefulSnippets.map((snippet) => `・${escapeMrkdwn(truncate(formatEvidenceSnippet(reason, snippet), 130))}`);
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

async function searchProfileIndex(env, query, uiCategory, options = {}) {
  const index = await loadProfileIndex(env);
  return searchVectorIndex(env, index, query, {
    uiCategory,
    threshold: env.PEOPLE_FINDER_VECTOR_THRESHOLD || DEFAULT_VECTOR_THRESHOLD,
    rerankQuery: options.rerankQuery,
    skipRerank: options.skipRerank
  });
}

async function searchMessageIndex(env, query, options = {}) {
  const index = await loadMessageIndex(env);
  return searchVectorIndex(env, index, query, {
    threshold: env.PEOPLE_FINDER_MESSAGE_VECTOR_THRESHOLD || DEFAULT_MESSAGE_VECTOR_THRESHOLD,
    requireRerankEvidence: true,
    rerankQuery: options.rerankQuery,
    skipRerank: options.skipRerank
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
  if (results.length === 0) {
    return results;
  }
  if (options.skipRerank) {
    return results;
  }
  if (env.PEOPLE_FINDER_ENABLE_RERANK === 'false') {
    return options.requireRerankEvidence ? [] : results;
  }

  try {
    return await rerankVectorResults(env, query, results, {
      rerankQuery: options.rerankQuery || query,
      candidateLimit: env.PEOPLE_FINDER_RERANK_CANDIDATES,
      includeAdjacent: env.PEOPLE_FINDER_DIRECT_ONLY !== 'true'
    });
  } catch (error) {
    console.error('Vector people rerank failed', error);
    return options.requireRerankEvidence ? [] : results;
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
    result.messageQuotes.push(...(item.unit.quotes || []).map((quote) => ({
      ...quote,
      unitId: item.unit['@id']
    })));
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
  const decisions = await geminiRerank(env, options.rerankQuery || query, candidates);
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

async function planSearchIntent(env, query, category) {
  const model = env.GEMINI_RERANK_MODEL || DEFAULT_RERANK_MODEL;
  const data = await callGemini(env, model, 'generateContent', {
    contents: [
      {
        role: 'user',
        parts: [{ text: buildSearchPlanPrompt(query, category) }]
      }
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json'
    }
  });
  const text = geminiText(data);
  return normalizeSearchPlan(parseJsonText(text), query, category);
}

function buildSearchPlanPrompt(query, category) {
  return `あなたは社員検索のクエリ理解担当です。
入力を、社員を探すための検索計画に変換してください。

重要:
- ユーザーに質問形式を強制しない。「AWS経験者」のような短い入力も質問として解釈する。
- 「経験者」は本人の実務経験を求める。「勉強会を案内した」「記事を共有した」「関心がある」だけでは足りない。
- 「詳しい人」「相談できる人」は本人の知見・実務接点・説明できそうな根拠を求める。
- 「好きな人」は本人の興味・嗜好を求める。
- 「紹介した人」「共有した人」は情報共有の行動を求める。
- ベクトル検索用クエリには、主題語と根拠になりそうな言い換えを入れる。

JSONだけを返してください。
{
  "interpretedQuestion": "ユーザーが本当に知りたいこと",
  "relationIntent": "has_work_experience | can_consult | has_interest | shared_information | general_match",
  "topicTerms": ["AWS"],
  "searchQuery": "AWS 運用 監視 構築 設計 保守 実務 経験 現場",
  "mustHaveEvidence": ["本人の実務経験"],
  "rejectEvidence": ["勉強会を案内しただけ"]
}

入力: ${query}
カテゴリ: ${category}`;
}

function normalizeSearchPlan(plan, query, category) {
  const fallback = simpleSearchPlan(query, category);
  const normalized = plan && typeof plan === 'object' ? plan : {};
  return {
    interpretedQuestion: String(normalized.interpretedQuestion || fallback.interpretedQuestion).trim(),
    relationIntent: String(normalized.relationIntent || fallback.relationIntent).trim(),
    topicTerms: Array.isArray(normalized.topicTerms) ? normalized.topicTerms.map(String).filter(Boolean).slice(0, 8) : fallback.topicTerms,
    searchQuery: String(normalized.searchQuery || fallback.searchQuery).trim(),
    mustHaveEvidence: Array.isArray(normalized.mustHaveEvidence) ? normalized.mustHaveEvidence.map(String).filter(Boolean).slice(0, 8) : [],
    rejectEvidence: Array.isArray(normalized.rejectEvidence) ? normalized.rejectEvidence.map(String).filter(Boolean).slice(0, 8) : []
  };
}

function simpleSearchPlan(query, category) {
  const queryText = stripQueryHelpers(query) || normalizeText(query) || String(query || '').trim();
  const relationIntent = inferRelationIntent(query, category);
  return {
    interpretedQuestion: `${query}に合う社員を知りたい`,
    relationIntent,
    topicTerms: queryText ? [queryText] : [],
    searchQuery: expandSearchQuery(queryText || query, relationIntent),
    mustHaveEvidence: defaultMustHaveEvidence(relationIntent),
    rejectEvidence: defaultRejectEvidence(relationIntent)
  };
}

function inferRelationIntent(query, category) {
  const normalized = normalizeText(query);
  if (/経験者|実務経験|経験|携わ|担当|運用|監視|設計|構築|保守/.test(normalized)) return 'has_work_experience';
  if (/紹介|共有|案内|投稿|知らせ/.test(normalized)) return 'shared_information';
  if (/詳しい|相談|教えて|得意|知見|わかる|分かる/.test(normalized)) return 'can_consult';
  if (category === '興味・人柄' || /好き|趣味|ハマ|興味|推し/.test(normalized)) return 'has_interest';
  return 'general_match';
}

function expandSearchQuery(queryText, relationIntent) {
  const parts = [queryText, ...queryAliases(queryText)];
  if (relationIntent === 'has_work_experience') {
    parts.push('実務 経験 担当 運用 監視 設計 構築 保守 開発 現場');
  } else if (relationIntent === 'can_consult') {
    parts.push('相談 詳しい 知見 得意 実務 接点 説明');
  } else if (relationIntent === 'has_interest') {
    parts.push('好き 趣味 ハマっている 興味');
  }
  return [...new Set(parts.filter(Boolean))].join(' ');
}

function queryAliases(queryText) {
  const normalized = normalizeText(queryText);
  const aliases = [];
  if (normalized.includes('ポケカ')) aliases.push('ポケモンカード pokemon card トレカ カードゲーム');
  if (normalized.includes('aws')) aliases.push('amazon web services クラウド インフラ');
  return aliases;
}

function defaultMustHaveEvidence(relationIntent) {
  if (relationIntent === 'has_work_experience') return ['本人の実務経験'];
  if (relationIntent === 'has_interest') return ['本人の興味・嗜好・発言'];
  if (relationIntent === 'can_consult') return ['本人の知見・実務接点・説明できそうな根拠'];
  if (relationIntent === 'shared_information') return ['本人が紹介・共有・案内した行動'];
  return [];
}

function defaultRejectEvidence(relationIntent) {
  if (relationIntent === 'has_work_experience') return ['勉強会を案内しただけ', '記事を共有しただけ', '関心があるだけ'];
  return [];
}

async function generatePeopleAnswer(env, query, category, plan, candidates) {
  const model = env.GEMINI_RERANK_MODEL || DEFAULT_RERANK_MODEL;
  const prompt = buildAnswerPrompt(query, category, plan, candidates);
  const startedAt = Date.now();
  const baseDiagnostics = {
    model,
    category,
    relationIntent: plan?.relationIntent || '',
    candidateCount: candidates.length,
    promptChars: prompt.length
  };
  console.log('People answer generation started', baseDiagnostics);

  let data;
  try {
    data = await callGemini(env, model, 'generateContent', {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json'
      }
    });
  } catch (error) {
    throw attachAnswerDiagnostics(error, {
      ...baseDiagnostics,
      stage: 'gemini_generate_content',
      elapsedMs: Date.now() - startedAt
    });
  }

  const text = geminiText(data);
  let parsed;
  try {
    parsed = parseJsonText(text);
  } catch (error) {
    throw attachAnswerDiagnostics(error, {
      ...baseDiagnostics,
      stage: 'parse_json',
      elapsedMs: Date.now() - startedAt,
      responseChars: text.length,
      finishReasons: geminiFinishReasons(data)
    });
  }

  const answer = String(parsed.answer || '').trim();
  const selected = Array.isArray(parsed.selected) ? parsed.selected : [];
  if (!answer) {
    console.warn('People answer generation returned empty answer', {
      ...baseDiagnostics,
      stage: 'empty_answer',
      elapsedMs: Date.now() - startedAt,
      responseChars: text.length,
      selectedCount: selected.length,
      finishReasons: geminiFinishReasons(data)
    });
  } else {
    console.log('People answer generation completed', {
      ...baseDiagnostics,
      elapsedMs: Date.now() - startedAt,
      responseChars: text.length,
      answerChars: answer.length,
      selectedCount: selected.length,
      finishReasons: geminiFinishReasons(data)
    });
  }

  return {
    answer: answer || '回答を生成できませんでした。',
    selected
  };
}

function attachAnswerDiagnostics(error, diagnostics) {
  if (error && typeof error === 'object') {
    error.answerDiagnostics = {
      ...(error.answerDiagnostics || {}),
      ...diagnostics
    };
  }
  return error;
}

function answerGenerationErrorDetails(error) {
  return {
    name: error?.name || 'Error',
    message: truncate(error?.message || String(error), 500),
    ...(error?.answerDiagnostics || {})
  };
}

function answerFailureDiagnosticsNote(env, error) {
  if (env.PEOPLE_FINDER_SHOW_FAILURE_DIAGNOSTICS !== 'true') return '';
  const details = answerGenerationErrorDetails(error);
  const parts = [
    details.stage ? `stage=${details.stage}` : '',
    details.model ? `model=${details.model}` : '',
    Number.isFinite(details.candidateCount) ? `candidates=${details.candidateCount}` : '',
    Number.isFinite(details.promptChars) ? `promptChars=${details.promptChars}` : '',
    Number.isFinite(details.responseChars) ? `responseChars=${details.responseChars}` : '',
    Number.isFinite(details.elapsedMs) ? `elapsedMs=${details.elapsedMs}` : '',
    Array.isArray(details.finishReasons) && details.finishReasons.length > 0
      ? `finishReasons=${details.finishReasons.join(',')}`
      : ''
  ].filter(Boolean);
  return parts.length > 0 ? `診断: ${parts.join(' / ')}` : '';
}

function geminiFinishReasons(data) {
  return (data?.candidates || [])
    .map((candidate) => candidate.finishReason)
    .filter(Boolean);
}

function buildAnswerPrompt(query, category, plan, candidates) {
  return `あなたは社員検索BOTの回答生成担当です。
ユーザーの質問意図に対して、候補の根拠だけを使って回答してください。

ルール:
- 候補に含まれる根拠だけを使い、推測で補わない。
- 検索計画の relationIntent と mustHaveEvidence / rejectEvidence を厳密に使う。
- 「経験者」意図なら、本人が実務で何をしたかを答える。運用、監視、管理、設計、構築、保守、開発、年数など、根拠にある範囲で具体化する。
- 年数や担当範囲が根拠にない場合は「年数は不明」のように不足を明示する。
- 質問意図に合わない候補は回答に含めない。例: 経験者検索で、勉強会案内やアーカイブ共有だけの人は除外する。
- ただ短くするのではなく、質問に答えるために必要な情報を書く。
- Slack mrkdwnで読みやすく書く。表は使わない。
- JSONだけを返す。

出力形式:
{
  "answer": "回答本文",
  "selected": [
    { "employeeName": "社員名", "reasonUnitIds": ["候補内のunitId"] }
  ]
}

ユーザー入力: ${query}
カテゴリ: ${category}
検索計画:
${JSON.stringify(plan, null, 2)}

候補:
${JSON.stringify(candidates.map(compactAnswerCandidate), null, 2)}`;
}

function compactAnswerCandidate(result) {
  return {
    employeeName: result.employeeName,
    score: result.score,
    reasons: (result.reasons || []).slice(0, 5).map((reason) => ({
      unitId: reason.unitId,
      label: reason.label || reason.relationLabel || reason.topicLabel,
      semanticType: reason.semanticType,
      sourceLabel: reason.sourceLabel,
      score: reason.score,
      detailBullets: (reason.detailBullets || reason.evidenceSnippets || [])
        .slice(0, 4)
        .map((bullet) => truncate(typeof bullet === 'string' ? bullet : bullet.text, 220))
    })),
    quotes: (result.messageQuotes || []).slice(0, 3).map((quote) => ({
      unitId: quote.unitId,
      messageId: quote.messageId,
      text: truncate(quote.text, 260),
      channelName: quote.channelName,
      authorName: quote.authorName
    }))
  };
}

function geminiText(data) {
  return (data.candidates || [])
    .flatMap((candidate) => candidate.content?.parts || [])
    .map((part) => part.text)
    .filter(Boolean)
    .join('\n');
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
- クエリが求める関係性を厳密に見る。例: 「経験者」は本人の実務経験、「詳しい人」「相談」は本人の知見や実務接点、「好きな人」は本人の興味・嗜好、「紹介/共有した人」は情報共有の行動を重視する
- AWS、Azure、Reactのような短い技術名・製品名は、実務経験や具体的な話題として根拠に出ていれば direct
- ただし「経験者」検索では、勉強会の案内、学習機会の提供、アーカイブ共有、関心表明だけでは direct にしない
- 趣味検索では、具体的な接点がある候補を direct
- Slackメッセージ検索では、候補内の実発言・引用・具体メモだけを根拠にする
- クエリ語の言い換え、同義語、関連する固有名詞は考慮してよい
- ただし、実発言がクエリの主題を支えていない場合は、ベクトルscoreが高くても reject
- 挨拶、日程、ありがとう、かわいい等の汎用雑談だけで主題が根拠文にない場合は reject
- 発言が質問・引用・雑談だけで相談相手として弱い場合は adjacent または weak
- evidenceSupported は、選んだ根拠だけでクエリに答えられる場合だけ true
- selectedReasonUnitIds は判定根拠に使ったunitIdだけを入れる。Slackメッセージ検索では最低1件必須
- JSONだけを返す

出力形式:
{
  "decisions": [
    {
      "employeeName": "社員名",
      "intentFit": "direct",
      "confidence": 0.9,
      "reason": "短い理由",
      "evidenceSupported": true,
      "selectedReasonUnitIds": ["提示されたunitId"]
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
      detailBullets: (reason.detailBullets || [])
        .slice(0, 3)
        .map((bullet) => truncate(bullet, 240))
    })),
    quotes: (result.messageQuotes || []).slice(0, 2).map((quote) => ({
      text: truncate(quote.text, 240),
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
      if (decision.evidenceSupported === false) return null;
      const selectedIds = new Set(decision.selectedReasonUnitIds || []);
      const selectedReasons = selectedIds.size > 0
        ? result.reasons.filter((reason) => selectedIds.has(reason.unitId))
        : result.reasons;
      const slackMessageResult = isSlackMessageResult(result);
      const displayReasons = selectedReasons.length > 0 ? selectedReasons : result.reasons;
      const selectedMessageQuotes = selectedIds.size > 0
        ? filterMessageQuotesByReasonIds(result.messageQuotes || [], selectedIds)
        : result.messageQuotes;
      const displayMessageQuotes = selectedMessageQuotes.length > 0
        ? selectedMessageQuotes
        : filterMessageQuotesByReasonIds(result.messageQuotes || [], new Set(displayReasons.map((reason) => reason.unitId)));
      return {
        ...result,
        intentFit: decision.intentFit,
        rerankConfidence: decision.confidence,
        rerankReason: decision.reason,
        reasons: displayReasons,
        messageQuotes: slackMessageResult ? displayMessageQuotes : (displayMessageQuotes || result.messageQuotes)
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

function isSlackMessageResult(result) {
  return (result.reasons || []).some((reason) => reason.semanticType === 'slack_message');
}

function filterMessageQuotesByReasonIds(quotes, selectedIds) {
  const normalizedIds = new Set([...selectedIds].map(normalizeEvidenceId).filter(Boolean));
  return (quotes || []).filter((quote) => {
    const ids = [
      quote.unitId,
      quote.messageId,
      messagePageIdFromQuote(quote)
    ].map(normalizeEvidenceId);
    return ids.some((id) => normalizedIds.has(id));
  });
}

function normalizeEvidenceId(value) {
  return String(value || '')
    .replace(/^search-message:/, '')
    .replace(/^message:/, '')
    .trim();
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
