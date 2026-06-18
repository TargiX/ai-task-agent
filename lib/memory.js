export const DEFAULT_KNOWLEDGE_DOCS = [
  {
    id: 'prd-quality',
    title: 'PRD quality bar',
    tags: ['prd', 'goals', 'scope', 'requirements'],
    body:
      'A useful PRD states the user problem, target audience, measurable goals, MVP scope, non-goals, and acceptance signals. Keep product scope concrete enough for engineering planning.',
  },
  {
    id: 'task-breakdown',
    title: 'Engineering task breakdown',
    tags: ['tasks', 'acceptance', 'owners', 'estimates'],
    body:
      'Generated tasks should include owner, priority, effort estimate, and acceptance criteria. A good task is small enough for implementation and clear enough for issue export.',
  },
  {
    id: 'human-approval',
    title: 'Human approval policy',
    tags: ['approval', 'review', 'risk', 'human-in-the-loop'],
    body:
      'External actions such as creating Linear or GitHub issues must wait for human approval. Rejected tasks should remain auditable with reviewer notes.',
  },
  {
    id: 'integration-export',
    title: 'Linear and GitHub export contract',
    tags: ['linear', 'github', 'issues', 'api'],
    body:
      'Issue exports need provider-specific payloads, retries or partial-failure reporting, and enough context to preserve source PRD, priority, labels, and acceptance criteria.',
  },
  {
    id: 'agent-observability',
    title: 'Agent observability',
    tags: ['logs', 'trace', 'tool-calling', 'debugging'],
    body:
      'Agent runs should expose graph state, tool-call logs, validation checks, provider attempts, and pause/resume points so a reviewer can explain the workflow from code and UI.',
  },
  {
    id: 'customer-feedback-domain',
    title: 'Customer feedback SaaS domain pattern',
    tags: ['feedback', 'feature requests', 'clustering', 'planning'],
    body:
      'Feedback portals usually need request intake, duplicate clustering, voting or prioritization, product-manager triage, status visibility, and sync into engineering planning.',
  },
  {
    id: 'analytics-domain',
    title: 'Analytics SaaS domain pattern',
    tags: ['analytics', 'dashboard', 'metrics', 'reporting'],
    body:
      'Analytics products need event collection, metric definitions, dashboard states, permissions, filters, drilldowns, and trust signals around data freshness.',
  },
  {
    id: 'billing-domain',
    title: 'Billing SaaS domain pattern',
    tags: ['billing', 'subscription', 'payments', 'invoices'],
    body:
      'Billing workflows need subscription state, invoices, payment retries, plan changes, entitlements, audit trails, and careful approval gates for revenue-impacting actions.',
  },
];

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'for',
  'in',
  'into',
  'of',
  'or',
  'the',
  'to',
  'with',
  'users',
  'user',
]);

export function retrieveContext(idea, { limit = 4, docs = DEFAULT_KNOWLEDGE_DOCS } = {}) {
  const queryTokens = tokenize(idea);
  const matches = docs
    .map((doc) => {
      const searchable = [doc.title, ...(doc.tags || []), doc.body].join(' ');
      const docTokens = tokenize(searchable);
      const overlap = [...queryTokens].filter((token) => docTokens.has(token));
      const tagHits = (doc.tags || []).filter((tag) => queryTokens.has(normalizeToken(tag))).length;
      const score = overlap.length + tagHits * 2;
      return {
        id: doc.id,
        title: doc.title,
        tags: doc.tags || [],
        excerpt: doc.body,
        score,
      };
    })
    .filter((doc) => doc.score > 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit);

  const fallbacks = docs
    .filter((doc) => ['prd-quality', 'task-breakdown', 'human-approval', 'agent-observability'].includes(doc.id))
    .map((doc) => ({
      id: doc.id,
      title: doc.title,
      tags: doc.tags || [],
      excerpt: doc.body,
      score: 0,
    }));

  return {
    query: idea,
    matches: matches.length ? matches : fallbacks.slice(0, limit),
  };
}

export function formatRetrievedContext(retrieval) {
  return retrieval.matches
    .map((match, index) => `${index + 1}. ${match.title}: ${match.excerpt}`)
    .join('\n');
}

export function contextForPrd(retrieval) {
  return retrieval.matches.map((match) => `${match.title}: ${match.excerpt}`);
}

function tokenize(text) {
  return new Set(
    String(text)
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map(normalizeToken)
      .filter((token) => token.length > 2 && !STOPWORDS.has(token)),
  );
}

function normalizeToken(token) {
  return String(token).toLowerCase().replace(/s$/, '');
}
