const fs = require('fs');
const path = require('path');

const TEAM_DOC_FILE = path.join(__dirname, '../../docs/TEAM.md');

const JOB_MAP = {
  Engineer: 'Engineer',
  Designer: 'Designer',
  Sales: 'Sales',
  PM: 'PM',
  Corporate: 'Corporate',
  EM: 'Engineer',
  QA: 'QA',
  HR: 'HR',
  '経営': '経営',
  Executive: '経営',
  Other: 'Other',
};

const MODE_CONFIG = {
  issue: {
    intro: '自動生成された組織図です。Issueによる更新が反映されます。',
    includeRelatedResources: false,
    includeOrgMapHeading: false,
    sectionLabels: {
      personality: '🛠 性格傾向 (Personality Traits)',
      strengths: '💪 仕事スタイルと強み (Work Styles & Strengths)',
      values: '💎 価値観とモチベーター (Values & Motivators)',
      current: '📈 現在の状態 (Current State)',
    },
    traitLabels: {
      openness: '開放性 (Openness)',
      conscientiousness: '誠実性 (Conscientiousness)',
      extraversion: '外向性 (Extraversion)',
      agreeableness: '協調性 (Agreeableness)',
      neuroticism: '神経症的傾向 (Neuroticism)',
    },
    personalitySummaryFallback: employee => employee.personality || '-',
    personalityMissing: employee => `※Slack連携後に詳細な性格分析結果が表示されます。 (暫定性格: ${employee.personality || '-'})\n`,
    strengthsMissing: employee => `※Slack連携後に詳細な強み分析が表示されます。 (既存スキル: ${employee.skills?.join(', ') || '-'})\n`,
    valuesMissing: () => '※Slack連携後に詳細分析が表示されます。\n',
    currentMissing: () => '※Slack連携後に表示されます。\n',
    alumniPrefix: '\n',
  },
  slack: {
    intro: '自動生成された組織図です。IssueおよびSlack連携による高度なAI分析結果が反映されます。',
    includeRelatedResources: true,
    includeOrgMapHeading: true,
    sectionLabels: {
      personality: '🛠 性格傾向',
      strengths: '💪 仕事スタイルと強み',
      values: '💎 価値観とモチベーター',
      current: '📈 現在の状態',
    },
    traitLabels: {
      openness: '開放性',
      conscientiousness: '誠実性',
      extraversion: '外向性',
      agreeableness: '協調性',
      neuroticism: '神経症的傾向',
    },
    personalitySummaryFallback: () => '-',
    personalityMissing: () => 'データなし\n',
    strengthsMissing: () => 'データなし\n',
    valuesMissing: () => 'データなし\n',
    currentMissing: () => 'データなし\n',
    alumniPrefix: '',
    logMessage: outputFile => `Regenerated ${outputFile} with detailed profiles.`,
  },
};

function getConfig(mode = 'slack') {
  return MODE_CONFIG[mode] || MODE_CONFIG.slack;
}

