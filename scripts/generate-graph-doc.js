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
    console.log(`ドキュメント生成完了: ${OUTPUT_FILE}`);
}

main();
