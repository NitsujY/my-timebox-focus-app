import { useEffect, useState } from "react";
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
};

type QuestionOption = {
  label: string;
  description: string;
};

type PermissionPrompt = {
  action: string;
  command: string;
};

type FileDiffMock = {
  file: string;
  shortFile: string;
  additions: number;
  deletions: number;
  patch: string;
};

type ToolStepMock = {
  label: string;
  status: "completed" | "running";
};

type OpenCodeSession = {
  id: string;
  serverId: string;
  model: string;
  title: string;
  repo: string;
  status: "running" | "idle" | "question" | "permission";
  elapsedSec: number;
  statusSummary: string;
  questionPrompt?: {
    question: string;
    options: QuestionOption[];
  };
  permissionPrompt?: PermissionPrompt;
  recentTools?: ToolStepMock[];
  filesChanged?: FileDiffMock[];
  latestOutcomeMarkdown: string;
  checkpoints: Checkpoint[];
};

type FlightTask = {
  id: string;
  title: string;
  section: "focus" | "buffer" | "backlog" | "done";
  triage: TriageState;
  priority: number;
  plannedMin: number;
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
    endpoint: "https://opencode-homelab.taila12039.ts.net/api",
    defaultDir: "/workspace",
    online: false,
    latencyMs: 0,
    repos: [
      { label: "my-timebox-focus-app", dir: "/workspace/my-timebox-focus-app" },
      { label: "homelab/infra", dir: "/workspace/infra" },
    ],
  },
];

