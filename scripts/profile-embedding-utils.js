const crypto = require('crypto');

const DEFAULT_LOCAL_DIMENSIONS = 1024;
const DEFAULT_GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001';
const DEFAULT_GEMINI_EMBEDDING_DIMENSIONS = 768;

const LOCAL_SYNONYMS = {
  qa: ['品質保証', 'テスト', 'テスト設計', '総合テスト', '検証', '不具合'],
  品質保証: ['qa', 'テスト', '検証'],
  テスト: ['qa', '品質保証', '検証', 'テスト設計'],
  aws: ['クラウド', '運用', '監視', 'インフラ'],
  ポケモン: ['pokemon', 'pokémon', 'ポケカ', 'ゲーム'],
  ポケカ: ['ポケモン', 'pokemon', 'カード'],
  ガンダム: ['ロボット作品', 'ゲーム', 'gundam']
};

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
    .replace(/について|に関心がある|に興味がある|を探して|探して|教えて欲しい|教えてほしい|教えて|欲しい|ほしい|詳しい|相談/g, ' ')
    .replace(/([a-z0-9+#.])([^a-z0-9+#.\s])/g, '$1 $2')
    .replace(/([^a-z0-9+#.\s])([a-z0-9+#.])/g, '$1 $2')
    .replace(/(^|\s)(に|を|が|は|の|と|で)(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

  for (const [term, synonyms] of Object.entries(LOCAL_SYNONYMS)) {
    if (normalized.includes(normalizeText(term))) {
      tokens.push(...synonyms.map(normalizeText));
    }
  }

  return [...new Set(tokens.filter(Boolean))];
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function textHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function normalizeVector(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!norm) return vector;
  return vector.map((value) => Number((value / norm).toFixed(8)));
}

function fitVectorDimensions(vector, dimensions) {
  if (!dimensions || !Array.isArray(vector) || vector.length <= dimensions) return vector;
  return vector.slice(0, dimensions);
}

function localFixtureEmbedding(text, dimensions = DEFAULT_LOCAL_DIMENSIONS) {
  const vector = Array(dimensions).fill(0);
  for (const token of tokenize(text)) {
    const hash = stableHash(token);
    const index = hash.readUInt32BE(0) % dimensions;
    vector[index] += 1;
  }
  return normalizeVector(vector);
}

function cosineSimilarity(a, b) {
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

function createLocalFixtureProvider(options = {}) {
  const dimensions = Number(options.dimensions || DEFAULT_LOCAL_DIMENSIONS);
  return {
    name: 'local-fixture',
    model: `local-hash-v1-${dimensions}`,
    dimensions,
    async embed(text) {
      return localFixtureEmbedding(text, dimensions);
    }
  };
}

function resolveProviderName(providerName) {
  return providerName || process.env.PROFILE_EMBEDDING_PROVIDER || 'gemini';
}

async function createEmbeddingProvider(options = {}) {
  const providerName = resolveProviderName(options.provider);
  if (providerName === 'local-fixture') {
    return createLocalFixtureProvider(options);
  }
  if (providerName !== 'gemini') {
    throw new Error(`Unknown embedding provider: ${providerName}`);
  }

  const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is required for gemini embedding provider. Use --provider local-fixture for tests.');
  }

  const modelName = options.model || process.env.GEMINI_EMBEDDING_MODEL || DEFAULT_GEMINI_EMBEDDING_MODEL;
  const dimensions = Number(options.outputDimensionality || options.dimensions || process.env.GEMINI_EMBEDDING_DIMENSIONS || DEFAULT_GEMINI_EMBEDDING_DIMENSIONS);

  return {
    name: 'gemini',
    model: modelName,
    dimensions,
    async embed(text, task = 'document') {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${geminiModelResource(modelName)}:embedContent`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          content: { role: 'user', parts: [{ text }] },
          embedContentConfig: {
            taskType: task === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
            outputDimensionality: dimensions
          }
        })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(`Gemini embedContent failed: ${response.status} ${JSON.stringify(data).slice(0, 240)}`);
      }
      if (!Array.isArray(data.embedding?.values)) {
        throw new Error('Gemini embedding response did not include embedding.values.');
      }
      return fitVectorDimensions(data.embedding.values, dimensions);
    }
  };
}

function geminiModelResource(model) {
  const value = String(model || '').trim();
  return value.startsWith('models/') ? value : `models/${value}`;
}

module.exports = {
  cosineSimilarity,
  createEmbeddingProvider,
  createLocalFixtureProvider,
  fitVectorDimensions,
  localFixtureEmbedding,
  normalizeText,
  stripQueryHelpers,
  textHash,
  tokenize
};
