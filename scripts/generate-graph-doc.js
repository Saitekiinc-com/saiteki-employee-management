/**
 * generate-graph-doc.js
 * 
 * ナレッジグラフデータから人間可読なドキュメントを生成
 * 入力: data/knowledge-graph.json
 * 出力: docs/KNOWLEDGE_GRAPH.md
 * 
 * 実行: node scripts/generate-graph-doc.js
 */

const fs = require('fs');
const path = require('path');

const INPUT_FILE = path.join(__dirname, '../data/knowledge-graph.json');
const OUTPUT_FILE = path.join(__dirname, '../docs/KNOWLEDGE_GRAPH.md');

const HTML_OUTPUT_FILE = path.join(__dirname, '../docs/index.html');
const JS_TEMPLATE_FILE = path.join(__dirname, 'graph-template.js');

function main() {
  console.log('=== ナレッジグラフ ドキュメント生成 ===\n');

  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`入力ファイルが見つかりません: ${INPUT_FILE}`);
    process.exit(1);
  }

  const graph = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  const { metadata, nodes, edges } = graph;

  const personNodes = nodes.filter(n => n.type === 'person');
  const attrNodes = nodes.filter(n => n.type === 'attribute');
  const sharedEdges = edges.filter(e => e.type === 'SHARES');
  const aiEdges = edges.filter(e => e.ai_generated);

  let md = '';

  // ヘッダー
  md += '# ナレッジグラフ分析レポート\n\n';
  md += `> 社員数: ${metadata.employee_count}名 | ノード: ${metadata.node_count} | エッジ: ${metadata.edge_count} | AI拡張: ${metadata.ai_enhanced ? 'あり' : 'なし'}\n\n`;
  md += '- [👥 チーム構成図・詳細プロフィールはこちら (TEAM.md)](./TEAM.md)\n\n';
  md += '---\n\n';

  // スキル別グルーピング
  md += '## スキル・強み別グルーピング\n\n';
  const skillNodes = attrNodes.filter(n => n.categories.includes('skill'));
  skillNodes.sort((a, b) => (b.connectedPeople?.length || 0) - (a.connectedPeople?.length || 0));

  md += '| スキル | 保有者数 | 社員 |\n| --- | --- | --- |\n';
  skillNodes.forEach(node => {
    const people = node.connectedPeople || [];
    const linkedPeople = people.map(p => `[${p}](./TEAM.md#${encodeURIComponent(p)})`);
    md += `| ${node.label} | ${people.length} | ${linkedPeople.join(', ')} |\n`;
  });
  md += '\n';

  // 価値観別グルーピング
  md += '## 価値観別グルーピング\n\n';
  const valueNodes = attrNodes.filter(n => n.categories.includes('value'));
  valueNodes.sort((a, b) => (b.connectedPeople?.length || 0) - (a.connectedPeople?.length || 0));

  md += '| 価値観 | 共有者数 | 社員 |\n| --- | --- | --- |\n';
  valueNodes.forEach(node => {
    const people = node.connectedPeople || [];
    const linkedPeople = people.map(p => `[${p}](./TEAM.md#${encodeURIComponent(p)})`);
    md += `| ${node.label} | ${people.length} | ${linkedPeople.join(', ')} |\n`;
  });
  md += '\n';

  // 関心事別グルーピング
  md += '## 関心事別グルーピング\n\n';
  const interestNodes = attrNodes.filter(n => n.categories.includes('interest'));
  interestNodes.sort((a, b) => (b.connectedPeople?.length || 0) - (a.connectedPeople?.length || 0));

  md += '| 関心事 | 関心者数 | 社員 |\n| --- | --- | --- |\n';
  interestNodes.forEach(node => {
    const people = node.connectedPeople || [];
    const linkedPeople = people.map(p => `[${p}](./TEAM.md#${encodeURIComponent(p)})`);
    md += `| ${node.label} | ${people.length} | ${linkedPeople.join(', ')} |\n`;
  });
  md += '\n';

  // 社員間マッチング（共通項目が多い順）
  md += '## 社員間マッチング\n\n';
  md += '共通のスキル・価値観・関心事が多い組み合わせです。\n\n';

  const topShared = sharedEdges
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 20);

  md += '| 順位 | 社員ペア | 共通数 | 共通スキル | 共通価値観 | 共通関心事 |\n| --- | --- | --- | --- | --- | --- |\n';
  topShared.forEach((edge, i) => {
    const nameA = edge.source.replace('person:', '');
    const nameB = edge.target.replace('person:', '');
    const linkedPair = `[${nameA}](./TEAM.md#${encodeURIComponent(nameA)}) × [${nameB}](./TEAM.md#${encodeURIComponent(nameB)})`;
    const s = edge.shared || {};
    md += `| ${i + 1} | ${linkedPair} | ${edge.weight} | ${(s.skills || []).join(', ') || '-'} | ${(s.values || []).join(', ') || '-'} | ${(s.interests || []).join(', ') || '-'} |\n`;
  });
  md += '\n';

  // AI推論による関係性
  if (aiEdges.length > 0) {
    md += '## AI推論による関係性\n\n';
    md += 'カスタムチューニングモデルによる深層分析の結果です。\n\n';

    const complementEdges = aiEdges.filter(e => e.type === 'COMPLEMENTS').sort((a, b) => b.weight - a.weight);
    const mentoringEdges = aiEdges.filter(e => e.type === 'MENTORING_FIT').sort((a, b) => b.weight - a.weight);
    const synergyEdges = aiEdges.filter(e => e.type === 'TEAM_SYNERGY').sort((a, b) => b.weight - a.weight);

    if (complementEdges.length > 0) {
      md += '### 補完関係\n\n';
      md += '| 社員ペア | スコア | 理由 |\n| --- | --- | --- |\n';
      complementEdges.forEach(e => {
        const a = e.source.replace('person:', '');
        const b = e.target.replace('person:', '');
        const linkedPair = `[${a}](./TEAM.md#${encodeURIComponent(a)}) × [${b}](./TEAM.md#${encodeURIComponent(b)})`;
        md += `| ${linkedPair} | ${e.weight}/10 | ${e.reason || '-'} |\n`;
      });
      md += '\n';
    }

    if (mentoringEdges.length > 0) {
      md += '### メンタリング適性\n\n';
      md += '| メンター → メンティー | スコア | 理由 |\n| --- | --- | --- |\n';
      mentoringEdges.forEach(e => {
        const a = e.source.replace('person:', '');
        const b = e.target.replace('person:', '');
        const linkedA = `[${a}](./TEAM.md#${encodeURIComponent(a)})`;
        const linkedB = `[${b}](./TEAM.md#${encodeURIComponent(b)})`;
        const dir = e.direction === 'B→A' ? `${linkedB} → ${linkedA}` : e.direction === 'mutual' ? `${linkedA} ↔ ${linkedB}` : `${linkedA} → ${linkedB}`;
        md += `| ${dir} | ${e.weight}/10 | ${e.reason || '-'} |\n`;
      });
      md += '\n';
    }

    if (synergyEdges.length > 0) {
      md += '### チーム相乗効果\n\n';
      md += '| 社員ペア | スコア | 理由 |\n| --- | --- | --- |\n';
      synergyEdges.forEach(e => {
        const a = e.source.replace('person:', '');
        const b = e.target.replace('person:', '');
        const linkedPair = `[${a}](./TEAM.md#${encodeURIComponent(a)}) × [${b}](./TEAM.md#${encodeURIComponent(b)})`;
        md += `| ${linkedPair} | ${e.weight}/10 | ${e.reason || '-'} |\n`;
      });
      md += '\n';
    }
  }

  // 統計サマリー
  md += '## 統計サマリー\n\n';

  // カテゴリ分布
  const categoryCounts = {};
  attrNodes.forEach(n => {
    n.categories.forEach(c => {
      categoryCounts[c] = (categoryCounts[c] || 0) + 1;
    });
  });

  md += '### ノード分布\n\n';
  md += '| カテゴリ | ノード数 |\n| --- | --- |\n';
  md += `| 社員 | ${personNodes.length} |\n`;
  Object.entries(categoryCounts).forEach(([cat, count]) => {
    const catLabel = { skill: 'スキル', value: '価値観', interest: '関心事', motivation: 'モチベーション' }[cat] || cat;
    md += `| ${catLabel} | ${count} |\n`;
  });
  md += `| **合計** | **${nodes.length}** |\n\n`;

  // エッジ分布
  const edgeTypeCounts = {};
  edges.forEach(e => {
    edgeTypeCounts[e.type] = (edgeTypeCounts[e.type] || 0) + 1;
  });

  md += '### エッジ分布\n\n';
  md += '| タイプ | エッジ数 |\n| --- | --- |\n';
  Object.entries(edgeTypeCounts).forEach(([type, count]) => {
    md += `| ${type} | ${count} |\n`;
  });
  md += `| **合計** | **${edges.length}** |\n\n`;

  // 書き込み
  const outputDir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(OUTPUT_FILE, md);
  console.log(`Markdown生成完了: ${OUTPUT_FILE}`);

  // HTML可視化ファイル生成
  generateHTML(graph);
}