const INITIAL_SESSIONS: OpenCodeSession[] = [
  {
    id: "ses_e2c8",
    serverId: "local",
    model: "claude-sonnet-4",
    title: "Update Confluence table GitHub Action",
    repo: "vyond/devops",
    status: "question",
    elapsedSec: 480,
    statusSummary: "Question",
    questionPrompt: {
      question: "How should we handle Confluence pages that already contain a manual table?",
      options: [
        {
          label: "Replace with database macro",
          description: "Converts existing markdown tables into native Confluence databases",
        },
        {
          label: "Append below existing table",
          description: "Leaves manual tables untouched and appends the synced block",
        },
        {
          label: "Skip and log warning",
          description: "Leaves pages with manual tables unchanged during sync",
        },
      ],
    },
    latestOutcomeMarkdown:
      "Inspected `grafana/push_md_to_confluence.py` on **local** and found 3 staging pages with manual tables.\n\nChoose how the sync script should treat those pages before I write the patch.",
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
        summary: "Found 3 staging pages with manual tables; waiting for migration choice.",
      },
    ],
  },
  {
    id: "ses_44a9",
    serverId: "local",
    model: "claude-sonnet-4",
    title: "Rotate staging ArgoCD webhook secret",
    repo: "vyond/eks-manifest",
    status: "permission",
    elapsedSec: 195,
    statusSummary: "Permission",
    permissionPrompt: {
      action: "shell",
      command: "kubectl -n argocd create secret generic webhook-secret --dry-run=client -o yaml",
    },
    recentTools: [
      { label: "read argocd/overlays/staging/kustomization.yaml", status: "completed" },
      { label: "kubectl -n argocd create secret --dry-run=client", status: "running" },
    ],
    latestOutcomeMarkdown:
      "Prepared the sealed secret manifest for `argocd/overlays/staging`. Approve the dry-run `kubectl` command to validate the generated secret schema.",
    checkpoints: [
      {
        id: "c30",
        timeAgo: "3m ago",
        actor: "you",
        summary: "Rotate staging ArgoCD webhook secret and validate sealed-secret manifest.",
      },
    ],
  },
  {
    id: "ses_91c2",
    serverId: "devbox",
    model: "claude-sonnet-4",
    title: "Add Grafana SLO panel for auth service",
    repo: "vyond/eks-manifest",
    status: "idle",
    elapsedSec: 660,
    statusSummary: "Review diff",
    filesChanged: [
      {
        file: "monitoring/grafana/auth.json",
        shortFile: "grafana/auth.json",
        additions: 84,
        deletions: 12,
        patch: `@@ -142,8 +142,24 @@
-      "title": "Auth Availability (Legacy)",
-      "expr": "avg(up{job=\\"auth-service\\"})"
+      "title": "Auth 99.9% SLO Burn Rate (5m / 1h)",
+      "targets": [
+        {
+          "expr": "sum(rate(http_requests_total{service=\\"auth\\",status=~\\"5..\\"}[5m])) / sum(rate(http_requests_total{service=\\"auth\\"}[5m]))",
+          "legendFormat": "5m error ratio"
+        },
+        {
+          "expr": "sum(rate(http_requests_total{service=\\"auth\\",status=~\\"5..\\"}[1h])) / sum(rate(http_requests_total{service=\\"auth\\"}[1h]))",
+          "legendFormat": "1h error ratio"
+        }
+      ]`,
      },
      {
        file: "monitoring/alerts/auth-slo.yaml",
        shortFile: "alerts/auth-slo.yaml",
        additions: 19,
        deletions: 2,
        patch: `@@ -12,4 +12,11 @@
-  - alert: AuthHighErrorRate
-    expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.05
+  - alert: AuthSLOBurnRateFast
+    expr: (sum(rate(http_requests_total{service="auth",status=~"5.."}[5m])) / sum(rate(http_requests_total{service="auth"}[5m]))) > (14.4 * 0.001)
+    for: 2m`,
      },
    ],
    latestOutcomeMarkdown:
      "Added the **99.9% availability burn-rate** panel to `monitoring/grafana/auth.json` (+84 -12) and updated multi-window alert thresholds.\n\n- Uses `sum(rate(http_requests_total{status=~\"5..\"}[5m]))` over 5m and 1h windows\n- Validated JSON schema against Grafana v10",
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
      },
    ],
  },
  {
    id: "ses_77b1",
    serverId: "devbox",
    model: "claude-sonnet-4",
    title: "Fix flaky account pool cleanup lock",
    repo: "vyond/qa-autotest-account-pool",
    status: "running",
    elapsedSec: 142,
    statusSummary: "pytest -n 5",
    recentTools: [
      { label: "read src/pool/lease_lock.py", status: "completed" },
      { label: "edit src/pool/lease_lock.py", status: "completed" },
      { label: "pytest tests/test_pool_lease.py -n 5", status: "running" },
    ],
    filesChanged: [
      {
        file: "src/pool/lease_lock.py",
        shortFile: "pool/lease_lock.py",
        additions: 28,
        deletions: 6,
        patch: `@@ -44,6 +44,14 @@
-    table.update_item(Key={"account_id": acc_id})
+    table.update_item(
+        Key={"account_id": acc_id},
+        ConditionExpression="attribute_not_exists(lease_owner) OR lease_expires_at < :now",
+    )`,
      },
    ],
    latestOutcomeMarkdown:
      "Running `pytest tests/test_pool_lease.py -n 5` on **devbox** to verify the conditional DynamoDB lease lock fix under 5 parallel workers.",
    checkpoints: [
      {
        id: "c20",
        timeAgo: "4m ago",
        actor: "you",
        summary: "Reproduce DynamoDB lease lock race condition with 5 parallel workers.",
      },
    ],
  },
  {
    id: "ses_88d4",
    serverId: "local",
    model: "gemini-2.5-pro",
    title: "Audit Vite bundle chunk splitting",
    repo: "my-timebox-focus-app",
    status: "running",
    elapsedSec: 54,
    statusSummary: "vite build",
    recentTools: [
      { label: "read vite.config.ts", status: "completed" },
      { label: "vite build --mode analyze", status: "running" },
    ],
    latestOutcomeMarkdown:
      "Inspecting `vite.config.ts` and running a production build check to measure chunk sizes.",
    checkpoints: [
      {
        id: "c41",
        timeAgo: "1m ago",
        actor: "you",
        summary: "Check bundle size and split vendor chunks if needed.",
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
    priority: 4,
    plannedMin: 15,
    serverId: "local",
    repo: "vyond/devops",
    specPrompt:
      "Update .github/workflows/sync-confluence.yml to escape pipe characters in markdown cells.",
    attentionMin: 12,
    agentMin: 8,
    linkedSessionId: "ses_e2c8",
  },
  {
    id: "t5",
    title: "Rotate staging ArgoCD webhook secret",
    section: "focus",
    triage: "needs_you",
    priority: 3,
    plannedMin: 10,
    serverId: "local",
    repo: "vyond/eks-manifest",
    specPrompt: "Rotate staging ArgoCD webhook secret and validate sealed-secret manifest.",
    attentionMin: 2,
    agentMin: 3,
    linkedSessionId: "ses_44a9",
  },
  {
    id: "t2",
    title: "Add Grafana SLO panel for auth service",
    section: "focus",
    triage: "needs_you",
    priority: 4,
    plannedMin: 25,
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
    priority: 3,
    plannedMin: 25,
    serverId: "devbox",
    repo: "vyond/qa-autotest-account-pool",
    specPrompt:
      "Reproduce DynamoDB lease lock race condition in tests/test_pool_lease.py with 5 parallel workers.",
    attentionMin: 4,
    agentMin: 3,
    linkedSessionId: "ses_77b1",
  },
  {
    id: "t9",
    title: "Audit Vite bundle chunk splitting",
    section: "focus",
    triage: "working",
    priority: 2,
    plannedMin: 15,
    serverId: "local",
    repo: "my-timebox-focus-app",
    specPrompt: "Check bundle size and split vendor chunks if needed.",
    attentionMin: 1,
    agentMin: 1,
    linkedSessionId: "ses_88d4",
  },
  {
    id: "t3",
    title: "Upgrade Homelab Caddy reverse proxy config",
    section: "focus",
    triage: "queued",
    priority: 3,
    plannedMin: 15,
    serverId: "homelab",
    queuedForServer: true,
    repo: "homelab/infra",
    specPrompt: "Add Tailscale TLS cert renewal hook to Caddyfile and reload service.",
    attentionMin: 3,
    agentMin: 0,
  },
  {
    id: "t7",
    title: "Set Node 25 engine-strict flag in qa-autotest",
    section: "focus",
    triage: "queued",
    priority: 2,
    plannedMin: 10,
    serverId: "devbox",
    repo: "vyond/qa-autotest-account-pool",
    specPrompt: "Ensure .npmrc sets engine-strict=false and verify pnpm install.",
    attentionMin: 0,
    agentMin: 0,
  },
  {
    id: "t10",
    title: "Review IAM least-privilege S3 policy on PR #418",
    section: "buffer",
    triage: "queued",
    priority: 2,
    plannedMin: 5,
    serverId: "local",
    repo: "vyond/devops",
    specPrompt: "Check PR #418 comments on least-privilege S3 policy.",
    attentionMin: 0,
    agentMin: 0,
  },
];

/* One System: Two Button Styles, One Radius Scale, Max 2 Boxes Deep */
const btnPrimary =
  "inline-flex min-h-9 items-center justify-center rounded-md bg-orange-600 px-3.5 py-1.5 text-[13px] font-medium text-white transition-all duration-150 hover:bg-orange-500 active:translate-y-px cursor-pointer";
const btnSecondary =
  "inline-flex min-h-9 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-[13px] font-medium text-zinc-200 transition-all duration-150 hover:border-zinc-700 hover:bg-zinc-800/90 active:translate-y-px cursor-pointer";
const btnGhost =
  "inline-flex min-h-9 items-center justify-center rounded-md px-2.5 py-1.5 text-[13px] text-zinc-400 transition-colors duration-150 hover:bg-zinc-900 hover:text-zinc-100 cursor-pointer";

function shortRepoName(repo?: string) {
  if (!repo) return "";
  return repo.replace(/^vyond\//, "").replace(/^homelab\//, "");
}

function fmtSec(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export default function MockFlightDeck({ onExitMock }: { onExitMock?: () => void }) {
  const [servers] = useState<ServerNode[]>(INITIAL_SERVERS);
  const [defaultServerId] = useState<string>("local");
  const [tasks, setTasks] = useState<FlightTask[]>(INITIAL_TASKS);
  const [sessions, setSessions] = useState<OpenCodeSession[]>(INITIAL_SESSIONS);
  const [archMode, setArchMode] = useState<"triage-sidebar" | "focus-plus-rail">(
    "triage-sidebar",
  );
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("tb_sidebar_width"));
    return saved >= 280 && saved <= 720 ? saved : 400;
  });
  const [isResizing, setIsResizing] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>("t1");
  const [mobileShowDetail, setMobileShowDetail] = useState(false);
  const [quickAddText, setQuickAddText] = useState("");
  const [toast, setToast] = useState<{ msg: string; undo?: () => void } | null>(null);

  const notify = (msg: string, undo?: () => void) => setToast({ msg, undo });

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    const iv = setInterval(() => {
      setSessions((prev) =>
        prev.map((s) =>
          s.status === "running" ? { ...s, elapsedSec: s.elapsedSec + 1 } : s,
        ),
      );
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  const advanceToNextWaiting = (actedTaskId: string, updatedTasks: FlightTask[]) => {
    if (selectedTaskId !== actedTaskId) return;
    const nextWaiting = updatedTasks.filter(
      (t) =>
        (t.section === "focus" || t.section === "buffer") &&
        t.triage === "needs_you" &&
        t.id !== actedTaskId,
    );
    if (nextWaiting.length > 0) {
      setSelectedTaskId(nextWaiting[0].id);
    } else {
      const nextWorking = updatedTasks.find(
        (t) => (t.section === "focus" || t.section === "buffer") && t.triage === "working",
      );
      if (nextWorking) setSelectedTaskId(nextWorking.id);
    }
  };

  const steerAgent = (taskId: string, instruction: string) => {
    const target = tasks.find((t) => t.id === taskId);
    if (!target) return;
    const srv = servers.find((s) => s.id === target.serverId) ?? servers[0];
    const text = instruction.trim() || target.specPrompt || target.title;

    if (!srv.online) {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId
            ? { ...t, specPrompt: text, queuedForServer: true, triage: "queued" }
            : t,
        ),
      );
      notify(`${srv.id} is offline — task queued`);
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
          model: "claude-sonnet-4",
          title: target.title,
          repo: target.repo,
          status: "running",
          elapsedSec: 1,
          statusSummary: "starting",
          recentTools: [
            { label: `inspect ${shortRepoName(target.repo) || "workspace"}`, status: "running" },
          ],
          latestOutcomeMarkdown: `Running on **${srv.id}** (\`${target.repo || srv.defaultDir}\`): *${text}*`,
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
                status: "running",
                questionPrompt: undefined,
                permissionPrompt: undefined,
                statusSummary: "running",
                recentTools: [
                  ...(s.recentTools ?? []).map((rt) => ({ ...rt, status: "completed" as const })),
                  { label: text.slice(0, 48), status: "running" as const },
                ].slice(-3),
                latestOutcomeMarkdown: `Running on **${srv.id}** (\`${target.repo || srv.defaultDir}\`): *${text}*`,
                checkpoints: [...s.checkpoints, userCheckpoint],
              }
            : s,
        ),
      );
    }

    const nextTasks = tasks.map((t) =>
      t.id === taskId
        ? {
            ...t,
            section: "focus" as const,
            queuedForServer: false,
            linkedSessionId: sid,
            triage: "working" as const,
          }
        : t,
    );
    setTasks(nextTasks);
    notify(`Sent to ${srv.id}/${shortRepoName(target.repo)}`);
  };

  const approvePermission = (taskId: string, decision: "once" | "always" | "reject") => {
    const target = tasks.find((t) => t.id === taskId);
    if (!target?.linkedSessionId) return;
    if (decision === "reject") {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === target.linkedSessionId
            ? {
                ...s,
                status: "idle",
                permissionPrompt: undefined,
                statusSummary: "Command rejected",
              }
            : s,
        ),
      );
      notify(`Rejected command on ${target.serverId}`);
      return;
    }
    steerAgent(taskId, `Approved (${decision}) — continue execution`);
  };

  const stopSession = (taskId: string) => {
    const target = tasks.find((t) => t.id === taskId);
    if (!target?.linkedSessionId) return;
    setSessions((prev) =>
      prev.map((s) =>
        s.id === target.linkedSessionId
          ? { ...s, status: "idle", statusSummary: "Paused" }
          : s,
      ),
    );
    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, triage: "needs_you" } : t)),
    );
    notify(`Stopped agent on ${target.serverId}`);
  };

  const completeTask = (taskId: string) => {
    const prevTasks = tasks;
    const nextTasks = tasks.map((t) =>
      t.id === taskId
        ? { ...t, section: "done" as const, triage: "queued" as const, queuedForServer: false }
        : t,
    );
    setTasks(nextTasks);
    advanceToNextWaiting(taskId, nextTasks);
    notify("Task marked done", () => setTasks(prevTasks));
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
                  permissionPrompt: undefined,
                  statusSummary: "Review diff",
                  latestOutcomeMarkdown:
                    "All **14 lease contention tests** passed with 5 parallel workers (`pytest tests/test_pool_lease.py`).\n\n- Added conditional expression check around DynamoDB lease update",
                }
              : s,
          ),
        );
      }
      setSelectedTaskId(working.id);
      notify(`${working.serverId} finished "${working.title}"`);
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
                  statusSummary: "Question",
                  questionPrompt: {
                    question: "Which lock timeout strategy should we use for the account pool?",
                    options: [
                      {
                        label: "TTL with heartbeat lease",
                        description: "Expires stale locks after 60s if a test worker crashes",
                      },
                      {
                        label: "Strict mutex with manual release",
                        description: "Requires a cleanup job when a runner aborts",
                      },
                    ],
                  },
                }
              : s,
          ),
        );
      }
      setSelectedTaskId(working.id);
      notify(`${working.serverId} asked a question on "${working.title}"`);
    }
  };

  const activeTasks = tasks.filter((t) => t.section === "focus" || t.section === "buffer");

  const laneNeedsYou = activeTasks
    .filter((t) => t.triage === "needs_you")
    .sort((a, b) => {
      const sa = sessions.find((s) => s.id === a.linkedSessionId);
      const sb = sessions.find((s) => s.id === b.linkedSessionId);
      const score = (s?: OpenCodeSession) =>
        s?.status === "question" ? 0 : s?.status === "permission" ? 1 : 2;
      return score(sa) - score(sb);
    });
  const laneWorking = activeTasks.filter((t) => t.triage === "working");
  const laneQueued = activeTasks.filter((t) => t.triage === "queued");

  const selectedTask =
    activeTasks.find((t) => t.id === selectedTaskId) ??
    laneNeedsYou[0] ??
    laneWorking[0] ??
    laneQueued[0] ??
    null;
  const selectedSession = selectedTask
    ? sessions.find((s) => s.id === selectedTask.linkedSessionId)
    : undefined;

  return (
    <div className="min-h-screen md:h-screen bg-[#09090b] text-zinc-100 flex flex-col">
      {/* Equal-Edge Header */}
      <header className="shrink-0 z-20 border-b border-zinc-800/80 bg-[#09090b]/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[1600px] items-center justify-between gap-4 px-5 py-3 sm:px-8">
          <div className="flex items-center gap-5">
            <span className="text-[16px] font-semibold tracking-tight text-zinc-100">
              Timebox
            </span>

            <div className="hidden md:flex items-center gap-3 text-[13px] text-zinc-400">
              <span className="inline-flex items-center gap-2 font-medium text-zinc-100">
                <span className="h-2 w-2 rounded-full bg-orange-500" />
                {laneNeedsYou.length} waiting for your answer
              </span>
              <span className="text-zinc-700">/</span>
              <span className="inline-flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-zinc-300 animate-pulse" />
                {laneWorking.length} processing
              </span>
              <span className="text-zinc-700">/</span>
              <span>{laneQueued.length} ready</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setArchMode("triage-sidebar")}
              className={archMode === "triage-sidebar" ? btnSecondary : btnGhost}
            >
              Option A: Left Triage Sidebar + Stage
            </button>
            <button
              type="button"
              onClick={() => setArchMode("focus-plus-rail")}
              className={archMode === "focus-plus-rail" ? btnSecondary : btnGhost}
            >
              Option B: Focus List + Right Agent Sidebar
            </button>
          </div>
        </div>
      </header>

      {/* Main Content — Equal Left & Right Edges, Works at 1440, 1024, 768, 390 */}
      <main className="mx-auto flex w-full max-w-none flex-1 min-h-0 flex-col px-4 pt-3 pb-3 sm:px-6 lg:px-8 overflow-y-auto">
        {archMode === "triage-sidebar" ? (
          /* =========================================================================
             OPTION A: LEFT GROUPED TRIAGE SIDEBAR + WIDE MAIN STAGE (RESIZABLE)
             ========================================================================= */
          <div
            className={`flex flex-1 min-h-0 flex-col md:flex-row items-stretch ${
              isResizing ? "select-none cursor-col-resize" : ""
            }`}
          >
            {/* LEFT SIDEBAR: Grouped by Swimlane State */}
            <aside
              aria-label="Task queues"
              style={{ "--sidebar-w": `${sidebarWidth}px` } as React.CSSProperties}
              className={`w-full shrink-0 space-y-6 md:w-[var(--sidebar-w)] md:h-full md:overflow-y-auto md:pr-1.5 [scrollbar-width:thin] [scrollbar-color:rgba(113,113,122,0.3)_transparent] ${
                mobileShowDetail ? "hidden md:block" : "block"
              }`}
            >
              {/* GROUP 1: WAITING FOR YOUR ANSWER */}
              <section className="space-y-2">
                <div className="flex items-center justify-between px-1">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-orange-500" />
                    <h2 className="text-[12px] font-semibold uppercase tracking-wider text-orange-400">
                      Waiting for Your Answer
                    </h2>
                  </div>
                  <span className="font-mono text-[12px] text-orange-400">
                    {laneNeedsYou.length}
                  </span>
                </div>

                {laneNeedsYou.length === 0 ? (
                  <p className="px-2 py-2 text-[13px] text-zinc-500">
                    All agent questions answered.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {laneNeedsYou.map((t) => {
                      const sess = sessions.find((s) => s.id === t.linkedSessionId);
                      const active = selectedTask?.id === t.id;
                      return (
                        <li key={t.id}>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedTaskId(t.id);
                              setMobileShowDetail(true);
                            }}
                            className={`w-full rounded-lg border px-3.5 py-3 text-left transition-all duration-150 cursor-pointer ${
                              active
                                ? "border-orange-500 bg-zinc-900 text-zinc-100"
                                : "border-zinc-800/80 bg-zinc-900/40 text-zinc-200 hover:border-zinc-700 hover:bg-zinc-900/70"
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
                              <span className="font-medium text-orange-400">
                                {sess?.statusSummary || "Needs review"}
                              </span>
                              <span className="text-zinc-500">
                                {t.serverId}/{shortRepoName(t.repo)}
                              </span>
                            </div>
                            <p className="mt-1 truncate text-[15px] font-medium text-zinc-100">
                              {t.title}
                            </p>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              {/* GROUP 2: AGENT PROCESSING */}
              <section className="space-y-2">
                <div className="flex items-center justify-between px-1">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-zinc-200 animate-pulse" />
                    <h2 className="text-[12px] font-semibold uppercase tracking-wider text-zinc-300">
                      Agent Processing
                    </h2>
                  </div>
                  <span className="font-mono text-[12px] text-zinc-400">
                    {laneWorking.length}
                  </span>
                </div>

                {laneWorking.length === 0 ? (
                  <p className="px-2 py-2 text-[13px] text-zinc-500">No agents running.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {laneWorking.map((t) => {
                      const sess = sessions.find((s) => s.id === t.linkedSessionId);
                      const active = selectedTask?.id === t.id;
                      return (
                        <li key={t.id}>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedTaskId(t.id);
                              setMobileShowDetail(true);
                            }}
                            className={`w-full rounded-lg border px-3.5 py-3 text-left transition-all duration-150 cursor-pointer ${
                              active
                                ? "border-orange-500 bg-zinc-900 text-zinc-100"
                                : "border-zinc-800/80 bg-zinc-900/35 text-zinc-200 hover:border-zinc-700 hover:bg-zinc-900/65"
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2 font-mono text-[11px] text-zinc-400">
                              <span>
                                {t.serverId}/{shortRepoName(t.repo)}
                              </span>
                              <span className="tabular-nums text-zinc-200">
                                {fmtSec(sess?.elapsedSec ?? 0)}
                              </span>
                            </div>
                            <p className="mt-1 truncate text-[15px] font-medium text-zinc-100">
                              {t.title}
                            </p>
                            {sess?.statusSummary && (
                              <p className="mt-1 truncate font-mono text-[11px] text-zinc-500">
                                {sess.statusSummary}
                              </p>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              {/* GROUP 3: READY & QUEUED */}
              <section className="space-y-2">
                <div className="flex items-center justify-between px-1">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-zinc-600" />
                    <h2 className="text-[12px] font-semibold uppercase tracking-wider text-zinc-400">
                      Ready in Focus
                    </h2>
                  </div>
                  <span className="font-mono text-[12px] text-zinc-500">
                    {laneQueued.length}
                  </span>
                </div>

                <ul className="space-y-1.5">
                  {laneQueued.map((t) => {
                    const active = selectedTask?.id === t.id;
                    return (
                      <li
                        key={t.id}
                        className={`flex items-center justify-between gap-2 rounded-lg border px-3.5 py-2.5 transition-all duration-150 ${
                          active
                            ? "border-orange-500 bg-zinc-900"
                            : "border-zinc-800/70 bg-zinc-900/25 hover:border-zinc-700"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedTaskId(t.id);
                            setMobileShowDetail(true);
                          }}
                          className="min-w-0 flex-1 text-left cursor-pointer"
                        >
                          <p className="truncate text-[15px] font-medium text-zinc-200">
                            {t.title}
                          </p>
                          <span className="font-mono text-[11px] text-zinc-500">
                            {t.serverId}/{shortRepoName(t.repo)} · {t.plannedMin}m
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => steerAgent(t.id, t.specPrompt || t.title)}
                          className="shrink-0 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 font-mono text-[11px] text-orange-400 hover:border-orange-500 cursor-pointer"
                        >
                          Run
                        </button>
                      </li>
                    );
                  })}
                </ul>

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!quickAddText.trim()) return;
                    const created: FlightTask = {
                      id: `t_${Date.now()}`,
                      title: quickAddText.trim(),
                      section: "focus",
                      triage: "queued",
                      priority: 3,
                      plannedMin: 15,
                      serverId: defaultServerId,
                      repo: "vyond/devops",
                      specPrompt: "",
                      attentionMin: 0,
                      agentMin: 0,
                    };
                    setTasks((prev) => [...prev, created]);
                    setQuickAddText("");
                    setSelectedTaskId(created.id);
                  }}
                  className="pt-1"
                >
                  <input
                    aria-label="Add task to Focus"
                    value={quickAddText}
                    onChange={(e) => setQuickAddText(e.target.value)}
                    placeholder="Add task (~server @repo)…"
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-900/50 px-3.5 py-2.5 text-[14px] text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-zinc-700"
                  />
                </form>
              </section>
            </aside>

            {/* DRAGGABLE RESIZE HANDLE */}
            <div
              role="separator"
              aria-orientation="vertical"
              title="Drag to resize sidebar · Double-click to reset"
              onPointerDown={(e) => {
                e.preventDefault();
                const startX = e.clientX;
                const startW = sidebarWidth;
                setIsResizing(true);
                const onMove = (ev: PointerEvent) => {
                  const next = Math.max(280, Math.min(720, startW + (ev.clientX - startX)));
                  setSidebarWidth(next);
                  localStorage.setItem("tb_sidebar_width", String(next));
                };
                const onUp = () => {
                  setIsResizing(false);
                  window.removeEventListener("pointermove", onMove);
                  window.removeEventListener("pointerup", onUp);
                };
                window.addEventListener("pointermove", onMove);
                window.addEventListener("pointerup", onUp);
              }}
              onDoubleClick={() => {
                setSidebarWidth(400);
                localStorage.setItem("tb_sidebar_width", "400");
              }}
              className="group hidden md:flex w-6 shrink-0 cursor-col-resize items-stretch justify-center self-stretch py-2 select-none md:h-full"
            >
              <div
                className={`w-px transition-colors duration-150 ${
                  isResizing
                    ? "w-0.5 bg-orange-500"
                    : "bg-zinc-800/80 group-hover:w-0.5 group-hover:bg-orange-500/80"
                }`}
              />
            </div>

            {/* RIGHT MAIN STAGE: Generous Workspace */}
            <div
              className={`min-w-0 flex-1 min-h-0 flex flex-col md:h-full ${
                mobileShowDetail ? "block" : "hidden md:flex"
              }`}
            >
              {mobileShowDetail && (
                <button
                  type="button"
                  onClick={() => setMobileShowDetail(false)}
                  className="mb-3 inline-flex items-center gap-1.5 text-[13px] font-medium text-orange-400 md:hidden cursor-pointer"
                >
                  ← Back to task queues ({laneNeedsYou.length} waiting)
                </button>
              )}

              {selectedTask && (
                <MainStageWorkspace
                  task={selectedTask}
                  session={selectedSession}
                  servers={servers}
                  waitingCount={laneNeedsYou.length}
                  onSteer={(msg) => steerAgent(selectedTask.id, msg)}
                  onApprove={(dec) => approvePermission(selectedTask.id, dec)}
                  onComplete={() => completeTask(selectedTask.id)}
                  onStop={() => stopSession(selectedTask.id)}
                  onUpdate={(fields) =>
                    setTasks((prev) =>
                      prev.map((x) => (x.id === selectedTask.id ? { ...x, ...fields } : x)),
                    )
                  }
                />
              )}
            </div>
          </div>
        ) : (
          /* =========================================================================
             OPTION B: FOCUS TASK LIST (CENTER) + RIGHT "WAITING & PROCESSING" SIDEBAR
             - Keeps your main Focus list super clean & wide on the left.
             - Dedicates a Right Sidebar specifically to "Waiting for Your Answer" (with
               1-click inline reply buttons) and "Agent Processing" below it.
             - On smaller screens (<1024px), the Waiting for Your Answer sidebar floats
               naturally to the top above the Focus list!
             ========================================================================= */
          <div className="grid flex-1 grid-cols-1 gap-8 lg:grid-cols-12 items-start">
            {/* RIGHT SIDEBAR (Order-1 on mobile/tablet so Waiting for Answer is always at the top!) */}
            <aside
              aria-label="Agent activity and questions"
              className="order-1 lg:order-2 lg:col-span-5 space-y-6 lg:sticky lg:top-20"
            >
              {/* WAITING FOR YOUR ANSWER DECK */}
              <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-4">
                <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-orange-500" />
                    <h2 className="text-[14px] font-semibold text-zinc-100">
                      Waiting for Your Answer
                    </h2>
                  </div>
                  <span className="font-mono text-[12px] text-orange-400">
                    {laneNeedsYou.length} pending
                  </span>
                </div>

                {laneNeedsYou.length === 0 ? (
                  <p className="py-4 text-[14px] text-zinc-500">
                    Nothing blocked on your input.
                  </p>
                ) : (
                  <div className="space-y-4">
                    {laneNeedsYou.map((t) => {
                      const sess = sessions.find((s) => s.id === t.linkedSessionId);
                      return (
                        <div
                          key={t.id}
                          className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 space-y-3"
                        >
                          <div className="flex items-center justify-between font-mono text-[12px] text-zinc-400">
                            <span className="text-orange-400 font-medium">
                              {sess?.statusSummary}
                            </span>
                            <span>
                              {t.serverId}/{shortRepoName(t.repo)}
                            </span>
                          </div>

                          <h3 className="text-[16px] font-semibold text-zinc-100 leading-snug">
                            {t.title}
                          </h3>

                          {sess?.status === "question" && sess.questionPrompt && (
                            <div className="space-y-2 pt-1">
                              <p className="text-[13px] text-zinc-300">
                                {sess.questionPrompt.question}
                              </p>
                              <div className="flex flex-col gap-1.5">
                                {sess.questionPrompt.options.map((opt) => (
                                  <button
                                    key={opt.label}
                                    type="button"
                                    onClick={() => steerAgent(t.id, opt.label)}
                                    className="rounded-md border border-zinc-800 bg-zinc-900 px-3.5 py-2 text-left text-[13px] font-medium text-zinc-100 hover:border-orange-500 cursor-pointer"
                                  >
                                    {opt.label}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}

                          {sess?.status === "permission" && sess.permissionPrompt && (
                            <div className="space-y-2.5 pt-1">
                              <code className="block overflow-x-auto rounded border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-[12px] text-zinc-200">
                                {sess.permissionPrompt.command}
                              </code>
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => approvePermission(t.id, "once")}
                                  className={btnPrimary}
                                >
                                  Allow once
                                </button>
                                <button
                                  type="button"
                                  onClick={() => approvePermission(t.id, "reject")}
                                  className={btnSecondary}
                                >
                                  Reject
                                </button>
                              </div>
                            </div>
                          )}

                          {sess?.status === "idle" && (
                            <div className="flex items-center justify-between gap-2 pt-1">
                              <span className="font-mono text-[12px] text-zinc-400">
                                2 files changed (+103 -14)
                              </span>
                              <button
                                type="button"
                                onClick={() => completeTask(t.id)}
                                className={btnPrimary}
                              >
                                Accept and complete
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* AGENT PROCESSING DECK */}
              <section className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-5 space-y-3">
                <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-zinc-200 animate-pulse" />
                    <h2 className="text-[14px] font-semibold text-zinc-100">
                      Agent Processing
                    </h2>
                  </div>
                  <span className="font-mono text-[12px] text-zinc-400">
                    {laneWorking.length} running
                  </span>
                </div>

                {laneWorking.map((t) => {
                  const sess = sessions.find((s) => s.id === t.linkedSessionId);
                  const lastTool = sess?.recentTools?.[sess.recentTools.length - 1];
                  return (
                    <div
                      key={t.id}
                      className="rounded-lg border border-zinc-800/80 bg-zinc-950/80 p-3.5 space-y-1.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[15px] font-medium text-zinc-100">
                          {t.title}
                        </span>
                        <span className="font-mono text-[12px] tabular-nums text-zinc-300">
                          {fmtSec(sess?.elapsedSec ?? 0)}
                        </span>
                      </div>
                      {lastTool && (
                        <p className="truncate font-mono text-[12px] text-zinc-400">
                          {t.serverId}: {lastTool.label}
                        </p>
                      )}
                    </div>
                  );
                })}
              </section>
            </aside>

            {/* MAIN FOCUS TASK LIST (LEFT 7 COLS) */}
            <section className="order-2 lg:order-1 lg:col-span-7 space-y-4">
              <div className="flex items-baseline justify-between border-b border-zinc-800 pb-2.5">
                <h2 className="text-[16px] font-semibold text-zinc-100">Focus Tasks</h2>
                <span className="text-[13px] text-zinc-500">
                  {activeTasks.length} tasks in Focus
                </span>
              </div>

              <div className="space-y-2.5">
                {activeTasks.map((t) => {
                  const sess = sessions.find((s) => s.id === t.linkedSessionId);
                  return (
                    <div
                      key={t.id}
                      onClick={() => setSelectedTaskId(t.id)}
                      className="flex items-center justify-between gap-4 rounded-lg border border-zinc-800 bg-zinc-900/40 px-5 py-4 hover:border-zinc-700 cursor-pointer"
                    >
                      <div className="min-w-0 flex-1">
                        <h3 className="text-[17px] font-medium text-zinc-100">
                          {t.title}
                        </h3>
                        <div className="mt-1 flex items-center gap-2 font-mono text-[12px] text-zinc-500">
                          <span>
                            {t.serverId}/{shortRepoName(t.repo)}
                          </span>
                          <span>·</span>
                          <span>{t.plannedMin}m</span>
                        </div>
                      </div>

                      {t.triage === "needs_you" ? (
                        <span className="font-mono text-[12px] font-medium text-orange-400">
                          {sess?.statusSummary || "Waiting for answer"} →
                        </span>
                      ) : t.triage === "working" ? (
                        <span className="font-mono text-[12px] text-zinc-300">
                          Processing ({fmtSec(sess?.elapsedSec ?? 0)})
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            steerAgent(t.id, t.specPrompt || t.title);
                          }}
                          className={btnPrimary}
                        >
                          Run agent
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        )}
      </main>

      {/* Bottom Simulation Bar */}
      <footer className="shrink-0 z-20 border-t border-zinc-800/80 bg-[#09090b]/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center justify-between gap-4 px-5 py-2.5 text-[13px] text-zinc-400 sm:px-8">
          <span>
            Sidebar Triage Prototype — works cleanly at 1440px, 1024px, 768px, and 390px
          </span>
          <div className="flex items-center gap-2">
            <button onClick={() => simulateEvent("finish")} className={btnSecondary}>
              Simulate agent finished
            </button>
            <button onClick={() => simulateEvent("question")} className={btnSecondary}>
              Simulate agent question
            </button>
            {onExitMock && (
              <button onClick={onExitMock} className={btnPrimary}>
                Open live app
              </button>
            )}
          </div>
        </div>
      </footer>

      {toast && (
        <div className="fixed bottom-14 left-1/2 z-40 -translate-x-1/2 rounded-md border border-zinc-700 bg-zinc-900 px-4 py-2 text-[13px] text-zinc-100 shadow-xl">
          {toast.msg}
          {toast.undo && (
            <button
              className="ml-3 font-medium text-orange-400 cursor-pointer"
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

function MainStageWorkspace({
  task,
  session,
  servers,
  waitingCount,
  onSteer,
  onApprove,
  onComplete,
  onStop,
  onUpdate,
}: {
  task: FlightTask;
  session?: OpenCodeSession;
  servers: ServerNode[];
  waitingCount: number;
  onSteer: (msg: string) => void;
  onApprove: (decision: "once" | "always" | "reject") => void;
  onComplete: () => void;
  onStop: () => void;
  onUpdate: (fields: Partial<FlightTask>) => void;
}) {
  const [steerInput, setSteerInput] = useState("");
  const [activeDiffIdx, setActiveDiffIdx] = useState(0);
  const [showCheckpoints, setShowCheckpoints] = useState(false);

  const srv = servers.find((s) => s.id === task.serverId) ?? servers[0];
  const diffs = session?.filesChanged ?? [];
  const safeDiffIdx = activeDiffIdx < diffs.length ? activeDiffIdx : 0;
  const activeDiff = diffs[safeDiffIdx];
  const tools = session?.recentTools ?? [];

  const handleSend = () => {
    const msg = steerInput.trim() || task.specPrompt || task.title;
    onSteer(msg);
    setSteerInput("");
  };

  return (
    <section
      aria-label="Active task workspace"
      className="rounded-xl border border-zinc-800/90 bg-zinc-900/40 p-5 sm:p-6 flex-1 min-h-0 flex flex-col md:h-full"
    >
      {/* Top Status & Server Context */}
      <div className="shrink-0 border-b border-zinc-800/80 pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[12px] text-zinc-400">
          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${
                task.triage === "needs_you"
                  ? "bg-orange-500"
                  : task.triage === "working"
                    ? "bg-zinc-200 animate-pulse"
                    : "bg-zinc-600"
              }`}
            />
            <span className="font-medium text-zinc-200">
              {task.serverId} / {shortRepoName(task.repo)}
            </span>
            {session?.model && <span>· {session.model}</span>}
            {session && <span>· {session.id}</span>}
          </div>

          {task.triage === "needs_you" && waitingCount > 1 && (
            <span className="text-orange-400">
              Auto-advances to next waiting task ({waitingCount} in queue)
            </span>
          )}
        </div>

        {/* Full-Width 22px Task Title — Never cramped */}
        <input
          aria-label="Task title"
          value={task.title}
          onChange={(e) => onUpdate({ title: e.target.value })}
          className="mt-2.5 w-full bg-transparent text-[22px] font-semibold tracking-[-0.015em] text-zinc-100 outline-none"
        />
      </div>

      {/* Scrollable Stage Content: Question, Permission, Pipeline, Diff, Markdown, Notes */}
      <div className="flex-1 min-h-0 overflow-y-auto space-y-5 pr-1.5 py-4 [scrollbar-width:thin] [scrollbar-color:rgba(113,113,122,0.3)_transparent]">

      {/* 1. IF WAITING FOR ANSWER: QUESTION */}
      {session?.status === "question" && session.questionPrompt && (
        <div className="space-y-3.5 border-b border-zinc-800/80 pb-6">
          <div className="text-[12px] font-mono uppercase tracking-wider text-orange-400">
            Agent Question — Choose an option to continue
          </div>
          <p className="text-[17px] font-medium text-zinc-100">
            {session.questionPrompt.question}
          </p>
          <div className="grid grid-cols-1 gap-2.5 pt-1 sm:grid-cols-3">
            {session.questionPrompt.options.map((opt, idx) => (
              <button
                key={opt.label}
                type="button"
                onClick={() => onSteer(opt.label)}
                className="flex flex-col items-start justify-between rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-left transition-all duration-150 hover:-translate-y-0.5 hover:border-orange-500 cursor-pointer"
              >
                <span className="text-[14px] font-semibold text-zinc-100">
                  {idx + 1}. {opt.label}
                </span>
                <span className="mt-1.5 text-[13px] leading-snug text-zinc-400">
                  {opt.description}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 2. IF WAITING FOR ANSWER: PERMISSION */}
      {session?.status === "permission" && session.permissionPrompt && (
        <div className="space-y-3.5 border-b border-zinc-800/80 pb-6">
          <div className="text-[12px] font-mono uppercase tracking-wider text-orange-400">
            Tool Permission Required on {task.serverId}
          </div>
          <code className="block overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-3 font-mono text-[13px] text-zinc-100">
            {session.permissionPrompt.command}
          </code>
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => onApprove("once")}
              className={btnPrimary}
            >
              Allow command once
            </button>
            <button
              type="button"
              onClick={() => onApprove("always")}
              className={btnSecondary}
            >
              Always allow in session
            </button>
            <button
              type="button"
              onClick={() => onApprove("reject")}
              className={btnGhost}
            >
              Reject
            </button>
          </div>
        </div>
      )}

      {/* 3. IF AGENT PROCESSING: LIVE TOOL PIPELINE */}
      {task.triage === "working" && tools.length > 0 && (
        <div className="space-y-2.5 border-b border-zinc-800/80 pb-6">
          <div className="flex items-center justify-between font-mono text-[12px] text-zinc-400">
            <span>Live Execution Pipeline</span>
            <span className="tabular-nums text-zinc-200">
              {fmtSec(session?.elapsedSec ?? 0)} elapsed
            </span>
          </div>
          <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950 p-4 font-mono text-[13px]">
            {tools.map((step, idx) => (
              <div
                key={idx}
                className={`flex items-center gap-2.5 ${
                  step.status === "running" ? "text-zinc-100 font-medium" : "text-zinc-500"
                }`}
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    step.status === "running"
                      ? "bg-orange-500 animate-pulse"
                      : "bg-zinc-600"
                  }`}
                />
                <span>{step.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 4. CODE DIFF VIEWER */}
      {diffs.length > 0 && activeDiff && (
        <div className="space-y-3 border-b border-zinc-800/80 pb-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              {diffs.map((f, idx) => (
                <button
                  key={f.file}
                  type="button"
                  onClick={() => setActiveDiffIdx(idx)}
                  className={`rounded-md px-3 py-1.5 font-mono text-[12px] cursor-pointer ${
                    idx === safeDiffIdx
                      ? "bg-zinc-800 text-zinc-100"
                      : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {f.shortFile}{" "}
                  <span className="text-emerald-400">+{f.additions}</span>{" "}
                  <span className="text-red-400">-{f.deletions}</span>
                </button>
              ))}
            </div>
            <button type="button" onClick={onComplete} className={btnPrimary}>
              Accept changes and complete
            </button>
          </div>

          <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 p-4 font-mono text-[12px] leading-relaxed">
            {activeDiff.patch.split("\n").map((line, i) => {
              const isAdd = line.startsWith("+") && !line.startsWith("+++");
              const isDel = line.startsWith("-") && !line.startsWith("---");
              const isHunk = line.startsWith("@@");
              return (
                <div
                  key={i}
                  className={`whitespace-pre px-2 py-0.5 ${
                    isAdd
                      ? "bg-emerald-500/15 text-emerald-300"
                      : isDel
                        ? "bg-red-500/15 text-red-300"
                        : isHunk
                          ? "text-zinc-500"
                          : "text-zinc-400"
                  }`}
                >
                  {line}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 5. AGENT SUMMARY MARKDOWN */}
      {session && (
        <div className="space-y-3 border-b border-zinc-800/80 pb-6">
          <div className="text-[15px] leading-relaxed text-zinc-200">
            <SimpleMarkdown text={session.latestOutcomeMarkdown} />
          </div>

          {session.checkpoints.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setShowCheckpoints((s) => !s)}
                className="font-mono text-[12px] text-zinc-400 hover:text-zinc-200 cursor-pointer"
              >
                {showCheckpoints ? "Hide" : "Show"} {session.checkpoints.length} checkpoints
              </button>
              {showCheckpoints && (
                <ol className="mt-2 space-y-1.5 border-l border-zinc-800 pl-3 text-[13px] text-zinc-400">
                  {session.checkpoints.map((cp) => (
                    <li key={cp.id}>
                      <span className="font-mono text-[12px] text-zinc-500">
                        {cp.actor === "you" ? "You" : session.serverId} ({cp.timeAgo}):{" "}
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

      {/* 6. TASK NOTES & CONTEXT */}
      <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-4 sm:p-5 space-y-2">
        <div className="flex items-center justify-between font-mono text-[11px] text-zinc-400">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-orange-500/70" />
            <span className="font-semibold uppercase tracking-wider text-zinc-300">
              Task Notes &amp; Context
            </span>
          </div>
          <span className="text-zinc-500">
            {task.specPrompt.trim() ? `${task.specPrompt.trim().split(/\s+/).filter(Boolean).length} words` : "Empty"} · auto-saves
          </span>
        </div>
        <textarea
          value={task.specPrompt}
          onChange={(e) => onUpdate({ specPrompt: e.target.value })}
          placeholder="Deep focus scratchpad… Write detailed specifications, steps, links, API snippets, or problem diagnosis here."
          rows={3}
          className="w-full resize-y bg-transparent text-[14px] sm:text-[15px] leading-relaxed text-zinc-100 placeholder:text-zinc-600 outline-none"
        />
      </div>

      </div>

      {/* 7. STEER / PROMPT COMPOSER */}
      <div className="shrink-0 space-y-2.5 pt-3 border-t border-zinc-800/80">
        <label htmlFor="stage-prompt" className="block text-[13px] font-medium text-zinc-300">
          {session ? "Steer agent or send custom reply" : "Initial prompt for agent"}
        </label>
        <textarea
          id="stage-prompt"
          rows={3}
          value={session ? steerInput : task.specPrompt}
          onChange={(e) => {
            if (session) setSteerInput(e.target.value);
            else onUpdate({ specPrompt: e.target.value });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={
            session
              ? `Send follow-up instructions to ${task.serverId}…`
              : `Describe what ${task.serverId} (${shortRepoName(task.repo) || srv.defaultDir}) should do…`
          }
          className="w-full resize-none rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-3 text-[14px] leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-zinc-600"
        />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {task.triage === "working" && (
              <button type="button" onClick={onStop} className={btnSecondary}>
                Stop agent
              </button>
            )}
            <button type="button" onClick={onComplete} className={btnSecondary}>
              Mark task done
            </button>
          </div>
          <button type="button" onClick={handleSend} className={btnPrimary}>
            {session ? "↑ Send" : "▶ Run agent"}
          </button>
        </div>
      </div>
    </section>
  );
}
