const fs = require('fs');
const path = require('path');
require('dotenv').config();

const DATA_FILE = path.join(__dirname, '../data/employees.json');
const OUT_DIR = path.join(__dirname, '../tmp/slack-unregistered-discovery');

const workspaces = [
  {
    key: 'primary',
    label: 'Primary Workspace',
    token: process.env.SLACK_BOT_TOKEN || process.env.SLACK_APP_TOKEN,
    channelIds: splitIds(process.env.SLACK_CHANNEL_ID),
    employeeSlackField: 'slack_id'
  },
  {
    key: 'secondary',
    label: 'Secondary Workspace',
    token: process.env.SLACK_BOT_TOKEN_2,
    channelIds: splitIds(process.env.SLACK_CHANNEL_ID_2),
    employeeSlackField: 'slack_id_2'
  }
];

function splitIds(value) {
  return value ? value.split(',').map((id) => id.trim()).filter(Boolean) : [];
}

function tsToIso(ts) {
  const seconds = Number.parseFloat(ts);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

function isHumanUser(user) {
  if (!user) return false;
  if (user.deleted || user.is_bot || user.is_app_user) return false;
  if (user.id === 'USLACKBOT' || user.name === 'slackbot') return false;
  return true;
}

function userDisplayName(user) {
  if (!user) return '';
  return user.profile?.real_name || user.real_name || user.profile?.display_name || user.name || user.id;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function slackGet(method, params, token, attempt = 1) {
  const url = new URL(`https://slack.com/api/${method}`);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, value);
    }
  });

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  if (response.status === 429 && attempt <= 3) {
    const retryAfter = Number(response.headers.get('retry-after') || 2);
    await sleep((retryAfter + 1) * 1000);
    return slackGet(method, params, token, attempt + 1);
  }

  return response.json();
}

async function listUsers(token) {
  const members = [];
  const errors = [];
  let cursor = undefined;

  do {
    const data = await slackGet('users.list', { limit: 200, cursor }, token);
    if (!data.ok) {
      errors.push({ method: 'users.list', error: data.error });
      break;
    }
    members.push(...(data.members || []));
    cursor = data.response_metadata?.next_cursor || undefined;
    await sleep(500);
  } while (cursor);

  return { members, errors };
}

async function channelInfo(channelId, token) {
  const data = await slackGet('conversations.info', { channel: channelId }, token);
  if (!data.ok) {
    return { id: channelId, name: channelId, error: data.error };
  }
  return {
    id: channelId,
    name: data.channel?.name || channelId,
    is_private: data.channel?.is_private
  };
}

async function fetchThreadReplies(channelId, threadTs, token) {
  const replies = [];
  const errors = [];
  let cursor = undefined;
  let page = 0;

  do {
    const data = await slackGet('conversations.replies', {
      channel: channelId,
      ts: threadTs,
      limit: 200,
      cursor
    }, token);

    if (!data.ok) {
      errors.push({ method: 'conversations.replies', channel: channelId, thread_ts: threadTs, error: data.error });
      break;
    }

    replies.push(...(data.messages || []));
    cursor = data.response_metadata?.next_cursor || undefined;
    page += 1;
    await sleep(700);
  } while (cursor && page < 10);

  return { replies, errors };
}

async function fetchChannelMessages(channelId, token, oldestTs) {
  const messages = [];
  const errors = [];
  const limitSignals = [];
  let cursor = undefined;
  let page = 0;

  do {
    const data = await slackGet('conversations.history', {
      channel: channelId,
      limit: 200,
      oldest: oldestTs,
      cursor
    }, token);

    if (!data.ok) {
      errors.push({ method: 'conversations.history', channel: channelId, error: data.error });
      break;
    }

    if (data.is_limited) {
      limitSignals.push({ channel: channelId, page, is_limited: true });
    }

    const pageMessages = data.messages || [];
    messages.push(...pageMessages);
    cursor = data.response_metadata?.next_cursor || undefined;
    page += 1;
    await sleep(1200);
  } while (cursor && page < 50);

  const parentThreads = messages.filter((message) => message.thread_ts && message.reply_count > 0);
  for (let index = 0; index < parentThreads.length; index += 5) {
    const chunk = parentThreads.slice(index, index + 5);
    const replyResults = await Promise.all(
      chunk.map((parent) => fetchThreadReplies(channelId, parent.thread_ts, token))
    );
    replyResults.forEach(({ replies, errors: replyErrors }) => {
      messages.push(...replies.slice(1));
      errors.push(...replyErrors);
    });
    await sleep(1000);
  }

  return { messages, errors, limitSignals };
}

function summarizeMessages(messages, channelMap) {
  return messages
    .filter((message) => message.user && message.text)
    .sort((a, b) => Number.parseFloat(a.ts) - Number.parseFloat(b.ts))
    .map((message) => ({
      ts: message.ts,
      iso: tsToIso(message.ts),
      channel_id: message.channel_id,
      channel_name: channelMap.get(message.channel_id)?.name || message.channel_id,
      thread_ts: message.thread_ts,
      text: message.text
    }));
}

