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

const HTML_OUTPUT_FILE = path.join(__dirname, '../docs/knowledge-graph.html');

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
    md += `> 自動生成: ${metadata.generated_at}\n`;
    md += `> 社員数: ${metadata.employee_count}名 | ノード: ${metadata.node_count} | エッジ: ${metadata.edge_count} | AI拡張: ${metadata.ai_enhanced ? 'あり' : 'なし'}\n\n`;
    md += '---\n\n';

    // スキル別グルーピング
    md += '## スキル・強み別グルーピング\n\n';
    const skillNodes = attrNodes.filter(n => n.categories.includes('skill'));
    skillNodes.sort((a, b) => (b.connectedPeople?.length || 0) - (a.connectedPeople?.length || 0));

    md += '| スキル | 保有者数 | 社員 |\n| --- | --- | --- |\n';
    skillNodes.forEach(node => {
        const people = node.connectedPeople || [];
        md += `| ${node.label} | ${people.length} | ${people.join(', ')} |\n`;
    });
    md += '\n';

    // 価値観別グルーピング
    md += '## 価値観別グルーピング\n\n';
    const valueNodes = attrNodes.filter(n => n.categories.includes('value'));
    valueNodes.sort((a, b) => (b.connectedPeople?.length || 0) - (a.connectedPeople?.length || 0));

    md += '| 価値観 | 共有者数 | 社員 |\n| --- | --- | --- |\n';
    valueNodes.forEach(node => {
        const people = node.connectedPeople || [];
        md += `| ${node.label} | ${people.length} | ${people.join(', ')} |\n`;
    });
    md += '\n';

    // 関心事別グルーピング
    md += '## 関心事別グルーピング\n\n';
    const interestNodes = attrNodes.filter(n => n.categories.includes('interest'));
    interestNodes.sort((a, b) => (b.connectedPeople?.length || 0) - (a.connectedPeople?.length || 0));

    md += '| 関心事 | 関心者数 | 社員 |\n| --- | --- | --- |\n';
    interestNodes.forEach(node => {
        const people = node.connectedPeople || [];
        md += `| ${node.label} | ${people.length} | ${people.join(', ')} |\n`;
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
        const s = edge.shared || {};
        md += `| ${i + 1} | ${nameA} × ${nameB} | ${edge.weight} | ${(s.skills || []).join(', ') || '-'} | ${(s.values || []).join(', ') || '-'} | ${(s.interests || []).join(', ') || '-'} |\n`;
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
                md += `| ${a} × ${b} | ${e.weight}/10 | ${e.reason || '-'} |\n`;
            });
            md += '\n';
        }

        if (mentoringEdges.length > 0) {
            md += '### メンタリング適性\n\n';
            md += '| メンター → メンティー | スコア | 理由 |\n| --- | --- | --- |\n';
            mentoringEdges.forEach(e => {
                const a = e.source.replace('person:', '');
                const b = e.target.replace('person:', '');
                const dir = e.direction === 'B→A' ? `${b} → ${a}` : e.direction === 'mutual' ? `${a} ↔ ${b}` : `${a} → ${b}`;
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
                md += `| ${a} × ${b} | ${e.weight}/10 | ${e.reason || '-'} |\n`;
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
  }
  #filter-select:focus { outline: none; border-color: #60a5fa; }
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
  .connections-list { margin-top: 12px; }
  .connections-list h4 {
    font-size: 12px;
    color: #94a3b8;
    margin-bottom: 8px;
  }
  .conn-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 0;
    border-bottom: 1px solid #1e293b;
    font-size: 12px;
  }
  .conn-item .conn-type {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 4px;
    background: #334155;
    color: #94a3b8;
  }
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
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 12px;
    padding: 14px 18px;
    font-size: 11px;
  }
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
      <label>表示フィルタ</label>
      <select id="filter-select">
        <option value="all">すべて表示</option>
        <option value="person-only">社員のみ</option>
        <option value="skill">スキル</option>
        <option value="value">価値観</option>
        <option value="interest">関心事</option>
        <option value="motivation">モチベーション</option>
      </select>
      <div class="edge-toggle">
        <label style="margin-bottom:8px">AI推論エッジ</label>
        <label class="toggle-row"><input type="checkbox" id="toggle-shares" checked> 共通項目</label>
        <label class="toggle-row"><input type="checkbox" id="toggle-complements" checked> 補完関係</label>
        <label class="toggle-row"><input type="checkbox" id="toggle-mentoring" checked> メンタリング適性</label>
        <label class="toggle-row"><input type="checkbox" id="toggle-synergy" checked> チーム相乗効果</label>
      </div>
    </div>
    <div id="detail-panel">
      <div class="detail-empty">ノードをクリックすると<br>詳細が表示されます</div>
    </div>
  </div>
  <div id="graph-container">
    <div class="tooltip" id="tooltip"></div>
    <div class="legend">
      <div class="legend-item"><div class="legend-dot" style="background:#818cf8"></div>社員</div>
      <div class="legend-item"><div class="legend-dot" style="background:#60a5fa"></div>スキル</div>
      <div class="legend-item"><div class="legend-dot" style="background:#34d399"></div>価値観</div>
      <div class="legend-item"><div class="legend-dot" style="background:#fb923c"></div>関心事</div>
      <div class="legend-item"><div class="legend-dot" style="background:#f472b6"></div>モチベーション</div>
    </div>
  </div>
