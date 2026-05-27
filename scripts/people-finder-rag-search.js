const fs = require('fs');
const path = require('path');

const DEFAULT_FACETS_FILE = path.join(__dirname, '../data/search-facets.jsonld');
const UI_CATEGORY_WORK = '仕事・相談';
const UI_CATEGORY_PERSONAL = '興味・人柄';
const DEFAULT_THRESHOLD = 0.18;

const WORK_QUERY_PATTERN = /aws|azure|gcp|react|next|rag|qa|pm|poc|api|db|sql|bi|gemini|cursor|notion|slack|github|開発|運用|監視|設計|要件|技術|テスト|品質|分析|採用|営業|総務|人事|オンボーディング|データ|プロンプト|自動化|インフラ|サーバ|アーキテクチャ|マネジメント|合意形成/i;
const PERSONAL_QUERY_PATTERN = /好き|趣味|休日|映画|音楽|ゲーム|アニメ|漫画|マンガ|ポケモン|ガンダム|トミカ|自炊|料理|楽器|動物|犬|猫|旅行|スポーツ|読書/i;

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[・、。,.!?！？:：;；()[\]{}「」『』"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripQueryHelpers(query) {
  return normalizeText(query)
    .replace(/が好きな人|が好き|好きな人|好きな|興味がある人|詳しい人|得意な人|できる人|話せる人|相談できる人|相談したい|人/g, ' ')
    .replace(/を知っている人|を知っている|知っている人|知っている|知ってる|分かる|わかる|経験者|または|もしくは|あるいは/g, ' ')
    .replace(/について|に関心がある|に興味がある|を探して|探して|教えて|詳しい|相談/g, ' ')
    .replace(/([a-z0-9+#.])([^a-z0-9+#.\s])/g, '$1 $2')
    .replace(/([^a-z0-9+#.\s])([a-z0-9+#.])/g, '$1 $2')
    .replace(/(^|\s)(に|を|が|は|の|と|で)(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferCategoryFromQuery(query) {
  const value = normalizeText(query);
  if (PERSONAL_QUERY_PATTERN.test(value)) return UI_CATEGORY_PERSONAL;
  if (WORK_QUERY_PATTERN.test(value)) return UI_CATEGORY_WORK;
  return null;
}

function resolveSearchCategory(query, selectedCategory) {
  const normalizedCategory = normalizeCategory(selectedCategory || UI_CATEGORY_PERSONAL);
  const inferredCategory = inferCategoryFromQuery(query);
  return {
    category: inferredCategory || normalizedCategory,
    inferred: Boolean(inferredCategory && inferredCategory !== normalizedCategory),
    selectedCategory: normalizedCategory
  };
}

function normalizeCategory(category) {
  const value = normalizeText(category);
  if (['work', 'job', 'consult', '仕事', '相談', normalizeText(UI_CATEGORY_WORK)].includes(value)) {
    return UI_CATEGORY_WORK;
  }
  if (['interest', 'personal', 'personality', '興味', '人柄', normalizeText(UI_CATEGORY_PERSONAL)].includes(value)) {
    return UI_CATEGORY_PERSONAL;
  }
  return category;
}

function addNgrams(tokens, text, size) {
  const chars = [...text.replace(/\s+/g, '')];
  if (chars.length < size) return;
  for (let index = 0; index <= chars.length - size; index++) {
    tokens.push(chars.slice(index, index + size).join(''));
  }
}

function tokenize(value) {
  const normalized = normalizeText(value);
  const tokens = [];
  const words = normalized.split(/\s+/).filter((word) => word.length >= 2);
  tokens.push(...words);
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

function loadFacets(file = DEFAULT_FACETS_FILE) {
  if (!fs.existsSync(file)) {
    throw new Error(`Search facets file not found: ${file}. Run "npm run build:search-facets" first.`);
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return data['@graph'] || [];
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
  const combinedText = [labelText, evidenceText, facet.sourceText].filter(Boolean).join(' ');
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
      sourceField: item.facet.sourceField,
      evidenceSnippets: item.facet.evidenceSnippets || [],
      evidence: item.facet.evidence
    });
    result.messageQuotes.push(...(item.facet.messageQuotes || []));
  }

  return [...byEmployee.values()]
    .map((result) => ({
      ...result,
      reasons: result.reasons
        .sort((a, b) => b.score - a.score)
        .slice(0, 3),
      messageQuotes: dedupeQuotes(result.messageQuotes).slice(0, 3)
    }))
    .sort((a, b) => b.score - a.score || a.employeeName.localeCompare(b.employeeName, 'ja'));
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

function searchFacets(facets, query, options = {}) {
  const categoryResolution = resolveSearchCategory(query, options.category || UI_CATEGORY_PERSONAL);
  const uiCategory = categoryResolution.category;
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

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    args[item.slice(2)] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const query = args.query || args.q;
  if (!query) {
    console.error('Usage: node scripts/people-finder-rag-search.js --category work --query "AWS運用に詳しい人"');
    process.exit(1);
  }

  try {
    const facets = loadFacets(args.file || DEFAULT_FACETS_FILE);
    const results = searchFacets(facets, query, {
      category: args.category,
      threshold: args.threshold
    });
    const categoryResolution = resolveSearchCategory(query, args.category || UI_CATEGORY_PERSONAL);
    console.log(JSON.stringify({ query, category: categoryResolution.category, categoryInferred: categoryResolution.inferred, results }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_THRESHOLD,
  loadFacets,
  normalizeCategory,
  normalizeText,
  resolveSearchCategory,
  searchFacets,
  stripQueryHelpers,
  tokenize
};