async function discoverWorkspace(workspace, employees, oldestTs) {
  if (!workspace.token || workspace.channelIds.length === 0) {
    return {
      workspace: workspace.key,
      label: workspace.label,
      configured: false,
      reason: 'missing token or channels'
    };
  }

  const registeredIds = new Set(
    employees.map((employee) => employee[workspace.employeeSlackField]).filter(Boolean)
  );

  const { members, errors: userErrors } = await listUsers(workspace.token);
  const humanMembers = members.filter(isHumanUser);
  const unregisteredMembers = new Map(
    humanMembers
      .filter((member) => !registeredIds.has(member.id))
      .map((member) => [member.id, member])
  );

  const channelMap = new Map();
  const channelErrors = [];
  for (const channelId of workspace.channelIds) {
    const info = await channelInfo(channelId, workspace.token);
    channelMap.set(channelId, info);
    if (info.error) channelErrors.push({ method: 'conversations.info', channel: channelId, error: info.error });
    await sleep(500);
  }

  const allMessages = [];
  const messageErrors = [];
  const limitSignals = [];
  for (const channelId of workspace.channelIds) {
    const { messages, errors, limitSignals: channelLimitSignals } = await fetchChannelMessages(
      channelId,
      workspace.token,
      oldestTs
    );
    messages.forEach((message) => {
      message.channel_id = channelId;
    });
    allMessages.push(...messages);
    messageErrors.push(...errors);
    limitSignals.push(...channelLimitSignals);
  }

  const messagesByUser = new Map();
  for (const message of allMessages) {
    if (!message.user || registeredIds.has(message.user)) continue;
    if (!messagesByUser.has(message.user)) messagesByUser.set(message.user, []);
    messagesByUser.get(message.user).push(message);
  }

  const posterIds = [...messagesByUser.keys()];
  posterIds.forEach((userId) => {
    if (!unregisteredMembers.has(userId)) {
      unregisteredMembers.set(userId, { id: userId, name: userId, unknown_from_messages: true });
    }
  });

  const candidates = [...unregisteredMembers.values()]
    .map((member) => {
      const messages = messagesByUser.get(member.id) || [];
      const summarizedMessages = summarizeMessages(messages, channelMap);
      return {
        user_id: member.id,
        name: userDisplayName(member),
        display_name: member.profile?.display_name || '',
        real_name: member.profile?.real_name || member.real_name || '',
        team_id: member.team_id,
        source: member.unknown_from_messages ? 'messages' : 'users.list',
        message_count: summarizedMessages.length,
        first_message_at: summarizedMessages[0]?.iso || null,
        last_message_at: summarizedMessages[summarizedMessages.length - 1]?.iso || null,
        channels: [...new Set(summarizedMessages.map((message) => message.channel_name))],
        messages: summarizedMessages
      };
    })
    .filter((candidate) => candidate.message_count > 0)
    .sort((a, b) => b.message_count - a.message_count || a.name.localeCompare(b.name, 'ja'));

  return {
    workspace: workspace.key,
    label: workspace.label,
    configured: true,
    registered_id_count: registeredIds.size,
    human_member_count: humanMembers.length,
    unregistered_human_member_count: unregisteredMembers.size,
    fetched_message_count: allMessages.filter((message) => message.user && message.text).length,
    candidate_count: candidates.length,
    channels: [...channelMap.values()],
    limit_signals: limitSignals,
    errors: [...userErrors, ...channelErrors, ...messageErrors],
    candidates
  };
}

async function main() {
  if (!fs.existsSync(DATA_FILE)) {
    throw new Error(`Data file not found: ${DATA_FILE}`);
  }

  const employees = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const latestEmployee = employees
    .filter((employee) => employee.createdAt)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const requestedOldestIso = process.env.DISCOVERY_OLDEST_ISO || latestEmployee?.createdAt;

  if (!requestedOldestIso) {
    throw new Error('Could not determine discovery start date.');
  }

  const oldestTs = Math.floor(Date.parse(requestedOldestIso) / 1000).toString();
  const workspaceReports = [];

  for (const workspace of workspaces) {
    console.log(`Discovering ${workspace.label}...`);
    workspaceReports.push(await discoverWorkspace(workspace, employees, oldestTs));
  }

  const report = {
    generated_at: new Date().toISOString(),
    requested_oldest_iso: requestedOldestIso,
    requested_oldest_ts: oldestTs,
    latest_registered_employee: latestEmployee
      ? {
          name: latestEmployee.name,
          createdAt: latestEmployee.createdAt,
          slack_id: latestEmployee.slack_id,
          slack_id_2: latestEmployee.slack_id_2
        }
      : null,
    workspaces: workspaceReports
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'unregistered-slack-report.json'), JSON.stringify(report, null, 2));

  const summaryLines = [
    '# Unregistered Slack Discovery',
    '',
    `Generated at: ${report.generated_at}`,
    `Requested oldest: ${report.requested_oldest_iso}`,
    `Latest registered employee: ${report.latest_registered_employee?.name || 'unknown'}`,
    ''
  ];

  for (const workspace of workspaceReports) {
    summaryLines.push(`## ${workspace.label}`);
    if (!workspace.configured) {
      summaryLines.push(`Skipped: ${workspace.reason}`, '');
      continue;
    }
    summaryLines.push(`Fetched messages: ${workspace.fetched_message_count}`);
    summaryLines.push(`Candidate users with messages: ${workspace.candidate_count}`);
    summaryLines.push(`Slack limit signals: ${workspace.limit_signals.length}`);
    summaryLines.push(`Errors: ${workspace.errors.length}`);
    summaryLines.push('');
    workspace.candidates.forEach((candidate) => {
      summaryLines.push(`- ${candidate.name} (${candidate.user_id}): ${candidate.message_count} messages, ${candidate.first_message_at || '-'} to ${candidate.last_message_at || '-'}`);
    });
    summaryLines.push('');
  }

  fs.writeFileSync(path.join(OUT_DIR, 'summary.md'), summaryLines.join('\n'));
  console.log(`Wrote discovery report to ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