function generateHTML(graph) {
  const jsTemplate = fs.readFileSync(JS_TEMPLATE_FILE, 'utf8');
  const graphJSON = JSON.stringify(graph);

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Saiteki ナレッジグラフ</title>
<script src="https://d3js.org/d3.v7.min.js"><\/script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Segoe UI', 'Hiragino Sans', 'Meiryo', sans-serif;
    background: #0f172a;
    color: #e2e8f0;
    overflow: hidden;
  }
  #app { display: flex; height: 100vh; }
  #sidebar {
    width: 320px;
    background: #1e293b;
    border-right: 1px solid #334155;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    flex-shrink: 0;
  }
  #sidebar-header {
    padding: 20px;
    border-bottom: 1px solid #334155;
    background: linear-gradient(135deg, #1e293b, #0f172a);
  }
  #sidebar-header h1 {
    font-size: 18px;
    font-weight: 700;
    background: linear-gradient(135deg, #60a5fa, #a78bfa);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    margin-bottom: 8px;
  }
  .stats {
    display: flex;
    gap: 12px;
    font-size: 11px;
    color: #94a3b8;
  }
  .stats span { display: flex; align-items: center; gap: 4px; }
  .stats .dot {
    width: 6px; height: 6px; border-radius: 50%;
    display: inline-block;
  }
  #controls { padding: 16px 20px; border-bottom: 1px solid #334155; }
  #controls label {
    font-size: 12px;
    color: #94a3b8;
    display: block;
    margin-bottom: 6px;
  }
  #filter-select {
    width: 100%;
    padding: 8px 12px;
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 8px;
    color: #e2e8f0;
    font-size: 13px;
    cursor: pointer;
    margin-bottom: 12px;
  }
  #search-input {
    width: 100%;
    padding: 10px 12px;
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 8px;
    color: #e2e8f0;
    font-size: 13px;
    margin-bottom: 16px;
  }
  #search-input:focus, #filter-select:focus { outline: none; border-color: #60a5fa; }
  .edge-toggle { margin-top: 12px; }
  .toggle-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
    font-size: 12px;
    color: #cbd5e1;
    cursor: pointer;
  }
  .toggle-row input { accent-color: #60a5fa; }
  #detail-panel {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
  }
  #detail-panel::-webkit-scrollbar { width: 4px; }
  #detail-panel::-webkit-scrollbar-thumb { background: #475569; border-radius: 2px; }
  .detail-empty {
    text-align: center;
    color: #64748b;
    margin-top: 60px;
    font-size: 13px;
    line-height: 1.8;
  }
  .detail-card {
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 12px;
    padding: 16px;
    margin-bottom: 12px;
  }
  .detail-card h3 {
    font-size: 15px;
    font-weight: 600;
    margin-bottom: 4px;
  }
  .detail-card .job {
    font-size: 11px;
    color: #60a5fa;
    margin-bottom: 8px;
  }
  .detail-card .summary {
    font-size: 12px;
    color: #94a3b8;
    line-height: 1.6;
    margin-bottom: 12px;
  }
  .detail-card .big5 {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 4px;
    text-align: center;
    font-size: 10px;
  }
  .big5 .score {
    font-size: 16px;
    font-weight: 700;
    color: #60a5fa;
  }
  .big5 .label { color: #64748b; margin-top: 2px; }
  .personality-section { margin-top: 12px; }
  .p-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 11px; }
  .p-bar .p-label { width: 48px; color: #94a3b8; flex-shrink: 0; }
  .p-bar .p-track { flex: 1; height: 6px; background: #1e293b; border-radius: 3px; overflow: hidden; }
  .p-bar .p-fill { height: 100%; border-radius: 3px; transition: width 0.4s; }
  .p-bar .p-score { width: 28px; text-align: right; color: #cbd5e1; font-weight: 600; }
  .connections-list { margin-top: 12px; }
  .connections-list h4 {
    font-size: 12px;
    color: #94a3b8;
    margin-bottom: 8px;
  }
  .conn-card {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 8px;
    padding: 10px 12px;
    margin-bottom: 8px;
  }
  .conn-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
  }
  .conn-card-name { font-size: 13px; font-weight: 600; }
  .conn-card-badge {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 10px;
    font-weight: 600;
  }
  .conn-card-reason { font-size: 11px; color: #94a3b8; line-height: 1.5; }
  .conn-card-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
  .tag { display: inline-block; font-size: 10px; padding: 2px 8px; border-radius: 10px; }
  .tag-skill { background: #60a5fa20; color: #60a5fa; }
  .tag-value { background: #34d39920; color: #34d399; }
  .tag-interest { background: #fb923c20; color: #fb923c; }
  .tag-relation { background: #a78bfa20; color: #a78bfa; }
  .conn-type.COMPLEMENTS { background: #7c3aed20; color: #a78bfa; }
  .conn-type.MENTORING_FIT { background: #f59e0b20; color: #fbbf24; }
  .conn-type.TEAM_SYNERGY { background: #10b98120; color: #34d399; }
  .conn-type.SHARES { background: #3b82f620; color: #60a5fa; }
  #graph-container { flex: 1; position: relative; }
  svg { width: 100%; height: 100%; }
  .tooltip {
    position: absolute;
    padding: 10px 14px;
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 8px;
    font-size: 12px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.15s;
    max-width: 280px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    z-index: 100;
  }
  .tooltip .tt-title { font-weight: 600; margin-bottom: 4px; }
  .tooltip .tt-sub { color: #94a3b8; font-size: 11px; }
  .legend {
    position: absolute;
    bottom: 20px;
    right: 20px;
    background: #1e293bdd;
    border: 1px solid #334155;
    border-radius: 12px;
    padding: 14px 18px;
    font-size: 11px;
    backdrop-filter: blur(8px);
  }
  .legend h5 { color: #94a3b8; margin-bottom: 6px; font-size: 10px; font-weight: 400; }
  .legend-item {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }
  .legend-item:last-child { margin-bottom: 0; }
  .legend-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .legend-line {
    width: 20px;
    height: 2px;
    flex-shrink: 0;
    border-radius: 1px;
  }
  .legend-divider { border-top: 1px solid #334155; margin: 6px 0; }
</style>
</head>
<body>
<div id="app">
  <div id="sidebar">
    <div id="sidebar-header">
      <h1>Saiteki ナレッジグラフ</h1>
      <div class="stats" id="stats"></div>
    </div>
    <div id="controls">
      <input type="text" id="search-input" placeholder="社員名を検索...">
      <select id="filter-select">
        <option value="all" selected>すべて表示</option>
        <option value="skill">スキル</option>
        <option value="value">価値観</option>
        <option value="interest">関心事</option>
        <option value="motivation">モチベーション</option>
      </select>
      <div class="edge-toggle">
        <label style="margin-bottom:8px">社員間リレーション</label>
        <label class="toggle-row"><input type="checkbox" id="toggle-shares"> 共通事項</label>
        <label class="toggle-row"><input type="checkbox" id="toggle-complements"> 補完関係</label>
        <label class="toggle-row"><input type="checkbox" id="toggle-mentoring"> メンタリング適性</label>
        <label class="toggle-row"><input type="checkbox" id="toggle-synergy"> チーム相乗効果</label>
      </div>
    </div>
    <div id="detail-panel">
      <div class="detail-empty">ノードをクリックすると<br>詳細が表示されます</div>
    </div>
  </div>
  <div id="graph-container">
    <div class="tooltip" id="tooltip"></div>
    <div class="legend">
      <h5>ノード</h5>
      <div class="legend-item"><div class="legend-dot" style="background:#818cf8"></div>社員</div>
      <div class="legend-item"><div class="legend-dot" style="background:#60a5fa"></div>スキル</div>
      <div class="legend-item"><div class="legend-dot" style="background:#34d399"></div>価値観</div>
      <div class="legend-item"><div class="legend-dot" style="background:#fb923c"></div>関心事</div>
      <div class="legend-item"><div class="legend-dot" style="background:#f472b6"></div>モチベーション</div>
      <div class="legend-divider"></div>
      <h5>社員間リレーション</h5>
      <div class="legend-item"><div class="legend-line" style="background:#3b82f6"></div>共通事項</div>
      <div class="legend-item"><div class="legend-line" style="background:#a78bfa"></div>補完関係</div>
      <div class="legend-item"><div class="legend-line" style="background:#fbbf24"></div>メンター相性</div>
      <div class="legend-item"><div class="legend-line" style="background:#34d399"></div>チーム相乗効果</div>
    </div>
  </div>
</div>
<script>
${jsTemplate.replace('__GRAPH_DATA_PLACEHOLDER__', graphJSON)}
</script>
</body>
</html>`;

  fs.writeFileSync(HTML_OUTPUT_FILE, html);
  console.log(`HTML可視化生成完了: ${HTML_OUTPUT_FILE}`);
}

main();

