const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { generateTeamDoc } = require('./lib/team-doc');

const DATA_FILE = path.join(__dirname, '../data/employees.json');

// メイン処理
async function main() {
  const issueBody = process.env.ISSUE_BODY;
  const issueTitle = process.env.ISSUE_TITLE;
  const issueLabels = JSON.parse(process.env.ISSUE_LABELS || '[]');

  if (!issueBody) {
    if (process.argv.includes('--sync')) {
      console.log('Manual sync triggered. Regenerating TEAM.md and enriching data with AI...');
      if (fs.existsSync(DATA_FILE)) {
        let currentEmployees = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

        // 未構造化のデータをバッチ処理
        let updated = false;
        for (let e of currentEmployees) {
          if (e.isActive !== false && e.self_intro && (!e.skills || e.skills.length === 0)) {
            console.log(`Enriching data for ${e.name} using AI...`);
            const structured = await extractDataWithAI({ self_intro: e.self_intro });
            if (structured && !structured.ai_error) {
              Object.assign(e, structured);
              e.updatedAt = new Date().toISOString();
              updated = true;
            }
          }
        }
        if (updated) {
          fs.writeFileSync(DATA_FILE, JSON.stringify(currentEmployees, null, 2));
        }

        generateTeamDoc(currentEmployees, { mode: 'issue' });
        console.log('TEAM.md regenerated and data enriched.');
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
  generateTeamDoc(employees, { mode: 'issue' });
}

// Issue本文のパース
function parseIssueBody(body) {
  const lines = body.split('\n');
  const data = {};
  let currentKey = null;

  const keyMap = {
    'お名前': 'name',
    '職種': 'job',
    'Slack ID': 'slack_id',
    '自己紹介 / キャリア詳細': 'self_intro'
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('### ')) {
      const label = line.replace('### ', '').trim();
      currentKey = keyMap[label];
    } else if (currentKey && line !== '' && line !== '_No response_') {
      data[currentKey] = (data[currentKey] ? data[currentKey] + '\n' : '') + line;
    }
  }
  return data;
}

// Vertex AI REST API を使用して構造化データを抽出
async function extractDataWithAI(rawData) {
  if (!rawData.self_intro) return {};

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY missing');
    return { ai_error: true, ai_error_msg: 'GEMINI_API_KEY missing' };
  }

  const projectId = process.env.GCP_PROJECT_ID;
  const location = process.env.GCP_LOCATION || 'us-central1';
  const modelId = process.env.GCP_MODEL_ID;
  const endpointId = process.env.GCP_ENDPOINT_ID;

  if (!projectId) {
    console.error('GCP_PROJECT_ID missing');
    return { ai_error: true, ai_error_msg: 'GCP_PROJECT_ID missing' };
  }

  // Vertex AI API Endpoint Construction
  let url = "";
  if (endpointId) {
    // ユーザー提供の参考プロジェクトに合わせ、エンドポイント使用時は v1beta1 を採用
    console.log(`Using Vertex AI Endpoint: ${endpointId} (v1beta1)`);
    url = `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/${location}/endpoints/${endpointId}:streamGenerateContent?key=${apiKey}`;
  } else {
    // 従来のモデル指定パターン (v1)
    let modelPath = "";
    const targetModel = modelId || "gemini-1.5-flash-002";
    if (targetModel.startsWith("gemini-")) {
      modelPath = `publishers/google/models/${targetModel}`;
    } else {
      modelPath = `models/${targetModel}`;
    }
    console.log(`Using Vertex AI Model Path: ${modelPath} (v1)`);
    url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/${modelPath}:streamGenerateContent?key=${apiKey}`;
  }

  try {
    const prompt = `
    あなたは人事データの分析官です。社員の自己紹介文から特定の情報を抽出し、JSON形式で出力してください。

    Input Text:
    """
    ${rawData.self_intro}
    """
    
    Output JSON format:
    {
      "skills": ["スキル1", "スキル2"],
      "interests": ["興味1", "興味2"],
      "goal": "キャリア目標（要約）",
      "personality": ["人柄キーワード1", "人柄キーワード2"],
      "job_guess": "Engineer"
    }

    Respond ONLY with valid JSON. Do not include markdown blocks. Do not add trailing commas.
    `;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('API Error:', errorText);
      throw new Error(`API ${response.status}: ${errorText}`);
    }

    const resDataArr = await response.json();
    let text = "";
    if (Array.isArray(resDataArr)) {
      text = resDataArr.map(chunk => chunk.candidates[0].content.parts[0].text).join('');
    } else {
      text = resDataArr.candidates[0].content.parts[0].text;
    }

    console.log('--- Raw AI Response ---');
    console.log(text);
    console.log('-----------------------');

    // 堅牢なJSON抽出処理
    const extractJSON = (str) => {
      const start = str.indexOf('{');
      const end = str.lastIndexOf('}');
      if (start === -1 || end === -1) return {};

      let jsonPart = str.substring(start, end + 1);
      // 文字列内のリテラル改行をスペースに置換
      jsonPart = jsonPart.replace(/\r?\n/g, ' ');
      // 末尾カンマの削除
      jsonPart = jsonPart.replace(/,(\s*[\]\}])/g, '$1');
      // 連続カンマの削除
      jsonPart = jsonPart.replace(/,\s*,/g, ',');

      try {
        return JSON.parse(jsonPart);
      } catch (e) {
        console.warn(`Initial parse failed: ${e.message}. Retrying with aggressive cleanup.`);
        try {
          const aggressive = jsonPart.replace(/[\n\r\t]/g, ' ').trim();
          return JSON.parse(aggressive);
        } catch (e2) {
          throw new Error(`AI JSON parse failed: ${e2.message}\nContent snippet: ${jsonPart.substring(0, 100)}`);
        }
      }
    };

    return extractJSON(text);
  } catch (error) {
    console.error('AI extraction error:', error);
    return { ai_error: true, ai_error_msg: error.message };
  }
}

function parseDeleteIssueBody(body) {
  const lines = body.split('\n');
  const data = {};
  let currentKey = null;
  const keyMap = { '対象社員名': 'name', '処理種別': 'action_type', '理由': 'reason' };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('### ')) {
      currentKey = keyMap[line.replace('### ', '').trim()];
    } else if (currentKey && line !== '' && line !== '_No response_') {
      data[currentKey] = line;
    }
  }
  return data;
}

function updateEmployee(employees, newData) {
  const index = employees.findIndex(e => e.name === newData.name);
  const now = new Date().toISOString();
  if (index !== -1) {
    employees[index] = { ...employees[index], ...newData, updatedAt: now, isActive: true };
  } else {
    employees.push({
      ...newData,
      createdAt: now,
      updatedAt: now,
      isActive: true,
      job: newData.job || newData.job_guess || 'Other'
    });
  }
}

function deleteEmployee(employees, data) {
  const index = employees.findIndex(e => e.name === data.name);
  if (index === -1) return;
  if (data.action_type.includes('Delete')) {
    employees.splice(index, 1);
  } else {
    employees[index].isActive = false;
    employees[index].archivedReason = data.reason;
    employees[index].archivedAt = new Date().toISOString();
  }
}

main().catch(console.error);
