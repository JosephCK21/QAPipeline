const path = require('path');
const { backendRoot, loadBackendEnv } = require('./_paths');
loadBackendEnv();
const { fetchIssue } = require(path.join(backendRoot, 'services', 'jiraService'));

async function main() {
  const issueKey = process.argv[2];
  if (!issueKey) {
    console.error('Usage: node code/devscripts/checkJiraApi.js <ISSUE_KEY>');
    process.exit(1);
  }

  try {
    const issue = await fetchIssue(issueKey);
    console.log('Jira API connectivity check: SUCCESS');
    console.log(JSON.stringify({
      key: issue.key,
      issueType: issue.issueType,
      status: issue.status,
      projectKey: issue.projectKey,
      parentKey: issue.parentKey
    }, null, 2));
  } catch (error) {
    console.error('Jira API connectivity check: FAILED');
    console.error(error.response?.data || error.message);
    process.exit(1);
  }
}

main();
