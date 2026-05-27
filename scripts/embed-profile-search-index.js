const fs = require('fs');
const path = require('path');
require('dotenv').config({ quiet: true });

const { createEmbeddingProvider, textHash } = require('./profile-embedding-utils');

const DATA_DIR = path.join(__dirname, '../data');
const INPUT_FILE = path.join(DATA_DIR, 'profile-search-index.json');
const OUTPUT_FILE = path.join(DATA_DIR, 'profile-search-index.embedded.json');
const DEFAULT_REQUEST_DELAY_MS = 700;
const DEFAULT_RETRY_DELAY_MS = 45000;
const DEFAULT_MAX_RETRIES = 6;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      index++;
    }
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function existingEmbeddingMap(outputFile, provider) {
  if (!fs.existsSync(outputFile)) return new Map();
  const existing = readJson(outputFile);
  const map = new Map();
  for (const unit of existing['@graph'] || []) {
    if (!unit.embedding?.vector || unit.embedding.provider !== provider.name || unit.embedding.model !== provider.model) continue;
    if (provider.dimensions && unit.embedding.dimensions !== provider.dimensions) continue;
    map.set(unit['@id'], unit.embedding);
  }
  return map;
}

async function embedProfileSearchIndex(index, provider, options = {}) {
  const existing = existingEmbeddingMap(options.outputFile || OUTPUT_FILE, provider);
  const limit = Number(options.limit || 0);
  const defaultRequestDelayMs = provider.name === 'gemini' ? DEFAULT_REQUEST_DELAY_MS : 0;
  const requestDelayMs = Number(options.requestDelayMs ?? process.env.PROFILE_EMBEDDING_DELAY_MS ?? defaultRequestDelayMs);
  let generated = 0;
  let reused = 0;

  const units = [];
  for (const unit of index['@graph'] || []) {
    const hash = textHash(unit.searchText || '');
    const previous = existing.get(unit['@id']);
    let embedding = previous && previous.textHash === hash ? previous : null;
    if (embedding) {
      reused++;
    } else {
      if (limit > 0 && generated >= limit) {
        units.push(unit);
        continue;
      }
      const vector = await embedWithRetry(provider, unit.searchText || '', 'document', options);
      embedding = {
        provider: provider.name,
        model: provider.model,
        textHash: hash,
        dimensions: vector.length,
        vector
      };
      generated++;
      if (requestDelayMs > 0) await sleep(requestDelayMs);
    }
    units.push({ ...unit, embedding });
  }

  return {
    ...index,
    generatedAt: new Date().toISOString(),
    embedding: {
      status: limit > 0 && generated >= limit ? 'partial' : 'generated',
      provider: provider.name,
      model: provider.model,
      dimensions: provider.dimensions,
      sourceTextField: 'searchText',
      generated,
      reused
    },
    '@graph': units
  };
}

async function embedWithRetry(provider, text, task, options = {}) {
  const maxRetries = Number(options.maxRetries ?? process.env.PROFILE_EMBEDDING_MAX_RETRIES ?? DEFAULT_MAX_RETRIES);
  const retryDelayMs = Number(options.retryDelayMs ?? process.env.PROFILE_EMBEDDING_RETRY_DELAY_MS ?? DEFAULT_RETRY_DELAY_MS);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await provider.embed(text, task);
    } catch (error) {
      if (!isRetryableEmbeddingError(error) || attempt >= maxRetries) throw error;
      const delay = retryDelayMs + attempt * 5000;
      console.warn(`Embedding rate limited; retrying in ${Math.round(delay / 1000)}s (${attempt + 1}/${maxRetries})`);
      await sleep(delay);
    }
  }
  throw new Error('Embedding retry loop exited unexpectedly');
}

function isRetryableEmbeddingError(error) {
  const message = String(error?.message || error || '');
  return message.includes('429') || message.includes('Too Many Requests') || message.includes('quota');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeEmbeddedIndex(index, outputFile = OUTPUT_FILE) {
  fs.writeFileSync(outputFile, `${JSON.stringify(index)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputFile = args.input || INPUT_FILE;
  const outputFile = args.output || OUTPUT_FILE;
  const provider = await createEmbeddingProvider({
    provider: args.provider,
    model: args.model,
    dimensions: args.dimensions
  });
  const index = readJson(inputFile);
  const embedded = await embedProfileSearchIndex(index, provider, {
    outputFile,
    limit: args.limit,
    requestDelayMs: args['delay-ms'],
    retryDelayMs: args['retry-delay-ms'],
    maxRetries: args.retries
  });
  writeEmbeddedIndex(embedded, outputFile);
  console.log(`Embedded ${embedded['@graph'].filter((unit) => unit.embedding?.vector).length} search units at ${outputFile}`);
  console.log(`Provider: ${provider.name} / ${provider.model}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  embedProfileSearchIndex,
  embedWithRetry,
  writeEmbeddedIndex
};
