import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

const API = "https://api.todoist.com/api/v1";
const QUICK = [2, 5, 15, 25, 90];

type Task = {
  id: string;
  content: string;
  priority: number; // 4 = highest
  section_id?: string | null;
  description?: string | null;
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

const pBar = (p: number) =>
  p === 4
    ? "border-l-zinc-200"
    : p === 3
      ? "border-l-zinc-500"
      : p === 2
        ? "border-l-zinc-700"
        : "border-l-zinc-800";

// mini NL parse: "Fix VPN 15m #Focus p1" -> content + duration + section + priority
// Todoist priority is inverted (4 = urgent), so p1..p4 maps to 4..1
function parseAdd(raw: string, sections: SectionMap) {
  let content = ` ${raw} `;
  let duration: number | undefined;
  let priority: number | undefined;
  let sectionName: string | undefined;
  content = content.replace(/\s(\d+)m(?=\s)/i, (_m, n) => {
    duration = +n;
    return " ";
  });
  content = content.replace(/\s#(\w+)(?=\s)/, (m, n) =>
    sections[(n as string).toLowerCase()] ? ((sectionName = n as string), " ") : (m as string),
  );
  content = content.replace(/\sp([1-4])(?=\s)/i, (_m, n) => {
    priority = 5 - +n;
    return " ";
  });
  return { content: content.trim().replace(/\s{2,}/g, " "), duration, priority, sectionName };
}

export default function App() {
  const [token, setToken] = useState(() => load("tb_token", ""));
  const [projectId, setProjectId] = useState(() => load("tb_project", ""));
  const [tasks, setTasks] = useState<Task[]>([]);
  const tasksRef = useRef<Task[]>([]);
  tasksRef.current = tasks; // fresh snapshot for async rollback paths
  const [sections, setSections] = useState<SectionMap>(() => load("tb_sections", {}));
  const [sessions, setSessions] = useState<Session[]>(() => load("tb_sessions", []));
  const [archivedDay, setArchivedDay] = useState(() => load("tb_archived", ""));
  const [active, setActive] = useState<{ task: Task; minutes: number } | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; undo?: () => void } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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

  const showToast = (msg: string, undo?: () => void) => {
    setToast({ msg, undo });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  };

  const toggleRow = (id: string) => setExpandedId((cur) => (cur === id ? null : id));

  // optimistic move with rollback on API failure (offline queues instead)
  const moveTo = async (t: Task, sectionId: string) => {
    const prev = tasksRef.current;
    setTasks((ts) => ts.map((x) => (x.id === t.id ? { ...x, section_id: sectionId } : x)));
    try {
      await mutate(token, {
        path: `/tasks/${t.id}/move`,
        method: "POST",
        body: { section_id: sectionId },
      });
    } catch {
      setTasks(prev);
      showToast("Move failed — rolled back");
    }
  };

  const addTask = async (raw: string, fallbackSection?: string) => {
    const p = parseAdd(raw, sections);
    if (!p.content) return;
    const sectionId = (p.sectionName && sections[p.sectionName.toLowerCase()]) || fallbackSection;
    const tmp: Task = {
      id: `tmp-${Date.now()}`,
      content: p.content,
      priority: p.priority ?? 1,
      section_id: sectionId ?? null,
      duration: p.duration != null ? { amount: p.duration, unit: "minute" } : undefined,
    };
    setTasks((ts) => [...ts, tmp]);
    try {
      await mutate(token, {
        path: "/tasks",
        method: "POST",
        body: {
          content: p.content,
          project_id: projectId,
          ...(sectionId ? { section_id: sectionId } : {}),
          ...(p.duration != null ? { duration: p.duration, duration_unit: "minute" } : {}),
          ...(p.priority ? { priority: p.priority } : {}),
        },
      });
    } catch {
      setTasks((ts) => ts.filter((t) => t.id !== tmp.id));
      showToast("Add failed — rolled back");
    }
  };

  const changeDuration = async (t: Task, minutes: number) => {
    setTasks((ts) =>
      sortTasks(
        ts.map((x) => (x.id === t.id ? { ...x, duration: { amount: minutes, unit: "minute" } } : x)),
      ),
    );
    await mutate(token, {
      path: `/tasks/${t.id}`,
      method: "POST",
      body: { duration: minutes, duration_unit: "minute" },
    });
  };

  // partial update, optimistic + rollback; rethrows so the editor can clear its indicator
  const updateTask = async (id: string, fields: { content?: string; description?: string }) => {
    const prev = tasksRef.current;
    setTasks((ts) => ts.map((x) => (x.id === id ? { ...x, ...fields } : x)));
    try {
      await mutate(token, { path: `/tasks/${id}`, method: "POST", body: fields });
    } catch {
      setTasks(prev);
      showToast("Save failed — rolled back");
      throw new Error("save failed");
    }
  };

  const deleteTask = async (t: Task) => {
    const snapshot = t;
    const prev = tasksRef.current;
    setExpandedId(null);
    setTasks((ts) => ts.filter((x) => x.id !== t.id));
    try {
      await mutate(token, { path: `/tasks/${t.id}`, method: "DELETE" });
    } catch {
      setTasks(prev);
      showToast("Delete failed — rolled back");
      return;
    }
    showToast("Task deleted.", async () => {
      try {
        const created = (await api(token, "/tasks", "POST", {
          content: snapshot.content,
          description: snapshot.description ?? "",
          project_id: projectId,
          ...(snapshot.section_id ? { section_id: snapshot.section_id } : {}),
          priority: snapshot.priority,
          ...(snapshot.duration
            ? { duration: snapshot.duration.amount, duration_unit: "minute" }
            : {}),
        })) as Task;
        setTasks((ts) => [...ts, created]);
        setSessions((ss) => {
          const next = ss.map((s) =>
            s.task_id === snapshot.id ? { ...s, task_id: created.id } : s,
          );
          save("tb_sessions", next);
          return next;
        });
      } catch {
        showToast("Undo failed");
      }
    });
  };

  const archiveAll = async () => {
    const prev = tasksRef.current;
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
      <main className="mx-auto max-w-[640px] px-4 pt-8 pb-24 md:pb-8">
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
            {backlogTasks.length === 0 ? (
              <p className="py-4 text-[13px] text-zinc-500">Backlog is empty.</p>
            ) : (
              <ul className="space-y-0.5">
                {backlogTasks.map((t) => (
                  <TaskRow
                    key={t.id}
                    t={t}
                    expanded={expandedId === t.id}
                    onToggle={() => toggleRow(t.id)}
                    onMove={sections.focus ? (x) => moveTo(x, sections.focus) : undefined}
                    onUpdate={updateTask}
                    onDuration={changeDuration}
                    onDelete={deleteTask}
                  />
                ))}
              </ul>
            )}
            <AddRow
              placeholder="＋ Add to Backlog…"
              sections={sections}
              onAdd={(raw) => addTask(raw, sections.backlog)}
            />
          </section>
        ) : (
          <FocusView
            focusTasks={focusTasks}
            bufferTasks={bufferTasks}
            backlogCount={backlogTasks.length}
            sections={sections}
            expandedId={expandedId}
            onToggle={toggleRow}
            onMove={(t) => moveTo(t, sections.focus)}
            onDemote={sections.backlog ? (t) => moveTo(t, sections.backlog) : undefined}
            onAdd={addTask}
            onUpdate={updateTask}
            onDuration={changeDuration}
            onDelete={deleteTask}
            onStart={(t, minutes) => setActive({ task: t, minutes })}
            onGoBacklog={() => setView("backlog")}
          />
        )}
      </main>
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-zinc-800 bg-zinc-950 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:hidden">
        <AddRow
          placeholder="＋ Quick add to Buffer…"
          alwaysOpen
          sections={sections}
          onAdd={(raw) => addTask(raw, sections.buffer)}
        />
      </div>
      {toast && (
        <div className="fixed bottom-20 left-1/2 z-40 -translate-x-1/2 rounded-md border border-zinc-800 bg-zinc-900 px-4 py-2 text-[13px] whitespace-nowrap md:bottom-6">
          {toast.msg}
          {toast.undo && (
            <button
              className="ml-2 text-orange-500"
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

function FocusView({
  focusTasks,
  bufferTasks,
  backlogCount,
  sections,
  expandedId,
  onToggle,
  onMove,
  onDemote,
  onAdd,
  onUpdate,
  onDuration,
  onDelete,
  onStart,
  onGoBacklog,
}: {
  focusTasks: Task[];
  bufferTasks: Task[];
  backlogCount: number;
  sections: SectionMap;
  expandedId: string | null;
  onToggle: (id: string) => void;
  onMove: (t: Task) => void;
  onDemote?: (t: Task) => void;
  onAdd: (raw: string, fallbackSection?: string) => void;
  onUpdate: (id: string, fields: { content?: string; description?: string }) => Promise<void>;
  onDuration: (t: Task, minutes: number) => void;
  onDelete: (t: Task) => void;
  onStart: (t: Task, minutes: number) => void;
  onGoBacklog: () => void;
}) {
  const [dismissed, setDismissed] = useState(() => load("tb_plan_dismissed", ""));
  const showPlan = focusTasks.length === 0 && backlogCount > 0 && dismissed !== todayStr();

  return (
    <div className="space-y-6">
      {showPlan && (
        <div className="flex items-center justify-between gap-4 rounded-md border border-zinc-800 bg-zinc-900 px-4 py-3">
          <p className="text-[13px] text-zinc-400">Plan your day — pull up to 3 tasks into Focus</p>
          <div className="flex shrink-0 gap-1">
            <button className={`${btn} text-orange-500`} onClick={onGoBacklog}>
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

      {sections.buffer && (
        <section>
          <p className="mb-1 px-2 text-[13px] text-zinc-500">Buffer</p>
          {bufferTasks.length > 0 && (
            <ul className="space-y-0.5">
              {bufferTasks.map((t) => (
                <TaskRow
                  key={t.id}
                  t={t}
                  expanded={expandedId === t.id}
                  onToggle={() => onToggle(t.id)}
                  onStart={onStart}
                  onUpdate={onUpdate}
                  onDuration={onDuration}
                  onDelete={onDelete}
                />
              ))}
            </ul>
          )}
          <AddRow
            placeholder="＋ Quick add to Buffer…"
            hotkey="b"
            sections={sections}
            onAdd={(raw) => onAdd(raw, sections.buffer)}
          />
        </section>
      )}

      {focusTasks.length > 3 && (
        <p className="rounded-md border border-zinc-800 bg-zinc-900 px-4 py-3 text-[13px] text-zinc-400">
          Too many priorities. Move something back to Backlog.
        </p>
      )}

      <section>
        <p className="mb-1 px-2 text-[13px] text-zinc-500">Focus</p>
        {focusTasks.length === 0 ? (
          <button
            className="block w-full py-8 text-center text-[13px] text-zinc-500"
            onClick={onGoBacklog}
          >
            Focus is empty. Pull from Backlog →
          </button>
        ) : (
          <ul className="space-y-0.5">
            {focusTasks.map((t) => (
              <TaskRow
                key={t.id}
                t={t}
                large
                expanded={expandedId === t.id}
                onToggle={() => onToggle(t.id)}
                onStart={onStart}
                onDemote={onDemote}
                onUpdate={onUpdate}
                onDuration={onDuration}
                onDelete={onDelete}
              />
            ))}
          </ul>
        )}
        {sections.focus && (
          <AddRow
            placeholder="＋ Add to Focus…"
            hotkey="n"
            sections={sections}
            onAdd={(raw) => onAdd(raw, sections.focus)}
          />
        )}
      </section>
    </div>
  );
}

function TaskRow({
  t,
  large,
  expanded,
  onToggle,
  onStart,
  defaultMinutes = 5,
  onMove,
  onDemote,
  onUpdate,
  onDuration,
  onDelete,
}: {
  t: Task;
  large?: boolean;
  expanded: boolean;
  onToggle: () => void;
  onStart?: (t: Task, minutes: number) => void;
  defaultMinutes?: number;
  onMove?: (t: Task) => void;
  onDemote?: (t: Task) => void;
  onUpdate: (id: string, fields: { content?: string; description?: string }) => Promise<void>;
  onDuration: (t: Task, minutes: number) => void;
  onDelete: (t: Task) => void;
}) {
  const rootRef = useRef<HTMLLIElement>(null);

  // collapse on tap-outside / Esc (collapse flushes via RowEditor unmount)
  useEffect(() => {
    if (!expanded) return;
    const down = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onToggle();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onToggle();
    };
    document.addEventListener("pointerdown", down);
    window.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", key);
    };
  }, [expanded, onToggle]);

  const dur = t.duration && (
    <span className="shrink-0 font-mono text-[13px] tabular-nums text-zinc-500">
      {t.duration.amount}m
    </span>
  );
  const actions = (
    <>
      {onStart && (
        <button
          className="shrink-0 rounded px-2 py-1 text-orange-500 transition-colors duration-150 hover:bg-zinc-800"
          title="Start timebox"
          onClick={() => onStart(t, t.duration?.amount ?? defaultMinutes)}
        >
          ▶
        </button>
      )}
      {onMove && (
        <button
          className={`${btn} shrink-0 px-2 py-1`}
          title="Pull into Focus"
          onClick={() => onMove(t)}
        >
          →
        </button>
      )}
    </>
  );

  return (
    <li
      ref={rootRef}
      className={`rounded-md border-l-2 transition-colors duration-150 ${
        expanded
          ? "border-l-orange-500 bg-zinc-900 ring-1 ring-zinc-700"
          : `${pBar(t.priority)} hover:bg-zinc-900 active:bg-zinc-800`
      }`}
    >
      {expanded ? (
        <RowEditor
          t={t}
          large={large}
          dur={dur}
          actions={actions}
          onClose={onToggle}
          onUpdate={onUpdate}
          onDuration={onDuration}
          onDemote={onDemote}
          onDelete={onDelete}
        />
      ) : (
        <div className={`flex items-center gap-2 px-2 ${large ? "min-h-14" : "min-h-11"}`}>
          <button
            className={`min-w-0 flex-1 truncate text-left ${large ? "text-[15px] font-medium" : "text-[14px]"}`}
            onClick={onToggle}
          >
            {t.content}
          </button>
          {dur}
          {actions}
        </div>
      )}
    </li>
  );
}

function RowEditor({
  t,
  large,
  dur,
  actions,
  onClose,
  onUpdate,
  onDuration,
  onDemote,
  onDelete,
}: {
  t: Task;
  large?: boolean;
  dur: ReactNode;
  actions: ReactNode;
  onClose: () => void;
  onUpdate: (id: string, fields: { content?: string; description?: string }) => Promise<void>;
  onDuration: (t: Task, minutes: number) => void;
  onDemote?: (t: Task) => void;
  onDelete: (t: Task) => void;
}) {
  const [title, setTitle] = useState(t.content);
  const [desc, setDesc] = useState(t.description ?? "");
  const [saveState, setSaveState] = useState<"" | "saving" | "saved">("");
  const [confirming, setConfirming] = useState(false);
  const titleLive = useRef(title);
  titleLive.current = title;
  const descLive = useRef(desc);
  descLive.current = desc;
  const tLive = useRef(t);
  tLive.current = t;
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const debRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const persist = async (fields: { content?: string; description?: string }) => {
    setSaveState("saving");
    clearTimeout(savedTimer.current);
    try {
      await onUpdate(t.id, fields);
      setSaveState("saved");
      savedTimer.current = setTimeout(() => setSaveState(""), 1000);
    } catch {
      setSaveState(""); // rollback toast already shown by onUpdate
    }
  };

  // refs keep this closure current, so the unmount flush never saves stale values
  const flush = () => {
    clearTimeout(debRef.current);
    const v = titleLive.current.trim();
    if (v && v !== tLive.current.content) persist({ content: v });
    if (descLive.current !== (tLive.current.description ?? ""))
      persist({ description: descLive.current });
  };
  // ponytail: unmount = collapse/switch row — auto-save happens here, always
  useEffect(() => () => flush(), []);

  // auto-grow textarea
  const descRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = descRef.current;
    if (el) {
      el.style.height = "0";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [desc]);

  return (
    <div>
      {/* title morphs in place: same font/line-height as the collapsed button, so no layout shift */}
      <div
        className={`flex items-center gap-2 px-2 ${large ? "min-h-14" : "min-h-11"}`}
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest("input,button")) onClose();
        }}
      >
        <input
          autoFocus
          className={`min-w-0 flex-1 bg-transparent p-0 text-left outline-none ${
            large ? "text-[15px] font-medium" : "text-[14px]"
          }`}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            clearTimeout(debRef.current);
            debRef.current = setTimeout(flush, 500);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") onClose();
          }}
        />
        {saveState && (
          <span className="shrink-0 text-[12px] text-zinc-500 transition-opacity duration-150">
            {saveState === "saving" ? "Saving…" : "Saved ✓"}
          </span>
        )}
        {dur}
        {actions}
      </div>
      <div className="row-expand">
        <div className="space-y-2 px-2 pb-3">
          <div className="border-t border-zinc-800" />
          <textarea
            ref={descRef}
            className="w-full resize-none overflow-hidden bg-transparent font-mono text-[13px] text-zinc-400 outline-none placeholder:text-zinc-600"
            placeholder="Add notes…"
            rows={2}
            value={desc}
            onChange={(e) => {
              setDesc(e.target.value);
              clearTimeout(debRef.current);
              debRef.current = setTimeout(flush, 500);
            }}
          />
          <div className="flex items-center gap-2">
            <DurationChips t={t} onDuration={onDuration} />
            {onDemote && (
              <button className={btn} title="Move back to Backlog" onClick={() => onDemote(t)}>
                ↓ Backlog
              </button>
            )}
            <button
              className={`ml-auto text-[13px] transition-colors duration-150 ${
                confirming ? "text-red-500" : "text-zinc-600 hover:text-zinc-400"
              }`}
              onClick={() => (confirming ? onDelete(t) : setConfirming(true))}
            >
              {confirming ? "Click again to confirm" : "Delete"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DurationChips({
  t,
  onDuration,
}: {
  t: Task;
  onDuration: (t: Task, minutes: number) => void;
}) {
  return (
    <div className="flex gap-1">
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
    </div>
  );
}

function AddRow({
  placeholder,
  hotkey,
  alwaysOpen,
  sections,
  onAdd,
}: {
  placeholder: string;
  hotkey?: string;
  alwaysOpen?: boolean;
  sections: SectionMap;
  onAdd: (raw: string) => void;
}) {
  const [open, setOpen] = useState(!!alwaysOpen);
  const [v, setV] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!hotkey) return;
    const h = (e: KeyboardEvent) => {
      if (
        e.key.toLowerCase() === hotkey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [hotkey]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const parsed = parseAdd(v, sections);
  const submit = () => {
    const raw = v.trim();
    if (raw) {
      onAdd(raw);
      setV("");
    }
  };

  if (!open)
    return (
      <button
        className="min-h-11 w-full rounded-md px-2 text-left text-[13px] text-zinc-600 transition-colors duration-150 hover:bg-zinc-900"
        onClick={() => setOpen(true)}
      >
        {placeholder}
      </button>
    );
  return (
    <div className="py-1">
      <input
        ref={inputRef}
        className={input}
        placeholder={placeholder}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            setV("");
            if (!alwaysOpen) setOpen(false);
          }
        }}
        onBlur={() => {
          if (!alwaysOpen) setOpen(false);
        }}
      />
      {v.trim() && (
        <div className="mt-1 flex flex-wrap gap-1 font-mono text-[11px] text-zinc-500">
          <span className="rounded border border-zinc-800 px-1.5 py-0.5">
            {parsed.content || "…"}
          </span>
          {parsed.duration != null && (
            <span className="rounded border border-zinc-800 px-1.5 py-0.5">{parsed.duration}m</span>
          )}
          {parsed.sectionName && (
            <span className="rounded border border-zinc-800 px-1.5 py-0.5">
              #{parsed.sectionName}
            </span>
          )}
          {parsed.priority != null && (
            <span className="rounded border border-zinc-800 px-1.5 py-0.5">
              p{5 - parsed.priority}
            </span>
          )}
        </div>
      )}
    </div>
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

// ponytail: tap anywhere toggles pause; buttons stopPropagation
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

  const tbtn =
    "min-h-12 rounded-md px-3 py-3 text-[13px] text-zinc-400 transition-colors duration-150 hover:bg-zinc-800 hover:text-zinc-200";
  const tap = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div
      className="relative flex min-h-screen flex-col items-center justify-center gap-6 overflow-hidden px-4 py-8"
      onClick={() => setPaused((p) => !p)}
    >
      <h2 className="max-w-3xl text-center text-[20px] text-zinc-400">{task.content}</h2>
      <div className="relative flex items-center justify-center">
        <svg viewBox="0 0 100 100" className="absolute h-[64vmin] w-[64vmin] -rotate-90">
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
          className={`relative font-mono text-[14vmin] leading-none font-bold tabular-nums ${
            frac <= 0.1 ? "text-orange-500" : "text-zinc-100"
          }`}
        >
          {fmt(left)}
        </p>
      </div>
      <div className="flex w-full max-w-xs flex-col gap-2 px-6 sm:w-auto sm:max-w-none sm:flex-row">
        <button
          className={tbtn}
          onClick={(e) => {
            tap(e);
            extend(5);
          }}
        >
          +5 min
        </button>
        <button
          className={tbtn}
          onClick={(e) => {
            tap(e);
            setPaused((p) => !p);
          }}
        >
          {paused ? "Resume" : "Pause"}
        </button>
        <button
          className={`${tbtn} text-orange-500`}
          onClick={(e) => {
            tap(e);
            logAndExit(true);
            onComplete();
          }}
        >
          Complete ✓
        </button>
        <button
          className={tbtn}
          onClick={(e) => {
            tap(e);
            logAndExit(false);
            onExit();
          }}
        >
          Abandon ✗
        </button>
      </div>

      {timesUp && (
        <div
          className="fixed inset-0 z-20 flex items-center justify-center bg-zinc-950/80"
          onClick={tap}
        >
          <div className="w-full max-w-xs space-y-2 rounded-md border border-zinc-800 bg-zinc-900 p-6">
            <h3 className="mb-4 text-[20px] font-semibold">Time's up!</h3>
            <button
              className={`${tbtn} block w-full text-orange-500`}
              onClick={() => {
                logAndExit(true);
                onComplete();
              }}
            >
              Mark complete
            </button>
            <button className={`${tbtn} block w-full`} onClick={() => extend(5)}>
              Extend +5 min
            </button>
            <button
              className={`${tbtn} block w-full`}
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
