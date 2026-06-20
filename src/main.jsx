import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  AlertCircle,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Database,
  Download,
  FileText,
  Github,
  GitPullRequest,
  History,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  Loader2,
  MoreHorizontal,
  Play,
  RefreshCw,
  Send,
  Settings,
  Sparkles,
  Workflow,
  X,
} from 'lucide-react';
import './styles.css';

const sampleIdea =
  'A lightweight customer feedback portal for B2B SaaS teams. Users submit feature requests, product managers cluster similar ideas, and approved requests sync into engineering planning.';

const exampleIdeas = [
  {
    label: 'Feedback portal',
    idea: sampleIdea,
  },
  {
    label: 'Billing ops',
    idea: 'A billing operations assistant for SaaS finance teams. It watches failed payments, explains churn risk, drafts customer-safe follow-ups, and creates engineering tasks for payment bugs.',
  },
  {
    label: 'Analytics review',
    idea: 'An analytics review workspace where product teams inspect dashboard anomalies, define metric changes, and export approved investigation tasks to engineering.',
  },
];

const runArtifacts = [
  {
    label: 'PRD',
    detail: 'Problem, audience, goals, MVP scope',
  },
  {
    label: 'Review queue',
    detail: 'Editable tasks with owner, priority, estimate',
  },
  {
    label: 'Issue package',
    detail: 'Linear/GitHub payload after approval',
  },
];

const productSteps = [
  {
    label: 'Idea',
    title: 'Write the product shape',
    detail: 'Start from a SaaS idea, customer workflow, internal tool, or feature request backlog.',
  },
  {
    label: 'Agent',
    title: 'Generate PRD and tasks',
    detail: 'The planner creates a PRD, five normalized tasks, and a traceable tool-call log.',
  },
  {
    label: 'Review',
    title: 'Approve the queue',
    detail: 'Edit owner, priority, estimate, and acceptance criteria before anything leaves the workspace.',
  },
  {
    label: 'Export',
    title: 'Package or create issues',
    detail: 'Public demo prepares safe payloads; guarded private mode can create Linear or GitHub issues.',
  },
];

const navItems = [
  { label: 'Workspace', icon: LayoutDashboard, target: '#workspace', active: true },
  { label: 'Runs', icon: History, target: '#runs' },
  { label: 'Review', icon: ListChecks, target: '#task-db' },
  { label: 'Exports', icon: Send, target: '#exports' },
  { label: 'Diagnostics', icon: Workflow, target: '#diagnostics' },
];

const skillStack = [
  'Graph runtime',
  'FastAPI/LangGraph adapter',
  'Tool calling',
  'Schema validation',
  'Human interrupt',
  'Supabase-ready state',
  'Linear/GitHub export',
];
const workspaceStorageKey = 'ai-task-agent.workspaceId';
const accessTokenStorageKey = 'ai-task-agent.accessToken';
const enteredAppStorageKey = 'ai-task-agent.enteredApp';

