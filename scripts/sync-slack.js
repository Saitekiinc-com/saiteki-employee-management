const fs = require('fs');
const path = require('path');
require('dotenv').config();

const DATA_FILE = path.join(__dirname, '../data/employees.json');
const BACKUP_FILE = path.join(__dirname, '../data/employees.backup.json');

// Configuration
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || process.env.SLACK_APP_TOKEN;
// Support multiple channels (comma-separated in SLACK_CHANNEL_ID)
const CHANNEL_IDS = process.env.SLACK_CHANNEL_ID ? process.env.SLACK_CHANNEL_ID.split(',').map(id => id.trim()) : [];
const PROJECT_ID = process.env.GCP_PROJECT_ID;
const LOCATION = process.env.GCP_LOCATION || 'us-central1';
const API_KEY = process.env.GEMINI_API_KEY;
const ENDPOINT_ID = process.env.GCP_ENDPOINT_ID;

// Parse command line arguments
const args = process.argv.slice(2);
const IS_FULL_SYNC = args.includes('--full');

async function main() {
    if (!SLACK_TOKEN || CHANNEL_IDS.length === 0 || !API_KEY || !PROJECT_ID) {
        console.error('Missing required environment variables: SLACK_BOT_TOKEN, SLACK_CHANNEL_ID, GEMINI_API_KEY, GCP_PROJECT_ID');
        process.exit(1);
    }

    if (!fs.existsSync(DATA_FILE)) {
        console.error('Data file not found:', DATA_FILE);
        process.exit(1);
    }

    // Backup existing data
    fs.copyFileSync(DATA_FILE, BACKUP_FILE);
    console.log(`Backed up data to ${BACKUP_FILE}`);

    const employees = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const targetEmployees = employees.filter(e => e.isActive !== false && e.slack_id);

    if (targetEmployees.length === 0) {
        console.log('No active employees with Slack ID found.');
        return;
    }

    console.log(`Starting sync... Full Mode: ${IS_FULL_SYNC}`);
    console.log(`Target Channels: ${CHANNEL_IDS.join(', ')}`);

    // Fetch messages from ALL channels
    let allMessages = [];
    for (const channelId of CHANNEL_IDS) {
        const cid = channelId.trim();
        if (!cid) continue;
        console.log(`Fetching messages from channel: ${cid}...`);
        try {
            const channelMessages = await fetchSlackMessages(cid, IS_FULL_SYNC);
            console.log(`  Fetched ${channelMessages.length} messages from ${cid}`);
            allMessages = allMessages.concat(channelMessages);
        } catch (e) {
            console.error(`  Failed to fetch from ${cid}: ${e.message}`);
        }
    }
    console.log(`Total messages fetched across all channels: ${allMessages.length}`);

    let updatedCount = 0;

    for (const employee of targetEmployees) {
        console.log(`Analyzing messages for ${employee.name} (${employee.slack_id})...`);

        // Filter messages by this user
        const userMessages = allMessages
            .filter(m => m.user === employee.slack_id && m.text)
            .map(m => `[${new Date(m.ts * 1000).toISOString()}] ${m.text}`)
            .join('\n');

        const msgCount = allMessages.filter(m => m.user === employee.slack_id && m.text).length;

        if (!userMessages || userMessages.length < 100) {
            console.log(`  Skipping: Not enough message data for ${employee.name} (${msgCount} messages).`);
            continue;
        }

        console.log(`  Processing ${msgCount} messages for AI analysis...`);

        // AI Enrichment with Advanced Profile Structure
        const enrichedData = await analyzeSlackActivityAdvanced(employee.name, userMessages);

        if (enrichedData && !enrichedData.ai_error) {
            // Remove legacy fields as requested by user
            const legacyFields = [
                'self_intro', 'skills', 'interests', 'goal',
                'personality', 'job_guess', 'like_tech', 'smart_goal',
                'profile_v2' // Remove the nested one
            ];
            legacyFields.forEach(field => delete employee[field]);

            // Map new structure directly to employee object based on the guide
            employee.last_updated = new Date().toISOString();
            employee.overall_summary = enrichedData.overall_summary;
            employee.personality_traits = enrichedData.personality_traits;
            employee.work_styles_and_strengths = enrichedData.work_styles_and_strengths;
            employee.communication_patterns = enrichedData.communication_patterns;
            employee.values_and_motivators = enrichedData.values_and_motivators;
            employee.current_state = enrichedData.current_state;

            employee.updatedAt = employee.last_updated;
            employee.slack_synced_at = employee.last_updated;
            updatedCount++;
            console.log(`  Success: Updated professional profile for ${employee.name}.`);
        }
    }

    if (updatedCount > 0) {
        fs.writeFileSync(DATA_FILE, JSON.stringify(employees, null, 2));
        console.log(`Saved ${updatedCount} profiles to ${DATA_FILE}.`);

        // Regenerate TEAM.md with the new data format
        generateTeamDoc(employees);
    } else {
        console.log('No updates performed.');
    }
}

