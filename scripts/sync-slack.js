const fs = require('fs');
const path = require('path');
require('dotenv').config();

const DATA_FILE = path.join(__dirname, '../data/employees.json');
const TEAM_DOC_FILE = path.join(__dirname, '../docs/TEAM.md');

// Configuration
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || process.env.SLACK_APP_TOKEN;
const CHANNEL_ID = process.env.SLACK_CHANNEL_ID; // Analysis target channel
const PROJECT_ID = process.env.GCP_PROJECT_ID;
const LOCATION = process.env.GCP_LOCATION || 'us-central1';
const API_KEY = process.env.GEMINI_API_KEY;
const ENDPOINT_ID = process.env.GCP_ENDPOINT_ID;

async function main() {
    if (!SLACK_TOKEN || !CHANNEL_ID || !API_KEY || !PROJECT_ID) {
        console.error('Missing required environment variables: SLACK_BOT_TOKEN, SLACK_CHANNEL_ID, GEMINI_API_KEY, GCP_PROJECT_ID');
        process.exit(1);
    }

    if (!fs.existsSync(DATA_FILE)) {
        console.error('Data file not found:', DATA_FILE);
        process.exit(1);
    }

    const employees = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const targetEmployees = employees.filter(e => e.isActive !== false && e.slack_id);

    if (targetEmployees.length === 0) {
        console.log('No active employees with Slack ID found.');
        return;
    }

    console.log(`Fetching messages from channel: ${CHANNEL_ID}...`);
    const messages = await fetchSlackMessages(CHANNEL_ID);
    console.log(`Total messages fetched: ${messages.length}`);

    let updatedCount = 0;

    for (const employee of targetEmployees) {
        console.log(`Analyzing messages for ${employee.name} (${employee.slack_id})...`);

        // Filter messages by this user
        const userMessages = messages
            .filter(m => m.user === employee.slack_id && m.text)
            .map(m => m.text)
            .join('\n');

        if (!userMessages || userMessages.length < 50) {
            console.log(`  Skipping: Not enough message data for ${employee.name}.`);
            continue;
        }

        // AI Enrichment
        const enrichedData = await analyzeSlackActivity(employee.name, userMessages);
        if (enrichedData && !enrichedData.ai_error) {
            // Merge unique skills and interests
            if (enrichedData.skills) {
                employee.skills = [...new Set([...(employee.skills || []), ...enrichedData.skills])].slice(0, 10);
            }
            if (enrichedData.interests) {
                employee.interests = [...new Set([...(employee.interests || []), ...enrichedData.interests])].slice(0, 10);
            }
            if (enrichedData.personality) {
                // Keep unique keywords for personality
                const currentP = Array.isArray(employee.personality) ? employee.personality : (employee.personality ? [employee.personality] : []);
                employee.personality = [...new Set([...currentP, ...enrichedData.personality])].slice(0, 5);
            }

            employee.updatedAt = new Date().toISOString();
            employee.slack_synced_at = employee.updatedAt;
            updatedCount++;
            console.log(`  Success: Updated tags and personality for ${employee.name}.`);
        }
    }

    if (updatedCount > 0) {
        fs.writeFileSync(DATA_FILE, JSON.stringify(employees, null, 2));
        console.log(`Saved ${updatedCount} updates to ${DATA_FILE}.`);

        // Regenerate TEAM.md
        // We can reuse the logic from process-issue.js if we export it, 
        // but for simplicity, we'll just run process-issue.js with a sync flag if possible
        // or just include the generation logic here.
        generateTeamDoc(employees);
    } else {
        console.log('No updates performed.');
    }
}

