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
    '好きな技術・使いたい技術': 'preferred_tech',
    '今年のゴール (SMART)': 'will',
    '不足しているもの・支援が必要なこと': 'gap'
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('### ')) {
      const label = line.replace('### ', '').trim();
      currentKey = keyMap[label];
      if (currentKey) data[currentKey] = ''; // 初期化
    } else if (currentKey && line !== '' && line !== '_No response_') {
      if (currentKey === 'preferred_tech') {
        data[currentKey] = line.split(',').map(s => s.trim());
      } else {
        // 複数行対応
        data[currentKey] = (data[currentKey] ? data[currentKey] + '\n' : '') + line;
      }
    }
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
  md += '| 名前 | 職種 | 好きな技術 | 今年のゴール (SMART) |\n';
  md += '| --- | --- | --- | --- |\n';

  activeEmployees.forEach(e => {
    // Preferred Tech
    const tech = Array.isArray(e.preferred_tech) ? e.preferred_tech.join(', ') : (e.preferred_tech || '-');

    // Will (SMART)
    let willContent = '-';
    if (e.will) {
      willContent = e.will.replace(/\n/g, '<br>');
    }

    md += `| ${e.name} | ${e.job} | ${tech} | ${willContent} |\n`;
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
