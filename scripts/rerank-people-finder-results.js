require('dotenv').config({ quiet: true });

const { normalizeText, stripQueryHelpers, tokenize } = require('./profile-embedding-utils');

const INTENT_RANK = {
  direct: 4,
  adjacent: 3,
  weak: 2,
  reject: 1
};

function parseJsonText(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`AI rerank response is not JSON: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1));
}

function compactReason(reason) {
  return {
    unitId: reason.unitId,
    semanticType: reason.semanticType,
    relationLabel: reason.relationLabel,
    topicLabel: reason.topicLabel,
    score: reason.score,
    detailBullets: (reason.detailBullets || []).slice(0, 3)
  };
}

function compactResult(result) {
  return {
    employeeName: result.employeeName,
    score: result.score,
    reasons: (result.reasons || []).map(compactReason),
    quotes: (result.quotes || []).slice(0, 2).map((quote) => ({
      text: quote.text,
      channelName: quote.channelName,
      authorName: quote.authorName
    }))
  };
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
- 「QAエンジニア」のような職種検索では、AI、エンジニア、影響力だけの候補は reject または weak
- 「ポケモン」のような趣味検索では、具体的な接点がある候補を direct
- Slackメッセージ検索では、候補内の実発言・引用・具体メモだけを根拠にする
- クエリ語の言い換え、同義語、関連する固有名詞は考慮してよい
- ただし、実発言がクエリの主題を支えていない場合は、ベクトルscoreが高くても reject
- 挨拶、日程、ありがとう、かわいい等の汎用雑談だけで主題が根拠文にない場合は reject
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
${JSON.stringify(results.map(compactResult), null, 2)}`;
}

async function createGeminiReranker(options = {}) {
  const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is required for gemini reranker. Use --reranker local-fixture for tests.');
  }
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const modelName = options.model || process.env.GEMINI_RERANK_MODEL || 'gemini-2.0-flash';
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json'
    }
  });
  return {
    name: 'gemini',
    model: modelName,
    async rerank(query, results) {
      const response = await model.generateContent(buildRerankPrompt(query, results));
      return parseJsonText(response.response.text()).decisions || [];
    }
  };
}

function textIncludesAny(text, terms) {
  const normalized = normalizeText(text);
  return terms.some((term) => normalized.includes(normalizeText(term)));
}

function resultText(result) {
  return [
    result.employeeName,
    ...(result.reasons || []).flatMap((reason) => [
      reason.semanticType,
      reason.relationLabel,
      reason.topicLabel,
      ...(reason.detailBullets || [])
    ]),
    ...(result.quotes || []).map((quote) => quote.text)
  ].join(' ');
}

function firstMatchingReasonIds(result, terms) {
  return (result.reasons || [])
    .filter((reason) => textIncludesAny([
      reason.relationLabel,
      reason.topicLabel,
      ...(reason.detailBullets || [])
    ].join(' '), terms))
    .map((reason) => reason.unitId)
    .slice(0, 3);
}

