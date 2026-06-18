export async function createGitHubIssues(payload, { env = process.env, fetchImpl = fetch } = {}) {
  const repository = env.GITHUB_REPOSITORY;
  if (!env.GITHUB_TOKEN || !repository) return null;

  const results = [];
  for (const issue of payload) {
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${repository}/issues`, {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${env.GITHUB_TOKEN}`,
          'content-type': 'application/json',
          'x-github-api-version': '2022-11-28',
        },
        body: JSON.stringify(issue),
      });
      const body = await safeJson(response);
      if (!response.ok) {
        results.push({ ok: false, title: issue.title, status: response.status, error: body.message || 'GitHub issue creation failed' });
      } else {
        results.push({
          ok: true,
          title: issue.title,
          id: body.id,
          number: body.number,
          url: body.html_url,
        });
      }
    } catch (error) {
      results.push({ ok: false, title: issue.title, status: 'network', error: error.message });
    }
  }
  return results;
}

export async function createLinearIssues(payload, { env = process.env, fetchImpl = fetch } = {}) {
  if (!env.LINEAR_API_KEY || !env.LINEAR_TEAM_ID) return null;

  const results = [];
  const query = `
    mutation IssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier title url }
      }
    }
  `;

  for (const issue of payload) {
    try {
      const response = await fetchImpl('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          authorization: env.LINEAR_API_KEY,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          query,
          variables: {
            input: {
              teamId: env.LINEAR_TEAM_ID,
              title: issue.title,
              description: enrichLinearDescription(issue),
            },
          },
        }),
      });
      const body = await safeJson(response);
      if (!response.ok || body.errors?.length || !body.data?.issueCreate?.success) {
        results.push({
          ok: false,
          title: issue.title,
          status: response.status,
          error: body.errors?.[0]?.message || 'Linear issueCreate failed',
        });
      } else {
        results.push({
          ok: true,
          title: issue.title,
          id: body.data.issueCreate.issue.id,
          identifier: body.data.issueCreate.issue.identifier,
          url: body.data.issueCreate.issue.url,
        });
      }
    } catch (error) {
      results.push({ ok: false, title: issue.title, status: 'network', error: error.message });
    }
  }
  return results;
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function enrichLinearDescription(issue) {
  const details = [];
  if (issue.priority) details.push(`Priority: ${issue.priority}`);
  if (issue.estimate) details.push(`Estimate: ${issue.estimate}`);
  if (issue.labels?.length) details.push(`Labels: ${issue.labels.join(', ')}`);
  if (!details.length) return issue.description;
  return `${issue.description || ''}\n\n${details.join('\n')}`.trim();
}
