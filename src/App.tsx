import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

const API = "https://api.todoist.com/api/v1";
const PAGE = 50; // ponytail: render cap for long lists, "show all" button instead of virtualization

type Role = "focus" | "buffer" | "backlog" | "done";
type RoleMap = Partial<Record<Role, string>>; // role -> todoist_section_id
type SectionInfo = { id: string; name: string };
// auto-detect variants, in priority order
const ROLE_DEF: { role: Role; label: string; names: string[] }[] = [
  { role: "focus", label: "Focus", names: ["focus", "today"] },
  { role: "buffer", label: "Buffer", names: ["buffer"] },
  { role: "backlog", label: "Backlog", names: ["backlog", "inbox", "later", "someday"] },
  { role: "done", label: "Done", names: ["done"] },
];
type Prefs = {
  focusCap: number;
  durations: number[];
  bufferOn: boolean;
  timerEnd: "hard" | "gentle";
  planBanner: boolean;
  completeAction: "done" | "close";
  celebrate: boolean;
  defaultMinutes: number;
};
const DEFAULT_PREFS: Prefs = {
  focusCap: 3,
  durations: [5, 10, 15, 25, 50, 90],
  bufferOn: true,
  timerEnd: "hard",
  planBanner: true,
  completeAction: "done",
  celebrate: true,
  defaultMinutes: 5,
};

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
  const [sectionList, setSectionList] = useState<SectionInfo[]>(() => load("tb_section_list", []));
  const [roles, setRoles] = useState<RoleMap>(() => load("tb_roles", {}));
  const [prefs, setPrefs] = useState<Prefs>(() => ({ ...DEFAULT_PREFS, ...load("tb_prefs", {}) }));
  const [noDuration, setNoDuration] = useState(() => load("tb_no_duration", false));
  const [sessions, setSessions] = useState<Session[]>(() => load("tb_sessions", []));
  const [archivedDay, setArchivedDay] = useState(() => load("tb_archived", ""));
  const [active, setActive] = useState<{ task: Task; minutes: number } | null>(null);
  const [celebrating, setCelebrating] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; undo?: () => void } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [view, setView] = useState<"focus" | "backlog" | "review" | "settings">("focus");
  const [obStep, setObStep] = useState<number | null>(() =>
    load("tb_onboarded", false) ? null : 0,
  );
  const [showRef, setShowRef] = useState(false);
  const [error, setError] = useState("");

  const updatePrefs = (p: Partial<Prefs>) =>
    setPrefs((cur) => {
      const next = { ...cur, ...p };
      save("tb_prefs", next);
      return next;
    });

  const updateRoles = (r: RoleMap) => {
    setRoles(r);
    save("tb_roles", r);
  };

  const createSection = async (name: string): Promise<SectionInfo> => {
    const s = (await api(token, "/sections", "POST", { name, project_id: projectId })) as SectionInfo;
    setSectionList((l) => {
      const next = [...l, s];
      save("tb_section_list", next);
      return next;
    });
    setSections((m) => {
      const next = { ...m, [name.toLowerCase()]: s.id };
      save("tb_sections", next);
      return next;
    });
    return s;
  };

  const refresh = useCallback(async () => {
    if (!token || !projectId) return;
    try {
      await flushQueue(token);
      const [sec, ts] = await Promise.all([
        api(token, `/sections?project_id=${projectId}`),
        api(token, `/tasks?project_id=${projectId}`),
      ]);
      const list = arr<SectionInfo>(sec);
      const map: SectionMap = {};
      for (const s of list) map[s.name.toLowerCase()] = s.id;
      save("tb_sections", map); // cached; next fetch re-resolves renames
      save("tb_section_list", list);
      setSections(map);
      setSectionList(list);
      // auto-detect unmapped or stale role mappings by name
      setRoles((prev) => {
        const next = { ...prev };
        for (const d of ROLE_DEF) {
          if (next[d.role] && list.some((s) => s.id === next[d.role])) continue;
          const hit = d.names.map((n) => map[n]).find(Boolean);
          if (hit) next[d.role] = hit;
          else delete next[d.role]; // stale id — triggers remap banner
        }
        save("tb_roles", next);
        return next;
      });
      setTasks(arr<Task>(ts));
      setError("");
    } catch (e) {
      setError(
        e instanceof TypeError ? "Couldn't reach Todoist — retrying in 30s" : String(e),
      );
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

  // ponytail: free Todoist accounts reject duration writes — detect once, then stop sending
  const proFail = () => {
    if (noDuration) return;
    setNoDuration(true);
    save("tb_no_duration", true);
    showToast("Durations need Todoist Pro — timers still work locally");
  };

  const addTask = async (raw: string, fallbackSection?: string) => {
    const p = parseAdd(raw, sections);
    if (!p.content) return;
    const sectionId = (p.sectionName && sections[p.sectionName.toLowerCase()]) || fallbackSection;
    const body = (withDur: boolean) => ({
      content: p.content,
      project_id: projectId,
      ...(sectionId ? { section_id: sectionId } : {}),
      ...(withDur && p.duration != null ? { duration: p.duration, duration_unit: "minute" } : {}),
      ...(p.priority ? { priority: p.priority } : {}),
    });
    const tmp: Task = {
      id: `tmp-${Date.now()}`,
      content: p.content,
      priority: p.priority ?? 1,
      section_id: sectionId ?? null,
      duration: p.duration != null ? { amount: p.duration, unit: "minute" } : undefined,
    };
    setTasks((ts) => [...ts, tmp]);
    try {
      await mutate(token, { path: "/tasks", method: "POST", body: body(!noDuration) });
    } catch (e) {
      if (p.duration != null && !(e instanceof TypeError)) {
        proFail();
        try {
          await mutate(token, { path: "/tasks", method: "POST", body: body(false) });
          return;
        } catch {
          /* falls through to rollback */
        }
      }
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
    if (noDuration) return;
    try {
      await mutate(token, {
        path: `/tasks/${t.id}`,
        method: "POST",
        body: { duration: minutes, duration_unit: "minute" },
      });
    } catch (e) {
      if (!(e instanceof TypeError)) proFail();
    }
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

  // ponytail: move, not close — Done section feeds estimation/review; evening archive closes them
  const completeTask = async (t: Task) => {
    if (prefs.completeAction === "done" && roles.done) {
      await moveTo(t, roles.done);
    } else {
      try {
        await mutate(token, { path: `/tasks/${t.id}/close`, method: "POST" });
        setTasks((ts) => ts.filter((x) => x.id !== t.id));
      } catch {
        showToast("Complete failed");
      }
    }
  };

  const archiveAll = async () => {
    const prev = tasksRef.current;
    const done = tasks.filter((t) => t.section_id === roles.done);
    setTasks((ts) => ts.filter((t) => t.section_id !== roles.done));
    try {
      for (const t of done) await mutate(token, { path: `/tasks/${t.id}/close`, method: "POST" });
      save("tb_archived", todayStr());
      setArchivedDay(todayStr());
    } catch {
      setTasks(prev);
      setError("Complete failed — rolled back");
    }
  };

  if (!token || !projectId)
    return (
      <Connect
        token={token}
        onDone={(t, p) => {
          save("tb_token", t);
          save("tb_project", p);
          setToken(t);
          setProjectId(p);
        }}
      />
    );

  const finishOnboarding = () => {
    save("tb_onboarded", true);
    setObStep(null);
  };

  if (obStep !== null)
    return (
      <Onboarding
        step={obStep}
        setStep={setObStep}
        onDone={finishOnboarding}
        mappingProps={{
          sectionList,
          roles,
          bufferOn: prefs.bufferOn,
          onCreate: createSection,
          onSave: updateRoles,
        }}
      />
    );

  if (celebrating && active)
    return <Celebration task={active.task} onDone={() => { setCelebrating(false); setActive(null); }} />;

  if (active)
    return (
      <Timer
        task={active.task}
        minutes={active.minutes}
        gentle={prefs.timerEnd === "gentle"}
        onExit={() => setActive(null)}
        onLog={logSession}
        onComplete={() => {
          completeTask(active.task); // ponytail: fire-and-forget — timer exits instantly; failure toast still surfaces
          if (prefs.celebrate) setCelebrating(true);
          else setActive(null);
        }}
      />
    );

  // ponytail: tasks without a section count as Backlog so nothing goes invisible
  const focusTasks = sortTasks(tasks.filter((t) => t.section_id === roles.focus));
  const bufferTasks = prefs.bufferOn ? tasks.filter((t) => t.section_id === roles.buffer) : [];
  const backlogTasks = sortTasks(
    tasks.filter((t) => t.section_id == null || t.section_id === roles.backlog),
  );
  const doneTasks = tasks.filter((t) => t.section_id === roles.done);
  // a mapped section deleted/renamed upstream leaves a stale id after refresh re-detect
  const remapNeeded =
    sectionList.length > 0 &&
    ROLE_DEF.some(
      (d) =>
        (d.role !== "buffer" || prefs.bufferOn) &&
        (!roles[d.role] || !sectionList.some((s) => s.id === roles[d.role])),
    );

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
              className={`${btn} px-2 text-zinc-500`}
              title="How it works"
              onClick={() => setShowRef((s) => !s)}
            >
              ?
            </button>
            <button
              className={`${btn} px-2 text-zinc-500 ${view === "settings" ? "text-zinc-200" : ""}`}
              title="Settings"
              onClick={() => setView(view === "settings" ? "focus" : "settings")}
            >
              ⚙
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
        {remapNeeded && (
          <div className="mb-4 flex items-center justify-between gap-4 rounded-md border border-zinc-800 bg-zinc-900 px-4 py-3">
            <p className="text-[13px] text-zinc-400">
              A mapped section changed in Todoist — re-map your sections.
            </p>
            <button
              className={`${btn} shrink-0 text-orange-500`}
              onClick={() => setView("settings")}
            >
              Re-map
            </button>
          </div>
        )}
        {view === "settings" ? (
          <SettingsPage
            prefs={prefs}
            onPrefs={updatePrefs}
            token={token}
            projectId={projectId}
            onProject={(id) => {
              save("tb_project", id);
              setProjectId(id); // refresh() re-fetches tasks/sections and re-detects roles
            }}
            mappingProps={{
              sectionList,
              roles,
              bufferOn: prefs.bufferOn,
              onCreate: createSection,
              onSave: updateRoles,
            }}
            onViewGuide={() => setObStep(0)}
            onTheory={() => setObStep(1)}
            onReset={() => {
              localStorage.clear();
              location.reload();
            }}
          />
        ) : view === "review" ? (
          <Review
            tasks={doneTasks}
            sessions={sessions}
            archived={archivedDay === todayStr() && doneTasks.length === 0}
            onArchiveAll={archiveAll}
          />
        ) : view === "backlog" ? (
          <section>
            {backlogTasks.length === 0 ? (
              <p className="py-4 text-[13px] text-zinc-500">
                Your parking lot for ideas. Dump anything here — it waits without interrupting you.
              </p>
            ) : (
              <BacklogList
                tasks={backlogTasks}
                expandedId={expandedId}
                onToggle={toggleRow}
                onMove={roles.focus ? (x) => moveTo(x, roles.focus!) : undefined}
                onComplete={completeTask}
                onUpdate={updateTask}
                onDuration={changeDuration}
                onDelete={deleteTask}
                durations={prefs.durations}
              />
            )}
            <AddRow
              placeholder="＋ Add to Backlog…"
              sections={sections}
              onAdd={(raw) => addTask(raw, roles.backlog)}
            />
          </section>
        ) : (
          <FocusView
            focusTasks={focusTasks}
            bufferTasks={bufferTasks}
            backlogCount={backlogTasks.length}
            sections={sections}
            focusId={roles.focus}
            bufferId={prefs.bufferOn ? roles.buffer : undefined}
            cap={prefs.focusCap}
            planBanner={prefs.planBanner}
            durations={prefs.durations}
            defaultMinutes={prefs.defaultMinutes}
            expandedId={expandedId}
            onToggle={toggleRow}
            onMove={(t) => roles.focus && moveTo(t, roles.focus)}
            onDemote={roles.backlog ? (t) => moveTo(t, roles.backlog!) : undefined}
            onAdd={addTask}
            onUpdate={updateTask}
            onDuration={changeDuration}
            onDelete={deleteTask}
            onComplete={completeTask}
            onStart={(t, minutes) => setActive({ task: t, minutes })}
            onGoBacklog={() => setView("backlog")}
          />
        )}
      </main>
      {prefs.bufferOn && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-zinc-800 bg-zinc-950 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:hidden">
          <AddRow
            placeholder="＋ Quick add to Buffer…"
            alwaysOpen
            sections={sections}
            onAdd={(raw) => addTask(raw, roles.buffer)}
          />
        </div>
      )}
      {showRef && <RefPanel onClose={() => setShowRef(false)} />}
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

function Connect({
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
      setErr("Couldn't load projects — check the token and your connection, then retry");
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
  focusId,
  bufferId,
  cap,
  planBanner,
  durations,
  defaultMinutes,
  expandedId,
  onToggle,
  onMove,
  onDemote,
  onAdd,
  onUpdate,
  onDuration,
  onDelete,
  onComplete,
  onStart,
  onGoBacklog,
}: {
  focusTasks: Task[];
  bufferTasks: Task[];
  backlogCount: number;
  sections: SectionMap;
  focusId?: string;
  bufferId?: string;
  cap: number;
  planBanner: boolean;
  durations: number[];
  defaultMinutes: number;
  expandedId: string | null;
  onToggle: (id: string) => void;
  onMove: (t: Task) => void;
  onDemote?: (t: Task) => void;
  onAdd: (raw: string, fallbackSection?: string) => void;
  onUpdate: (id: string, fields: { content?: string; description?: string }) => Promise<void>;
  onDuration: (t: Task, minutes: number) => void;
  onDelete: (t: Task) => void;
  onComplete: (t: Task) => void;
  onStart: (t: Task, minutes: number) => void;
  onGoBacklog: () => void;
}) {
  const [dismissed, setDismissed] = useState(() => load("tb_plan_dismissed", ""));
  const showPlan =
    planBanner && focusTasks.length === 0 && backlogCount > 0 && dismissed !== todayStr();

  return (
    <div className="space-y-6">
      {showPlan && (
        <div className="flex items-center justify-between gap-4 rounded-md border border-zinc-800 bg-zinc-900 px-4 py-3">
          <p className="text-[13px] text-zinc-400">
            Plan your day — pull up to {cap} tasks into Focus
          </p>
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

      {bufferId && (
        <section>
          <p className="mb-1 px-2 text-[13px] text-zinc-500">Buffer</p>
          {bufferTasks.length === 0 ? (
            <p className="px-2 py-2 text-[13px] text-zinc-600">
              Adhoc tasks land here. Quick-capture them, timebox them short, move on.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {bufferTasks.map((t) => (
                <TaskRow
                  key={t.id}
                  t={t}
                  durations={durations}
                  defaultMinutes={defaultMinutes}
                  expanded={expandedId === t.id}
                  onToggle={() => onToggle(t.id)}
                  onStart={onStart}
                  onComplete={() => onComplete(t)}
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
            onAdd={(raw) => onAdd(raw, bufferId)}
          />
        </section>
      )}

      {focusTasks.length > cap && (
        <p className="rounded-md border border-zinc-800 bg-zinc-900 px-4 py-3 text-[13px] text-zinc-400">
          Too many priorities — Focus holds {cap}. Move something back to Backlog.
        </p>
      )}

      <section>
        <p className="mb-1 px-2 text-[13px] text-zinc-500">Focus</p>
        {focusTasks.length === 0 ? (
          <button
            className="block w-full py-8 text-center text-[13px] text-zinc-500"
            onClick={onGoBacklog}
          >
            Focus holds today's top {cap} tasks. During a timebox, nothing else exists.
            <span className="mt-1 block text-orange-500">Pull from Backlog →</span>
          </button>
        ) : (
          <ul className="space-y-0.5">
            {focusTasks.map((t) => (
              <TaskRow
                key={t.id}
                t={t}
                large
                durations={durations}
                defaultMinutes={defaultMinutes}
                expanded={expandedId === t.id}
                onToggle={() => onToggle(t.id)}
                onStart={onStart}
                onComplete={() => onComplete(t)}
                onDemote={onDemote}
                onUpdate={onUpdate}
                onDuration={onDuration}
                onDelete={onDelete}
              />
            ))}
          </ul>
        )}
        {focusId && (
          <AddRow
            placeholder="＋ Add to Focus…"
            hotkey="n"
            sections={sections}
            onAdd={(raw) => onAdd(raw, focusId)}
          />
        )}
      </section>
    </div>
  );
}

// ponytail: cap-at-50 + "show all" beats a virtualization lib at this list size
function BacklogList({
  tasks,
  expandedId,
  onToggle,
  onMove,
  onComplete,
  onUpdate,
  onDuration,
  onDelete,
  durations,
}: {
  tasks: Task[];
  expandedId: string | null;
  onToggle: (id: string) => void;
  onMove?: (t: Task) => void;
  onComplete: (t: Task) => void;
  onUpdate: (id: string, fields: { content?: string; description?: string }) => Promise<void>;
  onDuration: (t: Task, minutes: number) => void;
  onDelete: (t: Task) => void;
  durations: number[];
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? tasks : tasks.slice(0, PAGE);
  return (
    <>
      <ul className="space-y-0.5">
        {visible.map((t) => (
          <TaskRow
            key={t.id}
            t={t}
            durations={durations}
            expanded={expandedId === t.id}
            onToggle={() => onToggle(t.id)}
            onMove={onMove}
            onComplete={() => onComplete(t)}
            onUpdate={onUpdate}
            onDuration={onDuration}
            onDelete={onDelete}
          />
        ))}
      </ul>
      {!showAll && tasks.length > PAGE && (
        <button className={`${btn} mt-1 w-full`} onClick={() => setShowAll(true)}>
          Show all {tasks.length}…
        </button>
      )}
    </>
  );
}

function TaskRow({
  t,
  large,
  expanded,
  onToggle,
  onStart,
  onComplete,
  defaultMinutes = 5,
  onMove,
  onDemote,
  onUpdate,
  onDuration,
  onDelete,
  durations,
}: {
  t: Task;
  large?: boolean;
  expanded: boolean;
  onToggle: () => void;
  onStart?: (t: Task, minutes: number) => void;
  onComplete?: () => void;
  defaultMinutes?: number;
  onMove?: (t: Task) => void;
  onDemote?: (t: Task) => void;
  onUpdate: (id: string, fields: { content?: string; description?: string }) => Promise<void>;
  onDuration: (t: Task, minutes: number) => void;
  onDelete: (t: Task) => void;
  durations: number[];
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
          durations={durations}
          onClose={onToggle}
          onUpdate={onUpdate}
          onDuration={onDuration}
          onDemote={onDemote}
          onComplete={onComplete}
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
  durations,
  onClose,
  onUpdate,
  onDuration,
  onDemote,
  onComplete,
  onDelete,
}: {
  t: Task;
  large?: boolean;
  dur: ReactNode;
  actions: ReactNode;
  durations: number[];
  onClose: () => void;
  onUpdate: (id: string, fields: { content?: string; description?: string }) => Promise<void>;
  onDuration: (t: Task, minutes: number) => void;
  onDemote?: (t: Task) => void;
  onComplete?: () => void;
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
            <DurationChips t={t} durations={durations} onDuration={onDuration} />
            {onDemote && (
              <button className={btn} title="Move back to Backlog" onClick={() => onDemote(t)}>
                ↓ Backlog
              </button>
            )}
            {onComplete && (
              <button className={`${btn} text-orange-500`} onClick={onComplete}>
                ✓ Complete
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
  durations,
  onDuration,
}: {
  t: Task;
  durations: number[];
  onDuration: (t: Task, minutes: number) => void;
}) {
  return (
    <div className="flex gap-1">
      {durations.map((m) => (
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
      {v.trim() &&
        (parsed.duration != null || parsed.sectionName || parsed.priority != null) && (
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
        <p className="text-[13px] text-zinc-500">
          Come back tonight: planned vs actual time, side by side. Most people underestimate by 50%
          — are you the exception?
        </p>
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
            Complete all
          </button>
        </>
      )}
    </div>
  );
}

function Celebration({ task, onDone }: { task: Task; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 1500);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div
      className="flex min-h-screen cursor-pointer flex-col items-center justify-center gap-4 px-4"
      onClick={onDone}
    >
      <p className="celebrate-pop text-6xl text-orange-500">✓</p>
      <p className="text-center text-[20px] font-semibold">Done!</p>
      <p className="max-w-md text-center text-[15px] text-zinc-400">{task.content}</p>
    </div>
  );
}

// ponytail: tap anywhere toggles pause; buttons stopPropagation
function Timer({
  task,
  minutes,
  gentle = false,
  onExit,
  onLog,
  onComplete,
}: {
  task: Task;
  minutes: number;
  gentle?: boolean;
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
        if (Notification.permission === "granted") {
          const n = new Notification("Time's up!", { body: task.content });
          n.onclick = () => window.focus(); // ponytail: browsers only allow window.focus() from a user gesture like this
        }
        if (!gentle) {
          alarm();
          document.body.classList.add("flash");
          setTimeout(() => document.body.classList.remove("flash"), 4000);
          setTimesUp(true);
        } else {
          document.title = `0:00 - ${task.content}`;
        }
      }
    }, 250);
    return () => {
      clearInterval(iv);
      document.title = "Timebox Focus";
    };
  }, [paused, task.content, gentle]);

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
      <button
        aria-label="Exit timer"
        className="absolute top-4 right-4 z-10 flex h-11 w-11 items-center justify-center rounded-md text-[20px] text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
        onClick={(e) => {
          tap(e);
          logAndExit(false);
          onExit();
        }}
      >
        ✕
      </button>
      <h2 className="max-w-3xl text-center text-[20px] text-zinc-400">{task.content}</h2>
      <div className="relative flex h-[64vmin] w-[64vmin] items-center justify-center">
        <svg viewBox="0 0 100 100" className="pointer-events-none absolute inset-0 h-full w-full -rotate-90">
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
        {paused && (
          <span className="absolute -bottom-[4vmin] left-1/2 -translate-x-1/2 text-[6vmin]" aria-label="Paused">
            ⏸
          </span>
        )}
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

type MappingProps = {
  sectionList: SectionInfo[];
  roles: RoleMap;
  bufferOn: boolean;
  onCreate: (name: string) => Promise<SectionInfo>;
  onSave: (r: RoleMap) => void;
};

function MappingScreen({
  sectionList,
  roles,
  bufferOn,
  onCreate,
  onSave,
  onDone,
}: MappingProps & { onDone?: () => void }) {
  const [draft, setDraft] = useState<RoleMap>(roles);
  // ponytail: sync re-detected roles (project switch) without clobbering edits on no-op refreshes
  const prevRoles = useRef(roles);
  useEffect(() => {
    if (JSON.stringify(prevRoles.current) === JSON.stringify(roles)) return;
    prevRoles.current = roles;
    setDraft(roles);
  }, [roles]);
  const [busy, setBusy] = useState(false);
  const defs = ROLE_DEF.filter((d) => d.role !== "buffer" || bufferOn);
  const picked = defs.map((d) => draft[d.role]).filter((x): x is string => !!x);
  const dup = picked.length !== new Set(picked).size;
  const missing = defs.filter((d) => !draft[d.role]);

  const create = async (role: Role, name: string) => {
    setBusy(true);
    try {
      const s = await onCreate(name);
      setDraft((d) => ({ ...d, [role]: s.id }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {defs.map((d) => (
        <div key={d.role} className="flex items-center gap-3">
          <span className="w-16 shrink-0 text-[13px] text-zinc-400">{d.label}</span>
          <select
            className={`${input} disabled:opacity-40`}
            disabled={busy}
            value={draft[d.role] ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "__create") create(d.role, d.label);
              else setDraft((cur) => ({ ...cur, [d.role]: v || undefined }));
            }}
          >
            <option value="">— not mapped —</option>
            {sectionList.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            <option value="__create">＋ Create “{d.label}” section</option>
          </select>
        </div>
      ))}
      {dup && (
        <p className="text-[13px] text-red-400">Two roles can't share a section — pick another.</p>
      )}
      {missing.length > 0 && (
        <button
          className={`${btn} text-orange-500 disabled:opacity-40`}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              for (const d of missing) {
                if (draft[d.role]) continue;
                const s = await onCreate(d.label);
                setDraft((cur) => ({ ...cur, [d.role]: s.id }));
              }
            } finally {
              setBusy(false);
            }
          }}
        >
          Auto-create missing sections ({missing.map((d) => d.label).join(", ")})
        </button>
      )}
      <div>
        <button
          className={`${btn} bg-zinc-800 text-zinc-100 disabled:opacity-40`}
          disabled={dup || busy}
          onClick={() => {
            onSave(draft);
            onDone?.();
          }}
        >
          Save mapping
        </button>
      </div>
    </div>
  );
}

const THEORY: [string, string][] = [
  ["Backlog", "Ideas park here. They wait."],
  ["Focus", "Today's top 3. Nothing else exists during a timebox."],
  ["Done", "Finished tasks rest here until your evening review."],
  ["Review", "Compare planned vs actual. Calibrate tomorrow."],
];

// ponytail: "animated" = tailwind pulse on the arrows, no animation lib
function TheoryDiagram() {
  return (
    <div className="flex flex-col items-center gap-1">
      {THEORY.map(([name, desc], i) => (
        <div key={name} className="flex flex-col items-center gap-1">
          {i > 0 && <span className="animate-pulse text-zinc-600">↓</span>}
          <div className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-4 py-3 text-center">
            <p className="text-[15px] font-semibold">{name}</p>
            <p className="mt-0.5 text-[13px] text-zinc-500">{desc}</p>
          </div>
        </div>
      ))}
      <span className="mt-1 text-[12px] text-zinc-600">…and back to Backlog tomorrow.</span>
    </div>
  );
}

function Onboarding({
  step,
  setStep,
  onDone,
  mappingProps,
}: {
  step: number;
  setStep: (n: number | null) => void;
  onDone: () => void;
  mappingProps: MappingProps;
}) {
  const [trial, setTrial] = useState(false);
  const next = () => setStep(step + 1);
  const skip = (
    <button className={`${btn} absolute top-4 right-4`} onClick={onDone}>
      Skip
    </button>
  );

  if (trial)
    return (
      <Timer
        task={{ id: "demo", content: "Try a 5-minute timebox", priority: 1 }}
        minutes={5}
        onExit={() => {
          setTrial(false);
          setStep(4);
        }}
        onLog={() => {}} // demo runs don't touch review stats
        onComplete={() => {
          setTrial(false);
          setStep(4);
        }}
      />
    );

  return (
    <div className="relative flex min-h-screen items-center justify-center px-4">
      {skip}
      <div className="w-full max-w-sm space-y-6">
        {step === 0 && (
          <>
            <div className="text-center text-[40px]">⏳</div>
            <h1 className="text-center text-[22px] font-semibold">
              Your list grows forever.
            </h1>
            <p className="text-center text-[15px] text-zinc-400">
              Timeboxing turns tasks into appointments with yourself.
            </p>
            <button className={`${btn} mx-auto block bg-zinc-800 text-zinc-100`} onClick={next}>
              How it works →
            </button>
          </>
        )}
        {step === 1 && (
          <>
            <TheoryDiagram />
            <button className={`${btn} mx-auto block bg-zinc-800 text-zinc-100`} onClick={next}>
              Set up sections →
            </button>
          </>
        )}
        {step === 2 && (
          <>
            <h2 className="text-center text-[18px] font-semibold">Map your sections</h2>
            <p className="text-center text-[13px] text-zinc-500">
              Point each role at a section in your Todoist project.
            </p>
            <MappingScreen {...mappingProps} onDone={next} />
          </>
        )}
        {step === 3 && (
          <>
            <h2 className="text-center text-[18px] font-semibold">Try it now</h2>
            <p className="text-center text-[15px] text-zinc-400">
              One demo task. Five minutes. Nothing else exists.
            </p>
            <button
              className={`${btn} mx-auto block bg-zinc-800 text-orange-500`}
              onClick={() => setTrial(true)}
            >
              ▶ Start a 5-minute timebox
            </button>
          </>
        )}
        {step === 4 && (
          <>
            <div className="text-center text-[40px]">🎉</div>
            <h2 className="text-center text-[22px] font-semibold">That's a timebox.</h2>
            <p className="text-center text-[15px] text-zinc-400">
              Planned vs actual shows up in tonight's Review.
            </p>
            <button className={`${btn} mx-auto block bg-zinc-800 text-zinc-100`} onClick={onDone}>
              Start using Timebox
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function RefPanel({ onClose }: { onClose: () => void }) {
  return (
    <aside className="fixed inset-y-0 right-0 z-30 w-72 overflow-y-auto border-l border-zinc-800 bg-zinc-950 p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">How it works</h2>
        <button className={btn} onClick={onClose}>
          ✕
        </button>
      </div>
      <TheoryDiagram />
      <ul className="mt-6 space-y-3 text-[13px] text-zinc-400">
        <li>
          <strong className="text-zinc-200">Hard stop.</strong> When the timer ends, you stop.
          Overruns are data, not failure.
        </li>
        <li>
          <strong className="text-zinc-200">One thing at a time.</strong> During a timebox, nothing
          else exists.
        </li>
        <li>
          <strong className="text-zinc-200">Review daily.</strong> Planned vs actual, every evening.
          Calibration is the whole game.
        </li>
      </ul>
    </aside>
  );
}

function SettingsPage({
  prefs,
  onPrefs,
  mappingProps,
  onViewGuide,
  onTheory,
  onReset,
  token,
  projectId,
  onProject,
}: {
  prefs: Prefs;
  onPrefs: (p: Partial<Prefs>) => void;
  mappingProps: MappingProps;
  onViewGuide: () => void;
  onTheory: () => void;
  onReset: () => void;
  token: string;
  projectId: string;
  onProject: (id: string) => void;
}) {
  const h = "mb-2 text-[13px] font-medium text-zinc-500";
  const row = "flex items-center justify-between gap-4 py-2";
  const toggle = (on: boolean) =>
    `relative h-6 w-10 shrink-0 rounded-full transition-colors ${on ? "bg-orange-500" : "bg-zinc-700"}`;
  return (
    <div className="max-w-md space-y-8">
      <section>
        <h2 className={h}>List (Todoist project)</h2>
        <ProjectSelect token={token} projectId={projectId} onProject={onProject} />
      </section>
      <section>
        <h2 className={h}>Section roles</h2>
        <MappingScreen {...mappingProps} />
      </section>
      <section>
        <h2 className={h}>Focus task cap</h2>
        <div className="flex gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              className={`rounded-md border px-3 py-1 font-mono text-[13px] ${
                prefs.focusCap === n
                  ? "border-zinc-600 text-zinc-200"
                  : "border-zinc-800 text-zinc-500 hover:bg-zinc-800"
              }`}
              onClick={() => onPrefs({ focusCap: n })}
            >
              {n}
            </button>
          ))}
        </div>
      </section>
      <section>
        <h2 className={h}>Duration presets (minutes, comma-separated)</h2>
        <input
          className={input}
          defaultValue={prefs.durations.join(", ")}
          onBlur={(e) => {
            const ds = e.target.value
              .split(",")
              .map((s) => parseInt(s.trim(), 10))
              .filter((n) => n > 0 && n <= 480);
            if (ds.length) onPrefs({ durations: [...new Set(ds)].sort((a, b) => a - b) });
          }}
        />
      </section>
      <section>
        <h2 className={h}>Behavior</h2>
        <div className={row}>
          <span className="text-[14px]">Default duration (no estimate)</span>
          <select
            className={`${input} w-24`}
            value={prefs.defaultMinutes}
            onChange={(e) => onPrefs({ defaultMinutes: +e.target.value })}
          >
            {prefs.durations.map((d) => (
              <option key={d} value={d}>
                {d}m
              </option>
            ))}
          </select>
        </div>
        <div className={row}>
          <span className="text-[14px]">Buffer section</span>
          <button
            className={toggle(prefs.bufferOn)}
            onClick={() => onPrefs({ bufferOn: !prefs.bufferOn })}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${prefs.bufferOn ? "left-4.5" : "left-0.5"}`}
            />
          </button>
        </div>
        <div className={row}>
          <span className="text-[14px]">Morning ritual banner</span>
          <button
            className={toggle(prefs.planBanner)}
            onClick={() => onPrefs({ planBanner: !prefs.planBanner })}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${prefs.planBanner ? "left-4.5" : "left-0.5"}`}
            />
          </button>
        </div>
        <div className={row}>
          <span className="text-[14px]">On complete</span>
          <div className="flex gap-1">
            {(["done", "close"] as const).map((m) => (
              <button
                key={m}
                className={`rounded-md border px-3 py-1 text-[13px] ${
                  prefs.completeAction === m
                    ? "border-zinc-600 text-zinc-200"
                    : "border-zinc-800 text-zinc-500 hover:bg-zinc-800"
                }`}
                onClick={() => onPrefs({ completeAction: m })}
              >
                {m === "done" ? "Move to Done" : "Close task"}
              </button>
            ))}
          </div>
        </div>
        <div className={row}>
          <span className="text-[14px]">Celebrate on complete</span>
          <button
            className={toggle(prefs.celebrate)}
            onClick={() => onPrefs({ celebrate: !prefs.celebrate })}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${prefs.celebrate ? "left-4.5" : "left-0.5"}`}
            />
          </button>
        </div>
        <div className={row}>
          <span className="text-[14px]">Timer end</span>
          <div className="flex gap-1">
            {(["hard", "gentle"] as const).map((m) => (
              <button
                key={m}
                className={`rounded-md border px-3 py-1 text-[13px] capitalize ${
                  prefs.timerEnd === m
                    ? "border-zinc-600 text-zinc-200"
                    : "border-zinc-800 text-zinc-500 hover:bg-zinc-800"
                }`}
                onClick={() => onPrefs({ timerEnd: m })}
              >
                {m === "hard" ? "Hard stop" : "Gentle"}
              </button>
            ))}
          </div>
        </div>
      </section>
      <section>
        <h2 className={h}>Help</h2>
        <div className="flex gap-4">
          <button className={`${btn} px-0 text-orange-500`} onClick={onViewGuide}>
            View guide again
          </button>
          <button className={`${btn} px-0 text-orange-500`} onClick={onTheory}>
            How it works
          </button>
        </div>
      </section>
      <section>
        <h2 className={h}>Danger</h2>
        <button className={`${btn} px-0 text-red-400`} onClick={onReset}>
          Reset token &amp; all local data
        </button>
      </section>
    </div>
  );
}

// ponytail: native <select>, roles auto re-detect on project switch via refresh()
function ProjectSelect({
  token,
  projectId,
  onProject,
}: {
  token: string;
  projectId: string;
  onProject: (id: string) => void;
}) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [focusCount, setFocusCount] = useState<Record<string, number>>({});
  const [err, setErr] = useState("");
  useEffect(() => {
    Promise.all([api(token, "/projects"), api(token, "/sections"), api(token, "/tasks")])
      .then(([pr, sec, ts]) => {
        setProjects(arr<Project>(pr));
        // ponytail: "focus" = section named like a focus role; 2 extra fetches instead of N per-project
        const focusSections = new Set(
          arr<SectionInfo & { project_id: string }>(sec)
            .filter((s) => ROLE_DEF[0].names.includes(s.name.toLowerCase()))
            .map((s) => s.id),
        );
        const counts: Record<string, number> = {};
        for (const t of arr<Task & { project_id: string }>(ts))
          if (t.section_id && focusSections.has(t.section_id))
            counts[t.project_id] = (counts[t.project_id] ?? 0) + 1;
        setFocusCount(counts);
      })
      .catch(() => setErr("Couldn't load projects"));
  }, [token]);
  if (err) return <p className="text-[13px] text-zinc-500">{err}</p>;
  if (!projects) return <p className="text-[13px] text-zinc-500">Loading projects…</p>;
  return (
    <select
      className={input}
      value={projectId}
      onChange={(e) => onProject(e.target.value)}
    >
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
          {focusCount[p.id] ? ` (${focusCount[p.id]} focus)` : ""}
        </option>
      ))}
    </select>
  );
}
