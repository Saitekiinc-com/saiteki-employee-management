const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { mergeSlackMessages, readJsonl, writeJsonl } = require('./build-search-facets');
const { generateTeamDoc } = require('./lib/team-doc');

const DATA_FILE = path.join(__dirname, '../data/employees.json');
const BACKUP_FILE = path.join(__dirname, '../data/employees.backup.json');
const SLACK_MESSAGES_FILE = path.join(__dirname, '../data/slack-messages.jsonl');

// Configuration - Primary Workspace
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || process.env.SLACK_APP_TOKEN;
// Support multiple channels (comma-separated in SLACK_CHANNEL_ID)
const CHANNEL_IDS = process.env.SLACK_CHANNEL_ID ? process.env.SLACK_CHANNEL_ID.split(',').map(id => id.trim()) : [];

// Configuration - Secondary Workspace (optional)
const SLACK_TOKEN_2 = process.env.SLACK_BOT_TOKEN_2;
const CHANNEL_IDS_2 = process.env.SLACK_CHANNEL_ID_2 ? process.env.SLACK_CHANNEL_ID_2.split(',').map(id => id.trim()) : [];

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

    console.log(`Starting sync... Full Mode: ${IS_FULL_SYNC}`);
    console.log(`Target Channels: ${CHANNEL_IDS.join(', ')}`);

    // Fetch messages from ALL channels (Primary Workspace)
    let allMessages = [];
    console.log('--- Primary Workspace ---');
    for (const channelId of CHANNEL_IDS) {
        const cid = channelId.trim();
        if (!cid) continue;
        console.log(`Fetching messages from channel: ${cid}...`);
        try {
            const channelMessages = await fetchSlackMessages(cid, IS_FULL_SYNC, SLACK_TOKEN);
            console.log(`  Fetched ${channelMessages.length} messages from ${cid}`);
            allMessages = allMessages.concat(channelMessages.map(m => ({ ...m, channelId: cid, workspace: 'primary' })));
        } catch (e) {
            console.error(`  Failed to fetch from ${cid}: ${e.message}`);
        }
    }
    console.log(`Primary workspace messages: ${allMessages.length}`);

    // Fetch messages from Secondary Workspace (if configured)
    let allMessages2 = [];
    if (SLACK_TOKEN_2 && CHANNEL_IDS_2.length > 0) {

        console.log('--- Secondary Workspace ---');
        for (const channelId of CHANNEL_IDS_2) {
            const cid = channelId.trim();
            if (!cid) continue;
            console.log(`Fetching messages from channel: ${cid}...`);
            try {
                const channelMessages = await fetchSlackMessages(cid, IS_FULL_SYNC, SLACK_TOKEN_2);
                console.log(`  Fetched ${channelMessages.length} messages from ${cid}`);
                allMessages2 = allMessages2.concat(channelMessages.map(m => ({ ...m, channelId: cid, workspace: 'secondary' })));
            } catch (e) {
                console.error(`  Failed to fetch from ${cid}: ${e.message}`);
            }
        }
        console.log(`Secondary workspace messages: ${allMessages2.length}`);
    } else {
        console.log('Secondary workspace not configured. Skipping.');
    }
    console.log(`Total messages fetched: ${allMessages.length + allMessages2.length}`);

    const existingSlackMessages = readJsonl(SLACK_MESSAGES_FILE);
    const mergedSlackMessages = mergeSlackMessages(existingSlackMessages, [...allMessages, ...allMessages2]);
    writeJsonl(SLACK_MESSAGES_FILE, mergedSlackMessages);
    console.log(`Saved ${mergedSlackMessages.length} normalized Slack messages to ${SLACK_MESSAGES_FILE}.`);

    const discoveredCount = await registerNewPrimaryWorkspaceUsers(employees, allMessages);
    if (discoveredCount > 0) {
        console.log(`Registered ${discoveredCount} newly discovered primary Slack users.`);
    }

    const targetEmployees = employees.filter(e => e.isActive !== false && (e.slack_id || e.slack_id_2));
    if (targetEmployees.length === 0) {
        console.log('No active employees with Slack ID found.');
        return;
    }

    let updatedCount = 0;

    for (const employee of targetEmployees) {
        const ids = [employee.slack_id, employee.slack_id_2].filter(Boolean);
        console.log(`Analyzing messages for ${employee.name} (IDs: ${ids.join(', ')})...`);

        // Filter messages by this user from both workspaces
        const primaryMessages = allMessages
            .filter(m => m.user === employee.slack_id && m.text);
        const secondaryMessages = allMessages2
            .filter(m => employee.slack_id_2 && m.user === employee.slack_id_2 && m.text);
        const combinedMessages = [...primaryMessages, ...secondaryMessages];

        const userMessages = combinedMessages
            .map(m => `[${new Date(m.ts * 1000).toISOString()}] ${m.text}`)
            .join('\n');

        const msgCount = combinedMessages.length;

        if (!userMessages || userMessages.length < 100) {
            console.log(`  Skipping: Not enough message data for ${employee.name} (${msgCount} messages).`);
            continue;
        }

        console.log(`  Processing ${msgCount} messages for AI analysis...`);

        // Build existing profile context for integration
        const existingProfile = employee.overall_summary ? {
            overall_summary: employee.overall_summary,
            personality_traits: employee.personality_traits,
            work_styles_and_strengths: employee.work_styles_and_strengths,
            communication_patterns: employee.communication_patterns,
            values_and_motivators: employee.values_and_motivators,
            current_state: employee.current_state
        } : null;

        // AI Enrichment with Advanced Profile Structure
        const enrichedData = await analyzeSlackActivityAdvanced(employee.name, userMessages, existingProfile);

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

    if (updatedCount > 0 || discoveredCount > 0) {
        fs.writeFileSync(DATA_FILE, JSON.stringify(employees, null, 2));
        console.log(`Saved ${updatedCount} profile updates and ${discoveredCount} new employees to ${DATA_FILE}.`);

        // Regenerate TEAM.md with the new data format
        generateTeamDoc(employees, { mode: 'slack' });
    } else {
        console.log('No updates performed.');
    }
}

