import { useEffect, useRef, useState } from "react";
import { SimpleMarkdown } from "./markdown";

type TriageState = "needs_you" | "working" | "queued";

type ServerRepo = {
  label: string;
  dir: string;
};

type ServerNode = {
  id: string;
  name: string;
  endpoint: string;
  defaultDir: string;
  online: boolean;
  latencyMs: number;
  repos: ServerRepo[];
};

type Checkpoint = {
  id: string;
  timeAgo: string;
  actor: "you" | "agent";
  summary: string;
  toolBadge?: string;
};

type QuestionOption = {
  label: string;
  description: string;
};

type OpenCodeSession = {
  id: string;
  serverId: string;
  title: string;
  repo: string;
  status: "running" | "idle" | "question";
  idleSinceLabel: string;
  questionPrompt?: {
    question: string;
    options: QuestionOption[];
  };
  latestOutcomeMarkdown: string;
  checkpoints: Checkpoint[];
};

type FlightTask = {
  id: string;
  title: string;
  section: "focus" | "buffer" | "backlog" | "done";
  triage: TriageState;
  serverId: string;
  queuedForServer?: boolean;
  repo: string;
  specPrompt: string;
  attentionMin: number;
  agentMin: number;
  linkedSessionId?: string;
};

const INITIAL_SERVERS: ServerNode[] = [
  {
    id: "local",
    name: "MacBook Local",
    endpoint: "/opencode-api",
    defaultDir: "/Users/justinyu",
    online: true,
    latencyMs: 11,
    repos: [
      { label: "vyond/devops", dir: "/Users/justinyu/Develop/vyond/devops" },
      { label: "vyond/eks-manifest", dir: "/Users/justinyu/Develop/vyond/eks-manifest" },
      {
        label: "vyond/qa-autotest-account-pool",
        dir: "/Users/justinyu/Develop/vyond/qa-autotest-account-pool",
      },
      { label: "vyond/turbo", dir: "/Users/justinyu/Develop/vyond/turbo" },
      { label: "vyond/next", dir: "/Users/justinyu/Develop/vyond/next" },
      {
        label: "my-timebox-focus-app",
        dir: "/Users/justinyu/Develop/my-diy-random-thing/my-timebox-focus-app",
      },
    ],
  },
  {
    id: "devbox",
    name: "Cloud Devbox",
    endpoint: "https://devbox.vyond.ts.net/api",
    defaultDir: "/home/ubuntu/vyond",
    online: true,
    latencyMs: 38,
    repos: [
      { label: "vyond/devops", dir: "/home/ubuntu/vyond/devops" },
      { label: "vyond/eks-manifest", dir: "/home/ubuntu/vyond/eks-manifest" },
      { label: "vyond/turbo", dir: "/home/ubuntu/vyond/turbo" },
      {
        label: "vyond/qa-autotest-account-pool",
        dir: "/home/ubuntu/vyond/qa-autotest-account-pool",
      },
    ],
  },
  {
    id: "homelab",
    name: "Home Server",
    endpoint: "https://homelab.tailnet.ts.net/api",
    defaultDir: "/workspace",
    online: false,
    latencyMs: 0,
    repos: [
      { label: "my-timebox-focus-app", dir: "/workspace/my-timebox-focus-app" },
      { label: "homelab/infra", dir: "/workspace/infra" },
    ],
  },
];

const btn =
  "rounded-md px-2.5 py-1 text-[13px] text-zinc-400 hover:bg-zinc-800/80 hover:text-zinc-200 cursor-pointer";

const TRIAGE_ORDER: Record<TriageState, number> = {
  needs_you: 0,
  working: 1,
  queued: 2,
};

const TRIAGE_UI: Record<
  TriageState,
  {
    label: string;
    leftBar: string;
    dot: string;
    labelCls: string;
  }
> = {
  needs_you: {
    label: "Needs You",
    leftBar: "border-l-orange-500 bg-zinc-900/40",
    dot: "bg-orange-500",
    labelCls: "text-orange-400 font-medium",
  },
  working: {
    label: "Working",
    leftBar: "border-l-zinc-500",
    dot: "bg-zinc-300 animate-pulse",
    labelCls: "text-zinc-300",
  },
  queued: {
    label: "Queued",
    leftBar: "border-l-zinc-800",
    dot: "bg-zinc-600",
    labelCls: "text-zinc-500",
  },
};

const INITIAL_SESSIONS: OpenCodeSession[] = [
  {
    id: "ses_e2c8",
    serverId: "local",
    title: "Confluence table GitHub Action",
    repo: "vyond/devops",
    status: "question",
    idleSinceLabel: "Waiting for your choice",
    questionPrompt: {
      question: "How should we handle Confluence pages that already have a manual table?",
      options: [
        {
          label: "Replace with native database embed (Recommended)",
          description: "Converts the legacy markdown table into a Confluence database macro",
        },
        {
          label: "Append below existing table",
          description: "Keeps the existing manual table untouched and adds the synced block below",
        },
        {
          label: "Skip & log warning",
          description: "Do not modify pages that already contain manual tables",
        },
      ],
    },
    latestOutcomeMarkdown:
      "Inspected `grafana/push_md_to_confluence.py` on **local** and found 3 staging pages with existing manual tables.",
    checkpoints: [
      {
        id: "c10",
        timeAgo: "18m ago",
        actor: "you",
        summary: "Update sync script to emit Confluence database macro.",
      },
      {
        id: "c11",
        timeAgo: "1m ago",
        actor: "agent",
        summary: "Checked staging pages and asked how to handle existing manual tables.",
        toolBadge: "question",
      },
    ],
  },
  {
    id: "ses_91c2",
    serverId: "devbox",
    title: "Add Grafana SLO panel for auth service",
    repo: "vyond/eks-manifest",
    status: "idle",
    idleSinceLabel: "Idle 2m · waiting for your steer",
    latestOutcomeMarkdown:
      "Added **99.9% availability burn-rate** panel to `monitoring/grafana/auth.json` (+84 -12).\n\n- Uses `sum(rate(http_requests_total{status=~\"5..\"}[5m]))` over 5m and 1h windows\n- Validated JSON schema against Grafana v10",
    checkpoints: [
      {
        id: "c1",
        timeAgo: "14m ago",
        actor: "you",
        summary: "Read monitoring/grafana/auth.json and add a 99.9% availability burn-rate panel.",
      },
      {
        id: "c4",
        timeAgo: "2m ago",
        actor: "agent",
        summary: "Updated PromQL filter and validated dashboard JSON.",
        toolBadge: "edit: monitoring/grafana/auth.json",
      },
    ],
  },
  {
    id: "ses_77b1",
    serverId: "devbox",
    title: "Investigate flaky account pool cleanup",
    repo: "vyond/qa-autotest-account-pool",
    status: "running",
    idleSinceLabel: "Running pytest (01:24 elapsed)…",
    latestOutcomeMarkdown:
      "Running `pytest tests/test_pool_lease.py -n 5` on **devbox** to reproduce DynamoDB lease contention.",
    checkpoints: [
      {
        id: "c20",
        timeAgo: "4m ago",
        actor: "you",
        summary: "Reproduce DynamoDB lease lock race condition with 5 parallel workers.",
      },
    ],
  },
];

