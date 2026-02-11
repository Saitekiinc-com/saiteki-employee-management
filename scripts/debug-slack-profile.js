const https = require('https');
require('dotenv').config();

const token = process.env.SLACK_BOT_TOKEN || process.env.SLACK_APP_TOKEN;
const userId = 'U09MGV3MU9H'; // Sugimoto-san's ID

async function main() {
    if (!token) {
        console.error('No token found');
        return;
    }

    const url = `https://slack.com/api/users.profile.get?user=${userId}&include_labels=true`;

    try {
        console.log(`Fetching profile for ${userId}...`);
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        const result = await response.json();

        if (result.ok) {
            console.log('Profile Data:');
            console.log(JSON.stringify(result.profile, null, 2));
        } else {
            console.error('Error fetching profile:', result.error);
        }

    } catch (error) {
        console.error('Exception:', error);
    }
}

main();