function emptyWorkspace() {
  return {
    idea: '',
    prd: null,
    tasks: [],
    logs: [],
    exports: [],
    graph: [],
    runHistory: [],
    workspace: {
      id: 'default',
      label: 'default',
    },
    provider: {
      ai: 'local-planner',
      storage: 'json',
      linear: 'not-configured',
      github: 'not-configured',
      access: 'demo-open',
    },
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...workspaceHeader(),
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Request failed');
  return body;
}

function workspaceHeader() {
  return {
    'x-ai-task-agent-workspace': currentWorkspaceKey(),
    ...accessTokenHeader(),
  };
}

function accessTokenHeader() {
  const token = currentAccessToken();
  return token ? { 'x-ai-task-agent-access-token': token } : {};
}

function currentWorkspaceKey() {
  if (typeof localStorage === 'undefined') return 'default';
  const stored = localStorage.getItem(workspaceStorageKey);
  if (stored) return normalizeClientWorkspaceKey(stored);
  const generated = createGuestWorkspaceKey();
  localStorage.setItem(workspaceStorageKey, generated);
  return generated;
}

function currentAccessToken() {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem(accessTokenStorageKey)?.trim() || '';
}

function normalizeClientWorkspaceKey(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || 'default';
}

function createGuestWorkspaceKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `guest-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `guest-${Math.random().toString(36).slice(2, 10)}`;
}

async function readSse(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';
    for (const block of blocks) {
      const event = parseSseBlock(block);
      if (event) await onEvent(event);
    }
  }

  const trailing = parseSseBlock(buffer);
  if (trailing) await onEvent(trailing);
}

function parseSseBlock(block) {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data) return null;
  return JSON.parse(data);
}

function App() {
  const [enteredApp, setEnteredApp] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.location.hash === '#app' || localStorage.getItem(enteredAppStorageKey) === '1';
  });

  function enterDemo() {
    localStorage.setItem(enteredAppStorageKey, '1');
    if (window.location.hash !== '#app') window.history.replaceState(null, '', '#app');
    setEnteredApp(true);
  }

  if (!enteredApp) return <LandingPage onEnter={enterDemo} />;
  return <WorkspaceApp />;
}

function LandingPage({ onEnter }) {
  return (
    <main className="nova-landing-shell">
      <header className="nova-landing-nav">
        <div className="nova-brand">
          <span className="nova-brand-mark">
            <Bot />
          </span>
          <div>
            <strong>AI Task Agent</strong>
            <span>Product ops copilot</span>
          </div>
        </div>
        <Button onClick={onEnter}>
          <Play data-icon="inline-start" />
          Open demo workspace
        </Button>
      </header>

      <section className="nova-landing-hero">
        <div className="nova-landing-copy">
          <h1>Turn a SaaS product idea into an approved engineering issue package.</h1>
          <p>
            AI Task Agent creates a PRD, breaks it into reviewable tasks, waits for human approval,
            then prepares Linear or GitHub issue payloads. Public demo mode is safe; private team mode can create real issues.
          </p>
          <div className="nova-landing-actions">
            <Button onClick={onEnter}>
              <Play data-icon="inline-start" />
              Try the live demo
            </Button>
            <Button variant="secondary" onClick={onEnter}>
              Use example idea
            </Button>
          </div>
        </div>
        <div className="nova-landing-preview" aria-label="Product workflow preview">
          <div className="nova-landing-preview-head">
            <span>Live workflow</span>
            <ToneBadge tone="success">OpenRouter + D1</ToneBadge>
          </div>
          <div className="nova-landing-flow">
            {productSteps.map((step, index) => (
              <div key={step.label} className="nova-landing-step">
                <span>{String(index + 1).padStart(2, '0')}</span>
                <strong>{step.title}</strong>
                <p>{step.detail}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="nova-landing-proof">
        <div>
          <strong>Guest workspaces</strong>
          <p>Each visitor gets an isolated guest workspace, so old runs never bleed into a new demo.</p>
        </div>
        <div>
          <strong>Human approval gate</strong>
          <p>Tasks must be edited, approved, or rejected before export is unlocked.</p>
        </div>
        <div>
          <strong>Private issue creation</strong>
          <p>Team tokens unlock guarded workspaces for real Linear/GitHub issue creation.</p>
        </div>
      </section>
    </main>
  );
}

function WorkspaceApp() {
  const [idea, setIdea] = useState(sampleIdea);
  const [workspace, setWorkspace] = useState(emptyWorkspace);
  const [exportTarget, setExportTarget] = useState('Linear');
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [taskDraft, setTaskDraft] = useState(null);
  const [freeModels, setFreeModels] = useState([]);
  const [preflight, setPreflight] = useState(null);
  const [exportPackage, setExportPackage] = useState(null);
  const [packageFormat, setPackageFormat] = useState('json');
  const [setupVerification, setSetupVerification] = useState(null);
  const [integrationVerification, setIntegrationVerification] = useState(null);
  const [teamConfig, setTeamConfig] = useState(null);
  const [demoReport, setDemoReport] = useState(null);
  const [streamStatus, setStreamStatus] = useState('');
  const [busyAction, setBusyAction] = useState('loading');
  const [error, setError] = useState('');
  const [workspaceKey, setWorkspaceKey] = useState(currentWorkspaceKey());
  const [workspaceDraft, setWorkspaceDraft] = useState(currentWorkspaceKey());
  const [accessTokenDraft, setAccessTokenDraft] = useState(currentAccessToken());
  const [privateWorkspaceDraft, setPrivateWorkspaceDraft] = useState('');
  const [privateTokenDraft, setPrivateTokenDraft] = useState('');

  const { prd, tasks, logs, exports, provider, graph, runHistory = [] } = workspace;

  useEffect(() => {
    refreshWorkspace();
    refreshFreeModels();
    refreshPreflight();
    refreshIntegrationVerification();
    refreshTeamConfig();
  }, []);

  const counts = useMemo(() => {
    const approved = tasks.filter((task) => task.status === 'approved').length;
    const rejected = tasks.filter((task) => task.status === 'rejected').length;
    return {
      approved,
      rejected,
      pending: tasks.length - approved - rejected,
      total: tasks.length,
    };
  }, [tasks]);

  const selectedTask = tasks.find((task) => task.id === selectedTaskId) || tasks[0];
  const latestExport = exports[0];
  const visiblePayload =
    latestExport?.target === exportTarget
      ? latestExport.payload
      : buildPreviewPayload(exportTarget, prd, tasks);
  const canExport = counts.approved > 0 && !['agent', 'export', 'package'].includes(busyAction);
  const activeExportPackage =
    exportPackage?.target === exportTarget && exportPackage?.runId === workspace.runId ? exportPackage : null;
  const workflowSteps = useMemo(
    () =>
      buildWorkflowSteps({
        idea,
        prd,
        counts,
        exports,
        busyAction,
      }),
    [idea, prd, counts, exports, busyAction]
  );

  useEffect(() => {
    if (!selectedTask) {
      setTaskDraft(null);
      return;
    }
    setTaskDraft({
      title: selectedTask.title || '',
      owner: selectedTask.owner || '',
      priority: selectedTask.priority || 'Medium',
      effort: selectedTask.effort || '',
      acceptance: selectedTask.acceptance || '',
      reviewNote: selectedTask.reviewNote || '',
    });
  }, [selectedTask?.id]);

  useEffect(() => {
    setExportPackage(null);
  }, [exportTarget, workspace.runId, counts.approved, counts.rejected, counts.total, exports.length]);

  async function refreshWorkspace() {
    setBusyAction('loading');
    setError('');
    try {
      const nextWorkspace = await api('/api/workspace');
      setWorkspace(nextWorkspace);
      if (nextWorkspace.idea) setIdea(nextWorkspace.idea);
      setSelectedTaskId(nextWorkspace.tasks[0]?.id || null);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyAction('');
    }
  }

  async function switchWorkspace() {
    const nextKey = normalizeClientWorkspaceKey(workspaceDraft);
    localStorage.setItem(workspaceStorageKey, nextKey);
    setWorkspaceKey(nextKey);
    setWorkspaceDraft(nextKey);
    setWorkspace(emptyWorkspace());
    setSelectedTaskId(null);
    setExportPackage(null);
    setSetupVerification(null);
    setIntegrationVerification(null);
    await refreshWorkspace();
    await refreshIntegrationVerification();
  }

  async function saveAccessToken() {
    const token = accessTokenDraft.trim();
    if (token) {
      localStorage.setItem(accessTokenStorageKey, token);
    } else {
      localStorage.removeItem(accessTokenStorageKey);
    }
    setExportPackage(null);
    setSetupVerification(null);
    setIntegrationVerification(null);
    await refreshWorkspace();
    await refreshIntegrationVerification();
  }

  async function refreshFreeModels() {
    try {
      const data = await api('/api/llm/free-models');
      setFreeModels(data.models || []);
    } catch {
      setFreeModels([]);
    }
  }

  async function refreshPreflight() {
    try {
      setPreflight(await api('/api/preflight'));
    } catch {
      setPreflight(null);
    }
  }

  async function refreshIntegrationVerification() {
    try {
      setIntegrationVerification(await api('/api/integrations/verify'));
    } catch {
      setIntegrationVerification(null);
    }
  }

  async function refreshTeamConfig() {
    try {
      setTeamConfig(await api('/api/team/workspaces'));
    } catch {
      setTeamConfig(null);
    }
  }

  async function openPrivateWorkspace() {
    const workspaceId = normalizeClientWorkspaceKey(privateWorkspaceDraft || workspaceDraft);
    const token = privateTokenDraft.trim();
    if (!workspaceId || !token) {
      setError('Enter a private workspace key and team token.');
      return;
    }
    setBusyAction('team-session');
    setError('');
    try {
      const session = await api('/api/team/session', {
        method: 'POST',
        body: JSON.stringify({ workspaceId, token }),
      });
      localStorage.setItem(workspaceStorageKey, session.workspace.id);
      localStorage.setItem(accessTokenStorageKey, token);
      setWorkspaceKey(session.workspace.id);
      setWorkspaceDraft(session.workspace.id);
      setAccessTokenDraft(token);
      setPrivateWorkspaceDraft('');
      setPrivateTokenDraft('');
      setWorkspace(emptyWorkspace());
      setSelectedTaskId(null);
      setExportPackage(null);
      await refreshWorkspace();
      await refreshIntegrationVerification();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyAction('');
    }
  }

  async function verifyIntegrations() {
    setBusyAction('verify-integrations');
    setError('');
    try {
      setIntegrationVerification(await api('/api/integrations/verify'));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyAction('');
    }
  }

  async function verifySetup() {
    setBusyAction('verify-setup');
    setError('');
    try {
      setSetupVerification(await api('/api/setup/verify'));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyAction('');
    }
  }

  async function runDemoReport() {
    setBusyAction('demo-report');
    setError('');
    try {
      setDemoReport(await api('/api/demo/report'));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyAction('');
    }
  }

  async function runAgent() {
    setBusyAction('agent');
    setError('');
    setStreamStatus('Opening live agent stream');
    setWorkspace((current) => ({
      ...emptyWorkspace(),
      idea,
      graph: fallbackGraph(),
      logs: [],
      runHistory: current.runHistory || [],
      provider: current.provider,
    }));
    try {
      const streamed = await runAgentStream();
      if (!streamed) {
        setStreamStatus('Stream unavailable; using JSON fallback');
        const nextWorkspace = await api('/api/agent/run', {
          method: 'POST',
          body: JSON.stringify({ idea }),
        });
        setWorkspace(nextWorkspace);
        setSelectedTaskId(nextWorkspace.tasks[0]?.id || null);
      }
    } catch (requestError) {
      try {
        setStreamStatus('Stream failed; using JSON fallback');
        const nextWorkspace = await api('/api/agent/run', {
          method: 'POST',
          body: JSON.stringify({ idea }),
        });
        setWorkspace(nextWorkspace);
        setSelectedTaskId(nextWorkspace.tasks[0]?.id || null);
      } catch (fallbackError) {
        setError(fallbackError.message || requestError.message);
      }
    } finally {
      setStreamStatus('');
      setBusyAction('');
    }
  }

  async function runAgentStream() {
    const response = await fetch('/api/agent/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...workspaceHeader() },
      body: JSON.stringify({ idea }),
    });
    if (!response.ok || !response.body) return false;

    let completedWorkspace = null;
    await readSse(response, async (event) => {
      if (event.type === 'error') throw new Error(event.message || 'Agent stream failed');
      if (event.message) setStreamStatus(event.message);
      setWorkspace((current) => {
        if (event.type === 'complete' && event.workspace) return event.workspace;
        const next = { ...current };
        if (event.graph) next.graph = event.graph;
        if (event.log) next.logs = [...(next.logs || []), event.log];
        return next;
      });
      if (event.type === 'complete' && event.workspace) {
        completedWorkspace = event.workspace;
        setSelectedTaskId(event.workspace.tasks[0]?.id || null);
      }
    });

    return Boolean(completedWorkspace);
  }

  async function patchTask(id, patch) {
    setBusyAction(id);
    setError('');
    try {
      const nextWorkspace = await api(`/api/tasks/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      setWorkspace(nextWorkspace);
      setSelectedTaskId(id);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyAction('');
    }
  }

  async function updateTaskStatus(id, status, reviewNote = '') {
    await patchTask(id, { status, reviewNote });
  }

  async function updateTaskBatch(status) {
    const taskIds = tasks.filter((task) => task.status === 'pending').map((task) => task.id);
    if (!taskIds.length) return;
    setBusyAction(`batch-${status}`);
    setError('');
    try {
      const nextWorkspace = await api('/api/tasks/batch', {
        method: 'PATCH',
        body: JSON.stringify({
          taskIds,
          status,
          reviewNote:
            status === 'approved'
              ? 'Bulk approved from the task review queue.'
              : 'Bulk rejected from the task review queue.',
        }),
      });
      setWorkspace(nextWorkspace);
      setSelectedTaskId(nextWorkspace.tasks.find((task) => taskIds.includes(task.id))?.id || null);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyAction('');
    }
  }

  async function saveSelectedTask() {
    if (!selectedTask || !taskDraft) return;
    await patchTask(selectedTask.id, taskDraft);
  }

  async function resetWorkspace() {
    setBusyAction('reset');
    setError('');
    try {
      const nextWorkspace = await api('/api/workspace', { method: 'DELETE' });
      setWorkspace(nextWorkspace);
      setIdea(sampleIdea);
      setSelectedTaskId(null);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyAction('');
    }
  }

  function loadExampleIdea(nextIdea) {
    setIdea(nextIdea);
  }

  async function selectRun(runId) {
    setBusyAction(`run-${runId}`);
    setError('');
    try {
      const nextWorkspace = await api('/api/runs/select', {
        method: 'POST',
        body: JSON.stringify({ runId }),
      });
      setWorkspace(nextWorkspace);
      if (nextWorkspace.idea) setIdea(nextWorkspace.idea);
      setSelectedTaskId(nextWorkspace.tasks[0]?.id || null);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyAction('');
    }
  }

  async function exportIssues() {
    setBusyAction('export');
    setError('');
    try {
      const nextWorkspace = await api('/api/export', {
        method: 'POST',
        body: JSON.stringify({ target: exportTarget }),
      });
      setWorkspace(nextWorkspace);
      setExportPackage(null);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyAction('');
    }
  }

  async function prepareExportPackage() {
    setBusyAction('package');
    setError('');
    try {
      setExportPackage(await api(`/api/export-package?target=${encodeURIComponent(exportTarget)}`));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyAction('');
    }
  }

  function downloadExportPackage(format) {
    if (!activeExportPackage) return;
    const extension = format === 'markdown' ? 'md' : 'json';
    const content =
      format === 'markdown'
        ? activeExportPackage.markdown
        : JSON.stringify(activeExportPackage.payload, null, 2);
    const blob = new Blob([content], { type: format === 'markdown' ? 'text/markdown' : 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${exportTarget.toLowerCase()}-issue-package.${extension}`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <TooltipProvider>
      <main className="nova-shell">
        <aside className="nova-sidebar" aria-label="Primary">
          <div className="nova-brand">
            <span className="nova-brand-mark">
              <Bot />
            </span>
            <div>
              <strong>AI Task Agent</strong>
              <span>Product ops copilot</span>
            </div>
          </div>

          <nav className="nova-nav">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <Button
                  key={item.label}
                  variant={item.active ? 'secondary' : 'ghost'}
                  className="nova-nav-item"
                  onClick={() => document.querySelector(item.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                >
                  <Icon data-icon="inline-start" />
                  {item.label}
                </Button>
              );
            })}
          </nav>
        </aside>

        <section className="nova-main">
          <header className="nova-topbar">
            <div className="nova-title">
              <div className="nova-kicker">
                Ideas
                <span>/</span>
                <strong>{prd ? 'Run active' : 'Draft'}</strong>
              </div>
              <h1>{prd ? prd.title : 'Product idea workspace'}</h1>
            </div>
            <div className="nova-command-bar">
              <FieldGroup className="nova-workspace-fields">
                <Field>
                  <FieldLabel htmlFor="workspace-key">Workspace</FieldLabel>
                  <Input
                    id="workspace-key"
                    value={workspaceDraft}
                    onChange={(event) => setWorkspaceDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') switchWorkspace();
                    }}
                    aria-label="Workspace key"
                  />
                </Field>
                {(provider.access === 'guarded' || accessTokenDraft) && (
                  <Field>
                    <FieldLabel htmlFor="workspace-token">Access token</FieldLabel>
                    <Input
                      id="workspace-token"
                      type="password"
                      value={accessTokenDraft}
                      onChange={(event) => setAccessTokenDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') saveAccessToken();
                      }}
                      placeholder="Paste token"
                      aria-label="Workspace access token"
                    />
                  </Field>
                )}
              </FieldGroup>
              <Button
                variant={workspaceKey === normalizeClientWorkspaceKey(workspaceDraft) ? 'outline' : 'secondary'}
                onClick={switchWorkspace}
                disabled={busyAction === 'loading'}
              >
                <RefreshCw data-icon="inline-start" />
                Switch
              </Button>
              {(provider.access === 'guarded' || accessTokenDraft) && (
                <Button variant="outline" onClick={saveAccessToken} disabled={busyAction === 'loading'}>
                  <Check data-icon="inline-start" />
                  Token
                </Button>
              )}
              <Button variant="outline" onClick={resetWorkspace} disabled={busyAction === 'reset'}>
                {busyAction === 'reset' ? (
                  <Loader2 className="spin" data-icon="inline-start" />
                ) : (
                  <RefreshCw data-icon="inline-start" />
                )}
                Reset
              </Button>
              <Button onClick={runAgent} disabled={busyAction === 'agent'}>
                {busyAction === 'agent' ? (
                  <Loader2 className="spin" data-icon="inline-start" />
                ) : (
                  <Play data-icon="inline-start" />
                )}
                Run agent
              </Button>
            </div>
          </header>

          {error && (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <section className="nova-status-grid">
            <MetricCard label="Total tasks" value={counts.total} />
            <MetricCard label="Approved" value={counts.approved} />
            <MetricCard label="Pending" value={counts.pending} />
            <MetricCard label="Runs" value={runHistory.length} />
          </section>
          <RuntimeStrip workspace={workspace.workspace?.label || workspaceKey} provider={provider} />
          <WorkflowOverview steps={workflowSteps} />

          <div className="nova-scroll-region">
            <div className="nova-workspace" id="workspace">
            <section className="nova-left">
              <Card className="nova-idea-card" size="sm">
                <CardHeader>
                  <CardTitle>Start a run</CardTitle>
                  <CardAction>
                    <Sparkles className="nova-card-icon" />
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <FieldGroup className="nova-form-stack">
                    <Field>
                      <FieldLabel htmlFor="product-idea">Product idea</FieldLabel>
                      <Textarea
                        id="product-idea"
                        value={idea}
                        onChange={(event) => setIdea(event.target.value)}
                        aria-label="Product idea"
                        className="min-h-36 resize-y"
                      />
                    </Field>
                    <div className="nova-example-grid" aria-label="Example product ideas">
                      {exampleIdeas.map((example) => (
                        <Button
                          key={example.label}
                          type="button"
                          variant={idea === example.idea ? 'secondary' : 'outline'}
                          size="sm"
                          onClick={() => loadExampleIdea(example.idea)}
                        >
                          {example.label}
                        </Button>
                      ))}
                    </div>
                    <div className="nova-run-artifacts">
                      {runArtifacts.map((artifact) => (
                        <div key={artifact.label}>
                          <strong>{artifact.label}</strong>
                          <span>{artifact.detail}</span>
                        </div>
                      ))}
                    </div>
                    <Button onClick={runAgent} disabled={busyAction === 'agent' || !idea.trim()}>
                      {busyAction === 'agent' ? (
                        <Loader2 className="spin" data-icon="inline-start" />
                      ) : (
                        <Play data-icon="inline-start" />
                      )}
                      Generate PRD and tasks
                    </Button>
                    <p className="nova-provider-line">
                      {busyAction === 'agent' && streamStatus
                        ? `Live stream: ${streamStatus}`
                        : freeModels[0]
                        ? `Best ${freeModels[0].source || 'free'} model: ${freeModels[0].name || freeModels[0].id}`
                        : `Provider chain: ${provider.ai}`}
                    </p>
                  </FieldGroup>
                </CardContent>
              </Card>

              <RunHistoryPanel
                runs={runHistory}
                activeRunId={workspace.runId}
                provider={provider}
                storageDetail={preflight?.checks?.find((check) => check.id === 'storage')?.detail}
                busyAction={busyAction}
                selectRun={selectRun}
              />
              <Card className="nova-access-card" size="sm" id="private-access">
                <CardHeader>
                  <CardTitle>Private workspace</CardTitle>
                  <CardAction>
                    <KeyRound className="nova-card-icon" />
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <PrivateAccessPanel
                    teamConfig={teamConfig}
                    privateWorkspaceDraft={privateWorkspaceDraft}
                    privateTokenDraft={privateTokenDraft}
                    setPrivateWorkspaceDraft={setPrivateWorkspaceDraft}
                    setPrivateTokenDraft={setPrivateTokenDraft}
                    busyAction={busyAction}
                    openPrivateWorkspace={openPrivateWorkspace}
                    compact
                  />
                </CardContent>
              </Card>
            </section>

            <section className="nova-center">
              <Tabs defaultValue="tasks" className="nova-tabs">
                <Card className="nova-workflow-card" size="sm">
                  <CardHeader className="nova-workflow-header" inset>
                    <div>
                      <CardTitle>Run workspace</CardTitle>
                      <CardDescription>
                        {prd ? 'Review generated planning output, then approve tasks for export.' : 'Generate a PRD and task queue from the product idea.'}
                      </CardDescription>
                    </div>
                    <CardAction>
                      <TabsList variant="line" className="nova-card-tabs">
                        <TabsTrigger value="tasks">
                          <ListChecks data-icon="inline-start" />
                          Tasks
                        </TabsTrigger>
                        <TabsTrigger value="prd">
                          <FileText data-icon="inline-start" />
                          PRD
                        </TabsTrigger>
                        <TabsTrigger value="logs">
                          <Workflow data-icon="inline-start" />
                          Trace
                        </TabsTrigger>
                      </TabsList>
                    </CardAction>
                  </CardHeader>
                  <CardContent>
                    <TabsContent value="tasks" id="task-db">
                      <TaskList
                        tasks={tasks}
                        selectedTask={selectedTask}
                        busyAction={busyAction}
                        setSelectedTaskId={setSelectedTaskId}
                        updateTaskStatus={updateTaskStatus}
                        updateTaskBatch={updateTaskBatch}
                      />
                    </TabsContent>

                    <TabsContent value="prd">
                      {prd ? <PrdView prd={prd} /> : <BlankState title="No PRD yet" />}
                    </TabsContent>

                    <TabsContent value="logs">
                      <TraceLogPanel graph={graph} logs={logs} />
                    </TabsContent>
                  </CardContent>
                </Card>
              </Tabs>
            </section>

            <aside className="nova-right">
              <Inspector
                selectedTask={selectedTask}
                taskDraft={taskDraft}
                setTaskDraft={setTaskDraft}
                busyAction={busyAction}
                saveSelectedTask={saveSelectedTask}
                updateTaskStatus={updateTaskStatus}
              />
              <ExportPanel
                exportTarget={exportTarget}
                setExportTarget={setExportTarget}
                provider={provider}
                integrationVerification={integrationVerification}
                visiblePayload={visiblePayload}
                exportPackage={activeExportPackage}
                approvedCount={counts.approved}
                packageFormat={packageFormat}
                setPackageFormat={setPackageFormat}
                canExport={canExport}
                busyAction={busyAction}
                prepareExportPackage={prepareExportPackage}
                downloadExportPackage={downloadExportPackage}
                exportIssues={exportIssues}
                verifyIntegrations={verifyIntegrations}
                exports={exports}
              />
            </aside>
            </div>

            <DiagnosticsPanel
              provider={provider}
              counts={counts}
              preflight={preflight}
              verification={setupVerification}
              busyAction={busyAction}
              verifySetup={verifySetup}
              report={demoReport}
              runDemoReport={runDemoReport}
              capabilities={preflight?.capabilities}
            />
          </div>
        </section>
      </main>
    </TooltipProvider>
  );
}

function RunHistoryPanel({ runs, activeRunId, provider, storageDetail, busyAction, selectRun }) {
  const jsonFallback = provider?.storage === 'json';
  return (
    <Card className="nova-runs-card" size="sm" id="runs">
      <CardHeader>
        <CardTitle>Run history</CardTitle>
        <CardAction>
          <History className="nova-card-icon" />
        </CardAction>
      </CardHeader>
      <CardContent>
        {jsonFallback && storageDetail ? <p className="nova-provider-line">{storageDetail}</p> : null}
        {runs.length ? (
          <div className="nova-runs-list">
            {runs.slice(0, 5).map((run) => {
              const active = run.runId === activeRunId;
              return (
                <button
                  key={run.runId}
                  type="button"
                  className="nova-run-row"
                  data-state={active ? 'active' : undefined}
                  onClick={() => selectRun(run.runId)}
                  disabled={busyAction === `run-${run.runId}` || active}
                >
                  <span>
                    <strong>{run.title}</strong>
                    <small>{formatDateTime(run.updatedAt || run.createdAt)}</small>
                  </span>
                  <span className="nova-run-meta">
                    <Badge variant={run.exportCount ? 'secondary' : 'outline'}>{run.status}</Badge>
                    <small>
                      {run.taskCount} tasks
                      {run.exportCount ? ` / ${run.exportCount} exports` : ''}
                    </small>
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <BlankState
            title="No runs yet"
            description={
              jsonFallback
                ? 'D1 or Supabase is required for durable resume on serverless previews.'
                : 'Generated runs will stay available for resume.'
            }
          />
        )}
      </CardContent>
    </Card>
  );
}

function PrivateAccessPanel({
  teamConfig,
  privateWorkspaceDraft,
  privateTokenDraft,
  setPrivateWorkspaceDraft,
  setPrivateTokenDraft,
  busyAction,
  openPrivateWorkspace,
  compact = false,
}) {
  const teamOptions = teamConfig?.teams || [];
  return (
    <>
      <div className="nova-private-copy">
        <strong>{compact ? 'Use private mode for real issue creation' : 'Open a private team workspace'}</strong>
        <p>
          Team workspaces keep shared runs isolated and unlock real Linear/GitHub issue creation when connectors are configured.
        </p>
      </div>
      <FieldGroup className={compact ? 'nova-private-form compact' : 'nova-private-form'}>
        <Field>
          <FieldLabel htmlFor={compact ? 'private-workspace-key-compact' : 'private-workspace-key'}>
            Workspace key
          </FieldLabel>
          <Input
            id={compact ? 'private-workspace-key-compact' : 'private-workspace-key'}
            value={privateWorkspaceDraft}
            onChange={(event) => setPrivateWorkspaceDraft(event.target.value)}
            placeholder={teamOptions[0]?.id || 'team-workspace'}
            aria-label="Private workspace key"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={compact ? 'private-workspace-token-compact' : 'private-workspace-token'}>
            Team token
          </FieldLabel>
          <Input
            id={compact ? 'private-workspace-token-compact' : 'private-workspace-token'}
            type="password"
            value={privateTokenDraft}
            onChange={(event) => setPrivateTokenDraft(event.target.value)}
            placeholder="Paste token"
            aria-label="Private workspace token"
          />
        </Field>
        <Button onClick={openPrivateWorkspace} disabled={busyAction === 'team-session'}>
          {busyAction === 'team-session' ? (
            <Loader2 className="spin" data-icon="inline-start" />
          ) : (
            <Check data-icon="inline-start" />
          )}
          Open private workspace
        </Button>
      </FieldGroup>
      {teamOptions.length ? (
        <div className="nova-team-list" aria-label="Configured private workspaces">
          {teamOptions.map((team) => (
            <Button
              key={team.id}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPrivateWorkspaceDraft(team.id)}
            >
              {team.label}
            </Button>
          ))}
        </div>
      ) : (
        <p className="nova-private-note">Private teams are configured by deployment env vars.</p>
      )}
    </>
  );
}

function MetricCard({ label, value, text = false }) {
  return (
    <div className="nova-metric">
      <span className="nova-metric-label">{label}</span>
      <strong className={text ? 'nova-metric-value text' : 'nova-metric-value'}>{value}</strong>
    </div>
  );
}

function WorkflowOverview({ steps }) {
  return (
    <section className="nova-flow-strip" aria-label="Run flow">
      {steps.map((step) => (
        <Card key={step.id} className="nova-flow-step" data-state={step.state} size="sm">
          <CardHeader>
            <CardDescription>{step.label}</CardDescription>
            <CardTitle>{step.value}</CardTitle>
            <CardAction>
              <WorkflowStateBadge state={step.state} />
            </CardAction>
          </CardHeader>
        </Card>
      ))}
    </section>
  );
}

function ToneBadge({ tone = 'neutral', children }) {
  return (
    <Badge variant="secondary" className={`nova-tone-badge tone-${tone}`}>
      {children}
    </Badge>
  );
}

function WorkflowStateBadge({ state }) {
  const tone = state === 'active' ? 'brand' : state === 'done' ? 'success' : 'neutral';
  const label = state === 'done' ? 'Done' : state === 'active' ? 'Now' : 'Next';
  return <ToneBadge tone={tone}>{label}</ToneBadge>;
}

function buildWorkflowSteps({ idea, prd, counts, exports, busyAction }) {
  const hasIdea = Boolean(idea.trim());
  const totalReviewed = counts.approved + counts.rejected;
  const hasTasks = counts.total > 0;
  const hasExport = exports.length > 0;

  return [
    {
      id: 'idea',
      label: 'Idea',
      value: hasIdea ? 'captured' : 'empty',
      state: hasIdea ? 'done' : 'waiting',
    },
    {
      id: 'prd',
      label: 'PRD',
      value: prd ? 'generated' : busyAction === 'agent' ? 'running' : 'waiting',
      state: prd ? 'done' : busyAction === 'agent' ? 'active' : 'waiting',
    },
    {
      id: 'tasks',
      label: 'Tasks',
      value: hasTasks ? `${counts.total} planned` : 'none yet',
      state: hasTasks ? 'done' : 'waiting',
    },
    {
      id: 'review',
      label: 'Review',
      value: hasTasks ? `${totalReviewed}/${counts.total} reviewed` : 'blocked',
      state: counts.pending > 0 ? 'active' : hasTasks ? 'done' : 'waiting',
    },
    {
      id: 'export',
      label: 'Export',
      value: hasExport ? `${exports.length} sent` : counts.approved ? 'package ready' : 'needs approval',
      state: hasExport ? 'done' : counts.approved ? 'active' : 'waiting',
    },
  ];
}

function RuntimeStrip({ workspace, provider }) {
  return (
    <div className="nova-runtime-strip" aria-label="Runtime status">
      <span>
        Workspace <strong>{workspace}</strong>
      </span>
      <ToneBadge tone="information">AI {provider.ai}</ToneBadge>
      <ToneBadge tone="neutral">Storage {provider.storage}</ToneBadge>
      <ToneBadge tone={provider.linear === 'configured' ? 'success' : 'warning'}>
        Linear {provider.linear}
      </ToneBadge>
      <ToneBadge tone={provider.access === 'guarded' ? 'success' : 'warning'}>
        {provider.access === 'guarded' ? 'Private access' : 'Public demo'}
      </ToneBadge>
    </div>
  );
}

function formatDateTime(value) {
  if (!value) return 'No timestamp';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'No timestamp';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function KernelFact({ label, value }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DiagnosticsPanel({
  provider,
  counts,
  preflight,
  verification,
  busyAction,
  verifySetup,
  report,
  runDemoReport,
  capabilities,
}) {
  return (
    <section className="nova-diagnostics" id="diagnostics">
      <Tabs defaultValue="runtime" className="nova-diagnostic-tabs">
        <Card className="nova-diagnostics-card" size="sm">
          <CardHeader className="nova-workflow-header">
            <div>
              <CardTitle>Diagnostics</CardTitle>
              <CardDescription>Runtime proof, launch readiness, and scope coverage.</CardDescription>
            </div>
            <CardAction>
              <TabsList variant="line" className="nova-card-tabs">
                <TabsTrigger value="runtime">
                  <Bot data-icon="inline-start" />
                  Runtime
                </TabsTrigger>
                <TabsTrigger value="preflight">
                  <Settings data-icon="inline-start" />
                  Preflight
                </TabsTrigger>
                <TabsTrigger value="coverage">
                  <ListChecks data-icon="inline-start" />
                  Coverage
                </TabsTrigger>
                <TabsTrigger value="demo">
                  <CheckCircle2 data-icon="inline-start" />
                  Report
                </TabsTrigger>
              </TabsList>
            </CardAction>
          </CardHeader>
          <CardContent>
            <TabsContent value="runtime">
              <RuntimeDiagnostics provider={provider} counts={counts} />
            </TabsContent>
            <TabsContent value="preflight">
              <PreflightContent
                preflight={preflight}
                verification={verification}
                busyAction={busyAction}
                verifySetup={verifySetup}
              />
            </TabsContent>
            <TabsContent value="coverage">
              <CoverageContent capabilities={capabilities} />
            </TabsContent>
            <TabsContent value="demo">
              <DemoReportContent report={report} busyAction={busyAction} runDemoReport={runDemoReport} />
            </TabsContent>
          </CardContent>
        </Card>
      </Tabs>
    </section>
  );
}

function RuntimeDiagnostics({ provider, counts }) {
  return (
    <div className="nova-diagnostic-grid">
      <div>
        <div className="nova-section-head">
          <strong>Agent kernel</strong>
          <span>{provider.storage}</span>
        </div>
        <div className="nova-kernel-grid">
          <KernelFact label="Runtime" value="Node graph" />
          <KernelFact label="Planner" value={provider.ai} />
          <KernelFact label="State" value={provider.storage} />
          <KernelFact label="Gate" value={counts.approved ? 'resumable' : 'waiting'} />
        </div>
      </div>
      <div>
        <div className="nova-section-head">
          <strong>Agent stack</strong>
          <span>{skillStack.length} modules</span>
        </div>
        <div className="nova-chip-list">
          {skillStack.map((skill) => (
            <Badge key={skill} variant="secondary">
              {skill}
            </Badge>
          ))}
        </div>
      </div>
    </div>
  );
}

function PreflightContent({ preflight, verification, busyAction, verifySetup }) {
  return (
    <>
        {preflight ? (
          <div className="nova-preflight-list">
            {preflight.checks.map((check) => (
              <div key={check.id} className="nova-preflight-row">
                <div>
                  <strong>{check.label}</strong>
                  <p>{check.detail}</p>
                </div>
                <ReadinessBadge status={check.status} />
              </div>
            ))}
            {preflight.setup?.groups?.length ? (
              <>
                <Separator />
                <div className="nova-setup-list">
                  {preflight.setup.groups.map((group) => (
                    <div key={group.id} className="nova-setup-row">
                      <div>
                        <strong>{group.label}</strong>
                        <p>{group.active}</p>
                        {group.missing.length ? (
                          <div className="nova-env-chip-list">
                            {group.missing.slice(0, 4).map((name) => (
                              <code key={name}>{name}</code>
                            ))}
                          </div>
                        ) : null}
                        {group.commands?.length ? (
                          <div className="nova-command-list">
                            {group.commands.slice(0, 2).map((command) => (
                              <code key={command}>{command}</code>
                            ))}
                          </div>
                        ) : null}
                      </div>
                      <ReadinessBadge status={group.status} />
                    </div>
                  ))}
                </div>
              </>
            ) : null}
            {preflight.setup?.acceptedSecretSets ? (
              <>
                <Separator />
                <LaunchPlan setup={preflight.setup} />
              </>
            ) : null}
            <Separator />
            <div className="nova-verification-head">
              <div>
                <strong>Runtime verification</strong>
                <p>{verification ? `${verification.durationMs} ms / ${verification.runtime}` : 'Run live checks against this runtime.'}</p>
              </div>
              <Button variant="outline" size="sm" onClick={verifySetup} disabled={busyAction === 'verify-setup'}>
                {busyAction === 'verify-setup' ? (
                  <Loader2 className="spin" data-icon="inline-start" />
                ) : (
                  <CheckCircle2 data-icon="inline-start" />
                )}
                Verify
              </Button>
            </div>
            {verification?.checks?.length ? (
              <div className="nova-verify-list">
                {verification.checks.map((check) => (
                  <div key={check.id} className="nova-verify-row">
                    <div>
                      <strong>{check.label}</strong>
                      <p>{check.detail}</p>
                    </div>
                    <ReadinessBadge status={check.status} />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="nova-log-list">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}
    </>
  );
}

function LaunchPlan({ setup }) {
  return (
    <div className="nova-launch-plan">
      <div className="nova-verification-head">
        <div>
          <strong>Launch plan</strong>
          <p>{setup.productionReady ? 'Production prerequisites are ready.' : 'Fill one option from each required group.'}</p>
        </div>
        <ReadinessBadge status={setup.productionReady ? 'ready' : 'missing'} />
      </div>
      <div className="nova-secret-set-list">
        {Object.entries(setup.acceptedSecretSets).map(([group, options]) => (
          <div key={group} className="nova-secret-set-row">
            <strong>{formatSecretGroup(group)}</strong>
            {options.slice(0, 3).map((option) => (
              <div className="nova-env-chip-list" key={option.join('|')}>
                {option.map((name) => (
                  <code key={name}>{name}</code>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="nova-command-list">
        {setup.launchChecklist?.slice(0, 3).map((item) => (
          <code key={item}>{item}</code>
        ))}
        <code>{setup.launchCommand}</code>
      </div>
    </div>
  );
}

function formatSecretGroup(value) {
  return value
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (letter) => letter.toUpperCase());
}

function CoverageContent({ capabilities }) {
  return (
    <>
        {capabilities?.length ? (
          <div className="nova-coverage-list">
            {capabilities.map((item) => (
              <div key={item.id} className="nova-coverage-row">
                <div>
                  <strong>{item.label}</strong>
                  <p>{item.detail}</p>
                </div>
                <ReadinessBadge status={item.status} />
              </div>
            ))}
          </div>
        ) : (
          <div className="nova-log-list">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}
    </>
  );
}

function DemoReportContent({ report, busyAction, runDemoReport }) {
  return (
    <div className="nova-form-stack">
        <div className="nova-verification-head">
          <div>
            <strong>{report ? report.summary.title : 'End-to-end dry run'}</strong>
            <p>{report ? `${report.summary.durationMs} ms / ${report.summary.traceSpans} trace spans` : 'Idea to PRD, tasks, approval, package, and trace.'}</p>
          </div>
          <Button variant="outline" size="sm" onClick={runDemoReport} disabled={busyAction === 'demo-report'}>
            {busyAction === 'demo-report' ? (
              <Loader2 className="spin" data-icon="inline-start" />
            ) : (
              <Play data-icon="inline-start" />
            )}
            Run report
          </Button>
        </div>
        {report ? (
          <>
            <div className="nova-demo-grid">
              <KernelFact label="Tasks" value={report.summary.tasks} />
              <KernelFact label="Approved" value={report.summary.approved} />
              <KernelFact label="Issues" value={report.issuePackage.payloadCount} />
              <KernelFact label="Events" value={report.summary.events} />
            </div>
            <div className="nova-verify-list">
              {report.checks.map((check) => (
                <div key={check.id} className="nova-verify-row">
                  <div>
                    <strong>{check.label}</strong>
                    <p>{check.detail}</p>
                  </div>
                  <ReadinessBadge status={check.status} />
                </div>
              ))}
            </div>
          </>
        ) : null}
    </div>
  );
}

function ReadinessBadge({ status }) {
  const tone =
    status === 'ready'
      ? 'success'
      : ['missing', 'misconfigured', 'failed'].includes(status)
        ? 'danger'
        : ['fallback', 'pending'].includes(status)
          ? 'warning'
          : 'neutral';
  return <ToneBadge tone={tone}>{status}</ToneBadge>;
}

function TaskList({
  tasks,
  selectedTask,
  busyAction,
  setSelectedTaskId,
  updateTaskStatus,
  updateTaskBatch,
}) {
  if (!tasks.length) {
    return <BlankState title="No tasks yet" description="Run the agent to create persisted tasks." />;
  }
  const pendingCount = tasks.filter((task) => task.status === 'pending').length;
  const batchBusy = busyAction.startsWith('batch-') || ['agent', 'export'].includes(busyAction);
  const reviewedCount = tasks.length - pendingCount;

  return (
    <div className="nova-task-db">
      <div className="nova-table-actions">
        <span>
          <strong>{tasks.length}</strong> tickets
          <small>{pendingCount ? `${pendingCount} pending review` : `${reviewedCount} reviewed`}</small>
        </span>
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => updateTaskBatch('approved')}
            disabled={!pendingCount || batchBusy}
          >
            <Check data-icon="inline-start" />
            Approve pending
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => updateTaskBatch('rejected')}
            disabled={!pendingCount || batchBusy}
          >
            <X data-icon="inline-start" />
            Reject pending
          </Button>
        </div>
      </div>
      <div className="nova-ticket-list" aria-label="Generated task tickets">
        {tasks.map((task, index) => (
          <article
            key={task.id}
            className="nova-ticket-card"
            data-state={selectedTask?.id === task.id ? 'selected' : undefined}
            onClick={() => setSelectedTaskId(task.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setSelectedTaskId(task.id);
              }
            }}
            role="button"
            tabIndex={0}
          >
            <header className="nova-ticket-head">
              <div className="nova-ticket-kicker">
                <span>{String(index + 1).padStart(2, '0')}</span>
                <code>{task.id}</code>
                <StatusBadge status={task.status} />
              </div>
              <div className="nova-ticket-actions">
                <Button
                  variant={task.status === 'approved' ? 'secondary' : 'outline'}
                  size="sm"
                  onClick={(event) => {
                    event.stopPropagation();
                    updateTaskStatus(task.id, 'approved');
                  }}
                  disabled={busyAction === task.id || task.status === 'approved'}
                >
                  <Check data-icon="inline-start" />
                  Approve
                </Button>
                <Button
                  variant={task.status === 'rejected' ? 'destructive' : 'outline'}
                  size="sm"
                  onClick={(event) => {
                    event.stopPropagation();
                    updateTaskStatus(task.id, 'rejected');
                  }}
                  disabled={busyAction === task.id || task.status === 'rejected'}
                >
                  <X data-icon="inline-start" />
                  Reject
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`More actions for ${task.id}`}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuGroup>
                      <DropdownMenuItem
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedTaskId(task.id);
                        }}
                      >
                        <FileText />
                        Inspect details
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={(event) => {
                          event.stopPropagation();
                          updateTaskStatus(task.id, 'approved');
                        }}
                        disabled={busyAction === task.id}
                      >
                        <Check />
                        Approve
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={(event) => {
                          event.stopPropagation();
                          updateTaskStatus(task.id, 'rejected');
                        }}
                        disabled={busyAction === task.id}
                      >
                        <X />
                        Reject
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </header>
            <div className="nova-ticket-body">
              <h3>{task.title}</h3>
              <p>{task.acceptance}</p>
            </div>
            <footer className="nova-ticket-footer">
              <ToneBadge tone="neutral">{task.owner}</ToneBadge>
              <PriorityBadge priority={task.priority} />
              <ToneBadge tone="neutral">{task.effort || 'Unestimated'}</ToneBadge>
            </footer>
          </article>
        ))}
      </div>
    </div>
  );
}

function Inspector({
  selectedTask,
  taskDraft,
  setTaskDraft,
  busyAction,
  saveSelectedTask,
  updateTaskStatus,
}) {
  return (
    <Card className="nova-inspector" size="sm">
      <CardHeader>
        <CardTitle>{selectedTask ? selectedTask.id : 'Task inspector'}</CardTitle>
        <CardAction>
          <Database className="nova-card-icon" />
        </CardAction>
      </CardHeader>
      <CardContent>
        {selectedTask ? (
          <FieldGroup className="nova-form-stack">
            <Field>
              <FieldLabel>Title</FieldLabel>
              <Input
                value={taskDraft?.title || ''}
                onChange={(event) => setTaskDraft((draft) => ({ ...draft, title: event.target.value }))}
              />
            </Field>
            <div className="nova-editor-row">
              <Field>
                <FieldLabel>Owner</FieldLabel>
                <Input
                  value={taskDraft?.owner || ''}
                  onChange={(event) => setTaskDraft((draft) => ({ ...draft, owner: event.target.value }))}
                />
              </Field>
              <Field>
                <FieldLabel>Priority</FieldLabel>
                <Select
                  value={taskDraft?.priority || 'Medium'}
                  onValueChange={(value) => setTaskDraft((draft) => ({ ...draft, priority: value }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="High">High</SelectItem>
                      <SelectItem value="Medium">Medium</SelectItem>
                      <SelectItem value="Low">Low</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <Field>
              <FieldLabel>Estimate</FieldLabel>
              <Input
                value={taskDraft?.effort || ''}
                onChange={(event) => setTaskDraft((draft) => ({ ...draft, effort: event.target.value }))}
              />
            </Field>
            <Field>
              <FieldLabel>Acceptance criteria</FieldLabel>
              <Textarea
                value={taskDraft?.acceptance || ''}
                onChange={(event) =>
                  setTaskDraft((draft) => ({ ...draft, acceptance: event.target.value }))
                }
              />
            </Field>
            <Field>
              <FieldLabel>Review note</FieldLabel>
              <Textarea
                value={taskDraft?.reviewNote || ''}
                onChange={(event) =>
                  setTaskDraft((draft) => ({ ...draft, reviewNote: event.target.value }))
                }
              />
            </Field>
            <div className="nova-inline-actions">
              <Button variant="outline" onClick={saveSelectedTask} disabled={busyAction === selectedTask.id}>
                Save
              </Button>
              <Button
                variant="secondary"
                onClick={() => updateTaskStatus(selectedTask.id, 'approved', taskDraft?.reviewNote || '')}
                disabled={busyAction === selectedTask.id}
              >
                <Check data-icon="inline-start" />
                Approve
              </Button>
              <Button
                variant="destructive"
                onClick={() => updateTaskStatus(selectedTask.id, 'rejected', taskDraft?.reviewNote || '')}
                disabled={busyAction === selectedTask.id}
              >
                <X data-icon="inline-start" />
                Reject
              </Button>
            </div>
            <Separator />
            <div className="nova-status-line">
              Status <StatusBadge status={selectedTask.status} />
            </div>
          </FieldGroup>
        ) : (
          <BlankState title="Select a task" />
        )}
      </CardContent>
    </Card>
  );
}

function ExportPanel({
  exportTarget,
  setExportTarget,
  provider,
  integrationVerification,
  visiblePayload,
  exportPackage,
  approvedCount,
  packageFormat,
  setPackageFormat,
  canExport,
  busyAction,
  prepareExportPackage,
  downloadExportPackage,
  exportIssues,
  verifyIntegrations,
  exports,
}) {
  const targetKey = exportTarget.toLowerCase();
  const targetIntegration = integrationVerification?.providers?.[targetKey];
  const hasApprovedTasks = approvedCount > 0;
  const isPackaging = busyAction === 'package';
  const previewText =
    packageFormat === 'markdown' && exportPackage
      ? exportPackage.markdown
      : JSON.stringify(exportPackage?.payload || visiblePayload.slice(0, 2), null, 2);
  const exportMode = exportPackage?.mode || clientExportMode(exportTarget, provider);
  const exportModeTone = exportMode.canCreateIssues ? 'success' : exportMode.connector === 'configured' ? 'warning' : 'neutral';
  const exportActionLabel = exportMode.canCreateIssues ? `Create ${exportTarget} issues` : 'Save export package';

  return (
    <Card className="nova-export" size="sm" id="exports">
      <CardHeader>
        <CardTitle>Issue export</CardTitle>
        <CardAction>
          <GitPullRequest className="nova-card-icon" />
        </CardAction>
      </CardHeader>
      <CardContent className="nova-form-stack">
        <ToggleGroup
          type="single"
          value={exportTarget}
          onValueChange={(value) => value && setExportTarget(value)}
          className="nova-toggle"
        >
          <ToggleGroupItem value="Linear" aria-label="Linear">
            <CheckCircle2 />
            Linear
          </ToggleGroupItem>
          <ToggleGroupItem value="GitHub" aria-label="GitHub">
            <Github />
            GitHub
          </ToggleGroupItem>
        </ToggleGroup>
        <p className="nova-provider-line">
          {exportTarget} connector: <strong>{provider[exportTarget.toLowerCase()]}</strong>
        </p>
        <div className="nova-export-mode">
          <div>
            <strong>{exportMode.canCreateIssues ? 'Real issue creation enabled' : 'Package-only export'}</strong>
            <p>{exportMode.reason}</p>
          </div>
          <ToneBadge tone={exportModeTone}>
            {exportMode.canCreateIssues ? 'private ready' : exportMode.connector === 'configured' ? 'guard required' : 'payload safe'}
          </ToneBadge>
        </div>
        <div className="nova-connector-check">
          <div className="nova-verification-head">
            <div>
              <strong>Connector verification</strong>
              <p>
                {targetIntegration
                  ? targetIntegration.detail
                  : 'Run read-only checks before creating real issues.'}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={verifyIntegrations}
              disabled={busyAction === 'verify-integrations'}
            >
              {busyAction === 'verify-integrations' ? (
                <Loader2 className="spin" data-icon="inline-start" />
              ) : (
                <RefreshCw data-icon="inline-start" />
              )}
              Verify
            </Button>
          </div>
          <div className="nova-connector-grid">
            {['linear', 'github'].map((id) => {
              const item = integrationVerification?.providers?.[id];
              return (
                <div key={id} className="nova-connector-row" data-state={id === targetKey ? 'active' : undefined}>
                  <span>
                    <strong>{item?.label || (id === 'github' ? 'GitHub Issues' : 'Linear')}</strong>
                    <small>{item?.configured ? 'configured' : 'not configured'}</small>
                  </span>
                  <ReadinessBadge status={item?.status || 'missing'} />
                </div>
              );
            })}
          </div>
        </div>
        <div className="nova-package-meta">
          <span>
            {isPackaging
              ? 'Preparing approved tasks for issue export.'
              : exportPackage
              ? `${exportPackage.summary.pendingExportCount ?? exportPackage.summary.approvedCount} issues ready for export`
              : hasApprovedTasks
                ? 'Approved tasks can be packaged before API export.'
                : 'Approve at least one task to unlock issue export.'}
          </span>
          {isPackaging ? (
            <Badge variant="outline">preparing</Badge>
          ) : exportPackage ? (
            <Badge variant="secondary">{exportPackage.status}</Badge>
          ) : (
            <Badge variant="outline">draft</Badge>
          )}
        </div>
        <ToggleGroup
          type="single"
          value={packageFormat}
          onValueChange={(value) => value && setPackageFormat(value)}
          className="nova-toggle"
        >
          <ToggleGroupItem value="json" aria-label="JSON payload">
            JSON
          </ToggleGroupItem>
          <ToggleGroupItem value="markdown" aria-label="Markdown issue package">
            Markdown
          </ToggleGroupItem>
        </ToggleGroup>
        <ScrollArea className="nova-payload">
          <pre>{previewText}</pre>
        </ScrollArea>
        <div className="nova-export-actions">
          <Button variant="outline" disabled={!hasApprovedTasks || busyAction === 'package'} onClick={prepareExportPackage}>
            {busyAction === 'package' ? (
              <Loader2 className="spin" data-icon="inline-start" />
            ) : (
              <FileText data-icon="inline-start" />
            )}
            Prepare package
          </Button>
          <Button
            variant="secondary"
            disabled={!exportPackage || isPackaging}
            onClick={() => downloadExportPackage(packageFormat === 'markdown' ? 'markdown' : 'json')}
          >
            <Download data-icon="inline-start" />
            Download
          </Button>
        </div>
        <Button disabled={!canExport} onClick={exportIssues}>
          {busyAction === 'export' ? (
            <Loader2 className="spin" data-icon="inline-start" />
          ) : (
            <Send data-icon="inline-start" />
          )}
          {exportActionLabel}
        </Button>
        <Separator />
        <div className="nova-export-history">
          <strong>History</strong>
          {exports.length ? (
            exports.slice(0, 3).map((record) => (
              <div key={record.id}>
                <span>
                  <strong>{record.target}</strong>
                  <small>{formatExportRecordMeta(record)}</small>
                </span>
                <Badge variant="outline">{record.status}</Badge>
              </div>
            ))
          ) : (
            <span className="text-muted-foreground">No exports yet</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function PrdView({ prd }) {
  return (
    <div className="nova-prd">
      <SummaryBlock title="Problem" body={prd.problem} />
      <SummaryBlock title="Audience" body={prd.audience} />
      <SummaryList title="Goals" items={prd.goals} />
      <SummaryList title="MVP scope" items={prd.scope} />
      <SummaryList title="Retrieved context" items={prd.context || []} />
      <SummaryList title="Validation checks" items={prd.validation || prd.checks || []} />
    </div>
  );
}

function TraceLogPanel({ graph, logs }) {
  return (
    <div className="nova-trace-grid">
      <section>
        <div className="nova-section-head">
          <strong>Agent graph</strong>
          <span>state machine</span>
        </div>
        <div className="nova-trace">
          {(graph?.length ? graph : fallbackGraph()).map((node) => (
            <div className={`nova-trace-row ${node.status}`} key={node.id}>
              <span>
                <CircleDot />
              </span>
              <div>
                <strong>{node.label}</strong>
                <p>{node.status}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section>
        <div className="nova-section-head">
          <strong>Tool calls</strong>
          <span>{logs.length ? `${logs.length} events` : 'waiting'}</span>
        </div>
        <RunLog logs={logs} />
      </section>
    </div>
  );
}

function RunLog({ logs }) {
  if (!logs.length) {
    return (
      <div className="nova-log-list">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  return (
    <ScrollArea className="nova-log-list">
      {logs.map((log) => (
        <div className="nova-log-row" key={log.id}>
          <span className={`nova-log-dot ${log.type}`} />
          <div>
            <strong>{log.label}</strong>
            <p>{log.detail}</p>
          </div>
        </div>
      ))}
    </ScrollArea>
  );
}

function BlankState({ title, description = 'The agent output will appear here.' }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Bot />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function SummaryBlock({ title, body }) {
  return (
    <section>
      <h3>{title}</h3>
      <p>{body}</p>
    </section>
  );
}

function SummaryList({ title, items }) {
  return (
    <section>
      <h3>{title}</h3>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function StatusBadge({ status }) {
  const tone =
    status === 'approved'
      ? 'success'
      : status === 'rejected'
        ? 'danger'
        : ['pending', 'waiting'].includes(status)
          ? 'warning'
          : ['planned', 'draft'].includes(status)
            ? 'information'
            : 'neutral';
  return <ToneBadge tone={tone}>{status}</ToneBadge>;
}

function PriorityBadge({ priority }) {
  const tone =
    priority === 'High'
      ? 'danger'
      : priority === 'Medium'
        ? 'information'
        : priority === 'Low'
          ? 'success'
          : 'neutral';
  return <ToneBadge tone={tone}>{priority || 'Priority'}</ToneBadge>;
}

function clientExportMode(target, provider = {}) {
  const targetKey = String(target || '').toLowerCase();
  const connector = provider[targetKey] || 'not-configured';
  const canCreateIssues = connector === 'configured' && provider.access === 'guarded';
  return {
    mode: canCreateIssues ? 'real-issue-creation' : 'package-only',
    canCreateIssues,
    connector,
    access: provider.access || 'demo-open',
    reason:
      connector !== 'configured'
        ? `${target} connector is not configured; the app can still prepare a safe issue package.`
        : canCreateIssues
          ? `Private guarded mode is active, so approved tasks can create real ${target} issues.`
          : `Public demo mode prepares ${target} packages only; enable guarded private access for real issue creation.`,
  };
}

function buildPreviewPayload(target, prd, tasks) {
  const approved = tasks.filter((task) => task.status === 'approved');
  if (target === 'GitHub') {
    return approved.map((task) => ({
      title: task.title,
      labels: ['ai-task-agent', task.owner.toLowerCase().replaceAll(' ', '-')],
      body: `${task.acceptance}\n\nSource PRD: ${prd?.title || 'Untitled PRD'}`,
    }));
  }
  return approved.map((task) => ({
    title: task.title,
    description: `${task.acceptance}\n\nSource PRD: ${prd?.title || 'Untitled PRD'}`,
    priority: task.priority,
    estimate: task.effort,
    team: task.owner,
  }));
}

function formatExportRecordMeta(record) {
  const payloadCount = Array.isArray(record.payload) ? record.payload.length : 0;
  const delivery = Array.isArray(record.delivery) ? record.delivery : [];
  if (!delivery.length) return `${payloadCount} payload${payloadCount === 1 ? '' : 's'}`;
  const created = delivery.filter((item) => item.ok).length;
  const failed = delivery.length - created;
  return failed ? `${created} created / ${failed} failed` : `${created} created`;
}

function fallbackGraph() {
  return [
    { id: 'idea', label: 'Idea captured', status: 'active' },
    { id: 'planner', label: 'Planner selected', status: 'waiting' },
    { id: 'prd', label: 'PRD generated', status: 'waiting' },
    { id: 'tasks', label: 'Tasks planned', status: 'waiting' },
    { id: 'validation', label: 'Output validated', status: 'waiting' },
    { id: 'db', label: 'Tasks inserted in DB', status: 'waiting' },
    { id: 'approval', label: 'Human approval gate', status: 'waiting' },
    { id: 'export', label: 'Issue export', status: 'waiting' },
  ];
}

createRoot(document.getElementById('root')).render(<App />);