async function fetchSlackMessages(channelId, isFullSync) {
    const messages = [];
    let hasMore = true;
    let cursor = undefined;

    // Safety limit: if full sync, allow more pages, otherwise just 1-2 pages
    const MAX_PAGES = isFullSync ? 50 : 3;
    let page = 0;

    // For full sync, we go back much further or indefinite execution (be careful of limits)
    // If not full sync, default to 7 days
    const oldest = isFullSync ? 0 : (Date.now() / 1000 - 14 * 24 * 60 * 60).toFixed(0); // Increased to 14 days for better context

    while (hasMore && page < MAX_PAGES) {
        const baseUrl = `https://slack.com/api/conversations.history?channel=${channelId}&limit=200${cursor ? `&cursor=${cursor}` : ''}${oldest ? `&oldest=${oldest}` : ''}`;

        const response = await fetch(baseUrl, {
            headers: {
                'Authorization': `Bearer ${SLACK_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();
        if (!data.ok) {
            console.error(`Slack API Error (Page ${page}): ${data.error}`);
            break;
        }

        const msgs = data.messages || [];
        messages.push(...msgs);

        if (data.response_metadata && data.response_metadata.next_cursor) {
            cursor = data.response_metadata.next_cursor;
            page++;
        } else {
            hasMore = false;
        }

        // Rate limit protection
        await new Promise(r => setTimeout(r, 1200));
    }

    // Now fetch threads
    // To avoid hitting API limits too hard, we recursively fetch threads but with concurrency limits
    // For 'full' mode this could be heavy.

    // Flatten messages to get only those with threads
    const threadParents = messages.filter(m => m.thread_ts && m.reply_count > 0);
    console.log(`    Found ${threadParents.length} threads in fetched messages.`);

    const allMessages = [...messages];

    // Batch thread fetching
    const CHUNK_SIZE = 5;
    for (let i = 0; i < threadParents.length; i += CHUNK_SIZE) {
        const chunk = threadParents.slice(i, i + CHUNK_SIZE);
        await Promise.all(chunk.map(async (parent) => {
            const replies = await fetchThreadReplies(channelId, parent.thread_ts);
            // replies[0] is usually the parent message itself
            allMessages.push(...replies.slice(1));
        }));
        // Small delay between chunks
        await new Promise(r => setTimeout(r, 1000));
    }

    return allMessages;
}

async function fetchThreadReplies(channelId, threadTs) {
    let allReplies = [];
    let hasMore = true;
    let cursor = undefined;
    let page = 0;

    while (hasMore && page < 10) { // Limit thread pagination depth
        const url = `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${threadTs}&limit=200${cursor ? `&cursor=${cursor}` : ''}`;
        try {
            const response = await fetch(url, {
                headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` }
            });
            const data = await response.json();
            if (!data.ok) break;

            allReplies.push(...(data.messages || []));

            if (data.response_metadata && data.response_metadata.next_cursor) {
                cursor = data.response_metadata.next_cursor;
                page++;
            } else {
                hasMore = false;
            }
        } catch (e) {
            console.error(`Thread fetch error: ${e.message}`);
            break;
        }
    }
    return allReplies;
}

