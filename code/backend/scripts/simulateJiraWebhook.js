require('dotenv').config();

async function main() {
  const issueKey = process.argv[2] || 'TEST-42';
  const projectKey = process.argv[3] || process.env.JIRA_PROJECT_KEY || 'TEST';
  const status = process.argv[4] || process.env.JIRA_TRIGGER_STATUS || 'Ready for Dev';
  const baseUrl = process.argv[5] || `http://localhost:${process.env.PORT || 3001}`;

  const payload = {
    webhookEvent: 'jira:issue_updated',
    issue: {
      key: issueKey,
      fields: {
        project: { key: projectKey },
        issuetype: { name: 'Story' }
      }
    },
    changelog: {
      items: [
        {
          field: 'status',
          fromString: 'In Progress',
          toString: status
        }
      ]
    }
  };

  try {
    const response = await fetch(`${baseUrl}/api/webhooks/jira`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    console.log(`[simulateJiraWebhook] ${response.status} ${response.statusText}`);
    console.log(text);

    if (!response.ok) {
      process.exit(1);
    }
  } catch (error) {
    console.error('[simulateJiraWebhook] Request failed:', error.message);
    process.exit(1);
  }
}

main();
