import { useCallback, useEffect, useRef, useState } from "react";

const API = "https://api.todoist.com/api/v1";
const QUICK = [15, 25, 50, 90];
const BUFFER_QUICK = [15, 25];

type Task = {
  id: string;
  content: string;
  priority: number; // 4 = highest
  section_id?: string | null;
  due?: { datetime?: string; date: string } | null;
  duration?: { amount: number; unit: string } | null;
};
type Project = { id: string; name: string };
type SectionMap = Record<string, string>; // lowercase section name -> id
type Session = {
  task_id: string;
  task_name: string;
  planned_minutes: number;
  actual_minutes: number;
  completed: boolean;
  timestamp: number;
};
type Mutation = { path: string; method: string; body?: object };

const load = <T,>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
};
const save = (k: string, v: unknown) => localStorage.setItem(k, JSON.stringify(v));
const arr = <T,>(d: unknown): T[] =>
  Array.isArray(d) ? d : ((d as { results?: T[] }).results ?? []);
const todayStr = () => new Date().toDateString();

// design tokens — one ghost button, one input
const btn =
  "rounded-md px-3 py-1.5 text-[13px] text-zinc-400 transition-colors duration-150 hover:bg-zinc-800 hover:text-zinc-200";
const input =
  "w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-[15px] outline-none placeholder:text-zinc-600 focus:border-zinc-700";

// ponytail: failed mutations queue in localStorage, flushed on next poll/online
async function api(token: string, path: string, method = "GET", body?: object) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.status === 204 ? null : res.json();
}

async function mutate(token: string, m: Mutation) {
  try {
    await api(token, m.path, m.method, m.body);
  } catch (e) {
    if (e instanceof TypeError) {
      const q = load<Mutation[]>("tb_queue", []);
      q.push(m);
      save("tb_queue", q);
    } else throw e;
  }
}

async function flushQueue(token: string) {
  const q = load<Mutation[]>("tb_queue", []);
  if (!q.length) return;
  const failed: Mutation[] = [];
  for (const m of q) {
    try {
      await api(token, m.path, m.method, m.body);
    } catch {
      failed.push(m);
    }
  }
  save("tb_queue", failed);
}

function fmt(sec: number) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ponytail: alarm = raw oscillator, no audio file
function alarm() {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0.25, ctx.currentTime);
  osc.start();
  osc.stop(ctx.currentTime + 1.5);
}

const sortTasks = (ts: Task[]) =>
  [...ts].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const da = a.due?.datetime ?? a.due?.date ?? "9999";
    const db = b.due?.datetime ?? b.due?.date ?? "9999";
    return da.localeCompare(db);
  });

