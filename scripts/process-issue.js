const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

const DATA_FILE = path.join(__dirname, '../data/employees.json');
const TEAM_DOC_FILE = path.join(__dirname, '../docs/TEAM.md');

// Gemini API Client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// メイン処理
async function main() {
  const issueBody = process.env.ISSUE_BODY;
  const issueTitle = process.env.ISSUE_TITLE;
  const issueLabels = JSON.parse(process.env.ISSUE_LABELS || '[]');

  if (!issueBody) {
    if (process.argv.includes('--sync')) {
      console.log('Manual sync triggered. Regenerating TEAM.md from existing data...');
      if (fs.existsSync(DATA_FILE)) {
        const currentEmployees = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        generateTeamDoc(currentEmployees);
        console.log('TEAM.md regenerated successfully.');
        return;
      } else {
        console.error('Data file not found. Cannot sync.');
        process.exit(1);
      }
    }
    console.error('No issue body found. Provide ISSUE_BODY or use --sync flag.');
    process.exit(1);
  }

  let employees = [];
  if (fs.existsSync(DATA_FILE)) {
    employees = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }

  // ラベルによって処理を分岐
  const isUpdate = issueLabels.some(l => l.name === 'employee-update');
  const isDelete = issueLabels.some(l => l.name === 'employee-delete');

  if (isUpdate) {
    const rawData = parseIssueBody(issueBody);
    console.log('Raw data from issue:', rawData);

    // AIによる構造化処理
    const structuredData = await extractDataWithAI(rawData);
    console.log('Structured data from AI:', structuredData);

    // マージして更新
    const finalData = { ...rawData, ...structuredData };
    updateEmployee(employees, finalData);

  } else if (isDelete) {
    const data = parseDeleteIssueBody(issueBody);
    console.log('Parsed delete data:', data);
    deleteEmployee(employees, data);
  } else {
    console.log('No relevant labels found. Skipping.');
    return;
  }

  // JSON保存
  fs.writeFileSync(DATA_FILE, JSON.stringify(employees, null, 2));

  // ドキュメント生成
  generateTeamDoc(employees);
}

// Issue本文のパース (Markdownのセクションごとの単純な抽出)
function parseIssueBody(body) {
  const lines = body.split('\n');
  const data = {};
  let currentKey = null;

  // New templates have 'self_intro'
  // Old templates had 'like_tech', 'smart_s', etc.
  // We mapping '自己紹介 / キャリア詳細' to 'self_intro'
  const keyMap = {
    'お名前': 'name',
    '職種': 'job', // マネージャー用オンボーディングで使われる可能性があるため残す
    '自己紹介 / キャリア詳細': 'self_intro'
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('### ')) {
      const label = line.replace('### ', '').trim();
      currentKey = keyMap[label];
      // マッピングされていないセクション（SMART等、旧形式の場合）は無視するか、その他として扱う
    } else if (currentKey && line !== '' && line !== '_No response_') {
      data[currentKey] = (data[currentKey] ? data[currentKey] + '\n' : '') + line;
    }
  }
  return data;
}

