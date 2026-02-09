const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../data/employees.json');
const TEAM_DOC_FILE = path.join(__dirname, '../docs/TEAM.md');

// メイン処理
async function main() {
  const issueBody = process.env.ISSUE_BODY;
  const issueTitle = process.env.ISSUE_TITLE;
  const issueLabels = JSON.parse(process.env.ISSUE_LABELS || '[]');

  if (!issueBody) {
    console.error('No issue body found');
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
    const data = parseIssueBody(issueBody);
    console.log('Parsed data:', data);
    updateEmployee(employees, data);
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

// Issue本文のパース
function parseIssueBody(body) {
  const lines = body.split('\n');
  const data = {};

  let currentKey = null;

  const keyMap = {
    'お名前': 'name',
    '職種': 'job',
    '好きな技術': 'like_tech',
    '嫌いな技術': 'dislike_tech',
    'S (Specific: 具体的)': 'smart_s',
    'M (Measurable: 測定可能)': 'smart_m',
    'A (Achievable: 達成可能)': 'smart_a',
    'R (Relevant: 関連性)': 'smart_r',
    'T (Time-bound: 期限)': 'smart_t'
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('### ')) {
      const label = line.replace('### ', '').trim();
      currentKey = keyMap[label];
    } else if (currentKey && line !== '' && line !== '_No response_') {
      // カンマ区切りは想定せず、すべて文字列として保存
      data[currentKey] = (data[currentKey] ? data[currentKey] + '\n' : '') + line;
    }
  }

  // SMARTをまとめた文字列も生成（表示用）
  if (data.smart_s || data.smart_m || data.smart_a || data.smart_r || data.smart_t) {
    data.smart_goal = [
      data.smart_s ? `**S:** ${data.smart_s}` : '',
      data.smart_m ? `**M:** ${data.smart_m}` : '',
      data.smart_a ? `**A:** ${data.smart_a}` : '',
      data.smart_r ? `**R:** ${data.smart_r}` : '',
      data.smart_t ? `**T:** ${data.smart_t}` : ''
    ].filter(Boolean).join(' / ');
  }

  return data;
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

  const entry = {
    ...newData,
    updatedAt: now,
    isActive: true
  };

  if (index !== -1) {
    employees[index] = { ...employees[index], ...entry };
  } else {
    employees.push({
      ...entry,
      createdAt: now
    });
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
  md += 'mindmap\n';
  md += '  root((株式会社Saiteki))\n';

  jobs.forEach(job => {
    md += `    ${job || 'Unassigned'}\n`;
    const members = activeEmployees.filter(e => e.job === job);
    members.forEach(m => {
      const safeName = m.name.replace(/[()"']/g, '');
      md += `      ${safeName}\n`;
    });
  });
  md += '```\n\n';

  md += '## 詳細リスト\n\n';
  md += '| 名前 | 職種 | 好きな技術 | 嫌いな技術 | 次のゴール (SMART) |\n';
  md += '| --- | --- | --- | --- | --- |\n';

  activeEmployees.forEach(e => {
    const likeTech = e.like_tech || '-';
    const dislikeTech = e.dislike_tech || '-';
    const goal = e.smart_goal || '-';

    md += `| ${e.name} | ${e.job} | ${likeTech} | ${dislikeTech} | ${goal} |\n`;
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
