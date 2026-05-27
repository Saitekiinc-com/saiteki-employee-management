const fs = require('fs');
const path = require('path');
require('dotenv').config({ quiet: true });

const { createEmbeddingProvider, textHash } = require('./profile-embedding-utils');

const DATA_DIR = path.join(__dirname, '../data');
const INPUT_FILE = path.join(DATA_DIR, 'profile-search-index.json');
const OUTPUT_FILE = path.join(DATA_DIR, 'profile-search-index.embedded.json');

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
    map.set(unit['@id'], unit.embedding);
  }
  return map;
}

async function embedProfileSearchIndex(index, provider, options = {}) {
  const existing = existingEmbeddingMap(options.outputFile || OUTPUT_FILE, provider);
  const limit = Number(options.limit || 0);
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
      const vector = await provider.embed(unit.searchText || '', 'document');
      embedding = {
        provider: provider.name,
        model: provider.model,
        textHash: hash,
        dimensions: vector.length,
        vector
      };
      generated++;
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
      sourceTextField: 'searchText',
      generated,
      reused
    },
    '@graph': units
  };
}

function writeEmbeddedIndex(index, outputFile = OUTPUT_FILE) {
  fs.writeFileSync(outputFile, `${JSON.stringify(index, null, 2)}\n`);
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
    limit: args.limit
  });
  writeEmbeddedIndex(embedded, outputFile);
  console.log(`Embedded ${embedded['@graph'].filter((unit) => unit.embedding?.vector).length} profile search units at ${outputFile}`);
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
  writeEmbeddedIndex
};