export default function App() {
  const [token, setToken] = useState(() => load("tb_token", ""));
  const [projectId, setProjectId] = useState(() => load("tb_project", ""));
  const [tasks, setTasks] = useState<Task[]>([]);
  const [sections, setSections] = useState<SectionMap>(() => load("tb_sections", {}));
  const [sessions, setSessions] = useState<Session[]>(() => load("tb_sessions", []));
  const [archivedDay, setArchivedDay] = useState(() => load("tb_archived", ""));
  const [active, setActive] = useState<{ task: Task; minutes: number } | null>(null);
  const [view, setView] = useState<"focus" | "backlog" | "review">("focus");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!token || !projectId) return;
    try {
      await flushQueue(token);
      const [sec, ts] = await Promise.all([
        api(token, `/sections?project_id=${projectId}`),
        api(token, `/tasks?project_id=${projectId}`),
      ]);
      const map: SectionMap = {};
      for (const s of arr<{ id: string; name: string }>(sec)) map[s.name.toLowerCase()] = s.id;
      save("tb_sections", map); // cached; next fetch re-resolves renames
      setSections(map);
      setTasks(arr<Task>(ts));
      setError("");
    } catch (e) {
      setError(e instanceof TypeError ? "Offline — changes will sync later" : String(e));
    }
  }, [token, projectId]);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 30_000);
    const onOnline = () => refresh();
    window.addEventListener("online", onOnline);
    return () => {
      clearInterval(iv);
      window.removeEventListener("online", onOnline);
    };
  }, [refresh]);

  const logSession = (s: Session) => {
    const next = [...sessions, s];
    setSessions(next);
    save("tb_sessions", next);
  };

  // optimistic move with rollback on API failure (offline queues instead)
  const moveTo = async (t: Task, sectionId: string) => {
    const prev = tasks;
    setTasks((ts) => ts.map((x) => (x.id === t.id ? { ...x, section_id: sectionId } : x)));
    try {
      await mutate(token, {
        path: `/tasks/${t.id}/move`,
        method: "POST",
        body: { section_id: sectionId },
      });
    } catch {
      setTasks(prev);
      setError("Move failed — rolled back");
    }
  };

  const quickAdd = async (content: string) => {
    const tmp: Task = {
      id: `tmp-${Date.now()}`,
      content,
      priority: 1,
      section_id: sections.buffer,
    };
    setTasks((ts) => [...ts, tmp]);
    try {
      await mutate(token, {
        path: "/tasks",
        method: "POST",
        body: { content, project_id: projectId, section_id: sections.buffer },
      });
    } catch {
      setTasks((ts) => ts.filter((t) => t.id !== tmp.id));
      setError("Add failed — rolled back");
    }
  };

  const archiveAll = async () => {
    const prev = tasks;
    const done = tasks.filter((t) => t.section_id === sections.done);
    setTasks((ts) => ts.filter((t) => t.section_id !== sections.done));
    try {
      for (const t of done) await mutate(token, { path: `/tasks/${t.id}/close`, method: "POST" });
      save("tb_archived", todayStr());
      setArchivedDay(todayStr());
    } catch {
      setTasks(prev);
      setError("Archive failed — rolled back");
    }
  };

  if (!token || !projectId)
    return (
      <Settings
        token={token}
        onDone={(t, p) => {
          save("tb_token", t);
          save("tb_project", p);
          setToken(t);
          setProjectId(p);
        }}
      />
    );

  if (active)
    return (
      <Timer
        task={active.task}
        minutes={active.minutes}
        onExit={() => setActive(null)}
        onLog={logSession}
        onComplete={async () => {
          await mutate(token, { path: `/tasks/${active.task.id}/close`, method: "POST" });
          setTasks((ts) => ts.filter((t) => t.id !== active.task.id));
          setActive(null);
        }}
      />
    );

  // ponytail: tasks without a section count as Backlog so nothing goes invisible
  const focusTasks = sortTasks(tasks.filter((t) => t.section_id === sections.focus));
  const bufferTasks = tasks.filter((t) => t.section_id === sections.buffer);
  const backlogTasks = sortTasks(
    tasks.filter((t) => t.section_id == null || t.section_id === sections.backlog),
  );
  const doneTasks = tasks.filter((t) => t.section_id === sections.done);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto grid max-w-[640px] grid-cols-[1fr_auto_1fr] items-center px-4 py-3">
          <span className="text-[15px] font-semibold">Timebox</span>
          <nav className="flex gap-1">
            {(["focus", "backlog", "review"] as const).map((v) => (
              <button
                key={v}
                className={`${btn} capitalize ${view === v ? "bg-zinc-800 text-zinc-100" : ""}`}
                onClick={() => setView(v)}
              >
                {v}
                {v === "backlog" && backlogTasks.length > 0 && (
                  <span className="ml-1 font-mono tabular-nums text-zinc-500">
                    {backlogTasks.length}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <div className="flex items-center justify-end gap-2">
            <button
              className={`${btn} text-zinc-600`}
              title="Reset token & project"
              onClick={() => {
                localStorage.clear();
                location.reload();
              }}
            >
              Reset
            </button>
            <span
              className={`h-2 w-2 rounded-full ${error ? "bg-red-500" : "bg-zinc-600"}`}
              title={error || "in sync"}
            />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[640px] px-4 py-8">
        {error && <p className="mb-4 text-[13px] text-zinc-500">{error}</p>}
        {view === "review" ? (
          <Review
            tasks={doneTasks}
            sessions={sessions}
            archived={archivedDay === todayStr() && doneTasks.length === 0}
            onArchiveAll={archiveAll}
          />
        ) : view === "backlog" ? (
          <section>
            <p className="mb-4 text-[13px] text-zinc-500">Click a task to pull it into Focus.</p>
            <BacklogList
              tasks={backlogTasks}
              canPull={!!sections.focus}
              onMove={(t) => moveTo(t, sections.focus)}
            />
          </section>
        ) : (
          <FocusView
            focusTasks={focusTasks}
            bufferTasks={bufferTasks}
            backlogTasks={backlogTasks}
            canBuffer={!!sections.buffer}
            canPull={!!sections.focus}
            onMove={(t) => moveTo(t, sections.focus)}
            onDemote={sections.backlog ? (t) => moveTo(t, sections.backlog) : undefined}
            onAdd={quickAdd}
            onDuration={async (t, minutes) => {
              setTasks((ts) =>
                sortTasks(
                  ts.map((x) =>
                    x.id === t.id ? { ...x, duration: { amount: minutes, unit: "minute" } } : x,
                  ),
                ),
              );
              await mutate(token, {
                path: `/tasks/${t.id}`,
                method: "POST",
                body: { duration: minutes, duration_unit: "minute" },
              });
            }}
            onStart={(t, minutes) => setActive({ task: t, minutes })}
          />
        )}
      </main>
    </div>
  );
}

function Settings({
  token: initial,
  onDone,
}: {
  token: string;
  onDone: (token: string, projectId: string) => void;
}) {
  const [token, setToken] = useState(initial);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [err, setErr] = useState("");

  const fetchProjects = async () => {
    setErr("");
    try {
      setProjects(arr<Project>(await api(token, "/projects")));
    } catch {
      setErr("Invalid token or network error");
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-sm space-y-4 px-4">
        <h1 className="text-[20px] font-semibold">Connect Todoist</h1>
        <input
          className={input}
          type="password"
          placeholder="API token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        {err && <p className="text-[13px] text-zinc-500">{err}</p>}
        {!projects ? (
          <button
            className={`${btn} text-orange-500 disabled:opacity-40`}
            disabled={!token}
            onClick={fetchProjects}
          >
            Load projects
          </button>
        ) : (
          <ul className="divide-y divide-zinc-800">
            {projects.map((p) => (
              <li key={p.id}>
                <button
                  className="w-full rounded-md px-2 py-2 text-left text-[15px] transition-colors duration-150 hover:bg-zinc-900"
                  onClick={() => onDone(token, p.id)}
                >
                  {p.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function BacklogList({
  tasks,
  canPull,
  onMove,
}: {
  tasks: Task[];
  canPull: boolean;
  onMove: (t: Task) => void;
}) {
  if (!tasks.length) return <p className="py-4 text-[13px] text-zinc-500">Backlog is empty.</p>;
  return (
    <ul className="divide-y divide-zinc-800">
      {tasks.map((t) => (
        <li key={t.id}>
          <button
            className="w-full rounded-md px-2 py-2 text-left text-[15px] transition-colors duration-150 hover:bg-zinc-900 disabled:opacity-40"
            disabled={!canPull}
            onClick={() => onMove(t)}
          >
            {t.content}
            {t.duration && (
              <span className="ml-2 font-mono text-[13px] tabular-nums text-zinc-500">
                {t.duration.amount}m
              </span>
            )}
            {t.due && (
              <span className="ml-2 text-[13px] text-zinc-600">
                {t.due.datetime ?? t.due.date}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

function FocusView({
  focusTasks,
  bufferTasks,
  backlogTasks,
  canBuffer,
  canPull,
  onMove,
  onDemote,
  onAdd,
  onDuration,
  onStart,
}: {
  focusTasks: Task[];
  bufferTasks: Task[];
  backlogTasks: Task[];
  canBuffer: boolean;
  canPull: boolean;
  onMove: (t: Task) => void;
  onDemote?: (t: Task) => void;
  onAdd: (content: string) => void;
  onDuration: (t: Task, minutes: number) => void;
  onStart: (t: Task, minutes: number) => void;
}) {
  const [drawer, setDrawer] = useState(false);
  const [dismissed, setDismissed] = useState(() => load("tb_plan_dismissed", ""));
  const showPlan = focusTasks.length === 0 && backlogTasks.length > 0 && dismissed !== todayStr();

  return (
    <div className="space-y-6">
      {showPlan && (
        <div className="flex items-center justify-between gap-4 rounded-md border border-zinc-800 bg-zinc-900 px-4 py-3">
          <p className="text-[13px] text-zinc-400">Plan your day — pull up to 3 tasks into Focus</p>
          <div className="flex shrink-0 gap-1">
            <button className={`${btn} text-orange-500`} onClick={() => setDrawer(true)}>
              Pull from Backlog
            </button>
            <button
              className={btn}
              onClick={() => {
                save("tb_plan_dismissed", todayStr());
                setDismissed(todayStr());
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {canBuffer && (
        <section>
          <QuickAdd onAdd={onAdd} />
          {bufferTasks.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-2">
              {bufferTasks.map((t) => (
                <li
                  key={t.id}
                  className="flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 py-1 pr-1 pl-3 text-[13px]"
                >
                  <span className="mr-1 max-w-[220px] truncate">{t.content}</span>
                  {BUFFER_QUICK.map((m) => (
                    <button
                      key={m}
                      className="rounded px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-orange-500 transition-colors duration-150 hover:bg-zinc-800"
                      title={`Start ${m}m timebox`}
                      onClick={() => onStart(t, m)}
                    >
                      ▶{m}
                    </button>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {focusTasks.length > 3 && (
        <p className="rounded-md border border-zinc-800 bg-zinc-900 px-4 py-3 text-[13px] text-zinc-400">
          Too many priorities. Move something back to Backlog.
        </p>
      )}

      {focusTasks.length === 0 ? (
        <button
          className="block w-full py-8 text-center text-[13px] text-zinc-500"
          onClick={() => setDrawer(true)}
        >
          Focus is empty. Pull from Backlog →
        </button>
      ) : (
        <ul className="space-y-3">
          {focusTasks.map((t) => (
            <TaskCard key={t.id} t={t} onDuration={onDuration} onStart={onStart} onDemote={onDemote} />
          ))}
        </ul>
      )}

      <section className="border-t border-zinc-800 pt-4">
        <button className={btn} onClick={() => setDrawer((d) => !d)}>
          {drawer ? "Hide Backlog" : `Pull from Backlog (${backlogTasks.length})`}
        </button>
        {drawer && (
          <div className="mt-2">
            <BacklogList tasks={backlogTasks} canPull={canPull} onMove={onMove} />
          </div>
        )}
      </section>
    </div>
  );
}

function QuickAdd({ onAdd }: { onAdd: (content: string) => void }) {
  const [v, setV] = useState("");
  return (
    <input
      className={input}
      placeholder="＋ Quick add to Buffer…"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && v.trim()) {
          onAdd(v.trim());
          setV("");
        }
      }}
    />
  );
}

function TaskCard({
  t,
  onDuration,
  onStart,
  onDemote,
}: {
  t: Task;
  onDuration: (t: Task, minutes: number) => void;
  onStart: (t: Task, minutes: number) => void;
  onDemote?: (t: Task) => void;
}) {
  const lb =
    t.priority === 4
      ? "border-l-zinc-200"
      : t.priority === 3
        ? "border-l-zinc-500"
        : t.priority === 2
          ? "border-l-zinc-700"
          : "border-l-zinc-800";
  return (
    <li className={`rounded-md border border-zinc-800 border-l-2 bg-zinc-900 p-4 ${lb}`}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-[15px] font-medium">{t.content}</p>
          <p className="mt-0.5 font-mono text-[13px] tabular-nums text-zinc-500">
            {t.duration ? `${t.duration.amount}m` : "no duration"}
            {t.due && ` · ${t.due.datetime ?? t.due.date}`}
          </p>
        </div>
        <button
          className="shrink-0 rounded-md px-4 py-2 text-[15px] font-medium text-orange-500 transition-colors duration-150 hover:bg-zinc-800"
          onClick={() => onStart(t, t.duration?.amount ?? 25)}
        >
          ▶ Start
        </button>
      </div>
      <div className="mt-3 flex gap-1">
        {QUICK.map((m) => (
          <button
            key={m}
            className={`rounded-md border px-2 py-0.5 font-mono text-[11px] tabular-nums transition-colors duration-150 ${
              t.duration?.amount === m
                ? "border-zinc-600 text-zinc-200"
                : "border-zinc-800 text-zinc-500 hover:bg-zinc-800"
            }`}
            onClick={() => onDuration(t, m)}
          >
            {m}
          </button>
        ))}
        {onDemote && (
          <button
            className={`${btn} ml-auto`}
            title="Move back to Backlog"
            onClick={() => onDemote(t)}
          >
            ↓ Backlog
          </button>
        )}
      </div>
    </li>
  );
}

function Review({
  tasks,
  sessions,
  archived,
  onArchiveAll,
}: {
  tasks: Task[];
  sessions: Session[];
  archived: boolean;
  onArchiveAll: () => void;
}) {
  const ts = sessions.filter((s) => new Date(s.timestamp).toDateString() === todayStr());
  const focused = ts.reduce((a, s) => a + s.actual_minutes, 0);
  const completed = ts.filter((s) => s.completed).length;
  const planned = ts.reduce((a, s) => a + s.planned_minutes, 0);
  const accuracy = planned ? Math.round((focused / planned) * 100) : 0;
  const actualFor = (id: string) => {
    const n = ts.filter((s) => s.task_id === id).reduce((a, s) => a + s.actual_minutes, 0);
    return n || null;
  };

  const stats: [string, string][] = [
    [`${focused}m`, "focused today"],
    [String(completed), "completed"],
    [`${accuracy}%`, "planned vs actual"],
  ];

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-3 gap-4 text-center">
        {stats.map(([v, l]) => (
          <div key={l}>
            <p className="font-mono text-[28px] font-semibold tabular-nums">{v}</p>
            <p className="text-[13px] text-zinc-500">{l}</p>
          </div>
        ))}
      </div>
      {archived ? (
        <p className="py-16 text-center text-[20px] font-semibold">Day complete ✓</p>
      ) : tasks.length === 0 ? (
        <p className="text-[13px] text-zinc-500">Nothing in Done yet.</p>
      ) : (
        <>
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-zinc-800 text-[13px] text-zinc-500">
                <th className="py-2 font-normal">Task</th>
                <th className="py-2 text-right font-normal">Planned</th>
                <th className="py-2 text-right font-normal">Actual</th>
                <th className="py-2 text-right font-normal">Δ</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => {
                const a = actualFor(t.id);
                const p = t.duration?.amount ?? null;
                const d = a != null && p != null ? a - p : null;
                return (
                  <tr key={t.id} className="border-b border-zinc-800/60">
                    <td className="py-2 pr-2 text-[15px]">{t.content}</td>
                    <td className="py-2 text-right font-mono text-[13px] tabular-nums text-zinc-500">
                      {p != null ? `${p}m` : "—"}
                    </td>
                    <td className="py-2 text-right font-mono text-[13px] tabular-nums text-zinc-500">
                      {a != null ? `${a}m` : "—"}
                    </td>
                    <td className="py-2 text-right font-mono text-[13px] tabular-nums text-zinc-500">
                      {d != null ? `${d > 0 ? "+" : ""}${d}m` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button
            className="rounded-md border border-zinc-800 px-4 py-2 text-[13px] text-orange-500 transition-colors duration-150 hover:bg-zinc-900"
            onClick={onArchiveAll}
          >
            Archive All
          </button>
        </>
      )}
    </div>
  );
}

function Timer({
  task,
  minutes,
  onExit,
  onLog,
  onComplete,
}: {
  task: Task;
  minutes: number;
  onExit: () => void;
  onLog: (s: Session) => void;
  onComplete: () => void;
}) {
  const [left, setLeft] = useState(minutes * 60);
  const [paused, setPaused] = useState(false);
  const [timesUp, setTimesUp] = useState(false);
  const endRef = useRef(Date.now() + minutes * 60_000);
  const elapsedRef = useRef(0); // seconds actually run
  const totalRef = useRef(minutes * 60);
  const alarmedRef = useRef(false);

  // ponytail: endTime timestamp, not decrementing counter — survives drift
  useEffect(() => {
    if (Notification.permission === "default") Notification.requestPermission();
    const iv = setInterval(() => {
      if (paused) return;
      const rem = Math.max(0, (endRef.current - Date.now()) / 1000);
      elapsedRef.current += 0.25;
      setLeft(rem);
      document.title = `${fmt(rem)} - ${task.content}`;
      if (rem <= 0 && !alarmedRef.current) {
        alarmedRef.current = true;
        alarm();
        if (Notification.permission === "granted")
          new Notification("Time's up!", { body: task.content });
        document.body.classList.add("flash");
        setTimeout(() => document.body.classList.remove("flash"), 4000);
        setTimesUp(true);
      }
    }, 250);
    return () => {
      clearInterval(iv);
      document.title = "Timebox Focus";
    };
  }, [paused, task.content]);

  const extend = (m: number) => {
    endRef.current += m * 60_000;
    totalRef.current += m * 60;
    alarmedRef.current = false;
    setTimesUp(false);
    setLeft((endRef.current - Date.now()) / 1000);
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === " ") {
        e.preventDefault();
        setPaused((p) => !p);
      } else if (e.key === "Enter") onComplete();
      else if (e.key === "Escape") onExit();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [paused, onComplete, onExit]);

  // keep endTime honest across pause: shift it forward by paused duration
  const pauseStarted = useRef(0);
  useEffect(() => {
    if (paused) pauseStarted.current = Date.now();
    else if (pauseStarted.current) {
      endRef.current += Date.now() - pauseStarted.current;
      pauseStarted.current = 0;
    }
  }, [paused]);

  const frac = Math.max(0, left / totalRef.current);
  const C = 2 * Math.PI * 48;

  const logAndExit = (completed: boolean) => {
    onLog({
      task_id: task.id,
      task_name: task.content,
      planned_minutes: minutes,
      actual_minutes: Math.round(elapsedRef.current / 60),
      completed,
      timestamp: Date.now(),
    });
  };

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden">
      <h2 className="absolute top-16 max-w-3xl px-4 text-center text-[20px] text-zinc-400">
        {task.content}
      </h2>
      <div className="relative flex items-center justify-center">
        <svg viewBox="0 0 100 100" className="absolute h-[92vmin] w-[92vmin] -rotate-90">
          <circle cx="50" cy="50" r="48" fill="none" stroke="#27272a" strokeWidth="0.75" />
          <circle
            cx="50"
            cy="50"
            r="48"
            fill="none"
            stroke="#f97316"
            strokeWidth="0.75"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - frac)}
            className="transition-[stroke-dashoffset] duration-150"
          />
        </svg>
        <p
          className={`relative font-mono text-[min(22vw,26vh)] leading-none font-bold tabular-nums ${
            frac <= 0.1 ? "text-orange-500" : "text-zinc-100"
          }`}
        >
          {fmt(left)}
        </p>
      </div>
      <div className="absolute bottom-16 flex gap-2">
        <button className={btn} onClick={() => extend(5)}>
          +5 min
        </button>
        <button className={btn} onClick={() => setPaused((p) => !p)}>
          {paused ? "Resume" : "Pause"}
        </button>
        <button
          className={`${btn} text-orange-500`}
          onClick={() => {
            logAndExit(true);
            onComplete();
          }}
        >
          Complete ✓
        </button>
        <button
          className={btn}
          onClick={() => {
            logAndExit(false);
            onExit();
          }}
        >
          Abandon ✗
        </button>
      </div>

      {timesUp && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-zinc-950/80">
          <div className="w-full max-w-sm space-y-2 rounded-md border border-zinc-800 bg-zinc-900 p-6">
            <h3 className="mb-4 text-[20px] font-semibold">Time's up!</h3>
            <button
              className="block w-full rounded-md px-4 py-2 text-[15px] font-medium text-orange-500 transition-colors duration-150 hover:bg-zinc-800"
              onClick={() => {
                logAndExit(true);
                onComplete();
              }}
            >
              Mark complete
            </button>
            <button
              className={`${btn} block w-full`}
              onClick={() => extend(5)}
            >
              Extend +5 min
            </button>
            <button
              className={`${btn} block w-full`}
              onClick={() => {
                logAndExit(false);
                onExit();
              }}
            >
              Not done — log & stop
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
