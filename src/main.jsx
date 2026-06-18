import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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

const navItems = [
  { label: 'Workspace', icon: LayoutDashboard, target: '#workspace', active: true },
  { label: 'Runs', icon: History, target: '#runs' },
  { label: 'Agent graph', icon: Workflow, target: '#agent-graph' },
  { label: 'Task DB', icon: Database, target: '#task-db' },
  { label: 'Exports', icon: Send, target: '#exports' },
  { label: 'Settings', icon: Settings, target: '#readiness' },
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

function emptyWorkspace() {
  return {
    idea: '',
    prd: null,
    tasks: [],
    logs: [],
    exports: [],
    graph: [],
    runHistory: [],
    provider: {
      ai: 'local-planner',
      storage: 'json',
      linear: 'not-configured',
      github: 'not-configured',
    },
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Request failed');
  return body;
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
  const [demoReport, setDemoReport] = useState(null);
  const [streamStatus, setStreamStatus] = useState('');
  const [busyAction, setBusyAction] = useState('loading');
  const [error, setError] = useState('');

  const { prd, tasks, logs, exports, provider, graph, runHistory = [] } = workspace;

  useEffect(() => {
    refreshWorkspace();
    refreshFreeModels();
    refreshPreflight();
    refreshIntegrationVerification();
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
  }, [exportTarget, workspace.runId, counts.approved, counts.rejected, counts.total]);

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
      headers: { 'content-type': 'application/json' },
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

          <Card className="nova-stack-card" size="sm">
            <CardHeader>
              <CardTitle>Agent stack</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="nova-chip-list">
                {skillStack.map((skill) => (
                  <Badge key={skill} variant="secondary">
                    {skill}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
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
            <div className="nova-actions">
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
            <MetricCard label="AI mode" value={provider.ai} text />
            <MetricCard label="Storage" value={provider.storage} text />
          </section>

          <div className="nova-workspace" id="workspace">
            <section className="nova-left">
              <Card className="nova-idea-card" size="sm">
                <CardHeader>
                  <CardTitle>Product idea</CardTitle>
                  <Sparkles className="nova-card-icon" />
                </CardHeader>
                <CardContent className="nova-form-stack">
                  <Textarea
                    value={idea}
                    onChange={(event) => setIdea(event.target.value)}
                    aria-label="Product idea"
                    className="min-h-36 resize-y"
                  />
                  <Button onClick={runAgent} disabled={busyAction === 'agent'}>
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

              <Card className="nova-graph-card" size="sm" id="agent-graph">
                <CardHeader>
                  <CardTitle>Execution trace</CardTitle>
                  <Workflow className="nova-card-icon" />
                </CardHeader>
                <CardContent>
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
                </CardContent>
              </Card>

              <Card className="nova-runtime-card" size="sm">
                <CardHeader>
                  <CardTitle>Agent kernel</CardTitle>
                  <Bot className="nova-card-icon" />
                </CardHeader>
                <CardContent>
                  <div className="nova-kernel-grid">
                    <KernelFact label="Runtime" value="Node graph" />
                    <KernelFact label="Planner" value={provider.ai} />
                    <KernelFact label="State" value={provider.storage} />
                    <KernelFact label="Gate" value={counts.approved ? 'resumable' : 'waiting'} />
                  </div>
                </CardContent>
              </Card>

              <PreflightPanel
                preflight={preflight}
                verification={setupVerification}
                busyAction={busyAction}
                verifySetup={verifySetup}
              />
              <DemoReportPanel report={demoReport} busyAction={busyAction} runDemoReport={runDemoReport} />
              <CoveragePanel capabilities={preflight?.capabilities} />
            </section>

            <section className="nova-center">
              <Tabs defaultValue="tasks" className="nova-tabs">
                <div className="nova-tabs-head">
                  <TabsList>
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
                      Logs
                    </TabsTrigger>
                  </TabsList>
                </div>

                <TabsContent value="tasks">
                  <Card size="sm" id="task-db">
                    <CardHeader>
                      <CardTitle>Task DB</CardTitle>
                      <Database className="nova-card-icon" />
                    </CardHeader>
                    <CardContent>
                      <TaskTable
                        tasks={tasks}
                        selectedTask={selectedTask}
                        busyAction={busyAction}
                        setSelectedTaskId={setSelectedTaskId}
                        updateTaskStatus={updateTaskStatus}
                        updateTaskBatch={updateTaskBatch}
                      />
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent value="prd">
                  <Card size="sm">
                    <CardHeader>
                      <CardTitle>{prd ? prd.title : 'Generated PRD'}</CardTitle>
                      <FileText className="nova-card-icon" />
                    </CardHeader>
                    <CardContent>
                      {prd ? <PrdView prd={prd} /> : <BlankState title="No PRD yet" />}
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent value="logs">
                  <Card size="sm">
                    <CardHeader>
                      <CardTitle>Tool calls</CardTitle>
                      <Workflow className="nova-card-icon" />
                    </CardHeader>
                    <CardContent>
                      <RunLog logs={logs} />
                    </CardContent>
                  </Card>
                </TabsContent>
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
        <History className="nova-card-icon" />
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

function MetricCard({ label, value, text = false }) {
  return (
    <Card className="nova-metric" size="sm">
      <CardContent>
        <span>{label}</span>
        <strong className={text ? 'text' : ''}>{value}</strong>
      </CardContent>
    </Card>
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

function PreflightPanel({ preflight, verification, busyAction, verifySetup }) {
  return (
    <Card className="nova-preflight" size="sm" id="readiness">
      <CardHeader>
        <CardTitle>Production preflight</CardTitle>
        <Settings className="nova-card-icon" />
      </CardHeader>
      <CardContent>
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
      </CardContent>
    </Card>
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

function CoveragePanel({ capabilities }) {
  return (
    <Card className="nova-coverage" size="sm">
      <CardHeader>
        <CardTitle>Scope coverage</CardTitle>
        <ListChecks className="nova-card-icon" />
      </CardHeader>
      <CardContent>
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
      </CardContent>
    </Card>
  );
}

function DemoReportPanel({ report, busyAction, runDemoReport }) {
  return (
    <Card className="nova-demo-report" size="sm">
      <CardHeader>
        <CardTitle>Demo report</CardTitle>
        <CheckCircle2 className="nova-card-icon" />
      </CardHeader>
      <CardContent className="nova-form-stack">
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
      </CardContent>
    </Card>
  );
}

function ReadinessBadge({ status }) {
  const variant =
    status === 'ready'
      ? 'secondary'
      : ['missing', 'misconfigured', 'failed'].includes(status)
        ? 'destructive'
        : 'outline';
  return <Badge variant={variant}>{status}</Badge>;
}

function TaskTable({
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

  return (
    <div className="nova-task-db">
      <div className="nova-table-actions">
        <span>{pendingCount} pending review</span>
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
      <div className="nova-table-wrap">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Task</TableHead>
              <TableHead className="w-28">Review</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.map((task) => (
              <TableRow
                key={task.id}
                data-state={selectedTask?.id === task.id ? 'selected' : undefined}
                onClick={() => setSelectedTaskId(task.id)}
              >
                <TableCell>
                  <div className="nova-task-cell">
                    <div className="nova-task-title-line">
                      <span className="font-mono text-xs text-muted-foreground">{task.id}</span>
                      <Badge variant={task.priority === 'High' ? 'destructive' : 'secondary'}>
                        {task.priority}
                      </Badge>
                      <Badge variant="outline">{task.owner}</Badge>
                    </div>
                    <strong>{task.title}</strong>
                    <span>{task.acceptance}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <StatusBadge status={task.status} />
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
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
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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
        <Database className="nova-card-icon" />
      </CardHeader>
      <CardContent>
        {selectedTask ? (
          <div className="nova-form-stack">
            <label>
              Title
              <Input
                value={taskDraft?.title || ''}
                onChange={(event) => setTaskDraft((draft) => ({ ...draft, title: event.target.value }))}
              />
            </label>
            <div className="nova-editor-row">
              <label>
                Owner
                <Input
                  value={taskDraft?.owner || ''}
                  onChange={(event) => setTaskDraft((draft) => ({ ...draft, owner: event.target.value }))}
                />
              </label>
              <label>
                Priority
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
              </label>
            </div>
            <label>
              Estimate
              <Input
                value={taskDraft?.effort || ''}
                onChange={(event) => setTaskDraft((draft) => ({ ...draft, effort: event.target.value }))}
              />
            </label>
            <label>
              Acceptance criteria
              <Textarea
                value={taskDraft?.acceptance || ''}
                onChange={(event) =>
                  setTaskDraft((draft) => ({ ...draft, acceptance: event.target.value }))
                }
              />
            </label>
            <label>
              Review note
              <Textarea
                value={taskDraft?.reviewNote || ''}
                onChange={(event) =>
                  setTaskDraft((draft) => ({ ...draft, reviewNote: event.target.value }))
                }
              />
            </label>
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
          </div>
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
  const previewText =
    packageFormat === 'markdown' && exportPackage
      ? exportPackage.markdown
      : JSON.stringify(exportPackage?.payload || visiblePayload.slice(0, 2), null, 2);

  return (
    <Card className="nova-export" size="sm" id="exports">
      <CardHeader>
        <CardTitle>Issue export</CardTitle>
        <GitPullRequest className="nova-card-icon" />
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
            {exportPackage
              ? `${exportPackage.summary.approvedCount} approved issues ready`
              : canExport
                ? 'Approved tasks can be packaged before API export.'
                : 'Approve at least one task to unlock issue export.'}
          </span>
          {exportPackage ? <Badge variant="secondary">{exportPackage.status}</Badge> : <Badge variant="outline">draft</Badge>}
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
          <Button variant="outline" disabled={!canExport || busyAction === 'package'} onClick={prepareExportPackage}>
            {busyAction === 'package' ? (
              <Loader2 className="spin" data-icon="inline-start" />
            ) : (
              <FileText data-icon="inline-start" />
            )}
            Prepare package
          </Button>
          <Button
            variant="secondary"
            disabled={!exportPackage}
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
          Export approved
        </Button>
        <Separator />
        <div className="nova-export-history">
          <strong>History</strong>
          {exports.length ? (
            exports.slice(0, 3).map((record) => (
              <div key={record.id}>
                <span>{record.target}</span>
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
  const variant = status === 'approved' ? 'secondary' : status === 'rejected' ? 'destructive' : 'outline';
  return <Badge variant={variant}>{status}</Badge>;
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
