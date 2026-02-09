const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../data/employees.json');
const TEMPLATE_FILE = path.join(__dirname, '../.github/ISSUE_TEMPLATE/career_goal.yml');

function sync() {
    if (!fs.existsSync(DATA_FILE)) {
        console.log('Data file not found. Skipping sync.');
        return;
    }
    if (!fs.existsSync(TEMPLATE_FILE)) {
        console.log('Template file not found. Skipping sync.');
        return;
    }

    const employees = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const activeNames = employees
        .filter(e => e.isActive !== false)
        .map(e => e.name)
        .sort();

    if (activeNames.length === 0) {
        activeNames.push("- まだ社員が登録されていません -");
    }

    let templateContent = fs.readFileSync(TEMPLATE_FILE, 'utf8');
    const lines = templateContent.split('\n');
    let newLines = [];
    let inNameSection = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // id: name フィールドを探す
        if (line.trim() === 'id: name') {
            inNameSection = true;
            newLines.push(line);
            continue;
        }

        // nameセクション内の optionsを探す
        if (inNameSection && line.trim().startsWith('options:')) {
            newLines.push(line);

            // 既存のオプションをスキップ
            while (i + 1 < lines.length && (lines[i + 1].trim().startsWith('-') || lines[i + 1].trim() === '')) {
                // 空行や古いオプション行は飛ばす
                i++;
            }

            // 新しい名前リストを追加
            activeNames.forEach(name => {
                newLines.push(`        - ${name}`);
            });

            inNameSection = false; // 処理完了
            continue;
        }

        newLines.push(line);
    }

    fs.writeFileSync(TEMPLATE_FILE, newLines.join('\n'));
    console.log(`Synced ${activeNames.length} names to ${TEMPLATE_FILE}`);
}

sync();
