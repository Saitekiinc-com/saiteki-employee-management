const fs = require('fs');
const path = require('path');
require('dotenv').config();

const DATA_FILE = path.join(__dirname, '../data/employees.json');
const OUT_DIR = path.join(__dirname, '../tmp/slack-all-unregistered-discovery');

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

function isHumanUser(user) {
  if (!user) return false;
  if (user.deleted || user.is_bot || user.is_app_user) return false;
  if (user.id === 'USLACKBOT' || user.name === 'slackbot') return false;
  return true;
}

function displayName(user) {
  return user.profile?.real_name || user.real_name || user.profile?.display_name || user.name || user.id;
}

function iso(ts) {
  const seconds = Number.parseFloat(ts);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function slackGet(method, params, token, attempt = 1) {
  const url = new URL(`https://slack.com/api/${method}`);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  });
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
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
  let cursor;
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

async function fetchThreadReplies(channelId, threadTs, token) {
  const messages = [];
  const errors = [];
  let cursor;
  let page = 0;
  do {
    const data = await slackGet('conversations.replies', { channel: channelId, ts: threadTs, limit: 200, cursor }, token);
    if (!data.ok) {
      errors.push({ method: 'conversations.replies', channel: channelId, thread_ts: threadTs, error: data.error });
      break;
    }
    messages.push(...(data.messages || []));
    cursor = data.response_metadata?.next_cursor || undefined;
    page += 1;
    await sleep(700);
  } while (cursor && page < 10);
  return { messages, errors };
}

async function fetchMessages(channelId, token, oldestTs) {
  const messages = [];
  const errors = [];
  let cursor;
  let page = 0;
  do {
    const data = await slackGet('conversations.history', { channel: channelId, limit: 200, oldest: oldestTs, cursor }, token);
    if (!data.ok) {
      errors.push({ method: 'conversations.history', channel: channelId, error: data.error });
      break;
    }
    messages.push(...(data.messages || []));
    cursor = data.response_metadata?.next_cursor || undefined;
    page += 1;
    await sleep(1200);
  } while (cursor && page < 50);

  const parents = messages.filter((message) => message.thread_ts && message.reply_count > 0);
  for (let i = 0; i < parents.length; i += 5) {
    const results = await Promise.all(parents.slice(i, i + 5).map((parent) => fetchThreadReplies(channelId, parent.thread_ts, token)));
    results.forEach((result) => {
      messages.push(...result.messages.slice(1));
      errors.push(...result.errors);
    });
    await sleep(1000);
  }
  return { messages, errors };
}

async function discoverWorkspace(workspace, employees, oldestTs) {
  if (!workspace.token || workspace.channelIds.length === 0) {
    return { workspace: workspace.key, label: workspace.label, configured: false };
  }

  const registeredIds = new Set(employees.map((employee) => employee[workspace.employeeSlackField]).filter(Boolean));
  const { members, errors } = await listUsers(workspace.token);
  const humanMembers = members.filter(isHumanUser);
  const unregistered = humanMembers.filter((member) => !registeredIds.has(member.id));

  const messages = [];
  for (const channelId of workspace.channelIds) {
    const result = await fetchMessages(channelId, workspace.token, oldestTs);
    result.messages.forEach((message) => messages.push({ ...message, channel_id: channelId }));
    errors.push(...result.errors);
  }

  const byUser = new Map();
  messages.forEach((message) => {
    if (!message.user || !message.text || registeredIds.has(message.user)) return;
    if (!byUser.has(message.user)) byUser.set(message.user, []);
    byUser.get(message.user).push(message);
  });

  const users = unregistered
    .map((member) => {
      const userMessages = byUser.get(member.id) || [];
      userMessages.sort((a, b) => Number.parseFloat(a.ts) - Number.parseFloat(b.ts));
      return {
        user_id: member.id,
        name: displayName(member),
        display_name: member.profile?.display_name || '',
        real_name: member.profile?.real_name || member.real_name || '',
        message_count: userMessages.length,
        first_message_at: iso(userMessages[0]?.ts),
        last_message_at: iso(userMessages[userMessages.length - 1]?.ts)
      };
    })
    .sort((a, b) => b.message_count - a.message_count || a.name.localeCompare(b.name, 'ja'));

  return {
    workspace: workspace.key,
    label: workspace.label,
    configured: true,
    registered_id_count: registeredIds.size,
    human_member_count: humanMembers.length,
    unregistered_human_member_count: unregistered.length,
    unregistered_with_messages_count: users.filter((user) => user.message_count > 0).length,
    unregistered_without_messages_count: users.filter((user) => user.message_count === 0).length,
    errors,
    users
  };
}

async function main() {
  const employees = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const latest = employees.filter((employee) => employee.createdAt).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const oldestIso = latest.createdAt;
  const oldestTs = Math.floor(Date.parse(oldestIso) / 1000).toString();
  const report = {
    generated_at: new Date().toISOString(),
    requested_oldest_iso: oldestIso,
    latest_registered_employee: latest ? { name: latest.name, createdAt: latest.createdAt } : null,
    workspaces: []
  };

  for (const workspace of workspaces) {
    console.log(`Discovering ${workspace.label}...`);
    report.workspaces.push(await discoverWorkspace(workspace, employees, oldestTs));
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'all-unregistered-slack-users.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'summary.md'), report.workspaces.map((workspace) => {
    if (!workspace.configured) return `## ${workspace.label}\nSkipped\n`;
    const lines = [
      `## ${workspace.label}`,
      `Human members: ${workspace.human_member_count}`,
      `Registered IDs: ${workspace.registered_id_count}`,
      `Unregistered users: ${workspace.unregistered_human_member_count}`,
      `With messages: ${workspace.unregistered_with_messages_count}`,
      `Without messages: ${workspace.unregistered_without_messages_count}`,
      '',
      ...workspace.users.map((user) => `- ${user.name} (${user.user_id}): ${user.message_count} messages`)
    ];
    return lines.join('\n');
  }).join('\n\n'));
  console.log(`Wrote discovery report to ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