// Gemini APIを使ってテキストから構造化データを抽出
async function extractDataWithAI(rawData) {
  if (!rawData.self_intro) {
    console.log('No self_intro found. Skipping AI extraction.');
    return {};
  }

  if (!process.env.GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY is not set. Skipping AI extraction.');
    return {};
  }

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview-001" });

    const prompt = `
    あなたは人事データの分析官です。以下の「自己紹介・キャリア詳細」のテキストから、社員のスキル、興味、目標、人柄を抽出し、JSON形式で出力してください。

    Input Text:
    """
    ${rawData.self_intro}
    """
    
    Output JSON Schema:
    {
      "skills": ["skill1", "skill2"], // 明示的に言及されている技術やスキル
      "interests": ["interest1", "interest2"], // 興味があること、学びたいこと、趣味
      "goal": "要約されたキャリア目標",
      "personality": "人柄や志向性のキーワード (例: リーダー気質, スペシャリスト志向, アウトドア派)",
      "job_guess": "Engineer" // 文脈から推測される職種 (Engineer, Designer, Sales, PM, Corporate, QA, HR, 経営, Other)
    }

    Response must be valid JSON only, no markdown formatting.
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    // Clean up markdown code blocks if present
    const jsonString = text.replace(/```json/g, '').replace(/```/g, '').trim();

    return JSON.parse(jsonString);
  } catch (error) {
    console.error('Error calling Gemini API:', error);
    return {};
  }
}

function parseDeleteIssueBody(body) {
  const lines = body.split('\n');
  const data = {};
  let currentKey = null;

  const keyMap = {
    '対象社員名': 'name',
    '処理種別': 'action_type',
    '理由': 'reason'
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('### ')) {
      const label = line.replace('### ', '').trim();
      currentKey = keyMap[label];
    } else if (currentKey && line !== '' && line !== '_No response_') {
      data[currentKey] = line;
    }
  }
  return data;
}

// 社員データの更新
function updateEmployee(employees, newData) {
  const index = employees.findIndex(e => e.name === newData.name);
  const now = new Date().toISOString();

  // 既存データがある場合はマージ、ただしnewDataのキー優先
  // AI抽出データの配列などは上書きする
  let entry = {};

  if (index !== -1) {
    entry = { ...employees[index], ...newData, updatedAt: now, isActive: true };
    // 配列データの重複排除などはあえてせず、最新のAI分析結果を信頼して上書きする
    employees[index] = entry;
  } else {
    // 新規作成（通常はオンボーディングで作成済みのはずだが、手動リカバリ等でここに来る場合も考慮）
    entry = {
      ...newData,
      createdAt: now,
      updatedAt: now,
      isActive: true,
      job: newData.job || newData.job_guess || 'Other' // Jobがない場合は推測を使う
    };
    employees.push(entry);
  }
}

// 社員データの削除・アーカイブ
function deleteEmployee(employees, data) {
  const index = employees.findIndex(e => e.name === data.name);
  if (index === -1) {
    console.log(`Employee ${data.name} not found.`);
    return;
  }

  if (data.action_type.includes('Delete')) {
    // 物理削除
    employees.splice(index, 1);
  } else {
    // アーカイブ (論理削除)
    employees[index].isActive = false;
    employees[index].archivedReason = data.reason;
    employees[index].archivedAt = new Date().toISOString();
  }
}

// Markdownドキュメント生成
function generateTeamDoc(employees) {
  const activeEmployees = employees.filter(e => e.isActive !== false);
  const archivedEmployees = employees.filter(e => e.isActive === false);

  const jobs = [...new Set(activeEmployees.map(e => e.job))];

  let md = '# チーム構成図\n\n';
  md += '自動生成された組織図です。Issueによる更新が反映されます。\n\n';

  md += '```mermaid\n';
  md += `%%{init: {
    'theme': 'base',
    'themeVariables': {
      'primaryColor': '#F2EBE3',
      'primaryTextColor': '#5D574F',
      'primaryBorderColor': '#D9CFC1',
      'lineColor': '#BEB3A5',
      'secondaryColor': '#FAF9F6',
      'tertiaryColor': '#FDFCFB',
      'nodeBorder': '1px'
    }
  }}%%\n`;
  md += 'mindmap\n';
  md += '  root((株式会社Saiteki))\n';

  const jobMap = {
    'Engineer': 'Engineer',
    'Designer': 'Designer',
    'Sales': 'Sales',
    'PM': 'PM',
    'Corporate': 'Corporate',
    'EM': 'Engineer',
    'QA': 'QA',
    'HR': 'HR',
    '経営': '経営',
    'Executive': '経営',
    'Other': 'Other'
  };

  jobs.forEach(job => {
    md += `    ${jobMap[job] || job || '未割り当て'}\n`;
    const members = activeEmployees.filter(e => e.job === job);
    members.forEach(m => {
      const safeName = m.name.replace(/[()"']/g, '');
      md += `      ${safeName}\n`;
    });
  });
  md += '```\n\n';

  md += '## 詳細リスト\n\n';
  md += '| 名前 | 職種 | 得意スキル (Tags) | 興味 (Interests) | 目標 (Goal) | 人柄 (Personality) |\n';
  md += '| --- | --- | --- | --- | --- | --- |\n';

  activeEmployees.forEach(e => {
    // 古いデータ形式(like_tech等)も考慮しつつ、新しいAIデータを優先表示
    const skills = e.skills ? e.skills.join(', ') : (e.like_tech || '-');
    const interests = e.interests ? e.interests.join(', ') : '-';
    // Goalは smart_goal か AI抽出の goal
    const goal = e.goal || (Array.isArray(e.smart_goal) ? e.smart_goal.join(' / ') : e.smart_goal) || '-';
    const personality = e.personality || '-';

    md += `| ${e.name} | ${e.job} | ${skills} | ${interests} | ${goal} | ${personality} |\n`;
  });

  if (archivedEmployees.length > 0) {
    md += '\n## Alumni (OB/OG)\n\n';
    md += '| 名前 | 在籍時の職種 | 理由 |\n';
    md += '| --- | --- | --- |\n';
    archivedEmployees.forEach(e => {
      md += `| ${e.name} | ${e.job} | ${e.archivedReason || '-'} |\n`;
    });
  }

  const docDir = path.dirname(TEAM_DOC_FILE);
  if (!fs.existsSync(docDir)) {
    fs.mkdirSync(docDir, { recursive: true });
  }

  fs.writeFileSync(TEAM_DOC_FILE, md);
}

main().catch(console.error);
