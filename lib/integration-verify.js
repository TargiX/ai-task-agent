export async function verifyIssueIntegrations({ env = process.env, fetchImpl = fetch } = {}) {
  const [github, linear] = await Promise.all([
    verifyGitHubIntegration({ env, fetchImpl }),
    verifyLinearIntegration({ env, fetchImpl }),
  ]);

  const providers = { github, linear };
  return {
    ok: Object.values(providers).some((provider) => provider.status === 'ready'),
    configured: Object.values(providers).filter((provider) => provider.configured).length,
    providers,
  };
}

async function verifyGitHubIntegration({ env, fetchImpl }) {
  const token = env.GITHUB_TOKEN?.trim();
  const repository = env.GITHUB_REPOSITORY?.trim();
  if (!token && !repository) {
    return {
      id: 'github',
      label: 'GitHub Issues',
      status: 'missing',
      configured: false,
      detail: 'GITHUB_TOKEN and GITHUB_REPOSITORY are not configured.',
    };
  }
  if (!token || !repository) {
    return {
      id: 'github',
      label: 'GitHub Issues',
      status: 'misconfigured',
      configured: false,
      detail: 'Set both GITHUB_TOKEN and GITHUB_REPOSITORY.',
    };
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    return {
      id: 'github',
      label: 'GitHub Issues',
      status: 'misconfigured',
      configured: false,
      detail: 'GITHUB_REPOSITORY must use owner/repo format.',
    };
  }

  try {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    });
    const body = await safeJson(response);
    if (!response.ok) {
      return {
        id: 'github',
        label: 'GitHub Issues',
        status: 'failed',
        configured: true,
        detail: body.message || `GitHub repository check failed with HTTP ${response.status}.`,
        evidence: { repository, status: response.status },
      };
    }
    return {
      id: 'github',
      label: 'GitHub Issues',
      status: 'ready',
      configured: true,
      detail: `GitHub repository ${repository} is reachable.`,
      evidence: {
        repository,
        private: Boolean(body.private),
        issues: body.has_issues !== false,
      },
    };
  } catch (error) {
    return {
      id: 'github',
      label: 'GitHub Issues',
      status: 'failed',
      configured: true,
      detail: error.message,
      evidence: { repository },
    };
  }
}

async function verifyLinearIntegration({ env, fetchImpl }) {
  const apiKey = env.LINEAR_API_KEY?.trim();
  const teamId = env.LINEAR_TEAM_ID?.trim();
  if (!apiKey && !teamId) {
    return {
      id: 'linear',
      label: 'Linear',
      status: 'missing',
      configured: false,
      detail: 'LINEAR_API_KEY and LINEAR_TEAM_ID are not configured.',
    };
  }
  if (!apiKey || !teamId) {
    return {
      id: 'linear',
      label: 'Linear',
      status: 'misconfigured',
      configured: false,
      detail: 'Set both LINEAR_API_KEY and LINEAR_TEAM_ID.',
    };
  }

  try {
    const response = await fetchImpl('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        authorization: apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query: 'query Team($id: String!) { team(id: $id) { id key name } }',
        variables: { id: teamId },
      }),
    });
    const body = await safeJson(response);
    const error = body.errors?.[0]?.message;
    if (!response.ok || error || !body.data?.team) {
      return {
        id: 'linear',
        label: 'Linear',
        status: 'failed',
        configured: true,
        detail: error || `Linear team check failed with HTTP ${response.status}.`,
        evidence: { teamId, status: response.status },
      };
    }
    return {
      id: 'linear',
      label: 'Linear',
      status: 'ready',
      configured: true,
      detail: `Linear team ${body.data.team.key || body.data.team.name || teamId} is reachable.`,
      evidence: {
        teamId: body.data.team.id,
        key: body.data.team.key,
        name: body.data.team.name,
      },
    };
  } catch (error) {
    return {
      id: 'linear',
      label: 'Linear',
      status: 'failed',
      configured: true,
      detail: error.message,
      evidence: { teamId },
    };
  }
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}
