/**
 * build-knowledge-graph.js
 * 
 * ナレッジグラフ構築スクリプト
 * Phase 1: employees.json から機械的にノード・エッジを抽出
 * Phase 2: カスタムチューニングモデルでAI拡張分析
 * 
 * 実行: node scripts/build-knowledge-graph.js [--skip-ai]
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const DATA_FILE = path.join(__dirname, '../data/employees.json');
const OUTPUT_FILE = path.join(__dirname, '../data/knowledge-graph.json');

const PROJECT_ID = process.env.GCP_PROJECT_ID;
const LOCATION = process.env.GCP_LOCATION || 'us-central1';
const API_KEY = process.env.GEMINI_API_KEY;
const ENDPOINT_ID = process.env.GCP_ENDPOINT_ID;

const args = process.argv.slice(2);
const SKIP_AI = args.includes('--skip-ai');

// ============================================================
// 同義語マッピング: 表記揺れを統一ラベルに正規化
// ============================================================
const synonymMap = {
    // スキル系
    'コミュニケーション能力': 'コミュニケーション',
    'コミュニケーション力': 'コミュニケーション',
    'チームコミュニケーション': 'コミュニケーション',
    '問題解決能力': '問題解決',
    '情報収集力': '情報収集',
    // 価値観系
    '自己成長': '成長',
    '自身の成長': '成長',
    '自己成長の機会': '成長',
    '貢献感': '貢献',
    '協調': '協調性',
    // 関心事系
    '生成AI': 'AI技術',
    'AI活用': 'AI技術',
    // モチベーション系
    '新しい技術の習得': '新しい知識・技術の習得',
    '新しい知識の習得': '新しい知識・技術の習得',
    '新しい知識やスキルの習得': '新しい知識・技術の習得',
    '新しい知識や技術の習得': '新しい知識・技術の習得',
    '新しい知識やスキルを習得すること': '新しい知識・技術の習得',
    'チームに貢献すること': 'チームへの貢献',
    '組織への貢献': 'チームへの貢献',
    '自身の成長を実感できること': '自己成長の実感',
    '周囲からの賞賛': '周囲からの感謝',
    'チームメンバーからの感謝': '周囲からの感謝',
    '他者からの賞賛': '周囲からの感謝',
    '感謝': '周囲からの感謝',
    'プロジェクトの成功': 'チームの成功',
    '組織目標の達成': 'チームの成功',
};

function normalizeLabel(label) {
    return synonymMap[label] || label;
}

function normalizeForId(label) {
    return normalizeLabel(label).replace(/[\s・]/g, '_').toLowerCase();
}

// ============================================================
// Phase 1: 機械的グラフ構築
// ============================================================
function buildMechanicalGraph(employees) {
    console.log('--- Phase 1: 機械的グラフ構築 ---');

    const nodes = [];
    const edges = [];
    const nodeMap = new Map();
    const edgeKeys = new Set();

    // 属性抽出設定
    const attrConfig = {
        skill: {
            field: 'work_styles_and_strengths',
            subField: 'dominant_strengths',
            edgeType: 'HAS_SKILL',
            color: '#60a5fa',
        },
        value: {
            field: 'values_and_motivators',
            subField: 'core_values',
            edgeType: 'VALUES',
            color: '#34d399',
        },
        interest: {
            field: 'current_state',
            subField: 'recent_topics_of_interest',
            edgeType: 'INTERESTED_IN',
            color: '#fb923c',
        },
        motivation: {
            field: 'values_and_motivators',
            subField: 'motivation_triggers',
            edgeType: 'MOTIVATED_BY',
            color: '#f472b6',
        },
    };

    // 1. Personノード生成
    const activeEmployees = employees.filter(e => e.isActive !== false);
    activeEmployees.forEach(emp => {
        const personId = `person:${emp.name}`;
        const personality = emp.personality_traits || {};
        nodes.push({
            id: personId,
            type: 'person',
            label: emp.name,
            job: emp.job,
            summary: emp.overall_summary || '',
            personality: {
                O: personality.openness?.score || 0,
                C: personality.conscientiousness?.score || 0,
                E: personality.extraversion?.score || 0,
                A: personality.agreeableness?.score || 0,
                N: personality.neuroticism?.score || 0,
            },
        });
        nodeMap.set(personId, true);
    });
    console.log(`  Personノード: ${activeEmployees.length}件`);

    // 2. 属性ノード・エッジ生成
    let attrNodeCount = 0;
    let attrEdgeCount = 0;

    Object.entries(attrConfig).forEach(([type, cfg]) => {
        activeEmployees.forEach(emp => {
            const fieldData = emp[cfg.field];
            if (!fieldData) return;
            const items = fieldData[cfg.subField] || [];

            // 正規化して重複排除
            const normalizedItems = [...new Set(items.map(normalizeLabel))];
            normalizedItems.forEach(normalizedItem => {
                const nodeId = `attr:${normalizeForId(normalizedItem)}`;

                if (!nodeMap.has(nodeId)) {
                    nodes.push({
                        id: nodeId,
                        type: 'attribute',
                        label: normalizedItem,
                        categories: [type],
                        color: cfg.color,
                        connectedPeople: [],
                    });
                    nodeMap.set(nodeId, true);
                    attrNodeCount++;
                }

                // 既存ノードにカテゴリを追加
                const attrNode = nodes.find(n => n.id === nodeId);
                if (attrNode) {
                    if (!attrNode.categories.includes(type)) {
                        attrNode.categories.push(type);
                    }
                    if (!attrNode.connectedPeople.includes(emp.name)) {
                        attrNode.connectedPeople.push(emp.name);
                    }
                }

                // エッジ生成（重複防止）
                const edgeKey = `${emp.name}->${nodeId}`;
                if (!edgeKeys.has(edgeKey)) {
                    edgeKeys.add(edgeKey);
                    edges.push({
                        source: `person:${emp.name}`,
                        target: nodeId,
                        type: cfg.edgeType,
                        weight: 1,
                    });
                    attrEdgeCount++;
                }
            });
        });
    });
    console.log(`  属性ノード: ${attrNodeCount}件`);
    console.log(`  Person→属性エッジ: ${attrEdgeCount}件`);

    // 3. 社員間の共通項目エッジ
    let sharedEdgeCount = 0;
    for (let i = 0; i < activeEmployees.length; i++) {
        for (let j = i + 1; j < activeEmployees.length; j++) {
            const a = activeEmployees[i];
            const b = activeEmployees[j];

            const getAttrs = (emp, field, subField) => {
                const data = emp[field];
                if (!data) return [];
                return [...new Set((data[subField] || []).map(normalizeLabel))];
            };

            const aSkills = getAttrs(a, 'work_styles_and_strengths', 'dominant_strengths');
            const bSkills = getAttrs(b, 'work_styles_and_strengths', 'dominant_strengths');
            const aValues = getAttrs(a, 'values_and_motivators', 'core_values');
            const bValues = getAttrs(b, 'values_and_motivators', 'core_values');
            const aInterests = getAttrs(a, 'current_state', 'recent_topics_of_interest');
            const bInterests = getAttrs(b, 'current_state', 'recent_topics_of_interest');

            const sharedSkills = aSkills.filter(s => bSkills.includes(s));
            const sharedValues = aValues.filter(v => bValues.includes(v));
            const sharedInterests = aInterests.filter(t => bInterests.includes(t));
            const totalShared = sharedSkills.length + sharedValues.length + sharedInterests.length;

            if (totalShared > 0) {
                edges.push({
                    source: `person:${a.name}`,
                    target: `person:${b.name}`,
                    type: 'SHARES',
                    weight: totalShared,
                    shared: {
                        skills: sharedSkills,
                        values: sharedValues,
                        interests: sharedInterests,
                    },
                });
                sharedEdgeCount++;
            }
        }
    }
    console.log(`  共通項目エッジ: ${sharedEdgeCount}件`);
    console.log(`  合計: ノード${nodes.length}件, エッジ${edges.length}件`);

    return { nodes, edges };
}

// ============================================================
// Phase 2: AI拡張分析
// ============================================================
async function enhanceWithAI(graph, employees) {
    if (SKIP_AI) {
        console.log('--- Phase 2: スキップ（--skip-ai フラグ） ---');
        return graph;
    }

    if (!API_KEY || !PROJECT_ID) {
        console.log('--- Phase 2: スキップ（API設定なし） ---');
        return graph;
    }

    console.log('--- Phase 2: AI拡張分析 ---');

    let url = '';
    if (ENDPOINT_ID) {
        url = `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT_ID}/locations/${LOCATION}/endpoints/${ENDPOINT_ID}:streamGenerateContent?key=${API_KEY}`;
        console.log('  カスタムチューニングモデルを使用');
    } else {
        url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/gemini-1.5-pro-002:streamGenerateContent?key=${API_KEY}`;
        console.log('  Gemini 1.5 Pro にフォールバック');
    }

    const activeEmployees = employees.filter(e => e.isActive !== false);
    const aiEdges = [];

    // 全ペアの組み合わせをバッチ処理
    const pairs = [];
    for (let i = 0; i < activeEmployees.length; i++) {
        for (let j = i + 1; j < activeEmployees.length; j++) {
            pairs.push([activeEmployees[i], activeEmployees[j]]);
        }
    }
    console.log(`  分析対象ペア数: ${pairs.length}`);

    // 5ペアずつバッチ処理
    const BATCH_SIZE = 5;
    for (let batchStart = 0; batchStart < pairs.length; batchStart += BATCH_SIZE) {
        const batch = pairs.slice(batchStart, batchStart + BATCH_SIZE);
        const pairDescriptions = batch.map(([a, b]) => {
            return `
【ペア: ${a.name} × ${b.name}】
${a.name}（${a.job}）: ${a.overall_summary || '情報なし'}
性格: O=${a.personality_traits?.openness?.score || '?'}, C=${a.personality_traits?.conscientiousness?.score || '?'}, E=${a.personality_traits?.extraversion?.score || '?'}, A=${a.personality_traits?.agreeableness?.score || '?'}, N=${a.personality_traits?.neuroticism?.score || '?'}
強み: ${a.work_styles_and_strengths?.dominant_strengths?.join(', ') || '不明'}
価値観: ${a.values_and_motivators?.core_values?.join(', ') || '不明'}

${b.name}（${b.job}）: ${b.overall_summary || '情報なし'}
性格: O=${b.personality_traits?.openness?.score || '?'}, C=${b.personality_traits?.conscientiousness?.score || '?'}, E=${b.personality_traits?.extraversion?.score || '?'}, A=${b.personality_traits?.agreeableness?.score || '?'}, N=${b.personality_traits?.neuroticism?.score || '?'}
強み: ${b.work_styles_and_strengths?.dominant_strengths?.join(', ') || '不明'}
価値観: ${b.values_and_motivators?.core_values?.join(', ') || '不明'}
`;
        }).join('\n---\n');

        const prompt = `
あなたは組織開発の専門家です。以下の社員ペアについて、チーム編成やメンタリングに役立つ関係性を分析してください。

${pairDescriptions}

各ペアについて以下を判定してください:
1. COMPLEMENTS（補完関係）: 互いの弱みを補い合える関係か。スコア0-10
2. MENTORING_FIT（メンタリング適性）: 一方が他方を指導できる関係か。スコア0-10。方向も示す
3. TEAM_SYNERGY（チーム相乗効果）: 同じチームで働いた場合の相乗効果。スコア0-10

JSONの配列で出力してください。Markdownブロックは不要です。
[
  {
    "person_a": "名前A",
    "person_b": "名前B",
    "complements": { "score": 0-10, "reason": "理由" },
    "mentoring_fit": { "score": 0-10, "direction": "A→B" | "B→A" | "mutual", "reason": "理由" },
    "team_synergy": { "score": 0-10, "reason": "理由" }
  }
]

注意:
- スコア5未満の関係は出力しない
- 根拠は具体的に50文字以内で
`;

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generation_config: {
                        response_mime_type: 'application/json',
                    },
                }),
            });

            if (!response.ok) {
                console.error(`  API Error: ${response.status}`);
                continue;
            }

            const resDataArr = await response.json();
            let text = '';
            if (Array.isArray(resDataArr)) {
                text = resDataArr.map(chunk => chunk?.candidates?.[0]?.content?.parts?.[0]?.text || '').join('');
            } else {
                text = resDataArr?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            }

            const results = JSON.parse(text);
            results.forEach(r => {
                if (r.complements?.score >= 5) {
                    aiEdges.push({
                        source: `person:${r.person_a}`,
                        target: `person:${r.person_b}`,
                        type: 'COMPLEMENTS',
                        weight: r.complements.score,
                        reason: r.complements.reason,
                        ai_generated: true,
                    });
                }
                if (r.mentoring_fit?.score >= 5) {
                    aiEdges.push({
                        source: `person:${r.person_a}`,
                        target: `person:${r.person_b}`,
                        type: 'MENTORING_FIT',
                        weight: r.mentoring_fit.score,
                        direction: r.mentoring_fit.direction,
                        reason: r.mentoring_fit.reason,
                        ai_generated: true,
                    });
                }
                if (r.team_synergy?.score >= 5) {
                    aiEdges.push({
                        source: `person:${r.person_a}`,
                        target: `person:${r.person_b}`,
                        type: 'TEAM_SYNERGY',
                        weight: r.team_synergy.score,
                        reason: r.team_synergy.reason,
                        ai_generated: true,
                    });
                }
            });

            console.log(`  バッチ ${Math.floor(batchStart / BATCH_SIZE) + 1}/${Math.ceil(pairs.length / BATCH_SIZE)}: ${results.length}ペア分析完了`);
        } catch (error) {
            console.error(`  バッチ処理エラー:`, error.message);
        }

        // レート制限対策
        await new Promise(r => setTimeout(r, 1200));
    }

    console.log(`  AI推論エッジ: ${aiEdges.length}件追加`);
    graph.edges.push(...aiEdges);
    return graph;
}

// ============================================================
// メイン処理
// ============================================================
async function main() {
    console.log('=== ナレッジグラフ構築開始 ===\n');

    if (!fs.existsSync(DATA_FILE)) {
        console.error(`データファイルが見つかりません: ${DATA_FILE}`);
        process.exit(1);
    }

    const employees = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    console.log(`社員データ読み込み: ${employees.length}件\n`);

    // Phase 1: 機械的グラフ構築
    let graph = buildMechanicalGraph(employees);

    // Phase 2: AI拡張分析
    graph = await enhanceWithAI(graph, employees);

    // メタデータ追加
    const output = {
        metadata: {
            generated_at: new Date().toISOString(),
            source: 'employees.json',
            employee_count: employees.filter(e => e.isActive !== false).length,
            node_count: graph.nodes.length,
            edge_count: graph.edges.length,
            ai_enhanced: !SKIP_AI && !!API_KEY && !!PROJECT_ID,
        },
        nodes: graph.nodes,
        edges: graph.edges,
    };

    // 出力ディレクトリ確認
    const outputDir = path.dirname(OUTPUT_FILE);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
    console.log(`\n=== 完了: ${OUTPUT_FILE} ===`);
    console.log(`  ノード: ${output.metadata.node_count}`);
    console.log(`  エッジ: ${output.metadata.edge_count}`);
    console.log(`  AI拡張: ${output.metadata.ai_enhanced ? 'あり' : 'なし'}`);
}

main().catch(console.error);