const INITIAL_TASKS: FlightTask[] = [
  {
    id: "t1",
    title: "Update Confluence table GitHub Action",
    section: "focus",
    triage: "needs_you",
    serverId: "local",
    repo: "vyond/devops",
    specPrompt:
      "Update .github/workflows/sync-confluence.yml to escape pipe characters in markdown cells.",
    attentionMin: 12,
    agentMin: 8,
    linkedSessionId: "ses_e2c8",
  },
  {
    id: "t2",
    title: "Add Grafana SLO panel for auth service",
    section: "focus",
    triage: "needs_you",
    serverId: "devbox",
    repo: "vyond/eks-manifest",
    specPrompt:
      "Read monitoring/grafana/auth.json and add a 99.9% availability burn-rate panel using 5m and 1h windows.",
    attentionMin: 6,
    agentMin: 11,
    linkedSessionId: "ses_91c2",
  },
  {
    id: "t4",
    title: "Fix flaky account pool cleanup lock",
    section: "focus",
    triage: "working",
    serverId: "devbox",
    repo: "vyond/qa-autotest-account-pool",
    specPrompt:
      "Reproduce DynamoDB lease lock race condition in tests/test_pool_lease.py with 5 parallel workers.",
    attentionMin: 4,
    agentMin: 3,
    linkedSessionId: "ses_77b1",
  },
  {
    id: "t3",
    title: "Upgrade Homelab Caddy reverse proxy config",
    section: "focus",
    triage: "queued",
    serverId: "homelab",
    queuedForServer: true,
    repo: "homelab/infra",
    specPrompt: "Add Tailscale TLS cert renewal hook to Caddyfile and reload service.",
    attentionMin: 3,
    agentMin: 0,
  },
  {
    id: "t5",
    title: "Rotate staging ArgoCD webhook secret",
    section: "buffer",
    triage: "queued",
    serverId: "devbox",
    repo: "vyond/eks-manifest",
    specPrompt: "",
    attentionMin: 2,
    agentMin: 0,
  },
  {
    id: "t6",
    title: "Migrate legacy Jenkins cleanup job to GitHub Actions",
    section: "backlog",
    triage: "queued",
    serverId: "local",
    repo: "vyond/devops",
    specPrompt: "Convert jenkins/jobs/cleanup-ami.groovy into a scheduled GitHub workflow.",
    attentionMin: 0,
    agentMin: 0,
  },
  {
    id: "t8",
    title: "Bump pnpm engine-strict config in next repo",
    section: "done",
    triage: "queued",
    serverId: "local",
    repo: "vyond/next",
    specPrompt: "Set engine-strict=false in .npmrc for Node 25 compatibility.",
    attentionMin: 4,
    agentMin: 7,
  },
];