</div>
<script>
const GRAPH_DATA = ${graphJSON};

const colorMap = {
  person: '#818cf8',
  skill: '#60a5fa',
  value: '#34d399',
  interest: '#fb923c',
  motivation: '#f472b6',
};

const edgeColorMap = {
  HAS_SKILL: '#60a5fa40',
  VALUES: '#34d39940',
  INTERESTED_IN: '#fb923c40',
  MOTIVATED_BY: '#f472b640',
  SHARES: '#3b82f660',
  COMPLEMENTS: '#a78bfa80',
  MENTORING_FIT: '#fbbf2480',
  TEAM_SYNERGY: '#34d39980',
};

const aiEdgeTypes = ['SHARES', 'COMPLEMENTS', 'MENTORING_FIT', 'TEAM_SYNERGY'];

let currentFilter = 'all';
let visibleEdgeTypes = new Set(aiEdgeTypes);

// Stats
const stats = document.getElementById('stats');
const meta = GRAPH_DATA.metadata;
stats.innerHTML = \`
  <span><span class="dot" style="background:#818cf8"></span>\${meta.employee_count}名</span>
  <span><span class="dot" style="background:#60a5fa"></span>\${meta.node_count}ノード</span>
  <span><span class="dot" style="background:#34d399"></span>\${meta.edge_count}エッジ</span>
  <span>\${meta.ai_enhanced ? 'AI拡張済' : ''}</span>
\`;

// SVG setup
const container = document.getElementById('graph-container');
const width = container.clientWidth;
const height = container.clientHeight;

const svg = d3.select('#graph-container').append('svg')
  .attr('width', width)
  .attr('height', height);

const g = svg.append('g');

// Zoom
const zoom = d3.zoom()
  .scaleExtent([0.1, 4])
  .on('zoom', (e) => g.attr('transform', e.transform));
svg.call(zoom);

const tooltip = document.getElementById('tooltip');
const detailPanel = document.getElementById('detail-panel');

function getFilteredData() {
  let nodes, edges;
  const allNodes = GRAPH_DATA.nodes;
  const allEdges = GRAPH_DATA.edges;

  if (currentFilter === 'all') {
    nodes = [...allNodes];
  } else if (currentFilter === 'person-only') {
    nodes = allNodes.filter(n => n.type === 'person');
  } else {
    const personNodes = allNodes.filter(n => n.type === 'person');
    const catNodes = allNodes.filter(n => n.type === 'attribute' && n.categories.includes(currentFilter));
    nodes = [...personNodes, ...catNodes];
  }

  const nodeIds = new Set(nodes.map(n => n.id));
  edges = allEdges.filter(e => {
    if (!nodeIds.has(e.source?.id || e.source) || !nodeIds.has(e.target?.id || e.target)) return false;
    if (aiEdgeTypes.includes(e.type) && !visibleEdgeTypes.has(e.type)) return false;
    return true;
  });

  return { nodes, edges };
}

function getNodeRadius(node) {
  if (node.type === 'person') return 20;
  const count = node.connectedPeople?.length || 1;
  return Math.min(6 + count * 2, 18);
}

function getNodeColor(node) {
  if (node.type === 'person') return colorMap.person;
  if (node.color) return node.color;
  const firstCat = node.categories?.[0] || 'skill';
  return colorMap[firstCat] || '#94a3b8';
}

let simulation, linkGroup, nodeGroup, labelGroup;

function render() {
  g.selectAll('*').remove();
  const data = getFilteredData();

  linkGroup = g.append('g').attr('class', 'links');
  nodeGroup = g.append('g').attr('class', 'nodes');
  labelGroup = g.append('g').attr('class', 'labels');

  const links = linkGroup.selectAll('line')
    .data(data.edges)
    .enter().append('line')
    .attr('stroke', d => edgeColorMap[d.type] || '#33415540')
    .attr('stroke-width', d => {
      if (d.type === 'SHARES') return Math.max(1, d.weight * 0.5);
      if (aiEdgeTypes.includes(d.type)) return 2;
      return 0.5;
    })
    .attr('stroke-dasharray', d => d.ai_generated ? '4,4' : 'none');

  const nodes = nodeGroup.selectAll('circle')
    .data(data.nodes)
    .enter().append('circle')
    .attr('r', getNodeRadius)
    .attr('fill', getNodeColor)
    .attr('stroke', d => d.type === 'person' ? '#818cf880' : 'none')
    .attr('stroke-width', d => d.type === 'person' ? 2 : 0)
    .attr('cursor', 'pointer')
    .on('mouseover', (event, d) => {
      tooltip.style.opacity = 1;
      let sub = '';
      if (d.type === 'person') sub = d.job;
      else sub = (d.connectedPeople?.length || 0) + '名が該当';
      tooltip.innerHTML = \`<div class="tt-title">\${d.label}</div><div class="tt-sub">\${sub}</div>\`;
    })
    .on('mousemove', (event) => {
      tooltip.style.left = (event.offsetX + 14) + 'px';
      tooltip.style.top = (event.offsetY - 14) + 'px';
    })
    .on('mouseout', () => { tooltip.style.opacity = 0; })
    .on('click', (event, d) => showDetail(d))
    .call(d3.drag()
      .on('start', (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
      .on('end', (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null; d.fy = null;
      })
    );

  const labels = labelGroup.selectAll('text')
    .data(data.nodes.filter(n => n.type === 'person' || (n.connectedPeople?.length || 0) >= 3))
    .enter().append('text')
    .text(d => d.label)
    .attr('text-anchor', 'middle')
    .attr('dy', d => d.type === 'person' ? -26 : -14)
    .attr('fill', '#cbd5e1')
    .attr('font-size', d => d.type === 'person' ? '12px' : '10px')
    .attr('pointer-events', 'none');

  simulation = d3.forceSimulation(data.nodes)
    .force('link', d3.forceLink(data.edges).id(d => d.id).distance(d => {
      if (d.type === 'SHARES' || aiEdgeTypes.includes(d.type)) return 120;
      return 80;
    }))
    .force('charge', d3.forceManyBody()
      .strength(d => d.type === 'person' ? -300 : -80)
    )
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius(d => getNodeRadius(d) + 4))
    .on('tick', () => {
      links
        .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
      nodes.attr('cx', d => d.x).attr('cy', d => d.y);
      labels.attr('x', d => d.x).attr('y', d => d.y);
    });
}

function showDetail(node) {
  if (node.type === 'person') {
    const p = node.personality || {};
    const allEdges = GRAPH_DATA.edges;
    const connections = allEdges.filter(e => {
      const src = e.source?.id || e.source;
      const tgt = e.target?.id || e.target;
      return (src === node.id || tgt === node.id) && aiEdgeTypes.includes(e.type);
    });

    let connHTML = '';
    if (connections.length > 0) {
      connHTML = '<div class="connections-list"><h4>関係性</h4>';
      connections.sort((a, b) => b.weight - a.weight).slice(0, 10).forEach(e => {
        const src = e.source?.id || e.source;
        const tgt = e.target?.id || e.target;
        const other = (src === node.id ? tgt : src).replace('person:', '');
        const reason = e.reason || '';
        connHTML += \`<div class="conn-item"><span>\${other} <span style="color:#64748b;font-size:10px">\${reason}</span></span><span class="conn-type \${e.type}">\${e.type.replace('_', ' ')}</span></div>\`;
      });
      connHTML += '</div>';
    }

    detailPanel.innerHTML = \`
      <div class="detail-card">
        <h3>\${node.label}</h3>
        <div class="job">\${node.job}</div>
        <div class="summary">\${node.summary}</div>
        <div class="big5">
          <div><div class="score">\${p.O}</div><div class="label">開放性</div></div>
          <div><div class="score">\${p.C}</div><div class="label">誠実性</div></div>
          <div><div class="score">\${p.E}</div><div class="label">外向性</div></div>
          <div><div class="score">\${p.A}</div><div class="label">協調性</div></div>
          <div><div class="score">\${p.N}</div><div class="label">神経症</div></div>
        </div>
        \${connHTML}
      </div>
    \`;
  } else {
    const people = node.connectedPeople || [];
    detailPanel.innerHTML = \`
      <div class="detail-card">
        <h3>\${node.label}</h3>
        <div class="job">\${node.categories?.join(', ')}</div>
        <div class="summary">該当社員: \${people.length}名</div>
        <div style="font-size:12px">\${people.map(p => '<div style="padding:4px 0;border-bottom:1px solid #1e293b">' + p + '</div>').join('')}</div>
      </div>
    \`;
  }
}

// Filter handlers
document.getElementById('filter-select').addEventListener('change', (e) => {
  currentFilter = e.target.value;
  render();
});

const toggleMap = {
  'toggle-shares': 'SHARES',
  'toggle-complements': 'COMPLEMENTS',
  'toggle-mentoring': 'MENTORING_FIT',
  'toggle-synergy': 'TEAM_SYNERGY',
};

Object.entries(toggleMap).forEach(([id, type]) => {
  document.getElementById(id).addEventListener('change', (e) => {
    if (e.target.checked) visibleEdgeTypes.add(type);
    else visibleEdgeTypes.delete(type);
    render();
  });
});

// Initial render
render();
svg.call(zoom.transform, d3.zoomIdentity.translate(width / 4, height / 4).scale(0.8));
<\/script>
</body>
</html>`;

    fs.writeFileSync(HTML_OUTPUT_FILE, html);
    console.log(`HTML可視化生成完了: ${HTML_OUTPUT_FILE}`);
}

main();