async function fetchSlackMessages(channelId) {
    // Last 7 days by default
    const oldest = (Date.now() / 1000 - 7 * 24 * 60 * 60).toFixed(0);
    const baseUrl = `https://slack.com/api/conversations.history?channel=${channelId}&oldest=${oldest}&limit=1000`;

    try {
        const response = await fetch(baseUrl, {
            headers: {
                'Authorization': `Bearer ${SLACK_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();
        if (!data.ok) {
            throw new Error(`Slack API Error: ${data.error}`);
        }

        const parentMessages = data.messages || [];
        const allMessages = [...parentMessages];

        // スレッドの取得
        for (const msg of parentMessages) {
            if (msg.thread_ts && msg.reply_count > 0) {
                const replies = await fetchThreadReplies(channelId, msg.thread_ts);
                // 親メッセージはhistoryに含まれているので、2番目以降のメッセージを追加
                allMessages.push(...replies.slice(1));
            }
        }

        return allMessages;
    } catch (error) {
        console.error('Failed to fetch Slack messages:', error);
        return [];
    }
}

async function fetchThreadReplies(channelId, threadTs) {
    const url = `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${threadTs}&limit=1000`;
    try {
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${SLACK_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        const data = await response.json();
        if (!data.ok) {
            console.error(`Thread API Error for ${threadTs}: ${data.error}`);
            return [];
        }
        return data.messages || [];
    } catch (error) {
        console.error(`Failed to fetch thread ${threadTs}:`, error);
        return [];
    }
}

async function analyzeSlackActivity(name, messages) {
    let url = "";
    if (ENDPOINT_ID) {
        url = `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT_ID}/locations/${LOCATION}/endpoints/${ENDPOINT_ID}:streamGenerateContent?key=${API_KEY}`;
    } else {
        url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/gemini-1.5-flash-002:streamGenerateContent?key=${API_KEY}`;
    }

    const prompt = `
    あなたは組織の活性化を支援する分析官です。社員のSlackでの最近の発言から、その人の専門性（スキル）、興味関心、人柄のキーワードを抽出してください。
    既存のプロフィールを補完するための情報です。

    対象社員: ${name}
    発言内容:
    """
    ${messages.substring(0, 10000)}
    """

    以下のJSON形式で出力してください。
    {
      "skills": ["抽出された具体的なスキル・技術"],
      "interests": ["最近興味を持っていそうなトピック"],
      "personality": ["人柄を表すキーワード"]
    }

    Respond ONLY with valid JSON. Do not include markdown blocks. Do not add trailing commas.
  `;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }]
            })
        });

        if (!response.ok) throw new Error(`AI API Error: ${response.status}`);

        const resDataArr = await response.json();
        let text = "";
        if (Array.isArray(resDataArr)) {
            text = resDataArr.map(chunk => chunk.candidates[0].content.parts[0].text).join('');
        } else {
            text = resDataArr.candidates[0].content.parts[0].text;
        }

        return extractJSON(text);
    } catch (error) {
        console.error(`AI analysis failed for ${name}:`, error.message);
        return { ai_error: true };
    }
}

function extractJSON(str) {
    const start = str.indexOf('{');
    const end = str.lastIndexOf('}');
    if (start === -1 || end === -1) return {};

    let jsonPart = str.substring(start, end + 1);
    jsonPart = jsonPart.replace(/\r?\n/g, ' ');
    jsonPart = jsonPart.replace(/,(\s*[\]\}])/g, '$1');
    jsonPart = jsonPart.replace(/,\s*,/g, ',');

    try {
        return JSON.parse(jsonPart);
    } catch (e) {
        return {};
    }
}

// Copy generateTeamDoc from process-issue.js to keep it standalone for now
function generateTeamDoc(employees) {
    const activeEmployees = employees.filter(e => e.isActive !== false);
    const archivedEmployees = employees.filter(e => e.isActive === false);
    const jobs = [...new Set(activeEmployees.map(e => e.job))];

    let md = '# チーム構成図\n\n自動生成された組織図です。IssueおよびSlack連携による更新が反映されます。\n\n';
    md += '```mermaid\n%%{init: {\'theme\': \'base\', \'themeVariables\': {\'primaryColor\': \'#F2EBE3\', \'primaryTextColor\': \'#5D574F\', \'primaryBorderColor\': \'#D9CFC1\', \'lineColor\': \'#BEB3A5\', \'secondaryColor\': \'#FAF9F6\', \'tertiaryColor\': \'#FDFCFB\', \'nodeBorder\': \'1px\'}}}%%\nmindmap\n  root((株式会社Saiteki))\n';

    const jobMap = { 'Engineer': 'Engineer', 'Designer': 'Designer', 'Sales': 'Sales', 'PM': 'PM', 'Corporate': 'Corporate', 'EM': 'Engineer', 'QA': 'QA', 'HR': 'HR', '経営': '経営', 'Executive': '経営', 'Other': 'Other' };

    jobs.forEach(job => {
        md += `    ${jobMap[job] || job || 'Other'}\n`;
        activeEmployees.filter(e => e.job === job).forEach(m => {
            md += `      ${m.name.replace(/[()"']/g, '')}\n`;
        });
    });
    md += '```\n\n## 詳細リスト\n\n| 名前 | 職種 | 得意スキル (Tags) | 興味 (Interests) | 目標 (Goal) | 人柄 (Personality) |\n| --- | --- | --- | --- | --- | --- |\n';

    activeEmployees.forEach(e => {
        const skills = (e.skills && e.skills.length > 0) ? e.skills.join(', ') : (e.like_tech || '-');
        const interests = (e.interests && e.interests.length > 0) ? e.interests.join(', ') : '-';
        const goal = e.goal || (Array.isArray(e.smart_goal) ? e.smart_goal.join(' / ') : e.smart_goal) || '-';
        const personality = Array.isArray(e.personality) ? e.personality.join(', ') : (e.personality || '-');

        md += `| ${e.name} | ${e.job} | ${skills} | ${interests} | ${goal} | ${personality} |\n`;
    });

    if (archivedEmployees.length > 0) {
        md += '\n## Alumni (OB/OG)\n\n| 名前 | 在籍時の職種 | 理由 |\n| --- | --- | --- |\n';
        archivedEmployees.forEach(e => md += `| ${e.name} | ${e.job} | ${e.archivedReason || '-'} |\n`);
    }

    const docDir = path.dirname(TEAM_DOC_FILE);
    if (!fs.existsSync(docDir)) fs.mkdirSync(docDir, { recursive: true });
    fs.writeFileSync(TEAM_DOC_FILE, md);
}

main().catch(console.error);