function localDecision(query, result) {
  const normalizedQuery = normalizeText(query);
  const text = resultText(result);

  if (textIncludesAny(normalizedQuery, ['ポケモン', 'ポケカ', 'pokemon', 'pokémon'])) {
    const terms = ['ポケモン', 'ポケカ', 'pokemon', 'pokémon'];
    const matchedIds = firstMatchingReasonIds(result, terms);
    const matched = matchedIds.length > 0 || (result.quotes || []).some((quote) => textIncludesAny(quote.text, terms));
    return {
      employeeName: result.employeeName,
      intentFit: matched ? 'direct' : 'reject',
      confidence: matched ? 0.9 : 0.1,
      reason: matched ? 'ポケモンまたはポケカへの具体的な接点がある' : 'ポケモン文脈の根拠がない',
      evidenceSupported: matched,
      selectedReasonUnitIds: matchedIds
    };
  }

  if (textIncludesAny(normalizedQuery, ['qa', '品質保証', 'テスト', '検証'])) {
    const directTerms = ['qa', '品質保証', 'qaエンジニア'];
    const adjacentTerms = ['テスト', '総合テスト', 'テスト設計', '検証', '品質管理'];
    const directIds = firstMatchingReasonIds(result, directTerms);
    const adjacentIds = firstMatchingReasonIds(result, adjacentTerms);
    const direct = directIds.length > 0;
    const adjacent = adjacentIds.length > 0;
    return {
      employeeName: result.employeeName,
      intentFit: direct ? 'direct' : adjacent ? 'adjacent' : 'reject',
      confidence: direct ? 0.92 : adjacent ? 0.76 : 0.18,
      reason: direct
        ? 'QAまたは品質保証の根拠がある'
        : adjacent
          ? 'テストや検証の経験に近い根拠がある'
          : 'QAやテストに直接つながる根拠が弱い',
      evidenceSupported: direct || adjacent,
      selectedReasonUnitIds: direct ? directIds : adjacentIds
    };
  }

  const queryTerms = tokenize(stripQueryHelpers(normalizedQuery) || normalizedQuery).filter((term) => term.length >= 2);
  const matched = queryTerms.some((term) => normalizeText(text).includes(term));
  return {
    employeeName: result.employeeName,
    intentFit: matched ? 'direct' : 'weak',
    confidence: matched ? 0.72 : 0.35,
    reason: matched ? '検索語に対応する根拠がある' : 'ベクトル類似はあるが明示的な根拠は弱い',
    evidenceSupported: matched,
    selectedReasonUnitIds: firstMatchingReasonIds(result, queryTerms)
  };
}

function createLocalFixtureReranker() {
  return {
    name: 'local-fixture',
    model: 'local-rerank-rules-v1',
    async rerank(query, results) {
      return results.map((result) => localDecision(query, result));
    }
  };
}

async function createReranker(options = {}) {
  const provider = options.provider || process.env.PROFILE_RERANK_PROVIDER || 'gemini';
  if (provider === 'local-fixture') return createLocalFixtureReranker();
  if (provider === 'gemini') return createGeminiReranker(options);
  throw new Error(`Unknown reranker provider: ${provider}`);
}

function applyDecisions(results, decisions, options = {}) {
  const includeAdjacent = options.includeAdjacent !== false;
  const decisionByName = new Map(decisions.map((decision) => [decision.employeeName, decision]));
  return results
    .map((result) => {
      const decision = decisionByName.get(result.employeeName);
      if (!decision) return null;
      const selectedIds = new Set(decision.selectedReasonUnitIds || []);
      const selectedReasons = selectedIds.size > 0
        ? result.reasons.filter((reason) => selectedIds.has(reason.unitId))
        : result.reasons;
      const slackMessageResult = isSlackMessageResult(result);
      if (slackMessageResult && (decision.evidenceSupported === false || selectedIds.size === 0 || selectedReasons.length === 0)) {
        return null;
      }
      const selectedQuotes = selectedIds.size > 0
        ? filterQuotesByReasonIds(result.quotes || [], selectedIds)
        : result.quotes;
      return {
        ...result,
        intentFit: decision.intentFit,
        rerankConfidence: decision.confidence,
        rerankReason: decision.reason,
        reasons: selectedReasons.length > 0 ? selectedReasons : result.reasons,
        quotes: slackMessageResult ? selectedQuotes : (selectedQuotes || result.quotes)
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

function filterQuotesByReasonIds(quotes, selectedIds) {
  const normalizedIds = new Set([...selectedIds].map(normalizeEvidenceId).filter(Boolean));
  return (quotes || []).filter((quote) => {
    const ids = [
      quote.unitId,
      quote.messageId
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

async function rerankPeopleResults(query, results, reranker, options = {}) {
  const candidateLimit = Number(options.candidateLimit || 12);
  const candidates = results.slice(0, candidateLimit);
  const decisions = await reranker.rerank(query, candidates);
  return applyDecisions(candidates, decisions, options);
}

module.exports = {
  applyDecisions,
  buildRerankPrompt,
  createReranker,
  rerankPeopleResults
};