function buildTeamDoc(employees, options = {}) {
  const config = getConfig(options.mode);
  const activeEmployees = employees.filter(employee => employee.isActive !== false);
  const archivedEmployees = employees.filter(employee => employee.isActive === false);
  const jobs = [...new Set(activeEmployees.map(employee => employee.job))];

  let md = '# チーム構成図\n\n';
  md += `${config.intro}\n\n`;

  if (config.includeRelatedResources) {
    md += '### 📊 関連リソース\n';
    md += '- [🌐 インタラクティブ・ナレッジグラフ (Web版)](https://saitekiinc-com.github.io/saiteki-employee-management/)\n';
    md += '- [📝 ナレッジグラフ分析レポート (Markdown)](./KNOWLEDGE_GRAPH.md)\n\n';
  }

  if (config.includeOrgMapHeading) {
    md += '### 組織マップ\n';
  }

  md += '```mermaid\n%%{init: {\'theme\': \'base\', \'themeVariables\': {\'primaryColor\': \'#F2EBE3\', \'primaryTextColor\': \'#5D574F\', \'primaryBorderColor\': \'#D9CFC1\', \'lineColor\': \'#BEB3A5\', \'secondaryColor\': \'#FAF9F6\', \'tertiaryColor\': \'#FDFCFB\', \'nodeBorder\': \'1px\'}}}%%\nmindmap\n  root((株式会社Saiteki))\n';
  jobs.forEach(job => {
    md += `    ${JOB_MAP[job] || job || 'Other'}\n`;
    activeEmployees.filter(employee => employee.job === job).forEach(member => {
      md += `      ${member.name.replace(/[()"']/g, '')}\n`;
    });
  });
  md += '```\n\n';

  md += '## 社員一覧サマリー\n\n| 名前 | 職種 | 性格傾向 (概略) | 現在の状態 |\n| --- | --- | --- | --- |\n';
  activeEmployees.forEach(employee => {
    const personality = employee.personality_traits?.summary || config.personalitySummaryFallback(employee);
    const current = employee.current_state?.summary || '-';
    md += `| [${employee.name}](#${encodeURIComponent(employee.name)}) | ${employee.job} | ${personality} | ${current} |\n`;
  });
  md += '\n---\n\n## 詳細プロフィール\n\n各社員の詳細な分析結果です。クリックして展開できます。\n\n';

  activeEmployees.forEach(employee => {
    md += `<div id="${employee.name}"></div>\n\n`;
    md += `### ${employee.name} (${employee.job})\n\n`;
    md += `> **総合サマリー**: ${employee.overall_summary || '-'}\n\n`;

    md += `<details>\n<summary><b>${config.sectionLabels.personality}</b></summary>\n\n`;
    if (employee.personality_traits) {
      md += `**要約**: ${employee.personality_traits.summary}\n\n`;
      md += '| 項目 | スコア | 根拠・エピソード |\n| --- | --- | --- |\n';
      Object.entries(config.traitLabels).forEach(([traitKey, traitLabel]) => {
        const data = employee.personality_traits[traitKey];
        if (data) {
          const safeEvidence = (data.evidence || '').replace(/\n/g, '<br>');
          md += `| ${traitLabel} | ${data.score}/10 | ${safeEvidence} |\n`;
        }
      });
    } else {
      md += config.personalityMissing(employee);
    }
    md += '\n</details>\n\n';

    md += `<details>\n<summary><b>${config.sectionLabels.strengths}</b></summary>\n\n`;
    if (employee.work_styles_and_strengths) {
      md += `**要約**: ${employee.work_styles_and_strengths.summary}\n\n`;
      md += `**問題解決スタイル**: ${employee.work_styles_and_strengths.problem_solving_style || '-'}\n\n`;
      md += `**主要な強み**: ${employee.work_styles_and_strengths.dominant_strengths?.join(', ') || '-'}\n\n`;
      md += '**証拠エピソード**:\n';
      employee.work_styles_and_strengths.evidence_episodes?.forEach(episode => {
        md += `- ${episode}\n`;
      });
    } else {
      md += config.strengthsMissing(employee);
    }
    md += '\n</details>\n\n';

    md += `<details>\n<summary><b>${config.sectionLabels.values}</b></summary>\n\n`;
    if (employee.values_and_motivators) {
      md += `**要約**: ${employee.values_and_motivators.summary}\n\n`;
      md += `**コアバリュー**: ${employee.values_and_motivators.core_values?.join(', ') || '-'}\n\n`;
      md += `**モチベーショントリガー**: ${employee.values_and_motivators.motivation_triggers?.join(', ') || '-'}\n\n`;
      md += '**証拠エピソード**:\n';
      employee.values_and_motivators.evidence_episodes?.forEach(episode => {
        md += `- ${episode}\n`;
      });
    } else {
      md += config.valuesMissing(employee);
    }
    md += '\n</details>\n\n';

    md += `<details>\n<summary><b>${config.sectionLabels.current}</b></summary>\n\n`;
    if (employee.current_state) {
      md += `**要約**: ${employee.current_state.summary}\n\n`;
      md += `- **感情レベル**: ${employee.current_state.sentiment_level || '-'}\n`;
      md += `- **業務負荷状況**: ${employee.current_state.workload_status || '-'}\n`;
      md += `- **最近の関心トピック**: ${employee.current_state.recent_topics_of_interest?.join(', ') || '-'}\n`;
    } else {
      md += config.currentMissing(employee);
    }
    md += '\n</details>\n\n';

    md += '---\n\n';
  });

  if (archivedEmployees.length > 0) {
    md += `${config.alumniPrefix}## Alumni (OB/OG)\n\n| 名前 | 在籍時の職種 | 理由 |\n| --- | --- | --- |\n`;
    archivedEmployees.forEach(employee => {
      md += `| ${employee.name} | ${employee.job} | ${employee.archivedReason || '-'} |\n`;
    });
  }

  return md;
}

function generateTeamDoc(employees, options = {}) {
  const outputFile = options.outputFile || TEAM_DOC_FILE;
  const md = buildTeamDoc(employees, options);
  const docDir = path.dirname(outputFile);

  if (!fs.existsSync(docDir)) {
    fs.mkdirSync(docDir, { recursive: true });
  }

  fs.writeFileSync(outputFile, md);

  const config = getConfig(options.mode);
  if (config.logMessage) {
    console.log(config.logMessage(outputFile));
  }
}

module.exports = {
  TEAM_DOC_FILE,
  buildTeamDoc,
  generateTeamDoc,
};