async function analyzeSlackActivityAdvanced(name, messages) {
    let url = "";
    if (ENDPOINT_ID) {
        url = `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT_ID}/locations/${LOCATION}/endpoints/${ENDPOINT_ID}:streamGenerateContent?key=${API_KEY}`;
    } else {
        url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/gemini-1.5-pro-002:streamGenerateContent?key=${API_KEY}`;
    }

    // Advanced Profiling Prompt based on User Guide
    const prompt = `
    あなたは組織心理学者兼ベテラン人事分析官です。
    提供されたSlackの発言ログ（タイムスタンプ付き）を徹底的に分析し、対象社員の「人物プロファイル」を作成してください。
    
    ## 分析対象
    名前: ${name}
    ログ:
    """
    ${messages.substring(0, 50000)} 
    """
    (※ログが非常に長い場合は最新または重要度の高いものを優先して分析してください)

    ## 出力フォーマット (JSON)
    以下のJSON構造に厳密に従って出力してください。Markdownブロック(\`\`\`json)は不要です。

    {
      "overall_summary": "人物像の総合サマリー（100文字程度）",
      "personality_traits": {
        "summary": "性格傾向の要約",
        "openness": { "score": 1-10, "evidence": "根拠となる発言や行動" },
        "conscientiousness": { "score": 1-10, "evidence": "..." },
        "extraversion": { "score": 1-10, "evidence": "..." },
        "agreeableness": { "score": 1-10, "evidence": "..." },
        "neuroticism": { "score": 1-10, "evidence": "..." }
      },
      "work_styles_and_strengths": {
        "summary": "仕事の進め方や強みの要約",
        "problem_solving_style": "問題解決時のアプローチ",
        "dominant_strengths": ["強み1", "強み2", "強み3"],
        "evidence_episodes": ["エピソード1", "エピソード2"]
      },
      "communication_patterns": {
        "summary": "コミュニケーション傾向の要約",
        "communication_style": "発言の特徴（論理的、感情的、簡潔など）"
      },
      "values_and_motivators": {
         "summary": "価値観とモチベーションの源泉の要約",
         "core_values": ["大切にしている価値観1", "価値観2"],
         "motivation_triggers": ["やる気が出るきっかけ1", "きっかけ2"],
         "evidence_episodes": ["エピソード1", "エピソード2"]
      },
      "current_state": {
        "summary": "現在の全体的な状況要約",
        "sentiment_level": "positive" | "neutral" | "negative",
        "workload_status": "直近の会話から推測される業務負荷",
        "recent_topics_of_interest": ["最近関心のあるトピック1", "トピック2"]
      }
    }
    
    注意:
    - 配列やオブジェクトの構造を崩さないこと。
    - "current_state"以外は、一時的な感情ではなく、長期的な特性を分析すること。
    - "current_state"は直近（ログの後半）の日付の発言を重視すること。
    `;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generation_config: {
                    response_mime_type: "application/json"
                }
            })
        });

        if (!response.ok) throw new Error(`AI API Error: ${response.status}`);

        const resDataArr = await response.json();
        let text = "";
        if (Array.isArray(resDataArr)) {
            text = resDataArr.map(chunk => chunk?.candidates?.[0]?.content?.parts?.[0]?.text || "").join('');
        } else {
            text = resDataArr?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        }

        return JSON.parse(text);
    } catch (error) {
        console.error(`AI analysis failed for ${name}:`, error.message);
        return { ai_error: true };
    }
}

const TEAM_DOC_FILE = path.join(__dirname, '../docs/TEAM.md');

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
    md += '```\n\n## 詳細リスト\n\n| 名前 | 職種 | 性格傾向 (Personality) | 強み/スタイル (Strengths) | 価値観 (Values) | 最近の状態 (Current) |\n| --- | --- | --- | --- | --- | --- |\n';

    activeEmployees.forEach(e => {
        const personality = e.personality_traits?.summary || '-';
        const strengths = e.work_styles_and_strengths?.summary || '-';
        const values = e.values_and_motivators?.summary || '-';
        const current = e.current_state?.summary || '-';

        md += `| ${e.name} | ${e.job} | ${personality} | ${strengths} | ${values} | ${current} |\n`;
    });

    if (archivedEmployees.length > 0) {
        md += '\n## Alumni (OB/OG)\n\n| 名前 | 在籍時の職種 | 理由 |\n| --- | --- | --- |\n';
        archivedEmployees.forEach(e => md += `| ${e.name} | ${e.job} | ${e.archivedReason || '-'} |\n`);
    }

    const docDir = path.dirname(TEAM_DOC_FILE);
    if (!fs.existsSync(docDir)) fs.mkdirSync(docDir, { recursive: true });
    fs.writeFileSync(TEAM_DOC_FILE, md);
    console.log(`Regenerated ${TEAM_DOC_FILE}`);
}

main().catch(console.error);