function shortRepoName(repo?: string) {
  if (!repo) return "";
  return repo.replace(/^vyond\//, "").replace(/^homelab\//, "");
}

function parseTaskInput(
  raw: string,
  servers: ServerNode[],
  defaultServerId: string,
  extraPrompt = "",
  pickedRepo = "",
  pickedServerId = "",
) {
  let text = raw.trim();
  let inlinePrompt = "";
  const slashIdx = text.indexOf("//");
  if (slashIdx !== -1) {
    inlinePrompt = text.slice(slashIdx + 2).trim();
    text = text.slice(0, slashIdx).trim();
  }
  let serverId = pickedServerId || defaultServerId;
  let repo = pickedRepo;

  text = text.replace(/(?:^|\s)~([\w.-]+)(?=\s|$)/, (_, s: string) => {
    const match = servers.find(
      (srv) =>
        srv.id.toLowerCase() === s.toLowerCase() ||
        srv.name.toLowerCase().includes(s.toLowerCase()),
    );
    if (match) serverId = match.id;
    return "";
  });

  const activeSrv = servers.find((s) => s.id === serverId) ?? servers[0];
  text = text.replace(/(?:^|\s)@([\w./-]+)(?=\s|$)/, (_, r: string) => {
    const match = activeSrv.repos.find(
      (k) =>
        k.label.toLowerCase() === r.toLowerCase() ||
        k.label.toLowerCase().endsWith(`/${r.toLowerCase()}`),
    );
    repo = match ? match.label : r;
    return "";
  });

  return {
    title: text.trim() || raw.trim(),
    repo,
    serverId,
    prompt: [inlinePrompt, extraPrompt.trim()].filter(Boolean).join("\n"),
  };
}

export default function MockFlightDeck({ onExitMock }: { onExitMock?: () => void }) {
  const [servers, setServers] = useState<ServerNode[]>(INITIAL_SERVERS);
  const [defaultServerId, setDefaultServerId] = useState<string>("local");
  const [serverFilter, setServerFilter] = useState<string>("all");
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<FlightTask[]>(INITIAL_TASKS);
  const [sessions, setSessions] = useState<OpenCodeSession[]>(INITIAL_SESSIONS);
  const [view, setView] = useState<"focus" | "backlog" | "review" | "servers">("focus");
  const [expandedId, setExpandedId] = useState<string | null>("t1");
  const [newBufferText, setNewBufferText] = useState("");
  const [toast, setToast] = useState<{ msg: string; undo?: () => void } | null>(null);

  const notify = (msg: string, undo?: () => void) => setToast({ msg, undo });

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  const steerAgent = (taskId: string, instruction: string, targetServerOverride?: string) => {
    const target = tasks.find((t) => t.id === taskId);
    if (!target) return;
    const srvId = targetServerOverride || target.serverId || defaultServerId;
    const srv = servers.find((s) => s.id === srvId) ?? servers[0];
    const text = instruction.trim() || target.specPrompt || target.title;

    if (!srv.online) {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId
            ? {
                ...t,
                serverId: srv.id,
                specPrompt: text,
                queuedForServer: true,
                triage: "queued",
              }
            : t,
        ),
      );
      notify(`${srv.id} is offline — queued in Todoist for auto-execution`);
      return;
    }

    const sid = target.linkedSessionId || `ses_${Math.random().toString(16).slice(2, 6)}`;
    const userCheckpoint: Checkpoint = {
      id: `cp_${Date.now()}`,
      timeAgo: "just now",
      actor: "you",
      summary: text,
    };

    if (!target.linkedSessionId) {
      setSessions((prev) => [
        {
          id: sid,
          serverId: srv.id,
          title: target.title,
          repo: target.repo,
          status: "running",
          idleSinceLabel: `Running on ${srv.id}…`,
          latestOutcomeMarkdown: `Executing on **${srv.id}** (\`${target.repo || srv.defaultDir}\`): *${text}*…`,
          checkpoints: [userCheckpoint],
        },
        ...prev,
      ]);
    } else {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sid
            ? {
                ...s,
                serverId: srv.id,
                status: "running",
                questionPrompt: undefined,
                idleSinceLabel: `Running on ${srv.id}…`,
                latestOutcomeMarkdown: `Executing on **${srv.id}** (\`${target.repo || srv.defaultDir}\`): *${text}*…`,
                checkpoints: [...s.checkpoints, userCheckpoint],
              }
            : s,
        ),
      );
    }

    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId
          ? {
              ...t,
              serverId: srv.id,
              queuedForServer: false,
              linkedSessionId: sid,
              triage: "working",
            }
          : t,
      ),
    );
    notify(`Dispatched to ${srv.id}/${shortRepoName(target.repo) || "~"} (${sid})`);
  };

  const toggleServerOnline = (srvId: string) => {
    const targetSrv = servers.find((s) => s.id === srvId);
    if (!targetSrv) return;
    const nextOnline = !targetSrv.online;

    setServers((prev) =>
      prev.map((s) =>
        s.id === srvId
          ? {
              ...s,
              online: nextOnline,
              latencyMs: nextOnline ? Math.floor(12 + Math.random() * 35) : 0,
            }
          : s,
      ),
    );

    if (nextOnline) {
      const waiting = tasks.filter((t) => t.serverId === srvId && t.queuedForServer);
      if (waiting.length > 0) {
        const newSessions: OpenCodeSession[] = [];
        setTasks((prev) =>
          prev.map((t) => {
            if (t.serverId !== srvId || !t.queuedForServer) return t;
            const sid = `ses_${Math.random().toString(16).slice(2, 6)}`;
            newSessions.push({
              id: sid,
              serverId: srvId,
              title: t.title,
              repo: t.repo,
              status: "running",
              idleSinceLabel: `Auto-started on ${srvId}…`,
              latestOutcomeMarkdown: `Auto-started queued task on **${srvId}** (\`${t.repo || targetSrv.defaultDir}\`): *${t.specPrompt || t.title}*`,
              checkpoints: [
                {
                  id: `cp_${Date.now()}`,
                  timeAgo: "just now",
                  actor: "you",
                  summary: t.specPrompt || t.title,
                },
              ],
            });
            return {
              ...t,
              queuedForServer: false,
              linkedSessionId: sid,
              triage: "working",
            };
          }),
        );
        setSessions((prev) => [...newSessions, ...prev]);
        notify(
          `${srvId} connected — auto-started ${waiting.length} queued task${waiting.length > 1 ? "s" : ""}`,
        );
      } else {
        notify(`${srvId} connected`);
      }
    } else {
      notify(`${srvId} offline — new tasks for ${srvId} will queue`);
    }
  };

  const completeTask = (taskId: string) => {
    const prevTasks = tasks;
    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId
          ? { ...t, section: "done", triage: "queued", queuedForServer: false }
          : t,
      ),
    );
    if (expandedId === taskId) setExpandedId(null);
    notify(`Completed · session history preserved`, () => setTasks(prevTasks));
  };

  const simulateEvent = (kind: "finish" | "question") => {
    const working = tasks.find((t) => t.triage === "working") ?? tasks[0];
    if (!working) return;
    if (kind === "finish") {
      setTasks((prev) =>
        prev.map((t) => (t.id === working.id ? { ...t, triage: "needs_you" } : t)),
      );
      if (working.linkedSessionId) {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === working.linkedSessionId
              ? {
                  ...s,
                  status: "idle",
                  questionPrompt: undefined,
                  idleSinceLabel: `Idle on ${s.serverId} · waiting for your steer`,
                  latestOutcomeMarkdown:
                    "All **14 lease contention tests** passed with 5 workers (`pytest tests/test_pool_lease.py`).\n\n- Added exponential backoff around DynamoDB conditional update",
                  checkpoints: [
                    ...s.checkpoints,
                    {
                      id: `cp_${Date.now()}`,
                      timeAgo: "just now",
                      actor: "agent",
                      summary: "Fixed DynamoDB lock contention; 14/14 tests passing.",
                      toolBadge: "shell: pytest tests/test_pool_lease.py",
                    },
                  ],
                }
              : s,
          ),
        );
      }
      notify(`${working.serverId} finished "${working.title}" — Needs You`);
    } else {
      setTasks((prev) =>
        prev.map((t) => (t.id === working.id ? { ...t, triage: "needs_you" } : t)),
      );
      if (working.linkedSessionId) {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === working.linkedSessionId
              ? {
                  ...s,
                  status: "question",
                  idleSinceLabel: `Waiting for your choice on ${s.serverId}`,
                  questionPrompt: {
                    question: "Which lock timeout strategy should we use for the account pool?",
                    options: [
                      {
                        label: "TTL + Heartbeat lease (Recommended)",
                        description: "Auto-expires stale locks after 60s if worker crashes",
                      },
                      {
                        label: "Strict mutex with manual release",
                        description: "Simpler, but requires cleanup job if test runner aborts",
                      },
                    ],
                  },
                }
              : s,
          ),
        );
      }
      notify(`${working.serverId} asked a question on "${working.title}"`);
    }
  };

  const filterByServer = (list: FlightTask[]) =>
    serverFilter === "all" ? list : list.filter((t) => t.serverId === serverFilter);

  const focusTasks = filterByServer(tasks.filter((t) => t.section === "focus")).sort(
    (a, b) => TRIAGE_ORDER[a.triage] - TRIAGE_ORDER[b.triage],
  );
  const bufferTasks = filterByServer(tasks.filter((t) => t.section === "buffer"));
  const backlogTasks = filterByServer(tasks.filter((t) => t.section === "backlog"));
  const doneTasks = filterByServer(tasks.filter((t) => t.section === "done"));

  const needsYouCount = tasks.filter(
    (t) => t.section === "focus" && t.triage === "needs_you",
  ).length;
  const onlineServersCount = servers.filter((s) => s.online).length;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Clean Single-Line Header */}
      <header className="sticky top-0 z-10 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-3">
          <div className="flex shrink-0 items-center gap-2.5">
            <span className="text-[15px] font-semibold tracking-tight text-zinc-100">
              Timebox
            </span>
            <button
              type="button"
              onClick={() => setView(view === "servers" ? "focus" : "servers")}
              className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-zinc-800/90 bg-zinc-900/70 px-2.5 py-1 font-mono text-[11px] leading-none tabular-nums text-zinc-400 transition-colors hover:border-zinc-700 hover:bg-zinc-800/80 hover:text-zinc-200 cursor-pointer"
              title="Verify & configure execution servers and their projects"
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  onlineServersCount > 0 ? "bg-orange-500" : "bg-zinc-600"
                }`}
              />
              <span className="text-zinc-200">
                {onlineServersCount}/{servers.length}
              </span>
              <span className="text-zinc-500">online</span>
            </button>
          </div>

          <nav className="flex items-center gap-1">
            {(["focus", "backlog", "review", "servers"] as const).map((v) => (
              <button
                key={v}
                className={`${btn} capitalize ${
                  view === v ? "bg-zinc-800/90 text-zinc-100 font-medium" : ""
                }`}
                onClick={() => setView(v)}
              >
                {v}
                {v === "focus" && needsYouCount > 0 && (
                  <span className="ml-1.5 font-mono text-[11px] text-orange-400">
                    {needsYouCount}
                  </span>
                )}
                {v === "backlog" && backlogTasks.length > 0 && (
                  <span className="ml-1 font-mono text-[11px] text-zinc-500">
                    {backlogTasks.length}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>

        {/* Quiet Server Filter Bar (only on Focus/Backlog) */}
        {(view === "focus" || view === "backlog") && (
          <div className="border-t border-zinc-900 bg-zinc-950/60">
            <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-2 overflow-x-auto px-4 py-1.5 text-[12px]">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setServerFilter("all")}
                  className={`rounded px-2 py-0.5 font-mono text-[11px] cursor-pointer ${
                    serverFilter === "all"
                      ? "bg-zinc-800 text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  All
                </button>
                {servers.map((srv) => {
                  const active = serverFilter === srv.id;
                  return (
                    <button
                      key={srv.id}
                      type="button"
                      onClick={() => setServerFilter(active ? "all" : srv.id)}
                      className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 font-mono text-[11px] cursor-pointer ${
                        active
                          ? "bg-zinc-800 text-zinc-100"
                          : "text-zinc-500 hover:text-zinc-300"
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          srv.online ? "bg-orange-500" : "bg-zinc-600"
                        }`}
                      />
                      <span>{srv.id}</span>
                      <span className="text-[10px] text-zinc-600">
                        {srv.online ? `${srv.latencyMs}ms` : "offline"}
                      </span>
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={() => setView("servers")}
                className="shrink-0 font-mono text-[11px] text-zinc-500 hover:text-zinc-300 cursor-pointer"
              >
                Configure →
              </button>
            </div>
          </div>
        )}
      </header>

      <main className="mx-auto w-full max-w-5xl px-4 pt-6 pb-20">
        {view === "servers" && (
          <section className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-[15px] font-semibold text-zinc-100">
                  Execution Servers &amp; Projects
                </h2>
                <p className="mt-0.5 text-[13px] text-zinc-500">
                  Each server carries its own repositories and workspace directory.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setServers((prev) =>
                    prev.map((s) =>
                      s.online
                        ? { ...s, latencyMs: Math.floor(10 + Math.random() * 30) }
                        : s,
                    ),
                  );
                  notify(`Verified ${onlineServersCount}/${servers.length} servers online`);
                }}
                className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-[12px] font-medium text-orange-400 hover:border-zinc-700 cursor-pointer"
              >
                Verify all
              </button>
            </div>

            <ul className="space-y-3">
              {servers.map((srv) => {
                const isDefault = defaultServerId === srv.id;
                const isEditing = editingServerId === srv.id;
                const srvSessions = sessions.filter((s) => s.serverId === srv.id);
                const srvQueued = tasks.filter(
                  (t) => t.serverId === srv.id && t.queuedForServer,
                );

                return (
                  <li
                    key={srv.id}
                    className="rounded-md border border-zinc-800/90 bg-zinc-900/40 p-4"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5">
                        <span
                          className={`h-2 w-2 rounded-full ${
                            srv.online ? "bg-orange-500" : "bg-zinc-600"
                          }`}
                        />
                        <span className="text-[14px] font-medium text-zinc-100">
                          {srv.name}
                        </span>
                        <span className="font-mono text-[12px] text-zinc-500">
                          ~{srv.id}
                        </span>
                        {isDefault && (
                          <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                            default
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-3 text-[12px]">
                        <button
                          type="button"
                          onClick={() => toggleServerOnline(srv.id)}
                          className={`font-mono text-[11px] cursor-pointer ${
                            srv.online ? "text-orange-400" : "text-zinc-500 hover:text-zinc-300"
                          }`}
                        >
                          {srv.online
                            ? `${srv.latencyMs}ms · ${srvSessions.length} active`
                            : `offline${srvQueued.length ? ` · ${srvQueued.length} queued` : ""}`}
                        </button>
                        {!isDefault && (
                          <button
                            type="button"
                            onClick={() => {
                              setDefaultServerId(srv.id);
                              notify(`${srv.name} set as default`);
                            }}
                            className="text-zinc-500 hover:text-zinc-300 cursor-pointer"
                          >
                            Set default
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setEditingServerId(isEditing ? null : srv.id)}
                          className="text-zinc-400 hover:text-zinc-200 cursor-pointer"
                        >
                          {isEditing ? "Done" : "Edit"}
                        </button>
                      </div>
                    </div>

                    <div className="mt-1.5 font-mono text-[11px] text-zinc-500">
                      {srv.endpoint} · {srv.defaultDir}
                    </div>

                    {/* Projects / Repos attached to this server */}
                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      <span className="mr-1 text-[11px] text-zinc-500">Projects:</span>
                      {srv.repos.map((r) => (
                        <span
                          key={r.label}
                          title={r.dir}
                          className="rounded border border-zinc-800/80 bg-zinc-950/60 px-2 py-0.5 font-mono text-[11px] text-zinc-300"
                        >
                          {shortRepoName(r.label)}
                        </span>
                      ))}
                    </div>

                    {isEditing && (
                      <div className="mt-4 space-y-3 border-t border-zinc-800/80 pt-3 text-[12px]">
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          <div>
                            <label className="mb-1 block text-[11px] text-zinc-500">
                              Endpoint URL
                            </label>
                            <input
                              value={srv.endpoint}
                              onChange={(e) =>
                                setServers((prev) =>
                                  prev.map((x) =>
                                    x.id === srv.id ? { ...x, endpoint: e.target.value } : x,
                                  ),
                                )
                              }
                              className="w-full rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 font-mono text-zinc-200 outline-none"
                            />
                          </div>
                          <div>
                            <label className="mb-1 block text-[11px] text-zinc-500">
                              Default Workspace Path
                            </label>
                            <input
                              value={srv.defaultDir}
                              onChange={(e) =>
                                setServers((prev) =>
                                  prev.map((x) =>
                                    x.id === srv.id ? { ...x, defaultDir: e.target.value } : x,
                                  ),
                                )
                              }
                              className="w-full rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 font-mono text-zinc-200 outline-none"
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {view === "focus" && (
          <div className="space-y-6">
            {/* Buffer Section */}
            <section>
              <div className="mb-1 flex items-center justify-between px-2">
                <span className="text-[13px] text-zinc-500">Buffer</span>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!newBufferText.trim()) return;
                    const parsed = parseTaskInput(newBufferText, servers, defaultServerId);
                    setTasks((prev) => [
                      ...prev,
                      {
                        id: `t_${Date.now()}`,
                        title: parsed.title,
                        section: "buffer",
                        triage: "queued",
                        serverId: parsed.serverId,
                        repo: parsed.repo,
                        specPrompt: parsed.prompt,
                        attentionMin: 0,
                        agentMin: 0,
                      },
                    ]);
                    setNewBufferText("");
                  }}
                >
                  <input
                    value={newBufferText}
                    onChange={(e) => setNewBufferText(e.target.value)}
                    placeholder="＋ Quick add… (~server @repo)"
                    className="w-52 bg-transparent text-right text-[13px] text-zinc-300 outline-none placeholder:text-zinc-600"
                  />
                </form>
              </div>
              {bufferTasks.length > 0 && (
                <ul className="space-y-1">
                  {bufferTasks.map((t) => (
                    <TriageRow
                      key={t.id}
                      task={t}
                      servers={servers}
                      session={sessions.find((s) => s.id === t.linkedSessionId)}
                      sessions={sessions}
                      expanded={expandedId === t.id}
                      onToggle={() => setExpandedId(expandedId === t.id ? null : t.id)}
                      onSteer={(msg, srvId) => steerAgent(t.id, msg, srvId)}
                      onComplete={() => completeTask(t.id)}
                      onUpdate={(fields) =>
                        setTasks((prev) =>
                          prev.map((x) => (x.id === t.id ? { ...x, ...fields } : x)),
                        )
                      }
                    />
                  ))}
                </ul>
              )}
            </section>

            {/* Focus Section */}
            <section>
              <div className="mb-2 flex items-center justify-between px-2">
                <span className="text-[13px] text-zinc-500">
                  Focus {serverFilter !== "all" ? `· ${serverFilter}` : ""}
                </span>
                <span className="text-[12px] text-zinc-600">
                  Sorted by attention needed
                </span>
              </div>

              <ul className="space-y-1">
                {focusTasks.map((t) => (
                  <TriageRow
                    key={t.id}
                    task={t}
                    large
                    servers={servers}
                    session={sessions.find((s) => s.id === t.linkedSessionId)}
                    sessions={sessions}
                    expanded={expandedId === t.id}
                    onToggle={() => setExpandedId(expandedId === t.id ? null : t.id)}
                    onSteer={(msg, srvId) => steerAgent(t.id, msg, srvId)}
                    onComplete={() => completeTask(t.id)}
                    onUpdate={(fields) =>
                      setTasks((prev) =>
                        prev.map((x) => (x.id === t.id ? { ...x, ...fields } : x)),
                      )
                    }
                  />
                ))}
              </ul>

              <div className="mt-2">
                <TaskComposer
                  servers={servers}
                  defaultServerId={defaultServerId}
                  placeholder="＋ Add to Focus… (Title ~server @repo // prompt or Tab)"
                  onSubmit={(parsed, launchAgent) => {
                    const id = `t_${Date.now()}`;
                    const srv = servers.find((s) => s.id === parsed.serverId) ?? servers[0];
                    let sid: string | undefined;
                    let queuedForServer = false;

                    if (launchAgent) {
                      if (srv.online) {
                        sid = `ses_${Math.random().toString(16).slice(2, 6)}`;
                        setSessions((prev) => [
                          {
                            id: sid!,
                            serverId: srv.id,
                            title: parsed.title,
                            repo: parsed.repo,
                            status: "running",
                            idleSinceLabel: `Running on ${srv.id}…`,
                            latestOutcomeMarkdown: `Executing on **${srv.id}** (\`${parsed.repo || srv.defaultDir}\`): *${parsed.prompt || parsed.title}*…`,
                            checkpoints: [
                              {
                                id: `cp_${Date.now()}`,
                                timeAgo: "just now",
                                actor: "you",
                                summary: parsed.prompt || parsed.title,
                              },
                            ],
                          },
                          ...prev,
                        ]);
                      } else {
                        queuedForServer = true;
                      }
                    }

                    setTasks((prev) => [
                      ...prev,
                      {
                        id,
                        title: parsed.title,
                        section: "focus",
                        triage: sid ? "working" : "queued",
                        serverId: srv.id,
                        queuedForServer,
                        repo: parsed.repo,
                        specPrompt: parsed.prompt,
                        attentionMin: 0,
                        agentMin: 0,
                        linkedSessionId: sid,
                      },
                    ]);

                    notify(
                      sid
                        ? `Dispatched to ${srv.id}/${shortRepoName(parsed.repo) || "~"} (${sid})`
                        : queuedForServer
                          ? `${srv.id} offline — queued in Todoist`
                          : `Added "${parsed.title}"`,
                    );
                  }}
                />
              </div>
            </section>
          </div>
        )}

        {view === "backlog" && (
          <section className="space-y-3">
            <TaskComposer
              alwaysOpen
              disableAgentAction
              servers={servers}
              defaultServerId={defaultServerId}
              placeholder="＋ Add to Backlog… (Title ~server @repo // prompt or Tab)"
              onSubmit={(parsed) => {
                const srv = servers.find((s) => s.id === parsed.serverId) ?? servers[0];
                setTasks((prev) => [
                  ...prev,
                  {
                    id: `t_${Date.now()}`,
                    title: parsed.title,
                    section: "backlog",
                    triage: "queued",
                    serverId: srv.id,
                    queuedForServer: false,
                    repo: parsed.repo,
                    specPrompt: parsed.prompt,
                    attentionMin: 0,
                    agentMin: 0,
                  },
                ]);
              }}
            />
            <ul className="space-y-1">
              {backlogTasks.map((t) => (
                <li
                  key={t.id}
                  className="flex min-h-11 items-center justify-between gap-2 rounded-md border-l-2 border-l-zinc-800 px-3 hover:bg-zinc-900/60"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[14px] text-zinc-200">{t.title}</span>
                      <span className="shrink-0 font-mono text-[11px] text-zinc-500">
                        {t.serverId}
                        {t.repo ? `/${shortRepoName(t.repo)}` : ""}
                      </span>
                    </div>
                    {t.specPrompt && (
                      <span className="block truncate text-[12px] text-zinc-500">
                        {t.specPrompt}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => {
                      setTasks((prev) =>
                        prev.map((x) => (x.id === t.id ? { ...x, section: "focus" } : x)),
                      );
                      notify("Pulled into Focus");
                    }}
                    className={btn}
                  >
                    → Focus
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {view === "review" && (
          <section className="space-y-6">
            <div>
              <p className="mb-2 px-2 text-[13px] text-zinc-500">Done today</p>
              <ul className="divide-y divide-zinc-900">
                {doneTasks.map((t) => (
                  <li
                    key={t.id}
                    className="flex items-center justify-between px-2 py-2.5 text-[14px]"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-zinc-400 line-through">{t.title}</span>
                      <span className="font-mono text-[11px] text-zinc-500">
                        {t.serverId}
                        {t.repo ? `/${shortRepoName(t.repo)}` : ""}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 font-mono text-[12px] text-zinc-500">
                      {t.linkedSessionId && (
                        <span className="text-zinc-400">{t.linkedSessionId} ↗</span>
                      )}
                      <span>
                        {t.attentionMin}m you · {t.agentMin}m ai
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}
      </main>

      {/* Quiet bottom simulation bar */}
      <footer className="fixed inset-x-0 bottom-0 border-t border-zinc-900 bg-zinc-950/95 px-4 py-2 text-[12px] text-zinc-500">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-2">
          <span>Interactive Mockup</span>
          <div className="flex items-center gap-2">
            <button onClick={() => simulateEvent("finish")} className={btn}>
              Simulate Turn Done
            </button>
            <button onClick={() => simulateEvent("question")} className={btn}>
              Simulate Question
            </button>
            <button onClick={() => toggleServerOnline("homelab")} className={btn}>
              {servers.find((s) => s.id === "homelab")?.online
                ? "Disconnect homelab"
                : "Connect homelab"}
            </button>
            {onExitMock && (
              <button onClick={onExitMock} className={`${btn} text-orange-500`}>
                Live App →
              </button>
            )}
          </div>
        </div>
      </footer>

      {toast && (
        <div className="fixed bottom-12 left-1/2 z-40 -translate-x-1/2 rounded-md border border-zinc-800 bg-zinc-900 px-4 py-2 text-[13px] whitespace-nowrap">
          {toast.msg}
          {toast.undo && (
            <button
              className="ml-2 text-orange-500 cursor-pointer"
              onClick={() => {
                toast.undo?.();
                setToast(null);
              }}
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TriageRow({
  task,
  large,
  servers,
  session,
  expanded,
  onToggle,
  onSteer,
  onComplete,
  onUpdate,
}: {
  task: FlightTask;
  large?: boolean;
  servers: ServerNode[];
  session?: OpenCodeSession;
  sessions: OpenCodeSession[];
  expanded: boolean;
  onToggle: () => void;
  onSteer: (instruction: string, serverIdOverride?: string) => void;
  onComplete: () => void;
  onUpdate: (fields: Partial<FlightTask>) => void;
}) {
  const [steerInput, setSteerInput] = useState("");
  const [showCheckpoints, setShowCheckpoints] = useState(false);

  const ui = TRIAGE_UI[task.triage];
  const hasQuestion = Boolean(session?.questionPrompt);
  const srv = servers.find((s) => s.id === task.serverId) ?? servers[0];
  const repoShort = shortRepoName(task.repo || session?.repo);
  const targetBadge = repoShort ? `${srv.id}/${repoShort}` : srv.id;

  const firstOutcomeLine = session?.latestOutcomeMarkdown
    ? session.latestOutcomeMarkdown
        .replace(/```[\s\S]*?```/g, "")
        .replace(/[*`#-]/g, "")
        .replace(/\s+/g, " ")
        .trim()
    : "";

  const subline = hasQuestion
    ? `Question: ${session?.questionPrompt?.question}`
    : task.queuedForServer
      ? `Queued for ${srv.id} (offline) · ${task.specPrompt || ""}`
      : firstOutcomeLine || task.specPrompt || "";

  const submitSteer = (textOverride?: string, srvOverride?: string) => {
    const msg = (textOverride ?? steerInput).trim() || task.specPrompt || task.title;
    onSteer(msg, srvOverride);
    setSteerInput("");
  };

  return (
    <li
      className={`rounded-md border-l-2 transition-colors duration-150 ${
        expanded
          ? "border-l-orange-500 bg-zinc-900/80 ring-1 ring-zinc-800"
          : `${ui.leftBar} hover:bg-zinc-900/50`
      }`}
    >
      {/* Collapsed Header Row */}
      <div className={`flex items-center gap-3 px-3 ${large ? "min-h-13" : "min-h-10"}`}>
        <button
          onClick={onComplete}
          title="Mark task Done"
          className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded border border-zinc-700 text-[10px] text-transparent hover:border-orange-500 hover:text-orange-400 cursor-pointer"
        >
          ✓
        </button>

        <button
          onClick={onToggle}
          className="min-w-0 flex-1 py-2 text-left cursor-pointer"
        >
          <div className="flex items-center gap-2">
            <span
              className={`truncate ${
                large ? "text-[15px] font-medium text-zinc-100" : "text-[14px] text-zinc-200"
              }`}
            >
              {task.title}
            </span>
            <span
              className="shrink-0 font-mono text-[11px] text-zinc-500"
              title={`Target: ${srv.name} (${task.repo || srv.defaultDir})`}
            >
              {targetBadge}
            </span>
          </div>
          {subline && (
            <span
              className={`block truncate text-[12px] ${
                hasQuestion || task.queuedForServer
                  ? "text-orange-400"
                  : task.triage === "needs_you"
                    ? "text-zinc-300"
                    : "text-zinc-500"
              }`}
            >
              {subline}
            </span>
          )}
        </button>

        {/* Right Triage Status + Primary Action */}
        <div className="flex shrink-0 items-center gap-2.5">
          <span
            className={`inline-flex items-center gap-1.5 font-mono text-[12px] ${
              task.queuedForServer ? "text-orange-400" : ui.labelCls
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                task.queuedForServer ? "bg-orange-500" : ui.dot
              }`}
            />
            {hasQuestion
              ? "Question"
              : task.queuedForServer
                ? "Queued"
                : ui.label}
          </span>

          {!session && !task.queuedForServer && (
            <button
              onClick={() => submitSteer()}
              title={srv.online ? `Run on ${targetBadge}` : `Queue for ${targetBadge}`}
              aria-label={srv.online ? `Run on ${targetBadge}` : `Queue for ${targetBadge}`}
              className="rounded px-2 py-1 text-[12px] text-orange-500 hover:bg-zinc-800 cursor-pointer"
            >
              ▶
            </button>
          )}
        </div>
      </div>

      {/* Expanded Drawer — Single Clean Surface */}
      {expanded && (
        <div className="row-expand">
          <div className="space-y-3 border-t border-zinc-800/70 px-3.5 pt-3 pb-3.5">
            {/* 1. Target Bar: Editable before start, locked read-only once session starts */}
            {session ? (
              <div className="flex items-center justify-between gap-2 text-[12px]">
                <div className="flex min-w-0 items-center gap-2 font-mono text-[11px] text-zinc-400">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      srv.online ? "bg-orange-500" : "bg-zinc-600"
                    }`}
                  />
                  <span className="font-medium text-zinc-200">{targetBadge}</span>
                  <span className="truncate text-zinc-600">
                    {srv.repos.find((r) => r.label === (task.repo || session.repo))?.dir ||
                      srv.defaultDir}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(`opencode -s ${session.id}`)}
                  title={`Copy "opencode -s ${session.id}"`}
                  className="shrink-0 font-mono text-[11px] text-zinc-500 hover:text-zinc-300 cursor-pointer"
                >
                  {session.id} ↗
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-zinc-500">Target:</span>
                  {servers.map((s) => {
                    const active = task.serverId === s.id;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => {
                          const hasCurrentRepo = s.repos.some((r) => r.label === task.repo);
                          onUpdate({
                            serverId: s.id,
                            repo: hasCurrentRepo ? task.repo : (s.repos[0]?.label ?? ""),
                            queuedForServer: task.queuedForServer && !s.online,
                          });
                        }}
                        className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 font-mono text-[11px] cursor-pointer ${
                          active
                            ? "bg-zinc-200 font-medium text-zinc-950"
                            : "bg-zinc-800/70 text-zinc-400 hover:text-zinc-200"
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            s.online
                              ? active
                                ? "bg-orange-600"
                                : "bg-orange-500"
                              : "bg-zinc-600"
                          }`}
                        />
                        <span>{s.id}</span>
                      </button>
                    );
                  })}

                  <span className="text-zinc-600">/</span>

                  <select
                    value={task.repo}
                    onChange={(e) => onUpdate({ repo: e.target.value })}
                    className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 font-mono text-[11px] text-zinc-200 outline-none"
                  >
                    <option value="">~ ({srv.defaultDir})</option>
                    {srv.repos.map((r) => (
                      <option key={r.label} value={r.label}>
                        {shortRepoName(r.label)} ({r.dir})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {/* 2. OpenCode Question Option Picker */}
            {hasQuestion && session?.questionPrompt && (
              <div className="space-y-1.5 border-l-2 border-l-orange-500 pl-3 py-0.5 text-[13px]">
                <div className="font-medium text-zinc-100">
                  {session.questionPrompt.question}
                </div>
                <div className="grid gap-1.5 pt-1">
                  {session.questionPrompt.options.map((opt) => (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => submitSteer(opt.label)}
                      className="flex flex-col items-start rounded border border-zinc-800 bg-zinc-950/80 px-3 py-2 text-left hover:border-orange-500/60 cursor-pointer"
                    >
                      <span className="text-[13px] font-medium text-zinc-100">
                        {opt.label}
                      </span>
                      <span className="text-[12px] text-zinc-400">
                        {opt.description}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 3. Latest Outcome (Markdown) + Checkpoints */}
            {session && (
              <div className="space-y-2 border-t border-zinc-800/60 pt-2.5">
                <div className="max-h-52 overflow-y-auto">
                  <SimpleMarkdown text={session.latestOutcomeMarkdown} />
                </div>

                {session.checkpoints.length > 0 && (
                  <div>
                    <button
                      type="button"
                      onClick={() => setShowCheckpoints((s) => !s)}
                      className="font-mono text-[11px] text-zinc-500 hover:text-zinc-300 cursor-pointer"
                    >
                      {showCheckpoints ? "▾" : "▸"} {session.checkpoints.length} checkpoints
                    </button>

                    {showCheckpoints && (
                      <ol className="mt-1.5 space-y-1.5 border-l border-zinc-800 pl-3 text-[12px]">
                        {session.checkpoints.map((cp) => (
                          <li key={cp.id} className="text-zinc-400">
                            <span className="font-mono text-[11px] text-zinc-500">
                              {cp.actor === "you" ? "you" : session.serverId} · {cp.timeAgo}:{" "}
                            </span>
                            <span className="text-zinc-300">{cp.summary}</span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* 4. Steer / Prompt Composer */}
            <div className="rounded-md border border-zinc-800 bg-zinc-950 p-2.5 focus-within:border-zinc-700">
              <textarea
                rows={2}
                value={session ? steerInput : task.specPrompt}
                onChange={(e) => {
                  if (session) setSteerInput(e.target.value);
                  else onUpdate({ specPrompt: e.target.value });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    submitSteer();
                  }
                }}
                placeholder={
                  session
                    ? `Steer OpenCode on ${targetBadge}…`
                    : `Prompt for ${targetBadge}…`
                }
                className="w-full resize-none bg-transparent text-[13px] leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-600"
              />

              <div className="mt-1.5 flex items-center justify-between border-t border-zinc-900 pt-1.5 text-[12px]">
                <span className="font-mono text-[11px] text-zinc-500">
                  {srv.online
                    ? `${srv.endpoint} (${srv.latencyMs}ms)`
                    : `${srv.id} offline · queues in Todoist`}
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => onUpdate({ section: "backlog" })}
                    title="Move to Backlog"
                    aria-label="Move to Backlog"
                    className="inline-flex h-7 w-7 items-center justify-center rounded text-[14px] text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 cursor-pointer"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={onComplete}
                    title="Done"
                    aria-label="Done"
                    className="inline-flex h-7 w-7 items-center justify-center rounded text-[14px] text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 cursor-pointer"
                  >
                    ✓
                  </button>
                  <button
                    type="button"
                    onClick={() => submitSteer()}
                    title={
                      session
                        ? "Send Steer (⌘↵)"
                        : srv.online
                          ? `Run on ${targetBadge} (⌘↵)`
                          : `Queue for ${targetBadge} (⌘↵)`
                    }
                    aria-label={
                      session
                        ? "Send Steer"
                        : srv.online
                          ? `Run on ${targetBadge}`
                          : `Queue for ${targetBadge}`
                    }
                    className="inline-flex h-7 w-7 items-center justify-center rounded bg-orange-600 text-[13px] font-medium text-white hover:bg-orange-500 cursor-pointer"
                  >
                    {session ? "↑" : "▶"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

function TaskComposer({
  placeholder,
  alwaysOpen,
  disableAgentAction = false,
  servers,
  defaultServerId,
  onSubmit,
}: {
  placeholder: string;
  alwaysOpen?: boolean;
  disableAgentAction?: boolean;
  servers: ServerNode[];
  defaultServerId: string;
  onSubmit: (
    parsed: { title: string; repo: string; serverId: string; prompt: string },
    launchAgent: boolean,
  ) => void;
}) {
  const [titleRaw, setTitleRaw] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [promptText, setPromptText] = useState("");
  const [pickedServerId, setPickedServerId] = useState(defaultServerId);
  const [pickedRepo, setPickedRepo] = useState("");
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setPickedServerId(defaultServerId);
  }, [defaultServerId]);

  const parsedPreview = parseTaskInput(
    titleRaw,
    servers,
    defaultServerId,
    promptText,
    showDetails ? pickedRepo : "",
    showDetails ? pickedServerId : "",
  );
  const targetSrv = servers.find((s) => s.id === parsedPreview.serverId) ?? servers[0];
  const targetLabel = parsedPreview.repo
    ? `${targetSrv.id}/${shortRepoName(parsedPreview.repo)}`
    : targetSrv.id;

  const submit = (launchAgent: boolean) => {
    if (!titleRaw.trim()) return;
    onSubmit(parsedPreview, launchAgent);
    setTitleRaw("");
    setPromptText("");
    if (!alwaysOpen) setShowDetails(false);
  };

  return (
    <div
      className={`rounded-md border transition-colors ${
        showDetails || titleRaw
          ? "border-zinc-800 bg-zinc-900/60"
          : "border-transparent hover:bg-zinc-900/30"
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <input
          value={titleRaw}
          onChange={(e) => setTitleRaw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Tab" && !e.shiftKey && !showDetails && titleRaw.trim()) {
              e.preventDefault();
              setShowDetails(true);
              setTimeout(() => promptRef.current?.focus(), 20);
            } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit(disableAgentAction ? false : true);
            } else if (e.key === "Enter" && !showDetails) {
              e.preventDefault();
              submit(false);
            } else if (e.key === "Escape") {
              setShowDetails(false);
            }
          }}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent text-[14px] text-zinc-100 outline-none placeholder:text-zinc-600"
        />
        <button
          type="button"
          onClick={() => setShowDetails((s) => !s)}
          className="shrink-0 rounded px-2 py-0.5 font-mono text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 cursor-pointer"
        >
          {showDetails ? "Hide" : `${targetLabel} ▾`}
        </button>
      </div>

      {showDetails && (
        <div className="space-y-2.5 border-t border-zinc-800/70 px-3 pt-2.5 pb-3 text-[12px]">
          {/* Single Unified Server → Project Bar */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-zinc-500">Target:</span>
            {servers.map((s) => {
              const active = targetSrv.id === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    setPickedServerId(s.id);
                    if (!s.repos.some((r) => r.label === pickedRepo)) {
                      setPickedRepo(s.repos[0]?.label ?? "");
                    }
                  }}
                  className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 font-mono text-[11px] cursor-pointer ${
                    active
                      ? "bg-zinc-200 font-medium text-zinc-950"
                      : "bg-zinc-800/70 text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      s.online
                        ? active
                          ? "bg-orange-600"
                          : "bg-orange-500"
                        : "bg-zinc-600"
                    }`}
                  />
                  <span>{s.id}</span>
                </button>
              );
            })}

            <span className="text-zinc-600">/</span>

            <select
              value={pickedRepo}
              onChange={(e) => setPickedRepo(e.target.value)}
              className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 font-mono text-[11px] text-zinc-200 outline-none"
            >
              <option value="">~ ({targetSrv.defaultDir})</option>
              {targetSrv.repos.map((r) => (
                <option key={r.label} value={r.label}>
                  {shortRepoName(r.label)} ({r.dir})
                </option>
              ))}
            </select>
          </div>

          <textarea
            ref={promptRef}
            rows={2}
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit(disableAgentAction ? false : true);
              }
            }}
            placeholder={`Prompt for ${targetLabel}…`}
            className="w-full resize-none rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-[13px] text-zinc-200 outline-none placeholder:text-zinc-600"
          />

          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[11px] text-zinc-500">
              {disableAgentAction
                ? "Enter or ⌘Enter saves to Backlog"
                : targetSrv.online
                ? `${targetSrv.endpoint} (${targetSrv.latencyMs}ms)`
                : `${targetSrv.id} offline · queues in Todoist`}
            </span>
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={() => submit(false)} className={btn}>
                Save task
              </button>
              {!disableAgentAction && (
                <button
                  type="button"
                  onClick={() => submit(true)}
                  className="rounded bg-orange-600 px-3 py-1 text-[12px] font-medium text-white hover:bg-orange-500 cursor-pointer"
                >
                  {targetSrv.online
                    ? `Run on ${targetLabel} ⌘↵`
                    : `Queue for ${targetLabel} ⌘↵`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
