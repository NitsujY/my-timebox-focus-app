import { useEffect, useRef, useState } from "react";
import { SimpleMarkdown } from "./markdown";

/**
 * Executive Triage Model:
 * Every Focus task automatically falls into 1 of 3 self-explanatory buckets:
 * 1. `needs_you` (Orange bar) — Agent asked a question (pick an option) OR finished its turn and is waiting for your steer.
 * 2. `working`   (Pulse dot)  — OpenCode agent is actively executing tools in the background.
 * 3. `queued`    (Quiet zinc) — Not running an agent right now (manual task or waiting to be kicked off).
 */
type TriageState = "needs_you" | "working" | "queued";

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
  repo: string;
  specPrompt: string;
  attentionMin: number;
  agentMin: number;
  linkedSessionId?: string;
};

const KNOWN_REPOS = [
  "vyond/devops",
  "vyond/eks-manifest",
  "vyond/qa-autotest-account-pool",
  "vyond/turbo",
  "vyond/next",
];

// Design tokens — 95% neutral zinc + 1 single orange-500 accent
const btn =
  "rounded-md px-2.5 py-1 text-[13px] text-zinc-400 transition-colors duration-150 hover:bg-zinc-800 hover:text-zinc-200 cursor-pointer";

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
    leftBar: "border-l-orange-500 bg-zinc-900/60",
    dot: "bg-orange-500",
    labelCls: "text-orange-400 font-medium",
  },
  working: {
    label: "Agent Working",
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
      "Inspected `grafana/push_md_to_confluence.py` and found 3 pages in staging with existing manual tables.",
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
    title: "Add Grafana SLO panel for auth service",
    repo: "vyond/eks-manifest",
    status: "idle",
    idleSinceLabel: "Idle 2m · waiting for your steer",
    latestOutcomeMarkdown:
      "Added **99.9% availability burn-rate** panel to `monitoring/grafana/auth.json` (+84 -12).\n\n- Uses `sum(rate(http_requests_total{status=~\"5..\"}[5m]))` over 5m and 1h windows\n- Validated JSON schema against Grafana v10\n\n```promql\nsum(rate(http_requests_total{service=\"auth\",status=~\"5..\"}[5m]))\n/ sum(rate(http_requests_total{service=\"auth\"}[5m]))\n```",
    checkpoints: [
      {
        id: "c1",
        timeAgo: "14m ago",
        actor: "you",
        summary: "Read monitoring/grafana/auth.json and add a 99.9% availability burn-rate panel.",
      },
      {
        id: "c2",
        timeAgo: "11m ago",
        actor: "agent",
        summary: "Inspected existing Prometheus rules and drafted 5m/1h multi-window query.",
        toolBadge: "read: monitoring/grafana/auth.json",
      },
      {
        id: "c3",
        timeAgo: "6m ago",
        actor: "you",
        summary: "Exclude 501 Not Implemented from the 5xx numerator.",
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
    title: "Investigate flaky account pool cleanup",
    repo: "vyond/qa-autotest-account-pool",
    status: "running",
    idleSinceLabel: "Running pytest (01:24 elapsed)…",
    latestOutcomeMarkdown:
      "Running `pytest tests/test_pool_lease.py -n 5` to reproduce DynamoDB lease contention.",
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
    id: "ses_10f4",
    title: "Debug Terraform state lock in us-east-1",
    repo: "vyond/devops",
    status: "running",
    idleSinceLabel: "Running terraform force-unlock check…",
    latestOutcomeMarkdown: "Checking DynamoDB lock table entry for `vpc-prod-us-east-1`.",
    checkpoints: [],
  },
];

const INITIAL_TASKS: FlightTask[] = [
  {
    id: "t1",
    title: "Update Confluence table GitHub Action",
    section: "focus",
    triage: "needs_you",
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
    repo: "vyond/qa-autotest-account-pool",
    specPrompt:
      "Reproduce DynamoDB lease lock race condition in tests/test_pool_lease.py with 5 parallel workers.",
    attentionMin: 4,
    agentMin: 3,
    linkedSessionId: "ses_77b1",
  },
  {
    id: "t3",
    title: "Review Q4 infra cost sheet & reply to Alex",
    section: "focus",
    triage: "queued",
    repo: "",
    specPrompt: "Compare NAT gateway bytes processed in us-east-1 between Oct and Nov.",
    attentionMin: 5,
    agentMin: 0,
  },
  {
    id: "t5",
    title: "Rotate staging ArgoCD webhook secret",
    section: "buffer",
    triage: "queued",
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
    repo: "vyond/next",
    specPrompt: "Set engine-strict=false in .npmrc for Node 25 compatibility.",
    attentionMin: 4,
    agentMin: 7,
  },
];

function parseTaskInput(raw: string, extraPrompt = "", pickedRepo = "") {
  let text = raw.trim();
  let inlinePrompt = "";
  const slashIdx = text.indexOf("//");
  if (slashIdx !== -1) {
    inlinePrompt = text.slice(slashIdx + 2).trim();
    text = text.slice(0, slashIdx).trim();
  }
  let repo = pickedRepo;
  text = text.replace(/(?:^|\s)@([\w./-]+)(?=\s|$)/, (_, r: string) => {
    const match = KNOWN_REPOS.find(
      (k) => k.toLowerCase() === r.toLowerCase() || k.endsWith(`/${r.toLowerCase()}`),
    );
    repo = match ?? r;
    return "";
  });
  return {
    title: text.trim() || raw.trim(),
    repo,
    prompt: [inlinePrompt, extraPrompt.trim()].filter(Boolean).join("\n"),
  };
}

export default function MockFlightDeck({ onExitMock }: { onExitMock?: () => void }) {
  const [tasks, setTasks] = useState<FlightTask[]>(INITIAL_TASKS);
  const [sessions, setSessions] = useState<OpenCodeSession[]>(INITIAL_SESSIONS);
  const [view, setView] = useState<"focus" | "backlog" | "review">("focus");
  const [expandedId, setExpandedId] = useState<string | null>("t1");
  const [newBufferText, setNewBufferText] = useState("");
  const [toast, setToast] = useState<{ msg: string; undo?: () => void } | null>(null);

  const notify = (msg: string, undo?: () => void) => setToast({ msg, undo });

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // Steer / Send instruction or option choice to OpenCode
  const steerAgent = (taskId: string, instruction: string) => {
    const target = tasks.find((t) => t.id === taskId);
    if (!target) return;
    const text = instruction.trim() || target.specPrompt || target.title;
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
          title: target.title,
          repo: target.repo,
          status: "running",
          idleSinceLabel: "Agent working…",
          latestOutcomeMarkdown: `Working on: *${text}*…`,
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
                idleSinceLabel: "Agent working…",
                latestOutcomeMarkdown: `Working on: *${text}*…`,
                checkpoints: [...s.checkpoints, userCheckpoint],
              }
            : s,
        ),
      );
    }

    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId ? { ...t, linkedSessionId: sid, triage: "working" } : t,
      ),
    );
    notify(`Sent to OpenCode (${sid}) — switched to Working`);
  };

  const completeTask = (taskId: string) => {
    const prevTasks = tasks;
    const target = tasks.find((t) => t.id === taskId);
    if (!target) return;
    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, section: "done", triage: "queued" } : t)),
    );
    if (expandedId === taskId) setExpandedId(null);
    notify(`Marked Done · session history preserved`, () => setTasks(prevTasks));
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
                  idleSinceLabel: "Idle just now · waiting for your steer",
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
      notify(`OpenCode finished: "${working.title}" now Needs You`);
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
                  idleSinceLabel: "Waiting for your choice",
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
      notify(`OpenCode asked a question on "${working.title}"`);
    }
  };

  const linkedIds = new Set(tasks.map((t) => t.linkedSessionId).filter(Boolean));
  const unlinkedSessions = sessions.filter((s) => !linkedIds.has(s.id));

  const focusTasks = tasks
    .filter((t) => t.section === "focus")
    .sort((a, b) => TRIAGE_ORDER[a.triage] - TRIAGE_ORDER[b.triage]);
  const bufferTasks = tasks.filter((t) => t.section === "buffer");
  const backlogTasks = tasks.filter((t) => t.section === "backlog");
  const doneTasks = tasks.filter((t) => t.section === "done");

  const needsYouCount = focusTasks.filter((t) => t.triage === "needs_you").length;
  const workingCount = focusTasks.filter((t) => t.triage === "working").length;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Sticky Header */}
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto grid max-w-[640px] grid-cols-[auto_1fr_auto] items-center px-4 py-3 sm:grid-cols-[1fr_auto_1fr]">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold">Timebox</span>
            <span
              className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-[11px] text-zinc-400"
              title="Connected to local OpenCode daemon"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-orange-500" />
              opencode
            </span>
          </div>

          <nav className="flex justify-center gap-1">
            {(["focus", "backlog", "review"] as const).map((v) => (
              <button
                key={v}
                className={`${btn} capitalize ${view === v ? "bg-zinc-800 text-zinc-100" : ""}`}
                onClick={() => setView(v)}
              >
                {v}
                {v === "focus" && needsYouCount > 0 && (
                  <span className="ml-1.5 rounded-full bg-orange-500/20 px-1.5 py-0.2 font-mono text-[11px] text-orange-400">
                    {needsYouCount}
                  </span>
                )}
                {v === "backlog" && backlogTasks.length > 0 && (
                  <span className="ml-1 font-mono tabular-nums text-zinc-500">
                    {backlogTasks.length}
                  </span>
                )}
              </button>
            ))}
          </nav>

          <div className="flex items-center justify-end gap-2 font-mono text-[12px] tabular-nums">
            {needsYouCount > 0 && (
              <span className="text-orange-400">{needsYouCount} needs you</span>
            )}
            {workingCount > 0 && (
              <span className="text-zinc-400">· {workingCount} working</span>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[640px] px-4 pt-6 pb-16">
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
                    const parsed = parseTaskInput(newBufferText);
                    setTasks((prev) => [
                      ...prev,
                      {
                        id: `t_${Date.now()}`,
                        title: parsed.title,
                        section: "buffer",
                        triage: "queued",
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
                    placeholder="＋ Quick add…"
                    className="w-48 bg-transparent text-right text-[13px] text-zinc-300 outline-none placeholder:text-zinc-600"
                  />
                </form>
              </div>
              {bufferTasks.length > 0 && (
                <ul className="space-y-0.5">
                  {bufferTasks.map((t) => (
                    <TriageRow
                      key={t.id}
                      task={t}
                      session={sessions.find((s) => s.id === t.linkedSessionId)}
                      sessions={sessions}
                      expanded={expandedId === t.id}
                      onToggle={() => setExpandedId(expandedId === t.id ? null : t.id)}
                      onSteer={(msg) => steerAgent(t.id, msg)}
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
              <div className="mb-1.5 flex items-center justify-between px-2">
                <span className="text-[13px] text-zinc-500">Focus</span>
                <span className="text-[12px] text-zinc-600">
                  Sorted by what needs your attention first
                </span>
              </div>

              <ul className="space-y-1">
                {focusTasks.map((t) => (
                  <TriageRow
                    key={t.id}
                    task={t}
                    large
                    session={sessions.find((s) => s.id === t.linkedSessionId)}
                    sessions={sessions}
                    expanded={expandedId === t.id}
                    onToggle={() => setExpandedId(expandedId === t.id ? null : t.id)}
                    onSteer={(msg) => steerAgent(t.id, msg)}
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
                  placeholder="＋ Add to Focus… (Title @repo // prompt or Tab for details)"
                  onSubmit={(parsed, launchAgent) => {
                    const id = `t_${Date.now()}`;
                    let sid: string | undefined;
                    if (launchAgent) {
                      sid = `ses_${Math.random().toString(16).slice(2, 6)}`;
                      setSessions((prev) => [
                        {
                          id: sid!,
                          title: parsed.title,
                          repo: parsed.repo,
                          status: "running",
                          idleSinceLabel: "Agent working…",
                          latestOutcomeMarkdown: `Working on: *${parsed.prompt || parsed.title}*…`,
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
                    }
                    setTasks((prev) => [
                      ...prev,
                      {
                        id,
                        title: parsed.title,
                        section: "focus",
                        triage: launchAgent ? "working" : "queued",
                        repo: parsed.repo,
                        specPrompt: parsed.prompt,
                        attentionMin: 0,
                        agentMin: 0,
                        linkedSessionId: sid,
                      },
                    ]);
                    notify(
                      launchAgent
                        ? `Created & dispatched to OpenCode (${sid})`
                        : `Added "${parsed.title}" to Focus`,
                    );
                  }}
                />
              </div>
            </section>

            {/* Unlinked OpenCode Sessions */}
            {unlinkedSessions.length > 0 && (
              <section className="border-t border-zinc-900 pt-2">
                <p className="mb-1 px-2 text-[12px] text-zinc-500">
                  Unlinked OpenCode sessions
                </p>
                <ul className="space-y-0.5">
                  {unlinkedSessions.map((s) => (
                    <li
                      key={s.id}
                      className="flex min-h-9 items-center justify-between gap-2 rounded-md px-2 text-[13px] text-zinc-400 hover:bg-zinc-900"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-500 animate-pulse" />
                        <span className="truncate text-zinc-300">{s.title}</span>
                        {s.repo && (
                          <span className="shrink-0 font-mono text-[11px] text-zinc-600">
                            {s.repo.replace("vyond/", "")}
                          </span>
                        )}
                      </div>
                      <button
                        onClick={() => {
                          setTasks((prev) => [
                            ...prev,
                            {
                              id: `t_${Date.now()}`,
                              title: s.title,
                              section: "focus",
                              triage: s.status === "running" ? "working" : "needs_you",
                              repo: s.repo,
                              specPrompt: "",
                              attentionMin: 0,
                              agentMin: 1,
                              linkedSessionId: s.id,
                            },
                          ]);
                          notify(`Tracked "${s.title}" in Focus`);
                        }}
                        className="shrink-0 text-[12px] text-zinc-500 hover:text-orange-500 cursor-pointer"
                      >
                        ＋ Track
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}

        {view === "backlog" && (
          <section className="space-y-3">
            <TaskComposer
              alwaysOpen
              placeholder="＋ Add to Backlog… (Title @repo // prompt or Tab for details)"
              onSubmit={(parsed, launchAgent) => {
                setTasks((prev) => [
                  ...prev,
                  {
                    id: `t_${Date.now()}`,
                    title: parsed.title,
                    section: launchAgent ? "focus" : "backlog",
                    triage: launchAgent ? "working" : "queued",
                    repo: parsed.repo,
                    specPrompt: parsed.prompt,
                    attentionMin: 0,
                    agentMin: 0,
                  },
                ]);
              }}
            />
            <ul className="space-y-0.5">
              {backlogTasks.map((t) => (
                <li
                  key={t.id}
                  className="flex min-h-11 items-center justify-between gap-2 rounded-md border-l-2 border-l-zinc-800 px-2.5 hover:bg-zinc-900"
                >
                  <div className="min-w-0">
                    <span className="block truncate text-[14px] text-zinc-200">
                      {t.title}
                    </span>
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
                      {t.repo && (
                        <span className="font-mono text-[11px] text-zinc-600">
                          {t.repo.replace("vyond/", "")}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 font-mono text-[12px] text-zinc-500">
                      {t.linkedSessionId && (
                        <span className="rounded border border-zinc-800 px-1.5 py-0.5 text-zinc-400">
                          {t.linkedSessionId} ↗
                        </span>
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

      {/* Quiet bottom bar for testing mock events */}
      <footer className="fixed inset-x-0 bottom-0 border-t border-zinc-900 bg-zinc-950/95 px-4 py-2 text-[12px] text-zinc-500">
        <div className="mx-auto flex max-w-[640px] items-center justify-between">
          <span>Preview controls</span>
          <div className="flex items-center gap-2">
            <button onClick={() => simulateEvent("finish")} className={btn}>
              Simulate Agent Finishes Turn
            </button>
            <button onClick={() => simulateEvent("question")} className={btn}>
              Simulate Agent Asks Question
            </button>
            {onExitMock && (
              <button onClick={onExitMock} className={`${btn} text-orange-500`}>
                Live Todoist App →
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
  session,
  sessions,
  expanded,
  onToggle,
  onSteer,
  onComplete,
  onUpdate,
}: {
  task: FlightTask;
  large?: boolean;
  session?: OpenCodeSession;
  sessions: OpenCodeSession[];
  expanded: boolean;
  onToggle: () => void;
  onSteer: (instruction: string) => void;
  onComplete: () => void;
  onUpdate: (fields: Partial<FlightTask>) => void;
}) {
  const [steerInput, setSteerInput] = useState("");
  const [showCheckpoints, setShowCheckpoints] = useState(false);
  const [showOptions, setShowOptions] = useState(false);

  const ui = TRIAGE_UI[task.triage];
  const hasQuestion = Boolean(session?.questionPrompt);
  const repoShort = (task.repo || session?.repo || "").replace("vyond/", "");

  const firstOutcomeLine = session?.latestOutcomeMarkdown
    ? session.latestOutcomeMarkdown
        .replace(/```[\s\S]*?```/g, "")
        .replace(/[*`#-]/g, "")
        .replace(/\s+/g, " ")
        .trim()
    : "";

  const subline = hasQuestion
    ? `Pick option: ${session?.questionPrompt?.question}`
    : firstOutcomeLine || task.specPrompt || "";

  const submitSteer = (textOverride?: string) => {
    const msg = (textOverride ?? steerInput).trim() || task.specPrompt || task.title;
    onSteer(msg);
    setSteerInput("");
  };

  return (
    <li
      className={`rounded-md border-l-2 transition-colors duration-150 ${
        expanded
          ? "border-l-orange-500 bg-zinc-900 ring-1 ring-zinc-800"
          : `${ui.leftBar} hover:bg-zinc-900`
      }`}
    >
      {/* Collapsed Header Row */}
      <div className={`flex items-center gap-2.5 px-3 ${large ? "min-h-13" : "min-h-10"}`}>
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
            {repoShort && (
              <span className="shrink-0 font-mono text-[11px] text-zinc-500">
                {repoShort}
              </span>
            )}
          </div>
          {subline && (
            <span
              className={`block truncate text-[12px] ${
                hasQuestion
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
          <span className={`inline-flex items-center gap-1.5 font-mono text-[12px] ${ui.labelCls}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${ui.dot}`} />
            {hasQuestion ? "Question" : ui.label}
          </span>

          {!session && (
            <button
              onClick={() => submitSteer()}
              className="rounded px-2 py-1 text-[12px] text-orange-500 hover:bg-zinc-800 cursor-pointer"
              title="Launch OpenCode agent on this task"
            >
              Run Agent →
            </button>
          )}
        </div>
      </div>

      {/* Expanded Executive Triage Drawer */}
      {expanded && (
        <div className="row-expand">
          <div className="space-y-3 border-t border-zinc-800/80 px-3 pt-3 pb-3">
            {/* 1. OpenCode Question Option Picker (when agent asks you to pick an option) */}
            {hasQuestion && session?.questionPrompt && (
              <div className="space-y-2 rounded-md border border-orange-500/40 bg-zinc-950 p-3 text-[13px]">
                <div className="font-medium text-zinc-100">
                  {session.questionPrompt.question}
                </div>
                <div className="grid gap-1.5 pt-0.5">
                  {session.questionPrompt.options.map((opt) => (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => submitSteer(opt.label)}
                      className="flex flex-col items-start rounded border border-zinc-800 bg-zinc-900/90 px-3 py-2 text-left transition-colors hover:border-orange-500/60 hover:bg-zinc-900 cursor-pointer"
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

            {/* 2. Latest Outcome (Markdown) + Collapsible Checkpoint History */}
            {session ? (
              <div className="space-y-2.5">
                <div className="flex items-center justify-between text-[11px] text-zinc-500">
                  <span className="font-medium uppercase tracking-wider text-zinc-400">
                    Latest Agent Outcome
                  </span>
                  <span className="font-mono">{session.idleSinceLabel}</span>
                </div>

                <div className="max-h-56 overflow-y-auto">
                  <SimpleMarkdown text={session.latestOutcomeMarkdown} />
                </div>

                {session.checkpoints.length > 0 && (
                  <div className="pt-1">
                    <button
                      type="button"
                      onClick={() => setShowCheckpoints((s) => !s)}
                      className="flex items-center gap-1.5 text-[12px] text-zinc-400 hover:text-zinc-200 cursor-pointer"
                    >
                      <span>{showCheckpoints ? "▾" : "▸"}</span>
                      <span>
                        {session.checkpoints.length} session checkpoints (history)
                      </span>
                    </button>

                    {showCheckpoints && (
                      <ol className="mt-2 space-y-1.5 border-l border-zinc-800 pl-3 text-[12px]">
                        {session.checkpoints.map((cp) => (
                          <li key={cp.id} className="flex flex-col gap-0.5">
                            <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                              <span
                                className={
                                  cp.actor === "you"
                                    ? "font-medium text-orange-400"
                                    : "font-medium text-zinc-300"
                                }
                              >
                                {cp.actor === "you" ? "You steered" : "OpenCode"}
                              </span>
                              <span>·</span>
                              <span className="font-mono">{cp.timeAgo}</span>
                              {cp.toolBadge && (
                                <span className="rounded bg-zinc-800/80 px-1.5 py-0.2 font-mono text-[10px] text-zinc-400">
                                  {cp.toolBadge}
                                </span>
                              )}
                            </div>
                            <p className="text-zinc-300">{cp.summary}</p>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-[12px] text-zinc-500">
                No OpenCode session running yet. Enter your prompt below to start.
              </div>
            )}

            {/* 3. Unmistakable Framed Steer / Reply Box (No hardcoded commit/test chips) */}
            <div className="rounded-md border border-zinc-700 bg-zinc-950 p-2.5 transition-colors focus-within:border-orange-500">
              <div className="mb-1 flex items-center justify-between text-[11px] text-zinc-500">
                <span className="font-medium text-zinc-400">
                  {session ? "Steer Agent / Reply" : "Initial Agent Prompt"}
                </span>
                <span className="font-mono">⌘Enter to send</span>
              </div>
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
                    ? "Type a custom answer or tell OpenCode what to do next…"
                    : "Describe what OpenCode should do for this task…"
                }
                className="w-full resize-none bg-transparent text-[14px] leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-600"
              />

              <div className="mt-1.5 flex items-center justify-end border-t border-zinc-900 pt-1.5">
                <button
                  type="button"
                  onClick={() => submitSteer()}
                  className="rounded bg-orange-600 px-3 py-1 text-[12px] font-medium text-white hover:bg-orange-500 cursor-pointer"
                >
                  {session ? "Send Steer ⌘↵" : "Start Agent ⌘↵"}
                </button>
              </div>
            </div>

            {/* 4. Optional Repo / Session Picker Drawer */}
            {showOptions && (
              <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800/70 pt-2 text-[12px]">
                <label className="flex items-center gap-1.5 text-zinc-400">
                  <span className="text-zinc-500">Repo</span>
                  <select
                    value={task.repo}
                    onChange={(e) => onUpdate({ repo: e.target.value })}
                    className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-[12px] text-zinc-300 outline-none"
                  >
                    <option value="">None (~)</option>
                    {KNOWN_REPOS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex items-center gap-1.5 text-zinc-400">
                  <span className="text-zinc-500">Session</span>
                  <select
                    value={task.linkedSessionId ?? ""}
                    onChange={(e) =>
                      onUpdate({ linkedSessionId: e.target.value || undefined })
                    }
                    className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-[12px] text-zinc-300 outline-none"
                  >
                    <option value="">Auto-create</option>
                    {sessions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.id} · {s.title.slice(0, 24)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            {/* 5. Minimal Bottom Bar */}
            <div className="flex items-center justify-between pt-0.5 text-[12px]">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowOptions((s) => !s)}
                  className="text-zinc-500 hover:text-zinc-300 cursor-pointer"
                >
                  {showOptions
                    ? "Hide options"
                    : [repoShort || "No repo (~)", task.linkedSessionId || "No session"]
                        .join(" · ")}
                </button>
                {task.linkedSessionId && (
                  <button
                    type="button"
                    onClick={() =>
                      navigator.clipboard?.writeText(`opencode -s ${task.linkedSessionId}`)
                    }
                    title={`Copy "opencode -s ${task.linkedSessionId}"`}
                    className="rounded border border-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-400 hover:text-zinc-200 cursor-pointer"
                  >
                    Open in CLI ↗
                  </button>
                )}
              </div>

              <button
                onClick={onComplete}
                className="rounded border border-zinc-700 px-2.5 py-1 text-[12px] text-zinc-200 hover:border-orange-500 hover:text-orange-400 cursor-pointer"
              >
                ✓ Mark Done
              </button>
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
  onSubmit,
}: {
  placeholder: string;
  alwaysOpen?: boolean;
  onSubmit: (
    parsed: { title: string; repo: string; prompt: string },
    launchAgent: boolean,
  ) => void;
}) {
  const [titleRaw, setTitleRaw] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [promptText, setPromptText] = useState("");
  const [pickedRepo, setPickedRepo] = useState("");
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const submit = (launchAgent: boolean) => {
    if (!titleRaw.trim()) return;
    const parsed = parseTaskInput(titleRaw, promptText, showDetails ? pickedRepo : "");
    onSubmit(parsed, launchAgent);
    setTitleRaw("");
    setPromptText("");
    if (!alwaysOpen) setShowDetails(false);
  };

  return (
    <div
      className={`rounded-md border transition-colors ${
        showDetails || titleRaw
          ? "border-zinc-800 bg-zinc-900/90"
          : "border-transparent bg-transparent hover:bg-zinc-900/40"
      }`}
    >
      <div className="flex items-center gap-2 px-2.5 py-2">
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
              submit(true);
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
          className="shrink-0 rounded px-2 py-0.5 text-[12px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 cursor-pointer"
        >
          {showDetails ? "Hide" : "＋ Prompt"}
        </button>
      </div>

      {showDetails && (
        <div className="space-y-2.5 border-t border-zinc-800/80 px-2.5 pt-2.5 pb-2.5 text-[12px]">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-zinc-500">Repo (optional):</span>
            <button
              type="button"
              onClick={() => setPickedRepo("")}
              className={`rounded px-2 py-0.5 font-mono text-[11px] cursor-pointer ${
                pickedRepo === ""
                  ? "bg-zinc-200 font-medium text-zinc-950"
                  : "bg-zinc-800/70 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              None (~)
            </button>
            {KNOWN_REPOS.map((r) => {
              const short = r.replace("vyond/", "");
              const active = pickedRepo === r;
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => setPickedRepo(r)}
                  className={`rounded px-2 py-0.5 font-mono text-[11px] cursor-pointer ${
                    active
                      ? "bg-zinc-200 font-medium text-zinc-950"
                      : "bg-zinc-800/70 text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {short}
                </button>
              );
            })}
          </div>

          <textarea
            ref={promptRef}
            rows={2}
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit(true);
              }
            }}
            placeholder="Todoist description / OpenCode prompt…"
            className="w-full resize-none rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 font-mono text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600"
          />

          <div className="flex items-center justify-end gap-1.5">
            <button type="button" onClick={() => submit(false)} className={btn}>
              Add to Queue
            </button>
            <button
              type="button"
              onClick={() => submit(true)}
              className="rounded bg-orange-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-orange-500 cursor-pointer"
            >
              Add & Start Agent ⌘↵
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