async function registerNewPrimaryWorkspaceUsers(employees, messages) {
    const knownSlackIds = new Set(employees.flatMap(e => [e.slack_id, e.slack_id_2]).filter(Boolean));
    const candidateIds = [...new Set(messages
        .filter(m => m.workspace === 'primary' && m.user && !knownSlackIds.has(m.user) && !m.subtype)
        .map(m => m.user))];
    let createdCount = 0;

    for (const userId of candidateIds) {
        const user = await fetchSlackUserInfo(userId, SLACK_TOKEN);
        if (!isEligibleSlackUser(user)) continue;

        const name = user.real_name || user.profile?.real_name || user.profile?.display_name;
        if (!name || employees.some(e => e.name === name)) continue;

        const now = new Date().toISOString();
        employees.push({
            name,
            job: 'Other',
            slack_id: userId,
            isActive: true,
            createdAt: now,
            updatedAt: now,
            last_updated: now,
            overall_summary: '',
            personality_traits: null,
            work_styles_and_strengths: null,
            communication_patterns: null,
            values_and_motivators: null,
            current_state: null
        });
        knownSlackIds.add(userId);
        createdCount++;
    }

    return createdCount;
}

function isEligibleSlackUser(user) {
    return Boolean(user)
        && !user.deleted
        && !user.is_bot
        && !user.is_app_user
        && !user.is_restricted
        && !user.is_ultra_restricted;
}

async function fetchSlackUserInfo(userId, token) {
    const url = `https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`;
    try {
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        if (!data.ok) {
            console.warn(`  Could not fetch Slack user ${userId}: ${data.error}`);
            return null;
        }
        return data.user;
    } catch (error) {
        console.warn(`  Could not fetch Slack user ${userId}: ${error.message}`);
        return null;
    }
}

async function fetchSlackMessages(channelId, isFullSync, token = SLACK_TOKEN) {
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
                'Authorization': `Bearer ${token}`,
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
            const replies = await fetchThreadReplies(channelId, parent.thread_ts, token);
            // replies[0] is usually the parent message itself
            allMessages.push(...replies.slice(1));
        }));
        // Small delay between chunks
        await new Promise(r => setTimeout(r, 1000));
    }

    return allMessages;
}

async function fetchThreadReplies(channelId, threadTs, token = SLACK_TOKEN) {
    let allReplies = [];
    let hasMore = true;
    let cursor = undefined;
    let page = 0;

    while (hasMore && page < 10) { // Limit thread pagination depth
        const url = `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${threadTs}&limit=200${cursor ? `&cursor=${cursor}` : ''}`;
        try {
            const response = await fetch(url, {
                headers: { 'Authorization': `Bearer ${token}` }
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

async function analyzeSlackActivityAdvanced(name, messages, existingProfile = null) {
    let url = "";
    if (ENDPOINT_ID) {
        url = `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT_ID}/locations/${LOCATION}/endpoints/${ENDPOINT_ID}:streamGenerateContent?key=${API_KEY}`;
    } else {
        url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/gemini-1.5-pro-002:streamGenerateContent?key=${API_KEY}`;
    }

    // Build existing profile context section
    let existingProfileSection = '';
    if (existingProfile) {
        existingProfileSection = `
    ## 参考：既存の分析結果
    以下はこの社員の過去の分析結果です。今回の発言ログは全ワークスペースのデータではなく、一部のワークスペースのみの可能性があります。
    既存の分析結果の洞察を尊重しつつ、新しい発言ログの内容と統合して総合的なプロファイルを更新してください。
    既存の分析と新しいデータで矛盾がある場合は、新しいデータを優先しつつ、既存の洞察も考慮してバランスの取れた分析を行ってください。
    """
    ${JSON.stringify(existingProfile, null, 2).substring(0, 10000)}
    """
`;
    }

    // Advanced Profiling Prompt based on User Guide
    const prompt = `
    あなたは組織心理学者兼ベテラン人事分析官です。
    提供されたSlackの発言ログ（タイムスタンプ付き）を徹底的に分析し、対象社員の「人物プロファイル」を作成してください。
    ${existingProfileSection}
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
    - **【重要】根拠(evidence)やエピソード(evidence_episodes)には、[2025-11-13...]のようなタイムスタンプや、<@U...>のようなユーザーIDを直接含めないでください。発言内容のエッセンスのみを自然な文章で記述してください。**
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

main().catch(console.error);
