import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { handleOAuthCallback, load, refreshToken, save, startOAuth } from "./auth";
import {
  deviceConfig,
  deviceEvents,
  deviceSetEnabled,
  deviceSetPaused,
  deviceStart,
  deviceStop,
  deviceUpdate,
} from "./deviceSerial";
import {
  createAndPromptOpenCodeSession,
  dirToShortRepo,
  fetchOpenCodeSessionSummary,
  fetchOpenCodeSnapshot,
  formatTaskDescription,
  getOpenCodeEventUrl,
  interruptOpenCodeSession,
  invalidateSessionSummary,
  KNOWN_REPOS,
  loadOpenCodeConfig,
  parseTaskDescription,
  renameOpenCodeSession,
  replyOpenCodeForm,
  replyOpenCodePermission,
  resolveOpenCodeBase,
  resolveRepoDir,
  resolveServer,
  saveOpenCodeConfig,
  sendOpenCodePrompt,
  shortModelLabel,
  switchOpenCodeSessionModel,
  verifyAllOpenCodeServers,
  type OpenCodeConfig,
  type OpenCodeLiveSession,
  type OpenCodeModelOption,
  type OpenCodeServer,
  type OpenCodeVerifyResult,
  type SessionSummary,
  type TaskMeta,
  type TriageState,
} from "./opencode";
import { SimpleMarkdown } from "./markdown";

const API = "https://api.todoist.com/api/v1";
const PAGE = 50;

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
  deviceOn: boolean; // ESP32 companion display over LAN HTTP (docs/firmware-v2.md)
  screenOffMin: number; // device idle screen-off timeout, minutes (0 = never)
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
  deviceOn: false,
  screenOffMin: 5,
};

type Task = {
  id: string;
  content: string;
  priority: number; // 4 = highest
  section_id?: string | null;
  description?: string | null;
  due?: { datetime?: string; date: string } | null;
  duration?: { amount: number; unit: string } | null;
  added_at?: string; // ISO — tie-breaker so newest lands on top
};
type Project = { id: string; name: string; is_favorite?: boolean };
type SectionMap = Record<string, string>; // lowercase section name -> id
type Session = {
  task_id: string;
  task_name: string;
  planned_minutes: number;
  actual_minutes: number;
  agent_minutes?: number;
  opencode_sessions?: string[];
  repo?: string;
  completed: boolean;
  timestamp: number;
  synced?: boolean; // comment posted/queued to Todoist
};
type Mutation = { path: string; method: string; body?: object };
// completed-tasks API item (free tier: ~3 months back)
type CompletedItem = { id: string; content: string; completed_at: string };

// comment text doubles as cross-device backup record (date included for backfills)
const sessionComment = (s: Session) => {
  const ai = s.agent_minutes ? ` · ai ${s.agent_minutes}m` : "";
  const oc =
    s.opencode_sessions && s.opencode_sessions.length > 0
      ? ` · 🔗 ${s.opencode_sessions.join(", ")}`
      : "";
  const rp = s.repo ? ` (${s.repo})` : "";
  return `⏱ ${new Date(s.timestamp).toLocaleDateString(undefined, { month: "numeric", day: "numeric" })} · planned ${s.planned_minutes}m · actual ${s.actual_minutes}m${ai} · ${s.completed ? "✓ completed" : "logged"}${oc}${rp}`;
};

const arr = <T,>(d: unknown): T[] =>
  Array.isArray(d) ? d : ((d as { results?: T[] }).results ?? []);
const todayStr = () => new Date().toDateString();

// design tokens — one ghost button, one input
const btn =
  "rounded-md px-3 py-1.5 text-[13px] text-zinc-400 transition-colors duration-150 hover:bg-zinc-800 hover:text-zinc-200";
const input =
  "w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-[15px] outline-none placeholder:text-zinc-600 focus:border-zinc-700";

async function api(token: string, path: string, method = "GET", body?: object) {
  const cleanPassed = token.trim();
  const call = (t: string) =>
    fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${t}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  // Only prefer localStorage token if the caller didn't pass a different explicit token
  const stored = load("tb_token", "").trim();
  const effectiveToken = cleanPassed || stored;
  let res = await call(effectiveToken);
  if (res.status === 401 && load("tb_refresh", "") && effectiveToken === stored)
    res = await call(await refreshToken()); // OAuth token expired — refresh & retry once
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.status === 204 ? null : res.json();
}

let pendingWrites = 0;
let lastWriteAt = 0; // grace window covers Todoist read-after-write lag

async function mutate(token: string, m: Mutation) {
  pendingWrites++;
  try {
    return await api(token, m.path, m.method, m.body);
  } catch (e) {
    if (e instanceof TypeError) {
      const q = load<Mutation[]>("tb_queue", []);
      q.push(m);
      save("tb_queue", q);
      return null; // queued for replay
    } else throw e;
  } finally {
    pendingWrites--;
    lastWriteAt = Date.now();
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
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

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
    if (da !== db) return da.localeCompare(db);
    return (b.added_at ?? "").localeCompare(a.added_at ?? ""); // ties: newest first
  });

// orange fade for freshly added rows — keeps glowing after the tmp id is swapped for the real one
const isNew = (t: Task) =>
  t.id.startsWith("tmp-") ||
  (t.added_at != null && Date.now() - Date.parse(t.added_at) < 1500);

const pBar = (p: number) =>
  p === 4
    ? "border-l-zinc-200"
    : p === 3
      ? "border-l-zinc-500"
      : p === 2
        ? "border-l-zinc-700"
        : "border-l-zinc-800";

const shortRepo = (r?: string) => (r ? r.replace(/^vyond\//, "").replace(/^homelab\//, "") : "");

// mini NL parse: "Fix VPN 15m #Focus p1 ~devbox @eks-manifest // check ingress.yaml" -> content + duration + section + priority + server + repo + prompt
// Todoist priority is inverted (4 = urgent), so p1..p4 maps to 4..1
function parseAdd(raw: string, sections: SectionMap, servers?: OpenCodeServer[]) {
  let text = raw;
  let prompt: string | undefined;
  const slashIdx = text.indexOf("//");
  if (slashIdx !== -1) {
    prompt = text.slice(slashIdx + 2).trim() || undefined;
    text = text.slice(0, slashIdx);
  }
  let content = ` ${text} `;
  let duration: number | undefined;
  let priority: number | undefined;
  let sectionName: string | undefined;
  let repo: string | undefined;
  let server: string | undefined;
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
  content = content.replace(/\s~([\w.-]+)(?=\s)/, (_m, s: string) => {
    const hit = servers?.find(
      (srv) =>
        srv.id.toLowerCase() === s.toLowerCase() ||
        srv.name.toLowerCase() === s.toLowerCase(),
    );
    server = hit ? hit.id : s;
    return " ";
  });
  const activeSrv = servers?.find((s) => s.id === server) ?? servers?.[0];
  const candidateRepos = activeSrv?.repos?.length ? activeSrv.repos : KNOWN_REPOS;
  content = content.replace(/\s@([\w./-]+)(?=\s)/, (_m, r: string) => {
    const match =
      candidateRepos.find(
        (k) =>
          k.label.toLowerCase() === r.toLowerCase() ||
          k.label.toLowerCase().endsWith(`/${r.toLowerCase()}`),
      ) ??
      KNOWN_REPOS.find(
        (k) =>
          k.label.toLowerCase() === r.toLowerCase() ||
          k.label.toLowerCase().endsWith(`/${r.toLowerCase()}`),
      );
    repo = match ? match.label : r;
    return " ";
  });
  return {
    content: content.trim().replace(/\s{2,}/g, " "),
    duration,
    priority,
    sectionName,
    server,
    repo,
    prompt,
  };
}

export default function App() {
  const [token, setToken] = useState(() => load("tb_token", ""));
  const [projectId, setProjectId] = useState(() => load("tb_project", ""));
  const [projects, setProjects] = useState<Project[]>(() => load("tb_projects", []));
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
  // task_id -> minutes actually timed, all history (cross-device via comment backfill)
  const spentBy = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of sessions) m[s.task_id] = (m[s.task_id] ?? 0) + s.actual_minutes;
    return m;
  }, [sessions]);
  const [active, setActive] = useState<{ task: Task; minutes: number } | null>(null);
  const [celebrating, setCelebrating] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; undo?: () => void } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [view, setView] = useState<"focus" | "backlog" | "review" | "analysis" | "settings">(
    "focus",
  );
  const [obStep, setObStep] = useState<number | null>(() =>
    load("tb_onboarded", false) ? null : 0,
  );
  const [showRef, setShowRef] = useState(false);
  const [error, setError] = useState("");

  // --- OpenCode Flight Deck State (Multi-Server) ---
  const [ocConfig, setOcConfig] = useState<OpenCodeConfig>(() => loadOpenCodeConfig());
  const [ocConnected, setOcConnected] = useState(false);
  const [ocServerOnlineById, setOcServerOnlineById] = useState<Record<string, boolean>>({});
  const [ocModelsByServer, setOcModelsByServer] = useState<Record<string, OpenCodeModelOption[]>>(
    {},
  );
  const [ocSessions, setOcSessions] = useState<OpenCodeLiveSession[]>([]);
  const [ocVerifyById, setOcVerifyById] = useState<Record<string, OpenCodeVerifyResult>>({});
  const [ocVerifying, setOcVerifying] = useState(false);
  const [drivingTaskId, setDrivingTaskId] = useState<string | null>(null);
  const [humanSecBy, setHumanSecBy] = useState<Record<string, number>>(() =>
    load("tb_human_sec", {}),
  );
  const [agentSecBy, setAgentSecBy] = useState<Record<string, number>>(() =>
    load("tb_agent_sec", {}),
  );
  const [ignoredOcIds, setIgnoredOcIds] = useState<string[]>(() =>
    load("tb_ignored_oc", []),
  );

  // Poll configured OpenCode servers every 3s + listen to SSE `/event` on default server
  const syncOpenCode = useCallback(async () => {
    const snap = await fetchOpenCodeSnapshot();
    setOcConnected(snap.connected);
    setOcServerOnlineById(snap.serverOnlineById);
    if (snap.connected) {
      setOcSessions(snap.sessions);
      setOcModelsByServer(snap.modelsByServer);
    }
  }, []);

  const runVerifyOpenCode = useCallback(
    async (override?: Partial<OpenCodeConfig>): Promise<OpenCodeVerifyResult> => {
      setOcVerifying(true);
      try {
        const all = await verifyAllOpenCodeServers(override);
        setOcVerifyById(all);
        const onlineMap: Record<string, boolean> = {};
        let anyOk = false;
        for (const [id, r] of Object.entries(all)) {
          onlineMap[id] = r.ok;
          if (r.ok) anyOk = true;
        }
        setOcServerOnlineById(onlineMap);
        setOcConnected(anyOk);
        // Sync React state in case discoverLocalBridge() populated the local password in localStorage
        setOcConfig(loadOpenCodeConfig());
        if (anyOk) await syncOpenCode();
        const cfg = { ...loadOpenCodeConfig(), ...override };
        const defSrv = resolveServer(cfg.defaultServerId, cfg);
        return (
          all[defSrv.id] ??
          Object.values(all)[0] ?? {
            serverId: defSrv.id,
            serverName: defSrv.name,
            ok: false,
            endpoint: resolveOpenCodeBase(defSrv.endpoint),
            sessionCount: 0,
            activeCount: 0,
            latencyMs: 0,
            checkedAt: Date.now(),
          }
        );
      } finally {
        setOcVerifying(false);
      }
    },
    [syncOpenCode],
  );

  const updateOcConfig = useCallback(
    (patch: Partial<OpenCodeConfig>) => {
      setOcConfig((cur) => {
        const nextServers = patch.servers ?? cur.servers;
        const nextDefaultId = patch.defaultServerId ?? cur.defaultServerId;
        const primary =
          nextServers.find((s) => s.id === nextDefaultId) ?? nextServers[0];
        const next: OpenCodeConfig = {
          ...cur,
          ...patch,
          servers: nextServers,
          defaultServerId: primary ? primary.id : nextDefaultId,
          endpoint: patch.endpoint ?? primary?.endpoint ?? cur.endpoint,
          password: patch.password ?? primary?.password ?? cur.password,
        };
        saveOpenCodeConfig(next);
        void runVerifyOpenCode(next);
        return next;
      });
    },
    [runVerifyOpenCode],
  );

  useEffect(() => {
    if (!token || !projectId) return;
    syncOpenCode();
    void runVerifyOpenCode();
    const iv = setInterval(syncOpenCode, 3000);
    let es: EventSource | null = null;
    try {
      const eventUrl = getOpenCodeEventUrl();
      // Only open unauthenticated EventSource for same-origin /opencode-api bridge
      if (eventUrl.startsWith("/")) {
        es = new EventSource(eventUrl);
        es.onmessage = () => {
          syncOpenCode();
        };
      }
    } catch {
      /* SSE optional fallback to 3s polling */
    }
    return () => {
      clearInterval(iv);
      es?.close();
    };
  }, [token, projectId, syncOpenCode, runVerifyOpenCode, ocConfig.defaultServerId, ocConfig.servers]);

  // 1-second background ticker: increments humanSec on expanded task and agentSec on any task whose linked OpenCode session is `running`
  useEffect(() => {
    const iv = setInterval(() => {
      if (expandedId) {
        setHumanSecBy((prev) => {
          const next = { ...prev, [expandedId]: (prev[expandedId] ?? 0) + 1 };
          save("tb_human_sec", next);
          return next;
        });
      }
      const runningIds = new Set(
        ocSessions.filter((s) => s.status === "running").map((s) => s.id),
      );
      if (runningIds.size > 0) {
        const activeTasks = tasksRef.current.filter((t) => {
          const meta = parseTaskDescription(t.description);
          return meta.sessions.some((sid) => runningIds.has(sid));
        });
        if (activeTasks.length > 0) {
          setAgentSecBy((prev) => {
            const next = { ...prev };
            for (const t of activeTasks) next[t.id] = (next[t.id] ?? 0) + 1;
            save("tb_agent_sec", next);
            return next;
          });
        }
      }
    }, 1000);
    return () => clearInterval(iv);
  }, [expandedId, ocSessions]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest?.("input,textarea")) return; // typing
      if (e.key === "?") {
        e.preventDefault();
        setShowRef((s) => !s);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  const [oauthErr, setOauthErr] = useState("");

  // complete the OAuth redirect (PKCE) before anything else needs the token
  useEffect(() => {
    handleOAuthCallback()
      .then((t) => t && setToken(t))
      .catch((e) => setOauthErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const updatePrefs = (p: Partial<Prefs>) =>
    setPrefs((cur) => {
      const next = { ...cur, ...p };
      save("tb_prefs", next);
      return next;
    });

  // device bridge follows the toggle; turning it off stops any live beacons
  useEffect(() => deviceSetEnabled(prefs.deviceOn), [prefs.deviceOn]);

  // push device-config prefs on toggle/change — sent straight to the device,
  // which applies + persists them
  useEffect(() => {
    if (prefs.deviceOn) deviceConfig(prefs.screenOffMin);
  }, [prefs.deviceOn, prefs.screenOffMin]);

  const updateRoles = (r: RoleMap) => {
    setRoles(r);
    save("tb_roles", r);
  };

  const switchProject = (id: string) => {
    save("tb_project", id);
    setProjectId(id); // refresh() re-fetches tasks/sections and re-detects roles
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
      const [pr, sec, ts] = await Promise.all([
        api(token, "/projects").catch(() => null),
        api(token, `/sections?project_id=${projectId}`),
        api(token, `/tasks?project_id=${projectId}`),
      ]);
      if (pr) {
        const plist = arr<Project>(pr)
          .filter((p) => p.name !== "Inbox")
          .sort((a, b) => Number(b.is_favorite ?? false) - Number(a.is_favorite ?? false));
        save("tb_projects", plist);
        setProjects(plist);
      }
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
      if (!pendingWrites && Date.now() - lastWriteAt > 2000) setTasks(arr<Task>(ts));
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

  const postComment = (s: Session) => {
    if (s.task_id === "demo" || s.task_id.startsWith("tmp-")) return false;
    mutate(token, {
      path: "/comments",
      method: "POST",
      body: { task_id: s.task_id, content: sessionComment(s) },
    }).catch(() => {});
    return true;
  };

  const logSession = (s: Session) => {
    const next = [...sessions, { ...s, synced: postComment(s) }];
    setSessions(next);
    save("tb_sessions", next);
  };

  // one-time backfill for sessions logged before comment sync existed
  const syncComments = () => {
    const pending = sessions.filter(
      (s) => !s.synced && s.task_id !== "demo" && !s.task_id.startsWith("tmp-"),
    );
    for (const s of pending) postComment(s);
    const next = sessions.map((s) => ({ ...s, synced: true }));
    setSessions(next);
    save("tb_sessions", next);
    showToast(
      pending.length ? `Syncing ${pending.length} logs to Todoist comments` : "All logs already synced",
    );
  };

  const showToast = (msg: string, undo?: () => void) => {
    setToast({ msg, undo });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  };

  // Break nudge: accumulate timer-run seconds, toast at 45 min, reset after a 15 min gap
  const WORK_LIMIT = 45 * 60;
  const BREAK_GAP = 15 * 60_000;
  const workRef = useRef(load("tb_work_sec", 0));
  const nudgedRef = useRef(false);
  const onWorkTick = useCallback((sec: number) => {
    workRef.current += sec;
    save("tb_work_sec", Math.round(workRef.current));
    if (workRef.current >= WORK_LIMIT && !nudgedRef.current) {
      nudgedRef.current = true;
      showToast("45 min of focus — take a 15 min break 🍵");
    }
  }, []);
  useEffect(() => {
    if (active) {
      if (Date.now() - load("tb_last_stop", 0) >= BREAK_GAP) {
        workRef.current = 0;
        save("tb_work_sec", 0);
        nudgedRef.current = false;
      }
    } else {
      save("tb_last_stop", Date.now());
    }
  }, [active]);

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

  // move a task to another Todoist list (project), with undo back to original section/project
  const moveToProject = async (t: Task, targetId: string) => {
    const targetName = projects.find((p) => p.id === targetId)?.name ?? "list";
    const fromProjectId = projectId;
    const prev = tasksRef.current;
    setExpandedId(null);
    setTasks((ts) => ts.filter((x) => x.id !== t.id));
    try {
      await mutate(token, {
        path: `/tasks/${t.id}/move`,
        method: "POST",
        body: { project_id: targetId },
      });
    } catch {
      setTasks(prev);
      showToast("Move failed — rolled back");
      return;
    }
    showToast(`Moved to ${targetName}.`, async () => {
      try {
        await mutate(token, {
          path: `/tasks/${t.id}/move`,
          method: "POST",
          body: t.section_id ? { section_id: t.section_id } : { project_id: fromProjectId },
        });
        setTasks((ts) => [...ts, t]);
      } catch {
        showToast("Undo failed");
      }
    });
  };

  const proFail = () => {
    if (noDuration) return;
    setNoDuration(true);
    save("tb_no_duration", true);
    showToast("Durations need Todoist Pro — timers still work locally");
  };

  const addTask = async (
    raw: string,
    fallbackSection?: string,
    extra?: {
      repo?: string;
      server?: string;
      model?: string;
      prompt?: string;
      note?: string;
      sessions?: string[];
      mode?: "save" | "drive" | "agent";
    },
  ) => {
    const p = parseAdd(raw, sections, ocConfig.servers);
    if (!p.content) return;
    const sectionId = (p.sectionName && sections[p.sectionName.toLowerCase()]) || fallbackSection;
    const repo = extra?.repo || p.repo || "";
    const targetSrv = resolveServer(extra?.server || p.server || ocConfig.defaultServerId, ocConfig);
    const serverId = targetSrv.id;
    const model = extra?.model || "";
    const prompt = extra?.prompt || p.prompt || "";
    const note = extra?.note || "";
    const linkedSessions = extra?.sessions ? [...extra.sessions] : [];

    // If launching OpenCode agent immediately on task creation (or queueing if target server is offline)
    let queuedForAgent = false;
    const isTargetOnline = ocServerOnlineById[serverId] ?? ocConnected;
    if (extra?.mode === "agent") {
      if (isTargetOnline) {
        try {
          const sid = await createAndPromptOpenCodeSession({
            title: p.content,
            directory: resolveRepoDir(repo, serverId),
            promptText: prompt || p.content,
            serverId,
            modelKey: model || undefined,
          });
          linkedSessions.push(sid);
          syncOpenCode();
        } catch {
          queuedForAgent = true;
          showToast(`"${serverId}" unreachable — queued in Todoist`);
        }
      } else {
        queuedForAgent = true;
        showToast(`Queued in Todoist — will run when "${serverId}" connects`);
      }
    }

    const description = formatTaskDescription({
      note,
      prompt,
      repo,
      server: serverId,
      model: model || undefined,
      sessions: linkedSessions,
      queued: queuedForAgent,
    });

    const body = (withDur: boolean) => ({
      content: p.content,
      ...(description ? { description } : {}),
      project_id: projectId,
      ...(sectionId ? { section_id: sectionId } : {}),
      ...(withDur && p.duration != null ? { duration: p.duration, duration_unit: "minute" } : {}),
      ...(p.priority ? { priority: p.priority } : {}),
    });
    const tmp: Task = {
      id: `tmp-${Date.now()}`,
      content: p.content,
      description: description || null,
      priority: p.priority ?? 1,
      section_id: sectionId ?? null,
      duration: p.duration != null ? { amount: p.duration, unit: "minute" } : undefined,
      added_at: new Date().toISOString(),
    };
    setTasks((ts) => [...ts, tmp]);
    if (extra?.mode === "drive") setDrivingTaskId(tmp.id);

    // swap the optimistic tmp id for the real one, or notes/edits hit POST /tasks/tmp-* -> 404
    const swap = (created: unknown) => {
      if (created && typeof (created as Task).id === "string") {
        const real = created as Task;
        setTasks((ts) => ts.map((x) => (x.id === tmp.id ? real : x)));
        setDrivingTaskId((cur) => (cur === tmp.id ? real.id : cur));
      }
    };
    try {
      swap(await mutate(token, { path: "/tasks", method: "POST", body: body(!noDuration) }));
    } catch (e) {
      if (p.duration != null && !(e instanceof TypeError)) {
        proFail();
        try {
          swap(await mutate(token, { path: "/tasks", method: "POST", body: body(false) }));
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
    const existingTask = prev.find((x) => x.id === id);
    setTasks((ts) => ts.map((x) => (x.id === id ? { ...x, ...fields } : x)));
    try {
      await mutate(token, { path: `/tasks/${id}`, method: "POST", body: fields });
      if (fields.content && existingTask && fields.content !== existingTask.content) {
        const meta = parseTaskDescription(fields.description ?? existingTask.description);
        for (const sid of meta.sessions) {
          const live = ocSessions.find((s) => s.id === sid);
          const srvId = live?.serverId || meta.server || ocConfig.defaultServerId;
          renameOpenCodeSession(sid, fields.content, srvId)
            .then(() => syncOpenCode())
            .catch(() => {});
        }
      }
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

  // Toggle human driving on a task (only 1 task can be driven at a time)
  const toggleDrive = (t: Task) => {
    setDrivingTaskId((cur) => {
      const next = cur === t.id ? null : t.id;
      if (next) showToast(`Driving "${t.content}"`);
      return next;
    });
  };

  // Park / flush current human & agent timer seconds into a Session log without completing
  const parkTask = (t: Task) => {
    if (drivingTaskId === t.id) setDrivingTaskId(null);
    const hSec = humanSecBy[t.id] ?? 0;
    const aSec = agentSecBy[t.id] ?? 0;
    if (hSec >= 30 || aSec >= 30) {
      const meta = parseTaskDescription(t.description);
      const hMin = hSec > 0 ? Math.max(1, Math.round(hSec / 60)) : 0;
      const aMin = aSec > 0 ? Math.max(1, Math.round(aSec / 60)) : 0;
      logSession({
        task_id: t.id,
        task_name: t.content,
        planned_minutes: t.duration?.amount ?? prefs.defaultMinutes,
        actual_minutes: hMin,
        agent_minutes: aMin || undefined,
        opencode_sessions: meta.sessions.length ? meta.sessions : undefined,
        repo: meta.repo || undefined,
        completed: false,
        timestamp: Date.now(),
      });
      setHumanSecBy((prev) => {
        const next = { ...prev };
        delete next[t.id];
        save("tb_human_sec", next);
        return next;
      });
      setAgentSecBy((prev) => {
        const next = { ...prev };
        delete next[t.id];
        save("tb_agent_sec", next);
        return next;
      });
      showToast(`Parked · logged ${hMin}m${aMin ? ` · ${aMin}m ai` : ""}`);
    } else {
      showToast("Parked");
    }
  };

  // Send prompt to OpenCode session on the task's assigned server (creates session if none linked yet).
  // If that server is offline (e.g. on mobile), queues the task in Todoist (`srv=<id> queue=1`).
  const handToAgent = useCallback(
    async (t: Task, customPrompt?: string, serverOverride?: string, modelOverride?: string) => {
      if (drivingTaskId === t.id) setDrivingTaskId(null);
      const meta = parseTaskDescription(t.description);
      const promptText = customPrompt?.trim() || meta.prompt || t.content;
      const repoLabel = meta.repo;
      const latestSid = meta.sessions[meta.sessions.length - 1];
      const existingLive = latestSid ? ocSessions.find((s) => s.id === latestSid) : undefined;
      const targetSrv = resolveServer(
        serverOverride || existingLive?.serverId || meta.server || ocConfig.defaultServerId,
        ocConfig,
      );
      const serverId = targetSrv.id;
      const modelKey = modelOverride ?? meta.model ?? existingLive?.modelKey ?? "";

      try {
        let sid = latestSid;
        if (!sid) {
          sid = await createAndPromptOpenCodeSession({
            title: t.content,
            directory: resolveRepoDir(repoLabel, serverId),
            promptText,
            serverId,
            modelKey: modelKey || undefined,
          });
        } else {
          if (modelKey && modelKey !== existingLive?.modelKey) {
            await switchOpenCodeSessionModel(sid, modelKey, serverId).catch(() => {});
          }
          await sendOpenCodePrompt(sid, promptText, serverId);
        }
        const nextSessions = Array.from(new Set([...meta.sessions, sid]));
        invalidateSessionSummary(sid);
        const nextDesc = formatTaskDescription({
          note: meta.note,
          prompt: customPrompt?.trim() ? customPrompt.trim() : meta.prompt,
          repo: repoLabel,
          server: serverId,
          model: modelKey || undefined,
          sessions: nextSessions,
          queued: false,
        });
        if (nextDesc !== (t.description ?? "")) {
          await updateTask(t.id, { description: nextDesc });
        }
        syncOpenCode();
        showToast(`Sent to ${serverId} (${sid.slice(0, 10)})`);
      } catch {
        const nextDesc = formatTaskDescription({
          note: meta.note,
          prompt: customPrompt?.trim() ? customPrompt.trim() : meta.prompt,
          repo: repoLabel,
          server: serverId,
          model: modelKey || undefined,
          sessions: meta.sessions,
          queued: true,
        });
        if (nextDesc !== (t.description ?? "")) {
          await updateTask(t.id, { description: nextDesc }).catch(() => {});
        }
        showToast(`"${serverId}" offline — queued in Todoist`);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drivingTaskId, syncOpenCode, token, ocSessions, ocConfig],
  );

  // Tasks queued from mobile (`queue=1` in Todoist description) waiting for an OpenCode session
  const queuedForAgentTasks = useMemo(
    () =>
      tasks.filter(
        (t) =>
          !t.id.startsWith("tmp-") &&
          t.section_id !== roles.done &&
          Boolean(parseTaskDescription(t.description).queued),
      ),
    [tasks, roles.done],
  );

  const launchingQueueRef = useRef<Set<string>>(new Set());

  const runQueuedTasks = useCallback(
    async (list: Task[] = queuedForAgentTasks) => {
      if (!ocConnected) return;
      for (const t of list) {
        if (launchingQueueRef.current.has(t.id)) continue;
        const meta = parseTaskDescription(t.description);
        const srv = resolveServer(meta.server || ocConfig.defaultServerId, ocConfig);
        if (!ocServerOnlineById[srv.id]) continue;
        launchingQueueRef.current.add(t.id);
        try {
          await handToAgent(t, undefined, srv.id);
        } finally {
          launchingQueueRef.current.delete(t.id);
        }
      }
    },
    [ocConnected, queuedForAgentTasks, handToAgent, ocConfig, ocServerOnlineById],
  );

  useEffect(() => {
    if (ocConnected && ocConfig.autoRunQueued && queuedForAgentTasks.length > 0) {
      void runQueuedTasks(queuedForAgentTasks);
    }
  }, [ocConnected, ocConfig.autoRunQueued, queuedForAgentTasks, runQueuedTasks]);

  // Approve pending OpenCode tool permission inline
  const approvePermission = async (t: Task) => {
    const meta = parseTaskDescription(t.description);
    const live = ocSessions.find(
      (s) => meta.sessions.includes(s.id) && s.permission,
    );
    if (!live?.permission) return;
    try {
      await replyOpenCodePermission(live.id, live.permission.id, "once", live.serverId);
      syncOpenCode();
      showToast(`Approved on ${live.serverId}`);
    } catch {
      showToast("Approval failed");
    }
  };

  // Answer pending OpenCode question / option picker inline
  const answerFormOption = async (t: Task, fieldKey: string, value: string, label: string) => {
    const meta = parseTaskDescription(t.description);
    const live = ocSessions.find((s) => meta.sessions.includes(s.id) && s.form);
    if (!live?.form) return;
    try {
      await replyOpenCodeForm(live.id, live.form.id, fieldKey, value, live.serverId);
      invalidateSessionSummary(live.id);
      syncOpenCode();
      showToast(`Selected "${label}" on ${live.serverId}`);
    } catch {
      showToast("Couldn't submit option to OpenCode");
    }
  };

  // completing from the list: interrupt any still-running OpenCode agent, keep OpenCode session history intact,
  // and stamp session IDs + human/agent minutes into the Todoist task comment & session log.
  const completeWithLog = (t: Task) => {
    if (drivingTaskId === t.id) setDrivingTaskId(null);
    const meta = parseTaskDescription(t.description);

    // If any linked OpenCode session is still running, interrupt it so it stops burning tokens
    for (const sid of meta.sessions) {
      const live = ocSessions.find((s) => s.id === sid);
      if (live?.status === "running") {
        interruptOpenCodeSession(sid, live.serverId);
      }
    }

    const hSec = humanSecBy[t.id] ?? 0;
    const aSec = agentSecBy[t.id] ?? 0;
    const hMin = hSec > 0 ? Math.max(1, Math.round(hSec / 60)) : 0;
    const aMin = aSec > 0 ? Math.max(1, Math.round(aSec / 60)) : 0;
    const planned = t.duration?.amount ?? prefs.defaultMinutes;

    const loggedToday = sessions.some(
      (s) => s.task_id === t.id && new Date(s.timestamp).toDateString() === todayStr(),
    );

    if (hMin > 0 || aMin > 0 || !loggedToday) {
      logSession({
        task_id: t.id,
        task_name: t.content,
        planned_minutes: planned,
        actual_minutes: hMin > 0 ? hMin : loggedToday ? 0 : planned,
        agent_minutes: aMin || undefined,
        opencode_sessions: meta.sessions.length ? meta.sessions : undefined,
        repo: meta.repo || undefined,
        completed: true,
        timestamp: Date.now(),
      });
    }

    setHumanSecBy((prev) => {
      const next = { ...prev };
      delete next[t.id];
      save("tb_human_sec", next);
      return next;
    });
    setAgentSecBy((prev) => {
      const next = { ...prev };
      delete next[t.id];
      save("tb_agent_sec", next);
      return next;
    });

    completeTask(t);
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
        key={token} // remount when OAuth lands so the fresh token becomes `initial`
        token={token}
        error={oauthErr}
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

  const toastEl = toast && (
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
  );

  if (celebrating && active)
    return (
      <>
        {toastEl}
        <Celebration task={active.task} onDone={() => { setCelebrating(false); setActive(null); }} />
      </>
    );

  if (active)
    return (
      <>
        {toastEl}
        <Timer
        task={active.task}
        minutes={active.minutes}
        gentle={prefs.timerEnd === "gentle"}
        onExit={() => setActive(null)}
        onLog={logSession}
        onTick={onWorkTick}
        onUpdate={updateTask}
        onComplete={() => {
          completeTask(active.task);
          if (prefs.celebrate) setCelebrating(true);
          else setActive(null);
        }}
      />
      </>
    );

  const focusTasks = sortTasks(tasks.filter((t) => t.section_id === roles.focus));
  const bufferTasks = prefs.bufferOn ? tasks.filter((t) => t.section_id === roles.buffer) : [];
  const backlogTasks = sortTasks(
    tasks.filter((t) => t.section_id == null || t.section_id === roles.backlog),
  );
  const doneTasks = tasks.filter((t) => t.section_id === roles.done);
  const otherProjects = projects.filter((p) => p.id !== projectId);

  // Unlinked OpenCode sessions active in the last 24h (and not already linked to any task or ignored)
  const linkedSessionIds = useMemo(() => {
    const s = new Set<string>(ignoredOcIds);
    for (const t of tasks) {
      for (const sid of parseTaskDescription(t.description).sessions) s.add(sid);
    }
    for (const sess of sessions) {
      for (const sid of sess.opencode_sessions ?? []) s.add(sid);
    }
    return s;
  }, [tasks, sessions, ignoredOcIds]);

  const unlinkedOcSessions = useMemo(
    () =>
      ocSessions.filter(
        (s) =>
          !linkedSessionIds.has(s.id) &&
          Date.now() - s.updatedAt < 24 * 3600_000,
      ),
    [ocSessions, linkedSessionIds],
  );

  // a mapped section deleted/renamed upstream leaves a stale id after refresh re-detect
  const remapNeeded =
    sectionList.length > 0 &&
    ROLE_DEF.some(
      (d) =>
        (d.role !== "buffer" || prefs.bufferOn) &&
        (!roles[d.role] || !sectionList.some((s) => s.id === roles[d.role])),
    );

  const runningOcCount = ocSessions.filter(
    (s) => s.status === "running" || s.status === "question",
  ).length;
  const totalServerCount = ocConfig.servers.length;
  const onlineServerCount = ocConfig.servers.filter((s) => ocServerOnlineById[s.id]).length;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-2 px-4 py-2.5 sm:px-6 lg:px-8">
          <div className="flex shrink-0 items-center gap-2.5">
            <span className="hidden text-[15px] font-semibold tracking-tight text-zinc-100 sm:inline">
              Timebox
            </span>
            <button
              type="button"
              onClick={async () => {
                setView("settings");
                const res = await runVerifyOpenCode();
                showToast(
                  res.ok
                    ? `✓ OpenCode connected · ${res.sessionCount} sessions (${res.latencyMs}ms)`
                    : `OpenCode offline (${res.error || "unreachable"})`,
                );
              }}
              className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-zinc-800/90 bg-zinc-900/70 px-2.5 py-1 font-mono text-[11px] leading-none tabular-nums text-zinc-400 transition-colors hover:border-zinc-700 hover:bg-zinc-800/80 hover:text-zinc-200"
              title={
                ocConnected
                  ? `Connected to ${onlineServerCount}/${totalServerCount} OpenCode server(s) (${ocSessions.length} sessions) — click to verify / manage servers`
                  : `OpenCode offline — click to configure servers or mobile queue`
              }
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  ocVerifying
                    ? "bg-orange-400 animate-ping"
                    : ocConnected
                      ? runningOcCount > 0
                        ? "bg-orange-500 animate-pulse"
                        : "bg-orange-500"
                      : queuedForAgentTasks.length > 0
                        ? "bg-amber-400"
                        : "bg-zinc-600"
                }`}
              />
              {ocConnected ? (
                <>
                  <span className="text-zinc-200">
                    {onlineServerCount}/{totalServerCount}
                  </span>
                  <span className="hidden text-zinc-500 sm:inline">online</span>
                  {runningOcCount > 0 && (
                    <>
                      <span className="text-zinc-700" aria-hidden="true">
                        ·
                      </span>
                      <span className="font-medium text-orange-400">
                        {runningOcCount}
                        <span className="hidden sm:inline"> active</span>
                      </span>
                    </>
                  )}
                </>
              ) : queuedForAgentTasks.length > 0 ? (
                <>
                  <span className="hidden text-zinc-500 sm:inline">offline</span>
                  <span className="hidden text-zinc-700 sm:inline" aria-hidden="true">
                    ·
                  </span>
                  <span className="text-amber-400">
                    {queuedForAgentTasks.length}
                    <span className="hidden sm:inline"> queued</span>
                    <span className="sm:hidden">q</span>
                  </span>
                </>
              ) : (
                <>
                  <span className="text-zinc-500 sm:hidden">off</span>
                  <span className="hidden text-zinc-500 sm:inline">offline</span>
                </>
              )}
            </button>
          </div>
          <nav className="flex shrink-0 items-center justify-center gap-0.5 sm:gap-1">
            {(["focus", "backlog", "review", "analysis"] as const).map((v) => (
              <button
                key={v}
                className={`${btn} whitespace-nowrap px-2 py-1.5 capitalize sm:px-2.5 ${view === v ? "bg-zinc-800/90 font-medium text-zinc-100" : ""}`}
                onClick={() => setView(v)}
              >
                {v}
                {v === "backlog" && backlogTasks.length > 0 && (
                  <span className="ml-1 font-mono text-[11px] tabular-nums text-zinc-500">
                    {backlogTasks.length}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <div className="flex shrink-0 items-center justify-end gap-1">
            <button
              className={`${btn} px-2 py-1.5 text-zinc-500`}
              title="How it works (?)"
              onClick={() => setShowRef((s) => !s)}
            >
              ?
            </button>
            <button
              className={`${btn} px-2 py-1.5 text-zinc-500 ${view === "settings" ? "text-zinc-200" : ""}`}
              title="Settings"
              onClick={() => setView(view === "settings" ? "focus" : "settings")}
            >
              ⚙
            </button>
            <span
              className={`ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full ${error ? "bg-red-500" : "bg-zinc-700"}`}
              title={error || "in sync"}
            />
          </div>
        </div>
        <ProjectChips projects={projects} projectId={projectId} onProject={switchProject} />
      </header>
      <main className="mx-auto w-full max-w-5xl px-4 pt-6 pb-12 sm:px-6 lg:px-8">
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
            ocConfig={ocConfig}
            onOcConfig={updateOcConfig}
            ocConnected={ocConnected}
            ocServerOnlineById={ocServerOnlineById}
            ocVerifyById={ocVerifyById}
            ocVerifying={ocVerifying}
            onVerifyOpenCode={async () => {
              const res = await runVerifyOpenCode();
              showToast(
                res.ok
                  ? `✓ Verified (${res.sessionCount} sessions · ${res.latencyMs}ms)`
                  : `Connection failed: ${res.error || "unreachable"}`,
              );
            }}
            queuedCount={queuedForAgentTasks.length}
            onRunQueued={() => void runQueuedTasks()}
            token={token}
            projectId={projectId}
            onProject={switchProject}
            mappingProps={{
              sectionList,
              roles,
              bufferOn: prefs.bufferOn,
              onCreate: createSection,
              onSave: updateRoles,
            }}
            onViewGuide={() => setObStep(0)}
            onTheory={() => setObStep(1)}
            unsynced={
              sessions.filter(
                (s) => !s.synced && s.task_id !== "demo" && !s.task_id.startsWith("tmp-"),
              ).length
            }
            onSyncComments={syncComments}
            onReset={() => {
              localStorage.clear();
              location.reload();
            }}
          />
        ) : view === "analysis" ? (
          <Analysis sessions={sessions} token={token} />
        ) : view === "review" ? (
          <Review
            tasks={doneTasks}
            sessions={sessions}
            archived={archivedDay === todayStr() && doneTasks.length === 0}
            onArchiveAll={archiveAll}
            onResumeTask={
              roles.focus
                ? (t) => {
                    moveTo(t, roles.focus!);
                    showToast(`Resumed "${t.content}" in Focus`);
                  }
                : undefined
            }
          />
        ) : view === "backlog" ? (
          <section>
            <AddRow
              alwaysOpen
              ocConnected={ocConnected}
              ocServers={ocConfig.servers}
              ocServerOnlineById={ocServerOnlineById}
              ocModelsByServer={ocModelsByServer}
              defaultServerId={ocConfig.defaultServerId}
              placeholder="＋ Add to Backlog… (~server @repo // prompt or Tab)"
              sections={sections}
              onAdd={(raw, extra) =>
                addTask(
                  raw,
                  extra?.mode && extra.mode !== "save" ? roles.focus ?? roles.backlog : roles.backlog,
                  extra,
                )
              }
            />
            {backlogTasks.length === 0 ? (
              <p className="py-4 text-[13px] text-zinc-500">
                Your parking lot for ideas. Dump anything here — it waits without interrupting you.
              </p>
            ) : (
              <BacklogList
                tasks={backlogTasks}
                expandedId={expandedId}
                spentBy={spentBy}
                ocConnected={ocConnected}
                ocServers={ocConfig.servers}
                ocServerOnlineById={ocServerOnlineById}
                ocModelsByServer={ocModelsByServer}
                defaultServerId={ocConfig.defaultServerId}
                ocSessions={ocSessions}
                humanSecBy={humanSecBy}
                onToggle={toggleRow}
                onHandToAgent={handToAgent}
                onApprove={approvePermission}
                onAnswerForm={answerFormOption}
                onMove={roles.focus ? (x) => moveTo(x, roles.focus!) : undefined}
                onMoveProject={otherProjects.length ? moveToProject : undefined}
                projects={otherProjects}
                onComplete={completeWithLog}
                onUpdate={updateTask}
                onDuration={changeDuration}
                onDelete={deleteTask}
                durations={prefs.durations}
                defaultMinutes={prefs.defaultMinutes}
              />
            )}
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
            spentBy={spentBy}
            expandedId={expandedId}
            ocConnected={ocConnected}
            ocServers={ocConfig.servers}
            ocServerOnlineById={ocServerOnlineById}
            ocModelsByServer={ocModelsByServer}
            defaultServerId={ocConfig.defaultServerId}
            ocSessions={ocSessions}
            unlinkedOcSessions={unlinkedOcSessions}
            queuedTasks={queuedForAgentTasks}
            autoRunQueued={ocConfig.autoRunQueued}
            onRunQueued={() => void runQueuedTasks()}
            onOpenOcSettings={() => setView("settings")}
            humanSecBy={humanSecBy}
            onToggle={toggleRow}
            onHandToAgent={handToAgent}
            onApprove={approvePermission}
            onAnswerForm={answerFormOption}
            onTrackOcSession={(s) => {
              addTask(s.title, roles.focus, {
                repo: s.repoShort,
                server: s.serverId,
                model: s.modelKey,
                sessions: [s.id],
              });
              showToast(`Tracked "${s.title}" (${s.serverId}) in Focus`);
            }}
            onIgnoreOcSession={(sid) => {
              const next = [...ignoredOcIds, sid];
              setIgnoredOcIds(next);
              save("tb_ignored_oc", next);
            }}
            onMove={(t) => roles.focus && moveTo(t, roles.focus)}
            onDemote={roles.backlog ? (t) => moveTo(t, roles.backlog!) : undefined}
            onMoveProject={otherProjects.length ? moveToProject : undefined}
            projects={otherProjects}
            onAdd={addTask}
            onUpdate={updateTask}
            onDuration={changeDuration}
            onDelete={deleteTask}
            onComplete={completeWithLog}
            onStart={(t, minutes) => setActive({ task: t, minutes })}
            onGoBacklog={() => setView("backlog")}
          />
        )}
      </main>
      {showRef && <RefPanel onClose={() => setShowRef(false)} />}
      {toastEl}
    </div>
  );
}

function Connect({
  token: initial,
  error: oauthError,
  onDone,
}: {
  token: string;
  error?: string;
  onDone: (token: string, projectId: string) => void;
}) {
  const [token, setToken] = useState(initial);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [err, setErr] = useState(oauthError ?? "");

  const fetchProjects = async () => {
    setErr("");
    const cleanToken = token.trim();
    if (!cleanToken) return;
    try {
      const ps = arr<Project & { is_inbox_project?: boolean; inbox_project?: boolean }>(
        await api(cleanToken, "/projects"),
      );
      // auto-pick the first project besides Inbox — no manual selection needed
      // (fall back to Inbox itself if it's the only project)
      const pick = ps.find((p) => !p.is_inbox_project && !p.inbox_project && p.name !== "Inbox") ?? ps[0];
      if (pick) onDone(cleanToken, pick.id);
      else setProjects(ps); // no projects at all — show the (empty) list
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (cleanToken === "JejvYTz1123-qJKgdA9DAvgetYODwYef18yrTw99Kb8") {
        setErr(
          "That's your OpenCode password — paste your Todoist API token here (or click Connect with Todoist above).",
        );
      } else if (msg.startsWith("401 ") || msg.startsWith("403 ")) {
        setErr(
          `Todoist rejected the token (${msg}). Get your personal API token at Todoist Settings → Integrations → Developer, or click "Connect with Todoist" above.`,
        );
      } else {
        setErr(`Couldn't load projects (${msg}) — check your connection and retry`);
      }
    }
  };

  // OAuth redirects back here with a token already set — jump straight to project pick
  useEffect(() => {
    if (initial) fetchProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-sm space-y-4 px-4">
        <h1 className="text-[20px] font-semibold">Connect Todoist</h1>
        <button
          className="w-full rounded-md bg-orange-600 px-3 py-2 text-[15px] font-medium text-white transition-colors duration-150 hover:bg-orange-500"
          onClick={startOAuth}
        >
          Connect with Todoist
        </button>
        <div className="flex items-center gap-3 text-[12px] text-zinc-600">
          <span className="h-px flex-1 bg-zinc-800" />
          or paste an API token
          <span className="h-px flex-1 bg-zinc-800" />
        </div>
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
    leftBar: "",
    dot: "bg-zinc-600",
    labelCls: "text-zinc-500",
  },
};

function resolveTaskTriage(
  t: Task,
  ocSessions: OpenCodeLiveSession[],
): { triage: TriageState; liveSession?: OpenCodeLiveSession; meta: TaskMeta } {
  const meta = parseTaskDescription(t.description);
  const linked = meta.sessions
    .map((sid) => ocSessions.find((s) => s.id === sid))
    .filter((s): s is OpenCodeLiveSession => Boolean(s));
  const liveSession = linked[linked.length - 1];

  if (!liveSession) {
    return { triage: "queued", meta };
  }
  if (liveSession.status === "running") {
    return { triage: "working", liveSession, meta };
  }
  // If session is asking a question (`question`), or finished and is idle (`ready` or `idle` while task is still in Focus),
  // it needs your attention/steer to either continue or mark Done.
  return { triage: "needs_you", liveSession, meta };
}

type AddExtra = {
  repo?: string;
  server?: string;
  model?: string;
  prompt?: string;
  note?: string;
  sessions?: string[];
  mode?: "save" | "drive" | "agent";
};

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
  spentBy,
  expandedId,
  ocConnected,
  ocServers,
  ocServerOnlineById,
  ocModelsByServer,
  defaultServerId,
  ocSessions,
  unlinkedOcSessions,
  queuedTasks,
  autoRunQueued,
  onRunQueued,
  onOpenOcSettings,
  humanSecBy,
  onToggle,
  onHandToAgent,
  onApprove,
  onAnswerForm,
  onTrackOcSession,
  onIgnoreOcSession,
  onMove,
  onDemote,
  onMoveProject,
  projects,
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
  spentBy: Record<string, number>;
  expandedId: string | null;
  ocConnected: boolean;
  ocServers: OpenCodeServer[];
  ocServerOnlineById: Record<string, boolean>;
  ocModelsByServer: Record<string, OpenCodeModelOption[]>;
  defaultServerId: string;
  ocSessions: OpenCodeLiveSession[];
  unlinkedOcSessions: OpenCodeLiveSession[];
  queuedTasks: Task[];
  autoRunQueued: boolean;
  onRunQueued: () => void;
  onOpenOcSettings: () => void;
  humanSecBy: Record<string, number>;
  onToggle: (id: string) => void;
  onHandToAgent: (t: Task, prompt?: string, serverId?: string, model?: string) => void;
  onApprove: (t: Task) => void;
  onAnswerForm: (t: Task, fieldKey: string, value: string, label: string) => void;
  onTrackOcSession: (s: OpenCodeLiveSession) => void;
  onIgnoreOcSession: (sid: string) => void;
  onMove: (t: Task) => void;
  onDemote?: (t: Task) => void;
  onMoveProject?: (t: Task, projectId: string) => void;
  projects?: Project[];
  onAdd: (raw: string, fallbackSection?: string, extra?: AddExtra) => void;
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

  // Bubble tasks that Need You to the top of Focus
  const sortedFocus = [...focusTasks].sort((a, b) => {
    const sa = resolveTaskTriage(a, ocSessions).triage;
    const sb = resolveTaskTriage(b, ocSessions).triage;
    return TRIAGE_ORDER[sa] - TRIAGE_ORDER[sb];
  });

  return (
    <div className="space-y-6">
      {queuedTasks.length > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-zinc-800 bg-zinc-900/90 px-3.5 py-2.5 text-[13px]">
          <div className="flex min-w-0 items-center gap-2 text-zinc-300">
            <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400 animate-pulse" />
            <span className="truncate">
              {ocConnected
                ? autoRunQueued
                  ? `Launching ${queuedTasks.length} queued task${queuedTasks.length === 1 ? "" : "s"} on connected OpenCode server…`
                  : `${queuedTasks.length} task${queuedTasks.length === 1 ? "" : "s"} queued for OpenCode`
                : `${queuedTasks.length} task${queuedTasks.length === 1 ? "" : "s"} queued in Todoist — will run when assigned server connects`}
            </span>
          </div>
          {ocConnected && !autoRunQueued ? (
            <button
              type="button"
              onClick={onRunQueued}
              className="shrink-0 rounded bg-orange-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-orange-500"
            >
              ▶ Run now
            </button>
          ) : !ocConnected ? (
            <button
              type="button"
              onClick={onOpenOcSettings}
              className="shrink-0 text-[12px] text-orange-500 hover:text-orange-400"
            >
              Servers ⚙
            </button>
          ) : null}
        </div>
      )}

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
          <div className="flex items-center gap-2 px-2">
            <p className="shrink-0 text-[13px] text-zinc-500">Buffer</p>
            <AddRow
              inline
              ocConnected={ocConnected}
              ocServers={ocServers}
              ocServerOnlineById={ocServerOnlineById}
              ocModelsByServer={ocModelsByServer}
              defaultServerId={defaultServerId}
              placeholder="＋ Quick add… (~server @repo // prompt)"
              hotkey="b"
              sections={sections}
              onAdd={(raw, extra) => onAdd(raw, bufferId, extra)}
            />
          </div>
          {bufferTasks.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {bufferTasks.map((t) => (
                <TaskRow
                  key={t.id}
                  t={t}
                  durations={durations}
                  defaultMinutes={defaultMinutes}
                  spentBy={spentBy}
                  ocConnected={ocConnected}
                  ocServers={ocServers}
                  ocServerOnlineById={ocServerOnlineById}
                  ocModelsByServer={ocModelsByServer}
                  defaultServerId={defaultServerId}
                  ocSessions={ocSessions}
                  humanSec={humanSecBy[t.id] ?? 0}
                  expanded={expandedId === t.id}
                  onToggle={() => onToggle(t.id)}
                  onHandToAgent={(p, srvId, mdl) => onHandToAgent(t, p, srvId, mdl)}
                  onApprove={() => onApprove(t)}
                  onAnswerForm={(k, v, l) => onAnswerForm(t, k, v, l)}
                  onStart={onStart}
                  onMove={focusId ? onMove : undefined}
                  onDemote={onDemote}
                  onMoveProject={onMoveProject}
                  projects={projects}
                  onComplete={() => onComplete(t)}
                  onUpdate={onUpdate}
                  onDuration={onDuration}
                  onDelete={onDelete}
                />
              ))}
            </ul>
          )}
        </section>
      )}

      {focusTasks.length > cap && (
        <p className="rounded-md border border-zinc-800 bg-zinc-900 px-4 py-3 text-[13px] text-zinc-400">
          Too many priorities — Focus holds {cap}. Move something back to Backlog.
        </p>
      )}

      <section>
        <div className="mb-1 flex items-center justify-between px-2">
          <p className="text-[13px] text-zinc-500">Focus</p>
          <span className="text-[12px] text-zinc-600">
            Sorted by what needs your attention first
          </span>
        </div>
        {sortedFocus.length === 0 ? (
          <button
            className="block w-full py-8 text-center text-[13px] text-zinc-500"
            onClick={onGoBacklog}
          >
            Focus holds today's top {cap} tasks.
            <span className="mt-1 block text-orange-500">Pull from Backlog →</span>
          </button>
        ) : (
          <ul className="space-y-0.5">
            {sortedFocus.map((t) => (
              <TaskRow
                key={t.id}
                t={t}
                large
                durations={durations}
                defaultMinutes={defaultMinutes}
                spentBy={spentBy}
                ocConnected={ocConnected}
                ocServers={ocServers}
                ocServerOnlineById={ocServerOnlineById}
                ocModelsByServer={ocModelsByServer}
                defaultServerId={defaultServerId}
                ocSessions={ocSessions}
                humanSec={humanSecBy[t.id] ?? 0}
                expanded={expandedId === t.id}
                onToggle={() => onToggle(t.id)}
                onHandToAgent={(p, srvId, mdl) => onHandToAgent(t, p, srvId, mdl)}
                onApprove={() => onApprove(t)}
                onAnswerForm={(k, v, l) => onAnswerForm(t, k, v, l)}
                onStart={onStart}
                onComplete={() => onComplete(t)}
                onDemote={onDemote}
                onMoveProject={onMoveProject}
                projects={projects}
                onUpdate={onUpdate}
                onDuration={onDuration}
                onDelete={onDelete}
              />
            ))}
          </ul>
        )}
        {focusId && (
          <AddRow
            ocConnected={ocConnected}
            ocServers={ocServers}
            ocServerOnlineById={ocServerOnlineById}
            ocModelsByServer={ocModelsByServer}
            defaultServerId={defaultServerId}
            placeholder="＋ Add to Focus… (~server @repo // prompt or Tab)"
            hotkey="n"
            sections={sections}
            onAdd={(raw, extra) => onAdd(raw, focusId, extra)}
          />
        )}
      </section>

      {unlinkedOcSessions.length > 0 && (
        <section className="border-t border-zinc-900 pt-3">
          <p className="mb-1 px-2 text-[12px] text-zinc-500">
            Unlinked OpenCode sessions (last 24h)
          </p>
          <ul className="space-y-0.5">
            {unlinkedOcSessions.slice(0, 6).map((s) => (
              <li
                key={s.id}
                className="flex min-h-9 items-center justify-between gap-2 rounded-md px-2 text-[13px] text-zinc-400 hover:bg-zinc-900"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      s.status === "running"
                        ? "bg-zinc-300 animate-pulse"
                        : "bg-orange-500"
                    }`}
                  />
                  {ocServers.length > 1 && (
                    <span className="shrink-0 rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.2 font-mono text-[11px] text-zinc-400">
                      {s.serverId}
                    </span>
                  )}
                  <span className="truncate text-zinc-300">{s.title}</span>
                  {s.repoShort && (
                    <span className="shrink-0 font-mono text-[11px] text-zinc-600">
                      {s.repoShort}
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => onTrackOcSession(s)}
                    className="text-[12px] text-zinc-400 hover:text-orange-500"
                    title="Create a Todoist Focus task linked to this session"
                  >
                    ＋ Track
                  </button>
                  <button
                    onClick={() => onIgnoreOcSession(s.id)}
                    className="px-1 text-[12px] text-zinc-600 hover:text-zinc-400"
                    title="Hide this session from Unlinked list (keeps session in OpenCode)"
                  >
                    ×
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function BacklogList({
  tasks,
  expandedId,
  spentBy,
  ocConnected,
  ocServers,
  ocServerOnlineById,
  ocModelsByServer,
  defaultServerId,
  ocSessions,
  humanSecBy,
  onToggle,
  onHandToAgent,
  onApprove,
  onAnswerForm,
  onMove,
  onMoveProject,
  projects,
  onComplete,
  onUpdate,
  onDuration,
  onDelete,
  durations,
  defaultMinutes,
}: {
  tasks: Task[];
  expandedId: string | null;
  spentBy: Record<string, number>;
  ocConnected: boolean;
  ocServers: OpenCodeServer[];
  ocServerOnlineById: Record<string, boolean>;
  ocModelsByServer: Record<string, OpenCodeModelOption[]>;
  defaultServerId: string;
  ocSessions: OpenCodeLiveSession[];
  humanSecBy: Record<string, number>;
  onToggle: (id: string) => void;
  onHandToAgent: (t: Task, prompt?: string, serverId?: string, model?: string) => void;
  onApprove: (t: Task) => void;
  onAnswerForm: (t: Task, fieldKey: string, value: string, label: string) => void;
  onMove?: (t: Task) => void;
  onMoveProject?: (t: Task, projectId: string) => void;
  projects?: Project[];
  onComplete: (t: Task) => void;
  onUpdate: (id: string, fields: { content?: string; description?: string }) => Promise<void>;
  onDuration: (t: Task, minutes: number) => void;
  onDelete: (t: Task) => void;
  durations: number[];
  defaultMinutes: number;
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
            defaultMinutes={defaultMinutes}
            spentBy={spentBy}
            ocConnected={ocConnected}
            ocServers={ocServers}
            ocServerOnlineById={ocServerOnlineById}
            ocModelsByServer={ocModelsByServer}
            defaultServerId={defaultServerId}
            ocSessions={ocSessions}
            humanSec={humanSecBy[t.id] ?? 0}
            expanded={expandedId === t.id}
            onToggle={() => onToggle(t.id)}
            onHandToAgent={(p, srvId, mdl) => onHandToAgent(t, p, srvId, mdl)}
            onApprove={() => onApprove(t)}
            onAnswerForm={(k, v, l) => onAnswerForm(t, k, v, l)}
            onMove={onMove}
            onMoveProject={onMoveProject}
            projects={projects}
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
  onHandToAgent,
  onApprove,
  onAnswerForm,
  onStart,
  onComplete,
  defaultMinutes = 5,
  onMove,
  onDemote,
  onMoveProject,
  projects,
  onUpdate,
  onDuration,
  onDelete,
  durations,
  spentBy,
  ocConnected = false,
  ocServers = [],
  ocServerOnlineById = {},
  ocModelsByServer = {},
  defaultServerId = "local",
  ocSessions,
  humanSec,
}: {
  t: Task;
  large?: boolean;
  expanded: boolean;
  onToggle: () => void;
  onHandToAgent: (prompt?: string, serverId?: string, model?: string) => void;
  onApprove: () => void;
  onAnswerForm: (fieldKey: string, value: string, label: string) => void;
  onStart?: (t: Task, minutes: number) => void;
  onComplete?: () => void;
  defaultMinutes?: number;
  onMove?: (t: Task) => void;
  onDemote?: (t: Task) => void;
  onMoveProject?: (t: Task, projectId: string) => void;
  projects?: Project[];
  onUpdate: (id: string, fields: { content?: string; description?: string }) => Promise<void>;
  onDuration: (t: Task, minutes: number) => void;
  onDelete: (t: Task) => void;
  durations: number[];
  spentBy: Record<string, number>;
  ocConnected?: boolean;
  ocServers?: OpenCodeServer[];
  ocServerOnlineById?: Record<string, boolean>;
  ocModelsByServer?: Record<string, OpenCodeModelOption[]>;
  defaultServerId?: string;
  ocSessions: OpenCodeLiveSession[];
  humanSec: number;
}) {
  const rootRef = useRef<HTMLLIElement>(null);
  const [zen, setZen] = useState(false);

  useEffect(() => {
    if (!expanded) setZen(false);
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const down = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onToggle();
    };
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setZen((z) => !z);
        return;
      }
      if (
        e.key.toLowerCase() === "f" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !(e.target as HTMLElement)?.closest?.("input,textarea,select")
      ) {
        e.preventDefault();
        setZen((z) => !z);
        return;
      }
      if (e.key === "Escape") {
        if (zen) {
          e.preventDefault();
          setZen(false);
        } else {
          onToggle();
        }
      }
    };
    document.addEventListener("pointerdown", down);
    window.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", key);
    };
  }, [expanded, zen, onToggle]);

  const { triage, liveSession, meta } = resolveTaskTriage(t, ocSessions);
  const ui = TRIAGE_UI[triage];
  const hasQuestion = Boolean(liveSession?.form);
  const needsApproval = Boolean(liveSession?.permission);
  const isQueuedForAgent = !liveSession && Boolean(meta.queued);
  const assignedServerId = liveSession?.serverId || meta.server || defaultServerId;
  const isAssignedServerOnline = ocServerOnlineById[assignedServerId] ?? ocConnected;

  const activeSid = meta.sessions[meta.sessions.length - 1] ?? "";
  const [summary, setSummary] = useState<SessionSummary | null>(null);

  useEffect(() => {
    if (!activeSid) {
      setSummary(null);
      return;
    }
    fetchOpenCodeSessionSummary(activeSid, liveSession?.updatedAt, assignedServerId).then((res) => {
      if (res) setSummary(res);
    });
  }, [activeSid, liveSession?.updatedAt, liveSession?.status, expanded, assignedServerId]);

  const spent = (spentBy[t.id] ?? 0) + Math.floor(humanSec / 60);
  const planned = t.duration?.amount ?? defaultMinutes;
  const over = spent > planned;

  const repoShort = shortRepo(meta.repo || liveSession?.repoShort);
  const showServerBadge = ocServers.length > 1 || (meta.server && meta.server !== defaultServerId);
  const activeModelKey = liveSession?.modelKey || meta.model || "";
  const activeModelShort = shortModelLabel(
    activeModelKey,
    ocModelsByServer[assignedServerId],
  );
  const targetBadge = [
    showServerBadge ? assignedServerId : null,
    repoShort,
    meta.model ? activeModelShort : null,
  ]
    .filter(Boolean)
    .join("/");

  const latestReplyOneLine = summary?.lastAssistantText
    ? summary.lastAssistantText
        .replace(/```[\s\S]*?```/g, "")
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/[*`#|-]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";

  const formQuestionTitle =
    liveSession?.form?.fields?.[0]?.title || liveSession?.form?.title || "";

  // Single quiet sub-line under task title
  const subline = hasQuestion
    ? `Question: ${formQuestionTitle}`
    : needsApproval && liveSession?.permission
      ? `Blocked: ${liveSession.permission.action} ${liveSession.permission.resources.join(" ")}`
      : triage === "working" && summary?.lastToolCall
        ? `Running: ${summary.lastToolCall}`
        : isQueuedForAgent
          ? `Queued for ${assignedServerId}${meta.prompt ? ` · ${meta.prompt.split("\n")[0]}` : ""}`
          : latestReplyOneLine || meta.note || meta.prompt.split("\n")[0] || "";

  const dur = (
    <div className="flex shrink-0 items-center gap-2 font-mono text-[12px] tabular-nums">
      {isQueuedForAgent ? (
        <span className="inline-flex items-center gap-1.5 text-[12px] text-amber-400">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
          Queued
        </span>
      ) : (
        (triage !== "queued" || liveSession) && (
          <span className={`inline-flex items-center gap-1.5 text-[12px] ${ui.labelCls}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${ui.dot}`} />
            {hasQuestion ? "Question" : ui.label}
          </span>
        )
      )}
      {spent > 0 ? (
        <span className="text-zinc-500">
          <span className={over ? "text-orange-500" : "text-zinc-400"}>{spent}m/</span>
          {planned}m
        </span>
      ) : (
        t.duration && <span className="text-zinc-500">{t.duration.amount}m</span>
      )}
    </div>
  );

  const actions = (
    <div className="flex shrink-0 items-center gap-1">
      {!liveSession && !onMove && !isQueuedForAgent && (
        <button
          className="shrink-0 rounded px-2 py-1 text-[12px] text-orange-500 transition-colors duration-150 hover:bg-zinc-800"
          title={
            isAssignedServerOnline
              ? `Run on ${assignedServerId}`
              : `Queue for ${assignedServerId}`
          }
          aria-label={
            isAssignedServerOnline
              ? `Run on ${assignedServerId}`
              : `Queue for ${assignedServerId}`
          }
          onClick={() => onHandToAgent(undefined, assignedServerId)}
        >
          ▶
        </button>
      )}
      {!liveSession && !onMove && isQueuedForAgent && isAssignedServerOnline && (
        <button
          className="shrink-0 rounded px-2 py-1 text-[12px] text-orange-500 transition-colors duration-150 hover:bg-zinc-800"
          title={`Start queued task on ${assignedServerId} now`}
          aria-label={`Start queued task on ${assignedServerId} now`}
          onClick={() => onHandToAgent(undefined, assignedServerId)}
        >
          ▶
        </button>
      )}
      {onMove && (
        <button
          className={`${btn} shrink-0 px-2 py-1`}
          title="Pull into Focus"
          aria-label="Pull into Focus"
          onClick={() => onMove(t)}
        >
          →
        </button>
      )}
    </div>
  );

  return (
    <li
      ref={rootRef}
      className={`rounded-md border-l-2 transition-colors duration-150 ${
        expanded
          ? "border-l-orange-500 bg-zinc-900/80 ring-1 ring-zinc-800"
          : `${ui.leftBar || pBar(t.priority)} hover:bg-zinc-900/50 active:bg-zinc-800/60`
      } ${isNew(t) ? "row-new" : ""}`}
    >
      {expanded ? (
        <RowEditor
          t={t}
          large={large}
          zen={zen}
          onToggleZen={() => setZen((z) => !z)}
          dur={dur}
          actions={actions}
          durations={durations}
          defaultMinutes={defaultMinutes}
          ocConnected={ocConnected}
          ocServers={ocServers}
          ocServerOnlineById={ocServerOnlineById}
          ocModelsByServer={ocModelsByServer}
          defaultServerId={defaultServerId}
          ocSessions={ocSessions}
          liveSession={liveSession}
          summary={summary}
          onClose={onToggle}
          onUpdate={onUpdate}
          onDuration={onDuration}
          onHandToAgent={onHandToAgent}
          onApprove={onApprove}
          onAnswerForm={onAnswerForm}
          onStartCountdown={
            onStart ? () => onStart(t, t.duration?.amount ?? defaultMinutes) : undefined
          }
          onDemote={onDemote}
          onMoveProject={onMoveProject}
          projects={projects}
          onComplete={onComplete}
          onDelete={onDelete}
        />
      ) : (
        <div className={`flex items-center gap-2.5 px-3 ${large ? "min-h-13" : "min-h-10"}`}>
          <button className="min-w-0 flex-1 py-1.5 text-left" onClick={onToggle}>
            <div className="flex items-center gap-2">
              <span
                className={`truncate ${
                  large ? "text-[15px] font-medium text-zinc-100" : "text-[14px] text-zinc-200"
                }`}
              >
                {t.content}
              </span>
              {targetBadge && (
                <span className="shrink-0 font-mono text-[11px] text-zinc-500">
                  {targetBadge}
                </span>
              )}
            </div>
            {subline && (
              <span
                className={`block truncate text-[12px] ${
                  hasQuestion || needsApproval
                    ? "text-orange-400"
                    : isQueuedForAgent
                      ? "text-amber-400/90"
                      : triage === "needs_you"
                        ? "text-zinc-300"
                        : "text-zinc-500"
                }`}
              >
                {subline}
              </span>
            )}
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
  zen = false,
  onToggleZen,
  dur,
  actions,
  durations,
  defaultMinutes = 5,
  ocConnected = false,
  ocServers = [],
  ocServerOnlineById = {},
  ocModelsByServer = {},
  defaultServerId = "local",
  ocSessions,
  liveSession,
  summary,
  onClose,
  onUpdate,
  onDuration,
  onHandToAgent,
  onApprove,
  onAnswerForm,
  onStartCountdown,
  onDemote,
  onMoveProject,
  projects,
  onComplete,
  onDelete,
}: {
  t: Task;
  large?: boolean;
  zen?: boolean;
  onToggleZen?: () => void;
  dur: ReactNode;
  actions: ReactNode;
  durations: number[];
  defaultMinutes?: number;
  ocConnected?: boolean;
  ocServers?: OpenCodeServer[];
  ocServerOnlineById?: Record<string, boolean>;
  ocModelsByServer?: Record<string, OpenCodeModelOption[]>;
  defaultServerId?: string;
  ocSessions: OpenCodeLiveSession[];
  liveSession?: OpenCodeLiveSession;
  summary: SessionSummary | null;
  onClose: () => void;
  onUpdate: (id: string, fields: { content?: string; description?: string }) => Promise<void>;
  onDuration: (t: Task, minutes: number) => void;
  onHandToAgent: (prompt?: string, serverId?: string, model?: string) => void;
  onApprove: () => void;
  onAnswerForm: (fieldKey: string, value: string, label: string) => void;
  onStartCountdown?: () => void;
  onDemote?: (t: Task) => void;
  onMoveProject?: (t: Task, projectId: string) => void;
  projects?: Project[];
  onComplete?: () => void;
  onDelete: (t: Task) => void;
}) {
  const initialMeta = useMemo(() => parseTaskDescription(t.description), [t.description]);
  const [title, setTitle] = useState(t.content);
  const [note, setNote] = useState(initialMeta.note);
  const [prompt, setPrompt] = useState(initialMeta.prompt);
  const [repo, setRepo] = useState(initialMeta.repo);
  const [server, setServer] = useState(
    liveSession?.serverId || initialMeta.server || defaultServerId,
  );
  const [model, setModel] = useState(initialMeta.model || liveSession?.modelKey || "");
  const [sessions, setSessions] = useState<string[]>(initialMeta.sessions);
  const [queued, setQueued] = useState<boolean>(Boolean(initialMeta.queued));
  const [saveState, setSaveState] = useState<"" | "saving" | "saved">("");
  const [confirming, setConfirming] = useState(false);
  const [showMeta, setShowMeta] = useState(false);
  const [showCheckpoints, setShowCheckpoints] = useState(false);
  const [replyText, setReplyText] = useState("");
  const hasSessionOutput = Boolean(
    liveSession || summary?.lastAssistantText || summary?.lastToolCall,
  );

  useEffect(() => {
    if (liveSession?.modelKey && !model) {
      setModel(liveSession.modelKey);
    }
  }, [liveSession?.modelKey, model]);

  const titleLive = useRef(title);
  titleLive.current = title;
  const metaLive = useRef<TaskMeta>({ note, prompt, repo, server, model, sessions, queued });
  metaLive.current = { note, prompt, repo, server, model, sessions, queued };
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

  const flush = () => {
    clearTimeout(debRef.current);
    const v = titleLive.current.trim();
    if (v && v !== tLive.current.content) persist({ content: v });
    const formattedDesc = formatTaskDescription(metaLive.current);
    if (formattedDesc !== (tLive.current.description ?? "")) {
      persist({ description: formattedDesc });
    }
  };
  useEffect(() => () => flush(), []);

  const scheduleFlush = () => {
    clearTimeout(debRef.current);
    debRef.current = setTimeout(flush, 500);
  };

  const promptRef = useRef<HTMLTextAreaElement>(null);
  const inputVal = hasSessionOutput ? replyText : prompt;
  useEffect(() => {
    const el = promptRef.current;
    if (el) {
      el.style.height = "0";
      const minH = zen ? 88 : 44;
      el.style.height = `${Math.max(minH, el.scrollHeight)}px`;
    }
  }, [inputVal, hasSessionOutput, zen]);

  const activeSrvObj = ocServers.find((s) => s.id === server) ?? ocServers[0];
  const serverRepos = activeSrvObj?.repos?.length ? activeSrvObj.repos : KNOWN_REPOS;
  const serverModels = ocModelsByServer[server] ?? [];
  const defaultModelObj = serverModels.find((m) => m.isDefault);
  const isTargetServerOnline = ocServerOnlineById[server] ?? ocConnected;
  const targetLabel = repo ? `${server}/${shortRepo(repo)}` : server;

  const activeSid = sessions[sessions.length - 1] ?? "";
  const turns = summary?.turns ?? [];

  const handleModelChange = (nextModel: string) => {
    setModel(nextModel);
    metaLive.current = { ...metaLive.current, model: nextModel };
    scheduleFlush();
    if (activeSid && isTargetServerOnline && nextModel) {
      switchOpenCodeSessionModel(activeSid, nextModel, server).catch(() => {});
    }
  };

  const submitToAgent = () => {
    flush();
    if (hasSessionOutput) {
      const msg = replyText.trim() || prompt.trim();
      onHandToAgent(msg || undefined, server, model || undefined);
      setReplyText("");
    } else {
      onHandToAgent(prompt, server, model || undefined);
    }
  };

  const modelSelectEl = (
    <select
      aria-label="OpenCode model"
      title="Select OpenCode model for this task"
      value={model}
      onChange={(e) => handleModelChange(e.target.value)}
      className="max-w-52 truncate rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 font-mono text-[11px] text-zinc-200 outline-none hover:border-zinc-700"
    >
      <option value="">
        {defaultModelObj ? `Default (${defaultModelObj.name})` : "Default model"}
      </option>
      {model && !serverModels.some((m) => m.key === model) && (
        <option value={model}>{shortModelLabel(model)}</option>
      )}
      {serverModels.map((m) => (
        <option key={m.key} value={m.key}>
          {m.name} ({m.providerID})
        </option>
      ))}
    </select>
  );

  return (
    <div
      className={
        zen
          ? "fixed inset-0 z-30 flex flex-col bg-zinc-950/98 backdrop-blur"
          : ""
      }
    >
      <div
        className={
          zen
            ? "mx-auto flex h-full w-full max-w-4xl flex-col px-4 py-4 sm:px-8 sm:py-6"
            : ""
        }
      >
        {/* title morphs in place */}
        <div
          className={`flex items-center gap-2.5 ${
            zen
              ? "border-b border-zinc-800 pb-3"
              : `px-3 ${large ? "min-h-13" : "min-h-10"}`
          }`}
          onClick={(e) => {
            if (!zen && !(e.target as HTMLElement).closest("input,button,select,textarea"))
              onClose();
          }}
        >
          <input
            autoFocus
            className={`min-w-0 flex-1 bg-transparent p-0 text-left outline-none ${
              zen
                ? "text-[18px] font-semibold text-zinc-100"
                : large
                  ? "text-[15px] font-medium"
                  : "text-[14px]"
            }`}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              scheduleFlush();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (zen) (e.target as HTMLInputElement).blur();
                else onClose();
              }
            }}
          />
          {saveState && (
            <span className="shrink-0 text-[12px] text-zinc-500 transition-opacity duration-150">
              {saveState === "saving" ? "Saving…" : "Saved ✓"}
            </span>
          )}
          {dur}
          {actions}
          {onToggleZen && (
            <button
              type="button"
              onClick={onToggleZen}
              className="shrink-0 rounded px-2 py-1 font-mono text-[13px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              title={zen ? "Exit full screen (⌘E or Esc)" : "Full screen focus mode (⌘E or F)"}
              aria-label={zen ? "Exit full screen" : "Full screen focus mode"}
            >
              {zen ? "⤡" : "⤢"}
            </button>
          )}
        </div>

        <div className={zen ? "flex min-h-0 flex-1 flex-col pt-3" : "row-expand"}>
          <div
            className={
              zen
                ? "flex min-h-0 flex-1 flex-col gap-4"
                : "space-y-3 border-t border-zinc-800/70 px-3.5 pt-3 pb-3.5"
            }
          >
            {/* 1. Target & Model Bar */}
            {activeSid ? (
              <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
                <div className="flex min-w-0 flex-wrap items-center gap-2 font-mono text-[11px] text-zinc-400">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      isTargetServerOnline ? "bg-orange-500" : "bg-zinc-600"
                    }`}
                  />
                  <span className="font-medium text-zinc-200">{targetLabel}</span>
                  <span className="truncate text-zinc-600">
                    {liveSession?.directory ||
                      serverRepos.find((r) => r.label === repo)?.dir ||
                      activeSrvObj?.defaultDir ||
                      "/Users/justinyu"}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {modelSelectEl}
                  <button
                    type="button"
                    onClick={() => navigator.clipboard?.writeText(`opencode -s ${activeSid}`)}
                    title={`Copy "opencode -s ${activeSid}"`}
                    className="shrink-0 font-mono text-[11px] text-zinc-500 hover:text-zinc-300"
                  >
                    {activeSid.slice(0, 10)} ↗
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-zinc-500">Target:</span>
                  {ocServers.map((s) => {
                    const active = server === s.id;
                    const online = ocServerOnlineById[s.id];
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => {
                          const nextRepos = s.repos?.length ? s.repos : KNOWN_REPOS;
                          const nextRepo = nextRepos.some((r) => r.label === repo)
                            ? repo
                            : (nextRepos[0]?.label ?? "");
                          setServer(s.id);
                          setRepo(nextRepo);
                          metaLive.current = {
                            ...metaLive.current,
                            server: s.id,
                            repo: nextRepo,
                          };
                          scheduleFlush();
                        }}
                        className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 font-mono text-[11px] ${
                          active
                            ? "bg-zinc-200 font-medium text-zinc-950"
                            : "bg-zinc-800/70 text-zinc-400 hover:text-zinc-200"
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            online
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
                    value={repo}
                    onChange={(e) => {
                      setRepo(e.target.value);
                      metaLive.current = { ...metaLive.current, repo: e.target.value };
                      scheduleFlush();
                    }}
                    className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 font-mono text-[11px] text-zinc-200 outline-none"
                  >
                    <option value="">~ ({activeSrvObj?.defaultDir || "/Users/justinyu"})</option>
                    {serverRepos.map((r) => (
                      <option key={r.label} value={r.label}>
                        {shortRepo(r.label)} ({r.dir})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center gap-1.5">
                  <span className="text-zinc-500">Model:</span>
                  {modelSelectEl}
                </div>
              </div>
            )}

            {/* Scrollable workspace region in Zen mode */}
            <div className={zen ? "min-h-0 flex-1 space-y-4 overflow-y-auto pr-1" : "space-y-3"}>
              {/* 2. OpenCode Question / Option Picker */}
              {liveSession?.form && (
                <div className="space-y-1.5 border-l-2 border-l-orange-500 pl-3 py-0.5 text-[13px]">
                  {liveSession.form.fields.map((field) => (
                    <div key={field.key} className="space-y-1.5">
                      <div className="font-medium text-zinc-100">
                        {field.title || liveSession.form?.title}
                      </div>
                      {field.description && (
                        <p className="text-[12px] text-zinc-400">{field.description}</p>
                      )}
                      {field.options && field.options.length > 0 && (
                        <div className="grid gap-1.5 pt-1">
                          {field.options.map((opt) => (
                            <button
                              key={opt.value}
                              type="button"
                              onClick={() => onAnswerForm(field.key, opt.value, opt.label)}
                              className="flex flex-col items-start rounded border border-zinc-800 bg-zinc-950/80 px-3 py-2 text-left hover:border-orange-500/60"
                            >
                              <span className="text-[13px] font-medium text-zinc-100">
                                {opt.label}
                              </span>
                              {opt.description && (
                                <span className="text-[12px] text-zinc-400">
                                  {opt.description}
                                </span>
                              )}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Fallback if a tool permission is pending */}
              {liveSession?.permission && (
                <div className="flex items-center justify-between gap-2 rounded border border-orange-500/40 bg-zinc-950 px-3 py-2 text-[12px]">
                  <div className="min-w-0 truncate font-mono text-zinc-200">
                    <span className="text-orange-400">Allow {liveSession.permission.action}: </span>
                    {liveSession.permission.resources.join(" ")}
                  </div>
                  <button
                    onClick={onApprove}
                    className="shrink-0 rounded bg-orange-600 px-2.5 py-1 font-medium text-white hover:bg-orange-500"
                  >
                    Allow
                  </button>
                </div>
              )}

              {/* 3. Latest OpenCode Outcome (Markdown) + Checkpoints */}
              {(summary?.lastAssistantText || summary?.lastToolCall) && (
                <div className="space-y-2 border-t border-zinc-800/60 pt-2.5">
                  <div className={zen ? "" : "max-h-56 overflow-y-auto"}>
                    {summary.lastAssistantText ? (
                      <SimpleMarkdown text={summary.lastAssistantText} />
                    ) : (
                      <p className="font-mono text-[12px] text-zinc-500">
                        Running {summary.lastToolCall}…
                      </p>
                    )}
                  </div>

                  {turns.length > 1 && (
                    <div>
                      <button
                        type="button"
                        onClick={() => setShowCheckpoints((s) => !s)}
                        className="font-mono text-[11px] text-zinc-500 hover:text-zinc-300"
                      >
                        {showCheckpoints ? "▾" : "▸"} {turns.length} checkpoints
                      </button>

                      {showCheckpoints && (
                        <ol
                          className={`mt-1.5 space-y-2.5 border-l border-zinc-800 pl-3 text-[12px] ${
                            zen ? "" : "max-h-48 overflow-y-auto"
                          }`}
                        >
                          {turns.map((turn) => (
                            <li key={turn.id} className="space-y-1 text-zinc-400">
                              <div className="font-mono text-[11px] text-zinc-500">
                                {turn.role === "user" ? "you" : server}
                              </div>
                              {turn.text && <SimpleMarkdown text={turn.text} />}
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* In Zen Mode, always show a comfortable Task Notes & Context editor */}
              {zen && (
                <div className="space-y-1.5 border-t border-zinc-800/60 pt-3">
                  <label className="block font-mono text-[11px] text-zinc-500">
                    Task Notes / Context
                  </label>
                  <textarea
                    rows={4}
                    value={note}
                    onChange={(e) => {
                      setNote(e.target.value);
                      scheduleFlush();
                    }}
                    placeholder="Write notes, links, or next-step context for this task…"
                    className="w-full resize-y rounded border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-[13px] leading-relaxed text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-700"
                  />
                </div>
              )}

              {/* 4. Queued Banner (when waiting for an offline server) */}
              {queued && !liveSession && (
                <div className="flex items-center justify-between gap-2 rounded border border-amber-500/30 bg-zinc-950 px-3 py-1.5 text-[12px]">
                  <span className="text-amber-300">
                    ⏳ Queued in Todoist — will start when {server} connects
                  </span>
                  <div className="flex shrink-0 items-center gap-2">
                    {isTargetServerOnline && (
                      <button
                        type="button"
                        onClick={submitToAgent}
                        className="rounded bg-orange-600 px-2 py-0.5 font-medium text-white hover:bg-orange-500"
                      >
                        Start now →
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setQueued(false);
                        metaLive.current = { ...metaLive.current, queued: false };
                        flush();
                      }}
                      className="text-zinc-400 hover:text-zinc-200"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* 5. Steer / Prompt Composer */}
            <div className="rounded-md border border-zinc-800 bg-zinc-950 p-2.5 focus-within:border-zinc-700">
              <textarea
                ref={promptRef}
                className="w-full resize-none overflow-hidden bg-transparent text-[13px] leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-600"
                placeholder={
                  hasSessionOutput
                    ? `Steer OpenCode on ${targetLabel}…`
                    : `Prompt for ${targetLabel}…`
                }
                rows={zen ? 4 : 2}
                value={inputVal}
                onChange={(e) => {
                  if (hasSessionOutput) {
                    setReplyText(e.target.value);
                  } else {
                    setPrompt(e.target.value);
                    scheduleFlush();
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    submitToAgent();
                  }
                }}
              />
              <div className="mt-1.5 flex items-center justify-between border-t border-zinc-900 pt-1.5 text-[12px]">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowMeta((s) => !s)}
                    className="text-zinc-500 hover:text-zinc-300"
                  >
                    {showMeta ? "Hide options" : "More options"}
                  </button>
                  {onToggleZen && (
                    <button
                      type="button"
                      onClick={onToggleZen}
                      className="text-zinc-500 hover:text-zinc-300"
                      title="Toggle full-screen focus mode (⌘E)"
                    >
                      {zen ? "⤡ Inline view" : "⤢ Zen mode"}
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  {onDemote && (
                    <button
                      type="button"
                      onClick={() => onDemote(t)}
                      title="Move to Backlog"
                      aria-label="Move to Backlog"
                      className="inline-flex h-7 w-7 items-center justify-center rounded text-[14px] text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-zinc-200"
                    >
                      ↓
                    </button>
                  )}
                  {onComplete && (
                    <button
                      type="button"
                      onClick={onComplete}
                      title="Done"
                      aria-label="Done"
                      className="inline-flex h-7 w-7 items-center justify-center rounded text-[14px] text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-zinc-200"
                    >
                      ✓
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={submitToAgent}
                    title={
                      hasSessionOutput
                        ? "Send Steer (⌘↵)"
                        : isTargetServerOnline
                          ? `Run on ${targetLabel} (⌘↵)`
                          : `Queue for ${targetLabel} (⌘↵)`
                    }
                    aria-label={
                      hasSessionOutput
                        ? "Send Steer"
                        : isTargetServerOnline
                          ? `Run on ${targetLabel}`
                          : `Queue for ${targetLabel}`
                    }
                    className="inline-flex h-7 w-7 items-center justify-center rounded bg-orange-600 text-[13px] font-medium text-white transition-colors hover:bg-orange-500"
                  >
                    {hasSessionOutput ? "↑" : "▶"}
                  </button>
                </div>
              </div>
            </div>

            {/* 6. Secondary Options Drawer */}
            {showMeta && (
              <div className="space-y-2 border-t border-zinc-800/60 pt-2.5 text-[12px]">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-1.5 text-zinc-400">
                    <span className="text-zinc-500">Session</span>
                    <select
                      value={activeSid}
                      onChange={(e) => {
                        const val = e.target.value;
                        const next = val ? Array.from(new Set([...sessions, val])) : [];
                        setSessions(next);
                        const picked = ocSessions.find((s) => s.id === val);
                        if (picked?.repoShort && !repo) setRepo(picked.repoShort);
                        if (picked?.serverId) setServer(picked.serverId);
                        if (picked?.modelKey) setModel(picked.modelKey);
                        scheduleFlush();
                      }}
                      className="max-w-52 truncate rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-[11px] text-zinc-300 outline-none"
                    >
                      <option value="">Auto-create</option>
                      {ocSessions.map((s) => (
                        <option key={s.id} value={s.id}>
                          [{s.serverId}] {s.id.slice(0, 10)} · {s.title.slice(0, 22)}
                        </option>
                      ))}
                    </select>
                  </label>

                  <DurationChips
                    t={t}
                    durations={durations}
                    defaultMinutes={defaultMinutes}
                    onDuration={onDuration}
                  />

                  {onStartCountdown && (
                    <button
                      className={btn}
                      title="Open classic fullscreen countdown timer"
                      onClick={onStartCountdown}
                    >
                      ⏱ Timer
                    </button>
                  )}
                  {onMoveProject && projects && projects.length > 0 && !t.id.startsWith("tmp-") && (
                    <label className={`${btn} relative inline-flex cursor-pointer items-center`}>
                      <span>⇄ List</span>
                      <select
                        aria-label="Move to another list"
                        className="absolute inset-0 cursor-pointer opacity-0"
                        value=""
                        onChange={(e) => e.target.value && onMoveProject(t, e.target.value)}
                      >
                        <option value="" disabled>
                          Move to list…
                        </option>
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <button
                    className={`ml-auto text-[12px] ${
                      confirming ? "text-red-500" : "text-zinc-600 hover:text-zinc-400"
                    }`}
                    onClick={() => (confirming ? onDelete(t) : setConfirming(true))}
                  >
                    {confirming ? "Confirm delete" : "Delete"}
                  </button>
                </div>

                {!zen && (
                  <div className="flex items-center gap-2">
                    <input
                      value={note}
                      onChange={(e) => {
                        setNote(e.target.value);
                        scheduleFlush();
                      }}
                      placeholder="Next-step note…"
                      className="flex-1 rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1 text-[13px] text-zinc-200 outline-none placeholder:text-zinc-600"
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DurationChips({
  t,
  durations,
  defaultMinutes = 5,
  onDuration,
}: {
  t: Task;
  durations: number[];
  defaultMinutes?: number;
  onDuration: (t: Task, minutes: number) => void;
}) {
  // no explicit estimate: the chip matching the effective default shows as selected
  const effective = t.duration?.amount ?? defaultMinutes;
  return (
    <div className="flex gap-1">
      {durations.map((m) => (
        <button
          key={m}
          className={`rounded-md border px-2 py-0.5 font-mono text-[11px] tabular-nums transition-colors duration-150 ${
            effective === m
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
  inline,
  ocConnected = false,
  ocServers = [],
  ocServerOnlineById = {},
  ocModelsByServer = {},
  defaultServerId = "local",
  sections,
  onAdd,
}: {
  placeholder: string;
  hotkey?: string;
  alwaysOpen?: boolean;
  inline?: boolean;
  ocConnected?: boolean;
  ocServers?: OpenCodeServer[];
  ocServerOnlineById?: Record<string, boolean>;
  ocModelsByServer?: Record<string, OpenCodeModelOption[]>;
  defaultServerId?: string;
  sections: SectionMap;
  onAdd: (raw: string, extra?: AddExtra) => void;
}) {
  const [open, setOpen] = useState(!!alwaysOpen);
  const [v, setV] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [promptText, setPromptText] = useState("");
  const [pickedRepo, setPickedRepo] = useState("");
  const [pickedServerId, setPickedServerId] = useState(defaultServerId);
  const [pickedModel, setPickedModel] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setPickedServerId(defaultServerId);
  }, [defaultServerId]);

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

  const parsed = parseAdd(v, sections, ocServers);
  const effectiveServerId = parsed.server || (showDetails ? pickedServerId : defaultServerId);
  const activeSrvObj = ocServers.find((s) => s.id === effectiveServerId) ?? ocServers[0];
  const serverRepos = activeSrvObj?.repos?.length ? activeSrvObj.repos : KNOWN_REPOS;
  const serverModels = ocModelsByServer[effectiveServerId] ?? [];
  const defaultModelObj = serverModels.find((m) => m.isDefault);
  const effectiveRepo = parsed.repo || (showDetails ? pickedRepo : "");
  const isTargetServerOnline = ocServerOnlineById[effectiveServerId] ?? ocConnected;
  const targetLabel = effectiveRepo
    ? `${effectiveServerId}/${shortRepo(effectiveRepo)}`
    : effectiveServerId;

  const submit = (mode: "save" | "drive" | "agent" = "save") => {
    const raw = v.trim();
    if (!raw) return;
    const combinedPrompt = [parsed.prompt, promptText.trim()].filter(Boolean).join("\n");
    onAdd(raw, {
      repo: effectiveRepo || undefined,
      server: effectiveServerId || undefined,
      model: pickedModel || undefined,
      prompt: combinedPrompt || undefined,
      mode,
    });
    setV("");
    setPromptText("");
    setPickedModel("");
    if (!alwaysOpen) setShowDetails(false);
  };

  if (!open)
    return (
      <button
        className={`${inline ? "min-h-11 shrink-0" : "min-h-11 w-full"} rounded-md px-2 text-left text-[13px] text-zinc-600 transition-colors duration-150 hover:bg-zinc-900/50`}
        onClick={() => setOpen(true)}
      >
        {placeholder}
      </button>
    );
  return (
    <div
      className={
        inline
          ? "min-w-0 flex-1 py-1"
          : `mt-1.5 rounded-md border transition-colors ${
              showDetails || v.trim()
                ? "border-zinc-800 bg-zinc-900/60"
                : "border-transparent"
            }`
      }
    >
      <div className={`flex items-center gap-1.5 ${inline ? "" : "px-2.5 py-1.5"}`}>
        <input
          ref={inputRef}
          className={
            inline
              ? input
              : "min-w-0 flex-1 bg-transparent py-1 text-[14px] text-zinc-100 outline-none placeholder:text-zinc-600"
          }
          placeholder={placeholder}
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Tab" && !e.shiftKey && !inline && !showDetails && v.trim()) {
              e.preventDefault();
              setShowDetails(true);
              setTimeout(() => promptRef.current?.focus(), 20);
            } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit("agent");
            } else if (e.key === "Enter") {
              e.preventDefault();
              submit("save");
            } else if (e.key === "Escape") {
              setV("");
              setShowDetails(false);
              if (!alwaysOpen) setOpen(false);
            }
          }}
          onBlur={() => {
            if (!alwaysOpen && !showDetails && !v.trim()) setOpen(false);
          }}
        />
        {!inline && (
          <button
            type="button"
            onClick={() => setShowDetails((s) => !s)}
            className="shrink-0 rounded px-2 py-1 font-mono text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
            title="Choose execution server, project repo & prompt (Tab)"
          >
            {showDetails ? "Hide" : `${targetLabel} ▾`}
          </button>
        )}
      </div>

      {showDetails && !inline && (
        <div className="space-y-2.5 border-t border-zinc-800/70 px-3 pt-2.5 pb-3 text-[12px]">
          {/* Single Unified Server → Project Bar */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-zinc-500">Target:</span>
            {ocServers.map((s) => {
              const active = effectiveServerId === s.id;
              const online = ocServerOnlineById[s.id];
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    const nextRepos = s.repos?.length ? s.repos : KNOWN_REPOS;
                    setPickedServerId(s.id);
                    if (pickedRepo && !nextRepos.some((r) => r.label === pickedRepo)) {
                      setPickedRepo(nextRepos[0]?.label ?? "");
                    }
                  }}
                  className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 font-mono text-[11px] ${
                    active
                      ? "bg-zinc-200 font-medium text-zinc-950"
                      : "bg-zinc-800/70 text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      online
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
              <option value="">~ ({activeSrvObj?.defaultDir || "/Users/justinyu"})</option>
              {serverRepos.map((r) => (
                <option key={r.label} value={r.label}>
                  {shortRepo(r.label)} ({r.dir})
                </option>
              ))}
            </select>

            <span className="ml-auto text-zinc-500">Model:</span>
            <select
              aria-label="OpenCode model"
              value={pickedModel}
              onChange={(e) => setPickedModel(e.target.value)}
              className="max-w-52 truncate rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 font-mono text-[11px] text-zinc-200 outline-none"
            >
              <option value="">
                {defaultModelObj ? `Default (${defaultModelObj.name})` : "Default model"}
              </option>
              {serverModels.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.name} ({m.providerID})
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
                submit("agent");
              }
            }}
            placeholder={`Prompt for ${targetLabel}…`}
            className="w-full resize-none rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-[13px] leading-relaxed text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-700"
          />

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-[11px] text-zinc-500">
              {isTargetServerOnline
                ? `${effectiveServerId} online · ⌘Enter runs agent`
                : `${effectiveServerId} offline · ⌘Enter queues in Todoist`}
            </span>
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={() => submit("save")} className={btn}>
                Save task
              </button>
              <button
                type="button"
                onClick={() => submit("agent")}
                className="rounded bg-orange-600 px-3 py-1 text-[12px] font-medium text-white hover:bg-orange-500"
              >
                {isTargetServerOnline
                  ? `Run on ${targetLabel} ⌘↵`
                  : `Queue for ${targetLabel} ⌘↵`}
              </button>
            </div>
          </div>
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
  onResumeTask,
}: {
  tasks: Task[];
  sessions: Session[];
  archived: boolean;
  onArchiveAll: () => void;
  onResumeTask?: (t: Task) => void;
}) {
  const ts = sessions.filter((s) => new Date(s.timestamp).toDateString() === todayStr());
  const focused = ts.reduce((a, s) => a + s.actual_minutes, 0);
  const agentTotal = ts.reduce((a, s) => a + (s.agent_minutes ?? 0), 0);
  const completed = ts.filter((s) => s.completed).length;
  const actualFor = (id: string) => {
    const n = ts.filter((s) => s.task_id === id).reduce((a, s) => a + s.actual_minutes, 0);
    return n || null;
  };
  const agentFor = (id: string) => {
    const n = ts.filter((s) => s.task_id === id).reduce((a, s) => a + (s.agent_minutes ?? 0), 0);
    return n || null;
  };
  const ocSessionsFor = (t: Task) => {
    const fromDesc = parseTaskDescription(t.description).sessions;
    const fromLogs = ts
      .filter((s) => s.task_id === t.id)
      .flatMap((s) => s.opencode_sessions ?? []);
    return Array.from(new Set([...fromDesc, ...fromLogs]));
  };

  const stats: [string, string][] = [
    [`${focused}m`, "you driving today"],
    [`${agentTotal}m`, "agent runtime"],
    [String(completed), "completed"],
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
          Completed tasks appear here with their human driving time, agent runtime, and preserved OpenCode session links.
        </p>
      ) : (
        <>
          <table className="w-full table-fixed text-left">
            <thead>
              <tr className="border-b border-zinc-800 text-[13px] text-zinc-500">
                <th className="py-2 font-normal">Task</th>
                <th className="w-28 py-2 text-right font-normal">OpenCode</th>
                <th className="w-16 py-2 text-right font-normal">You</th>
                <th className="w-16 py-2 text-right font-normal">Agent</th>
                {onResumeTask && <th className="w-16 py-2 text-right font-normal"></th>}
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => {
                const a = actualFor(t.id);
                const ai = agentFor(t.id);
                const sids = ocSessionsFor(t);
                const lastSid = sids[sids.length - 1];
                return (
                  <tr key={t.id} className="border-b border-zinc-800/60">
                    <td className="truncate py-2 pr-2 text-[15px]" title={t.content}>
                      {t.content}
                    </td>
                    <td className="py-2 text-right font-mono text-[12px] text-zinc-400">
                      {lastSid ? (
                        <button
                          onClick={() => {
                            navigator.clipboard?.writeText(`opencode -s ${lastSid}`);
                          }}
                          title={`Copy "opencode -s ${lastSid}" to resume session in terminal`}
                          className="rounded border border-zinc-800 px-1.5 py-0.5 hover:border-zinc-700 hover:text-zinc-200"
                        >
                          {lastSid.slice(0, 8)} ↗
                        </button>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="py-2 text-right font-mono text-[13px] tabular-nums text-zinc-400">
                      {a != null ? `${a}m` : "—"}
                    </td>
                    <td className="py-2 text-right font-mono text-[13px] tabular-nums text-zinc-500">
                      {ai != null ? `${ai}m` : "—"}
                    </td>
                    {onResumeTask && (
                      <td className="py-2 text-right">
                        <button
                          onClick={() => onResumeTask(t)}
                          className="text-[12px] text-zinc-500 hover:text-orange-500"
                          title="Move back to Focus with linked OpenCode session history intact"
                        >
                          Resume
                        </button>
                      </td>
                    )}
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

function Analysis({ sessions, token }: { sessions: Session[]; token: string }) {
  const [range, setRange] = useState(() => load("tb_analysis_range", 30));
  const [apiDone, setApiDone] = useState<CompletedItem[] | null>(null);
  useEffect(() => {
    setApiDone(null);
    api(
      token,
      `/tasks/completed/by_completion_date?since=${new Date(Date.now() - range * 86400_000).toISOString()}&until=${new Date().toISOString()}&limit=200`,
    )
      .then((d) => setApiDone((d as { items?: CompletedItem[] }).items ?? []))
      .catch(() => setApiDone([]));
  }, [token, range]);

  const recent = sessions.filter((s) => s.timestamp >= Date.now() - range * 86400_000);
  const days: { key: string; label: string; focused: number; planned: number }[] = [];
  for (let i = range - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400_000);
    const key = d.toDateString();
    const ds = recent.filter((s) => new Date(s.timestamp).toDateString() === key);
    days.push({
      key,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      focused: ds.reduce((a, s) => a + s.actual_minutes, 0),
      planned: ds.reduce((a, s) => a + s.planned_minutes, 0),
    });
  }
  const focused = days.reduce((a, d) => a + d.focused, 0);
  const planned = days.reduce((a, d) => a + d.planned, 0);
  const accuracy = planned ? Math.round((focused / planned) * 100) : 0;
  const daysActive = days.filter((d) => d.focused > 0).length;
  // week-vs-week compares across all sessions so it still works on the 7d view
  const weekAgo = Date.now() - 7 * 86400_000;
  const thisWeek = sessions
    .filter((s) => s.timestamp >= weekAgo)
    .reduce((a, s) => a + s.actual_minutes, 0);
  const lastWeek = sessions
    .filter((s) => s.timestamp >= weekAgo - 7 * 86400_000 && s.timestamp < weekAgo)
    .reduce((a, s) => a + s.actual_minutes, 0);
  const delta = thisWeek - lastWeek;

  const byTask: Record<string, { p: number; a: number }> = {};
  for (const s of recent) {
    const e = (byTask[s.task_name] ??= { p: 0, a: 0 });
    e.p += s.planned_minutes;
    e.a += s.actual_minutes;
  }
  const overruns = Object.entries(byTask)
    .map(([name, v]) => ({ name, ...v, d: v.a - v.p }))
    .filter((t) => t.d > 0)
    .sort((a, b) => b.d - a.d)
    .slice(0, 5);

  const hours = new Array<number>(24).fill(0);
  for (const s of recent) hours[new Date(s.timestamp).getHours()] += s.actual_minutes;
  const maxH = Math.max(1, ...hours);
  const maxF = Math.max(1, ...days.map((d) => d.focused));

  // tasks completed in Todoist with no matching timer session that day
  const sessionKeys = new Set(
    recent.map((s) => `${new Date(s.timestamp).toDateString()}|${s.task_name}`),
  );
  const manual = (apiDone ?? []).filter(
    (c) => !sessionKeys.has(`${new Date(c.completed_at).toDateString()}|${c.content}`),
  );

  // daily accuracy (actual/planned %) line — the dashed 100% line = perfect estimate
  const accPts = days
    .map((d, i) => ({ i, acc: d.planned ? (d.focused / d.planned) * 100 : null }))
    .filter((p): p is { i: number; acc: number } => p.acc != null);
  const accLine = accPts
    .map(
      (p, j) =>
        `${j === 0 ? "M" : "L"}${((p.i / (range - 1)) * 100).toFixed(1)},${(40 - (Math.min(150, p.acc) / 150) * 40).toFixed(1)}`,
    )
    .join(" ");
  const refY = (40 - (100 / 150) * 40).toFixed(1);

  const h = "mb-2 text-[13px] font-medium text-zinc-500";
  return (
    <div className="space-y-8">
      <div className="flex justify-center gap-1">
        {[7, 30, 90].map((d) => (
          <button
            key={d}
            className={`rounded-md border px-3 py-1 font-mono text-[13px] ${
              range === d
                ? "border-zinc-600 text-zinc-200"
                : "border-zinc-800 text-zinc-500 hover:bg-zinc-800"
            }`}
            onClick={() => {
              setRange(d);
              save("tb_analysis_range", d);
            }}
          >
            {d}d
          </button>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-4 text-center">
        {(
          [
            [`${Math.floor(focused / 60)}h ${focused % 60}m`, `focused (${range} days)`],
            [String(daysActive), "days active"],
            [`${accuracy}%`, "planned vs actual"],
          ] as [string, string][]
        ).map(([v, l]) => (
          <div key={l}>
            <p className="font-mono text-[28px] font-semibold tabular-nums">{v}</p>
            <p className="text-[13px] text-zinc-500">{l}</p>
          </div>
        ))}
      </div>

      <p className="text-center text-[13px] text-zinc-500">
        This week <span className="font-mono tabular-nums text-zinc-300">{thisWeek}m</span> vs last
        week <span className="font-mono tabular-nums text-zinc-300">{lastWeek}m</span>{" "}
        <span className={delta >= 0 ? "text-orange-500" : "text-zinc-500"}>
          ({delta >= 0 ? "+" : ""}
          {delta}m)
        </span>
      </p>

      <section>
        <h2 className={h}>Focused minutes per day</h2>
        <div className="flex h-28 items-end gap-[3px]">
          {days.map((d) => (
            <div
              key={d.key}
              className={`flex-1 rounded-sm ${d.focused ? "bg-orange-500" : "bg-zinc-800"}`}
              style={{ height: `${Math.max(3, (d.focused / maxF) * 100)}%` }}
              title={`${d.label}: ${d.focused}m`}
            />
          ))}
        </div>
        <div className="mt-1 flex justify-between text-[11px] text-zinc-600">
          <span>{days[0]?.label}</span>
          <span>{days[days.length - 1]?.label}</span>
        </div>
      </section>

      {accPts.length >= 2 && (
        <section>
          <h2 className={h}>Estimate accuracy trend (100% = perfect)</h2>
          <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-24 w-full">
            <line
              x1="0"
              y1={refY}
              x2="100"
              y2={refY}
              stroke="#3f3f46"
              strokeWidth="0.3"
              strokeDasharray="1.5 1.5"
            />
            <path d={accLine} fill="none" stroke="#f97316" strokeWidth="0.8" />
          </svg>
        </section>
      )}

      <section>
        <h2 className={h}>Worst estimates (biggest overruns)</h2>
        {overruns.length === 0 ? (
          <p className="text-[13px] text-zinc-500">No overruns in the last {range} days. 🎯</p>
        ) : (
          <table className="w-full text-left">
            <tbody>
              {overruns.map((t) => (
                <tr key={t.name} className="border-b border-zinc-800/60">
                  <td className="py-2 pr-2 text-[14px]">{t.name}</td>
                  <td className="py-2 text-right font-mono text-[13px] tabular-nums text-zinc-500">
                    {t.p}m → {t.a}m
                  </td>
                  <td className="py-2 text-right font-mono text-[13px] tabular-nums text-orange-500">
                    +{t.d}m
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2 className={h}>When you focus (hour of day)</h2>
        <div className="flex h-20 items-end gap-[2px]">
          {hours.map((m, i) => (
            <div
              key={i}
              className={`flex-1 rounded-sm ${m ? "bg-zinc-400" : "bg-zinc-800"}`}
              style={{ height: `${Math.max(3, (m / maxH) * 100)}%` }}
              title={`${i}:00 — ${m}m`}
            />
          ))}
        </div>
        <div className="mt-1 flex justify-between text-[11px] text-zinc-600">
          <span>0:00</span>
          <span>6:00</span>
          <span>12:00</span>
          <span>18:00</span>
          <span>24:00</span>
        </div>
      </section>

      <section>
        <h2 className={h}>Completed without a timer (from Todoist)</h2>
        {apiDone === null ? (
          <p className="text-[13px] text-zinc-500">Loading…</p>
        ) : manual.length === 0 ? (
          <p className="text-[13px] text-zinc-500">Everything completed was timeboxed. ✓</p>
        ) : (
          <>
            <p className="mb-2 text-[13px] text-zinc-500">
              {manual.length} task{manual.length === 1 ? "" : "s"} completed outside a timebox:
            </p>
            <ul className="space-y-1">
              {manual.slice(0, 10).map((c) => (
                <li key={c.id} className="flex justify-between gap-2 text-[14px]">
                  <span className="truncate">{c.content}</span>
                  <span className="shrink-0 font-mono text-[13px] text-zinc-500">
                    {new Date(c.completed_at).toLocaleDateString(undefined, {
                      month: "numeric",
                      day: "numeric",
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
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

// an unanswered "time's up" rings again after this long, then auto-stops (seconds)
const AUTO_STOP_SEC = 5 * 60;

function Timer({
  task,
  minutes,
  gentle = false,
  onExit,
  onLog,
  onComplete,
  onTick,
  onUpdate,
}: {
  task: Task;
  minutes: number;
  gentle?: boolean;
  onExit: () => void;
  onLog: (s: Session) => void;
  onComplete: () => void;
  onTick?: (sec: number) => void;
  onUpdate?: (id: string, fields: { content?: string; description?: string }) => Promise<void>;
}) {
  const [left, setLeft] = useState(minutes * 60);
  const [paused, setPaused] = useState(false);
  const [timesUp, setTimesUp] = useState(false);
  const [waited, setWaited] = useState(0); // minutes sat in the time-up dialog
  const [over, setOver] = useState(0); // seconds past the planned end
  const endRef = useRef(Date.now() + minutes * 60_000);
  const elapsedRef = useRef(0); // seconds actually run
  const totalRef = useRef(minutes * 60);
  const alarmedRef = useRef(false);
  const autoStoppedRef = useRef(false);
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;
  // assigned below logAndExit so the interval can trigger the walk-away auto-stop
  const stopRef = useRef<() => void>(() => {});
  const completeRef = useRef<() => void>(() => {}); // device "mark complete" event

  const canNotify = typeof Notification !== "undefined";

  useEffect(() => {
    if (canNotify && Notification.permission === "default") Notification.requestPermission();
    deviceStart(task, minutes, endRef.current);
    const hb = setInterval(() => deviceUpdate(endRef.current), 10_000); // device heartbeat-timeout is 25s
    const ev = setInterval(async () => {
      for (const e of await deviceEvents()) {
        if (e.type === "extend") extend(e.minutes ?? 5); // device right-half tap
        else if (e.type === "complete") completeRef.current(); // device right-half hold
        else stopRef.current(); // device left-half hold → log & stop
      }
    }, 5000);
    const iv = setInterval(() => {
      if (pausedRef.current) return; // ref, not state — pausing must not re-run this effect (it would deviceStop/deviceStart churn)
      const now = Date.now();
      const rem = Math.max(0, (endRef.current - now) / 1000);
      const ov = Math.max(0, (now - endRef.current) / 1000); // overrun past planned end
      if (alarmedRef.current) setWaited(Math.max(1, Math.ceil((now - endRef.current) / 60000)));
      elapsedRef.current += 0.25;
      onTickRef.current?.(0.25);
      setLeft(rem);
      setOver(ov);
      document.title = ov > 0 ? `+${fmt(ov)} - ${task.content}` : `${fmt(rem)} - ${task.content}`;
      if (rem <= 0 && !alarmedRef.current) {
        alarmedRef.current = true;
        if (canNotify && Notification.permission === "granted") {
          const n = new Notification("Time's up!", { body: task.content });
          n.onclick = () => window.focus();
        }
        if (!gentle) {
          alarm();
          document.body.classList.add("flash");
          setTimeout(() => document.body.classList.remove("flash"), 4000);
          setTimesUp(true);
        }
      }
      // unanswered time-up = user probably walked away: ring once more, then log & stop
      if (ov >= AUTO_STOP_SEC && !autoStoppedRef.current) {
        autoStoppedRef.current = true;
        if (!gentle) alarm();
        stopRef.current();
      }
    }, 250);
    return () => {
      clearInterval(iv);
      clearInterval(hb);
      clearInterval(ev);
      deviceStop();
      document.title = "Timebox Focus";
    };
  }, [task.content, gentle]);

  const extend = (m: number) => {
    endRef.current = Math.max(endRef.current, Date.now()) + m * 60_000;
    deviceUpdate(endRef.current);
    totalRef.current += m * 60;
    alarmedRef.current = false;
    autoStoppedRef.current = false;
    setTimesUp(false);
    setWaited(0);
    setOver(0);
    setLeft((endRef.current - Date.now()) / 1000);
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input,textarea")) return; // typing in notes
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
  const pausedRef = useRef(false);
  useEffect(() => {
    pausedRef.current = paused;
    if (paused) {
      document.title = `⏸ paused - ${task.content}`;
      pauseStarted.current = Date.now();
      deviceSetPaused(true, endRef.current); // device freezes its digits at end − now
    } else if (pauseStarted.current) {
      endRef.current += Date.now() - pauseStarted.current;
      pauseStarted.current = 0;
      deviceSetPaused(false, endRef.current); // device thaws at the shifted end
    }
  }, [paused, task.content]);

  const frac = Math.max(0, left / totalRef.current);

  const logAndExit = (completed: boolean) => {
    const secs = elapsedRef.current;
    onLog({
      task_id: task.id,
      task_name: task.content,
      planned_minutes: minutes,
      // any real run counts at least 1m — Math.round(29s) -> 0 would erase the effort
      actual_minutes: secs > 0 ? Math.max(1, Math.round(secs / 60)) : 0,
      completed,
      timestamp: Date.now(),
    });
  };
  stopRef.current = () => {
    logAndExit(false); // auto-stop logs as abandoned; overrun is still counted in actual_minutes
    onExit();
  };
  completeRef.current = () => {
    logAndExit(true); // device mark complete — same path as the button
    onComplete();
  };

  const tbtn =
    "min-h-12 rounded-md px-3 py-3 text-[13px] text-zinc-400 transition-colors duration-150 hover:bg-zinc-800 hover:text-zinc-200";

  // notes editor — same debounced persistence as the task list's RowEditor
  const [notesOpen, setNotesOpen] = useState(false);
  const [title, setTitle] = useState(task.content);
  const [desc, setDesc] = useState(task.description ?? "");
  const [saveState, setSaveState] = useState<"" | "saving" | "saved">("");
  const titleLive = useRef(title);
  titleLive.current = title;
  const descLive = useRef(desc);
  descLive.current = desc;
  const debRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const persist = async (fields: { content?: string; description?: string }) => {
    if (!onUpdate) return;
    setSaveState("saving");
    clearTimeout(savedTimer.current);
    try {
      await onUpdate(task.id, fields);
      setSaveState("saved");
      savedTimer.current = setTimeout(() => setSaveState(""), 1000);
    } catch {
      setSaveState(""); // rollback toast already shown by onUpdate
    }
  };
  const flush = () => {
    clearTimeout(debRef.current);
    const v = titleLive.current.trim();
    if (v && v !== task.content) persist({ content: v });
    if (descLive.current !== (task.description ?? "")) persist({ description: descLive.current });
  };
  useEffect(() => () => flush(), []);

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center gap-6 overflow-hidden px-4 py-8">
      <button
        aria-label="Exit timer"
        className="absolute top-4 right-4 z-10 flex h-11 w-11 items-center justify-center rounded-md text-[20px] text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
        onClick={() => {
          logAndExit(false);
          onExit();
        }}
      >
        ✕
      </button>
      <h2
        className={`max-w-3xl text-center text-[20px] ${paused ? "text-zinc-600" : "text-zinc-400"}`}
      >
        {task.content}
      </h2>
      {onUpdate && (
        <button
          className={`-mt-3 text-[12px] transition-colors ${
            notesOpen || task.description ? "text-orange-500" : "text-zinc-600 hover:text-zinc-400"
          }`}
          onClick={() => setNotesOpen((o) => !o)}
        >
          {notesOpen ? "Hide notes" : task.description ? "View notes" : "Add notes"}
        </button>
      )}
      {notesOpen && (
        <div className="w-full max-w-md space-y-2 rounded-md border border-zinc-800 bg-zinc-900 p-3">
          <div className="flex items-center gap-2">
            <input
              className="min-w-0 flex-1 bg-transparent p-0 text-[15px] outline-none"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                clearTimeout(debRef.current);
                debRef.current = setTimeout(flush, 500);
              }}
            />
            {saveState && (
              <span className="shrink-0 text-[12px] text-zinc-500">
                {saveState === "saving" ? "Saving…" : "Saved ✓"}
              </span>
            )}
          </div>
          <div className="border-t border-zinc-800" />
          <textarea
            className="w-full resize-none bg-transparent font-mono text-[12px] leading-snug text-zinc-400 outline-none placeholder:text-zinc-600"
            placeholder="Add notes…"
            rows={3}
            value={desc}
            onChange={(e) => {
              setDesc(e.target.value);
              clearTimeout(debRef.current);
              debRef.current = setTimeout(flush, 500);
            }}
          />
        </div>
      )}
      <div className="relative flex items-center justify-center">
        <div className="fixed inset-x-0 top-0 h-0.5 bg-zinc-800">
          <div
            className={`h-full transition-[width] duration-150 ${paused ? "bg-zinc-700" : "bg-orange-500"}`}
            style={{ width: `${frac * 100}%` }}
          />
        </div>
        <button
          className={`relative rounded-full p-[5vmin] font-mono text-[min(19vh,23vw)] leading-none font-bold tabular-nums outline-none transition-colors duration-150 ${
            paused ? "text-zinc-600" : frac <= 0.1 ? "text-orange-500" : "text-zinc-100 hover:bg-zinc-900/60 active:bg-zinc-800/60"
          }`}
          title={paused ? "Resume (Space)" : "Pause (Space)"}
          aria-label={paused ? "Resume timer" : "Pause timer"}
          aria-pressed={paused}
          onClick={() => setPaused((p) => !p)}
        >
          {over > 0 ? `+${fmt(over)}` : fmt(left)}
        </button>
        {paused && (
          <span
            className="pointer-events-none absolute -bottom-[6vmin] left-1/2 -translate-x-1/2 animate-pulse rounded-md border border-zinc-600 bg-zinc-800 px-4 py-1.5 text-[13px] font-medium tracking-wide whitespace-nowrap text-zinc-200 uppercase"
            aria-label="Paused"
          >
            ⏸ Paused
          </span>
        )}
      </div>
      <div className="flex w-full max-w-xs flex-col gap-2 px-6 sm:w-auto sm:max-w-none sm:flex-row">
        <button className={tbtn} onClick={() => extend(5)}>
          +5 min
        </button>
        <button
          className={`${tbtn} text-orange-500`}
          onClick={() => {
            logAndExit(true);
            onComplete();
          }}
        >
          Complete ✓
        </button>
        <button
          className={tbtn}
          onClick={() => {
            logAndExit(false);
            onExit();
          }}
        >
          Not done — log & stop
        </button>
      </div>

      {timesUp && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-zinc-950/80">
          <div className="w-full max-w-xs space-y-2 rounded-md border border-zinc-800 bg-zinc-900 p-6">
            <div className="mb-4">
              <h3 className="text-[20px] font-semibold">Time's up!</h3>
              <p className="mt-1 font-mono text-[13px] tabular-nums text-orange-500">
                +{fmt(over)} over — auto-stops at +{fmt(AUTO_STOP_SEC)}
              </p>
            </div>
            <button
              className={`${tbtn} block w-full text-orange-500`}
              onClick={() => {
                logAndExit(true);
                onComplete();
              }}
            >
              Mark complete
            </button>
            <div className="flex gap-2">
              <button className={`${tbtn} flex-1`} onClick={() => extend(5)}>
                +5 min
              </button>
              {waited > 5 && (
                <button className={`${tbtn} flex-1`} onClick={() => extend(waited)}>
                  +{waited} min (waited)
                </button>
              )}
            </div>
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
      <h3 className="mt-6 mb-2 text-[13px] font-semibold text-zinc-300">Shortcuts</h3>
      <ul className="space-y-1 font-mono text-[12px] text-zinc-400">
        <li><kbd className="text-zinc-200">?</kbd> — this panel</li>
        <li><kbd className="text-zinc-200">N</kbd> — add to Focus</li>
        <li><kbd className="text-zinc-200">B</kbd> — quick add to Buffer</li>
        <li><kbd className="text-zinc-200">⌘E</kbd> / <kbd className="text-zinc-200">F</kbd> — full-screen Zen mode on expanded task</li>
        <li><kbd className="text-zinc-200">Space</kbd> — pause timer · <kbd className="text-zinc-200">Enter</kbd> — complete · <kbd className="text-zinc-200">Esc</kbd> — exit</li>
      </ul>
    </aside>
  );
}

function SettingsPage({
  prefs,
  onPrefs,
  ocConfig,
  onOcConfig,
  ocConnected,
  ocServerOnlineById,
  ocVerifyById,
  ocVerifying,
  onVerifyOpenCode,
  queuedCount,
  onRunQueued,
  mappingProps,
  onViewGuide,
  onTheory,
  onReset,
  token,
  projectId,
  onProject,
  unsynced,
  onSyncComments,
}: {
  prefs: Prefs;
  onPrefs: (p: Partial<Prefs>) => void;
  ocConfig: OpenCodeConfig;
  onOcConfig: (p: Partial<OpenCodeConfig>) => void;
  ocConnected: boolean;
  ocServerOnlineById: Record<string, boolean>;
  ocVerifyById: Record<string, OpenCodeVerifyResult>;
  ocVerifying: boolean;
  onVerifyOpenCode: () => void;
  queuedCount: number;
  onRunQueued: () => void;
  mappingProps: MappingProps;
  onViewGuide: () => void;
  onTheory: () => void;
  onReset: () => void;
  token: string;
  projectId: string;
  onProject: (id: string) => void;
  unsynced: number;
  onSyncComments: () => void;
}) {
  const [editingSrvId, setEditingSrvId] = useState<string | null>(null);
  const [newRepoLabel, setNewRepoLabel] = useState("");
  const [newRepoDir, setNewRepoDir] = useState("");
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  const [newEndpoint, setNewEndpoint] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newDir, setNewDir] = useState("/Users/justinyu");
  const [showAddServer, setShowAddServer] = useState(false);

  const h = "mb-2 text-[13px] font-medium text-zinc-500";
  const row = "flex items-center justify-between gap-4 py-2";
  const toggle = (on: boolean) =>
    `relative h-6 w-10 shrink-0 rounded-full transition-colors ${on ? "bg-orange-500" : "bg-zinc-700"}`;

  const updateServerField = (srvId: string, patch: Partial<OpenCodeServer>) => {
    const nextServers = ocConfig.servers.map((s) =>
      s.id === srvId ? { ...s, ...patch } : s,
    );
    onOcConfig({ servers: nextServers });
  };

  const removeServer = (srvId: string) => {
    if (ocConfig.servers.length <= 1) return;
    const nextServers = ocConfig.servers.filter((s) => s.id !== srvId);
    const nextDefault =
      ocConfig.defaultServerId === srvId ? nextServers[0].id : ocConfig.defaultServerId;
    onOcConfig({ servers: nextServers, defaultServerId: nextDefault });
  };

  const addServer = () => {
    const cleanId = newId.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "");
    if (!cleanId || ocConfig.servers.some((s) => s.id === cleanId)) return;
    const dir = newDir.trim() || "/Users/justinyu";
    const srv: OpenCodeServer = {
      id: cleanId,
      name: newName.trim() || cleanId,
      endpoint: newEndpoint.trim(),
      password: newPassword.trim(),
      defaultDir: dir,
      repos: [],
      enabled: true,
    };
    onOcConfig({ servers: [...ocConfig.servers, srv] });
    setNewId("");
    setNewName("");
    setNewEndpoint("");
    setNewPassword("");
    setShowAddServer(false);
    setEditingSrvId(cleanId);
  };

  return (
    <div className="w-full space-y-8">
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-[14px] font-semibold text-zinc-100">
              Execution Servers &amp; Projects
            </h2>
            <p className="text-[12px] text-zinc-500">
              Each server carries its own projects, endpoint, and workspace path.
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <a
              href="?mock=1"
              className="rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[12px] text-zinc-300 hover:border-zinc-700 hover:text-zinc-100"
              title="Open interactive Multi-Server Flight Deck mockup"
            >
              Mockup ↗
            </a>
            <button
              type="button"
              disabled={ocVerifying}
              onClick={onVerifyOpenCode}
              className="rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[12px] font-medium text-orange-400 hover:border-zinc-700 disabled:opacity-50"
            >
              {ocVerifying ? "Verifying…" : "Verify all"}
            </button>
          </div>
        </div>

        {queuedCount > 0 && (
          <div className="flex items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-zinc-900/90 px-3 py-2 text-[12px] text-amber-300">
            <span>
              ⏳ {queuedCount} task{queuedCount === 1 ? "" : "s"} queued in Todoist
            </span>
            {ocConnected && (
              <button
                type="button"
                onClick={onRunQueued}
                className="rounded bg-orange-600 px-2.5 py-0.5 text-[11px] font-medium text-white hover:bg-orange-500"
              >
                ▶ Run now
              </button>
            )}
          </div>
        )}

        {/* Server Fleet List — Clean Collapsed Cards by Default */}
        <ul className="space-y-2.5">
          {ocConfig.servers.map((srv) => {
            const vRes = ocVerifyById[srv.id];
            const isOnline = ocServerOnlineById[srv.id] ?? vRes?.ok ?? false;
            const isDefault = ocConfig.defaultServerId === srv.id;
            const isEditing = editingSrvId === srv.id;
            const resolvedBase = resolveOpenCodeBase(srv.endpoint);
            const srvRepos = srv.repos ?? [];

            return (
              <li
                key={srv.id}
                className="rounded-md border border-zinc-800/90 bg-zinc-900/40 p-3.5 text-[13px]"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        ocVerifying
                          ? "bg-orange-400 animate-ping"
                          : isOnline
                            ? "bg-orange-500"
                            : "bg-zinc-600"
                      }`}
                    />
                    <span className="font-medium text-zinc-100">{srv.name}</span>
                    <span className="font-mono text-[12px] text-zinc-500">~{srv.id}</span>
                    {isDefault && (
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                        default
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2.5 text-[12px]">
                    <span
                      className={`font-mono text-[11px] ${
                        vRes?.ok ? "text-orange-400" : "text-zinc-500"
                      }`}
                    >
                      {vRes?.ok
                        ? `${vRes.latencyMs}ms · ${vRes.sessionCount} ses`
                        : "offline"}
                    </span>
                    {!isDefault && (
                      <button
                        type="button"
                        onClick={() => onOcConfig({ defaultServerId: srv.id })}
                        className="text-zinc-500 hover:text-zinc-300"
                      >
                        Set default
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setEditingSrvId(isEditing ? null : srv.id)}
                      className="text-zinc-400 hover:text-zinc-100"
                    >
                      {isEditing ? "Done" : "Edit"}
                    </button>
                  </div>
                </div>

                <div className="mt-1 font-mono text-[11px] text-zinc-500">
                  {resolvedBase}
                  {!srv.endpoint.trim() && resolvedBase === "/opencode-api" ? " (local bridge)" : ""} ·{" "}
                  {srv.defaultDir || "/Users/justinyu"}
                </div>

                {vRes && !vRes.ok && vRes.error && (
                  <p className="mt-2 rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 font-mono text-[11px] text-zinc-400">
                    {vRes.error}
                  </p>
                )}

                {/* Associated Projects / Repos */}
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  <span className="mr-0.5 text-[11px] text-zinc-500">Projects:</span>
                  {srvRepos.length === 0 ? (
                    <span className="font-mono text-[11px] text-zinc-600">
                      ~ ({srv.defaultDir || "/Users/justinyu"})
                    </span>
                  ) : (
                    srvRepos.map((r) => (
                      <span
                        key={r.label}
                        title={r.dir}
                        className="inline-flex items-center gap-1 rounded border border-zinc-800/80 bg-zinc-950/60 px-2 py-0.5 font-mono text-[11px] text-zinc-300"
                      >
                        {shortRepo(r.label)}
                        {isEditing && (
                          <button
                            type="button"
                            onClick={() =>
                              updateServerField(srv.id, {
                                repos: srvRepos.filter((x) => x.label !== r.label),
                              })
                            }
                            className="ml-0.5 text-zinc-500 hover:text-red-400"
                            title={`Remove ${r.label}`}
                          >
                            ×
                          </button>
                        )}
                      </span>
                    ))
                  )}
                </div>

                {/* Collapsible Edit Drawer */}
                {isEditing && (
                  <div className="mt-3 space-y-2.5 border-t border-zinc-800/80 pt-3 text-[12px]">
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-[11px] text-zinc-500">
                          Endpoint URL (empty = local bridge)
                        </label>
                        <input
                          className={`${input} py-1.5 font-mono text-[12px]`}
                          placeholder="http://127.0.0.1:49374/api or http://127.0.0.1:5173/opencode-api"
                          value={srv.endpoint}
                          onChange={(e) => {
                            updateServerField(srv.id, { endpoint: e.target.value.trim() });
                          }}
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[11px] text-zinc-500">
                          Default Workspace Path
                        </label>
                        <input
                          className={`${input} py-1.5 font-mono text-[12px]`}
                          placeholder="/Users/justinyu"
                          value={srv.defaultDir ?? "/Users/justinyu"}
                          onChange={(e) => {
                            updateServerField(srv.id, {
                              defaultDir: e.target.value.trim() || "/Users/justinyu",
                            });
                          }}
                        />
                      </div>
                    </div>

                    <div>
                      <label className="mb-1 block text-[11px] text-zinc-500">
                        Basic Auth Password (optional)
                      </label>
                      <input
                        type="password"
                        className={`${input} py-1.5 font-mono text-[12px]`}
                        placeholder="Paste password from ~/.config/opencode/service.json"
                        value={srv.password ?? ""}
                        onChange={(e) => {
                          updateServerField(srv.id, { password: e.target.value.trim() });
                        }}
                      />
                    </div>

                    {/* Add Project / Repo to this Server */}
                    <div className="space-y-1.5 pt-1">
                      <label className="block text-[11px] text-zinc-500">
                        Add project / repo to ~{srv.id}
                      </label>
                      <div className="flex gap-1.5">
                        <input
                          value={newRepoLabel}
                          onChange={(e) => setNewRepoLabel(e.target.value)}
                          placeholder="Name (e.g. vyond/devops)"
                          className="w-36 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600"
                        />
                        <input
                          value={newRepoDir}
                          onChange={(e) => setNewRepoDir(e.target.value)}
                          placeholder={`Path (e.g. ${srv.defaultDir || "/workspace"}/devops)`}
                          className="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const lbl = newRepoLabel.trim();
                            if (!lbl) return;
                            const dir =
                              newRepoDir.trim() ||
                              `${(srv.defaultDir || "/workspace").replace(/\/+$/, "")}/${shortRepo(lbl)}`;
                            updateServerField(srv.id, {
                              repos: [...srvRepos.filter((x) => x.label !== lbl), { label: lbl, dir }],
                            });
                            setNewRepoLabel("");
                            setNewRepoDir("");
                          }}
                          className="shrink-0 rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-[12px] text-zinc-200 hover:bg-zinc-700"
                        >
                          ＋ Add
                        </button>
                      </div>
                    </div>

                    {ocConfig.servers.length > 1 && (
                      <div className="flex justify-end pt-1">
                        <button
                          type="button"
                          onClick={() => removeServer(srv.id)}
                          className="text-[12px] text-red-400 hover:text-red-300"
                        >
                          Remove server
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {/* Add Server Node Drawer */}
        {!showAddServer ? (
          <button
            type="button"
            onClick={() => setShowAddServer(true)}
            className="w-full rounded-md border border-dashed border-zinc-800 py-2 text-[12px] text-zinc-400 hover:border-zinc-700 hover:bg-zinc-900/50 hover:text-zinc-200"
          >
            ＋ Add execution server
          </button>
        ) : (
          <div className="space-y-2 rounded-md border border-zinc-800 bg-zinc-900/60 p-3 text-[12px]">
            <div className="flex items-center justify-between">
              <span className="font-medium text-zinc-300">New Execution Server</span>
              <button
                type="button"
                onClick={() => setShowAddServer(false)}
                className="text-zinc-500 hover:text-zinc-300"
              >
                Cancel
              </button>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input
                className={`${input} py-1.5 font-mono text-[12px]`}
                placeholder="ID slug (e.g. gpu-box)"
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
              />
              <input
                className={`${input} py-1.5 text-[12px]`}
                placeholder="Display name (e.g. GPU Server)"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            <input
              className={`${input} py-1.5 font-mono text-[12px]`}
              placeholder="Endpoint URL (e.g. https://gpu.ts.net/api)"
              value={newEndpoint}
              onChange={(e) => setNewEndpoint(e.target.value)}
            />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input
                className={`${input} py-1.5 font-mono text-[12px]`}
                placeholder="Default dir (/workspace)"
                value={newDir}
                onChange={(e) => setNewDir(e.target.value)}
              />
              <input
                type="password"
                className={`${input} py-1.5 font-mono text-[12px]`}
                placeholder="Basic Auth password (optional)"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={addServer}
                disabled={!newId.trim()}
                className="rounded bg-orange-600 px-3 py-1 text-[12px] font-medium text-white hover:bg-orange-500 disabled:opacity-40"
              >
                Save Server
              </button>
            </div>
          </div>
        )}

        {/* Auto-run queued tasks */}
        <div className={row}>
          <div>
            <span className="text-[14px]">Auto-run queued tasks when server connects</span>
            <p className="text-[12px] text-zinc-500">
              Automatically launch tasks tagged <code className="font-mono">queue=1</code> once
              their assigned server is online.
            </p>
          </div>
          <button
            className={toggle(ocConfig.autoRunQueued)}
            onClick={() => onOcConfig({ autoRunQueued: !ocConfig.autoRunQueued })}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${ocConfig.autoRunQueued ? "left-4.5" : "left-0.5"}`}
            />
          </button>
        </div>
      </section>

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
        <input
          className={input}
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          defaultValue={prefs.focusCap}
          onBlur={(e) => {
            const n = parseInt(e.target.value, 10);
            const valid = Number.isFinite(n) && n >= 1;
            const cap = valid ? n : 3;
            if (!valid) e.target.value = String(cap);
            if (cap !== prefs.focusCap) onPrefs({ focusCap: cap });
          }}
        />
        <p className="mt-1 text-[12px] text-zinc-600">
          Any positive number. Defaults to 3 if left empty or invalid.
        </p>
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
        <h2 className={h}>ESP32 companion display</h2>
        <div className={row}>
          <span className="text-[14px]">Trigger device over LAN</span>
          <button
            className={toggle(prefs.deviceOn)}
            onClick={() => onPrefs({ deviceOn: !prefs.deviceOn })}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${prefs.deviceOn ? "left-4.5" : "left-0.5"}`}
            />
          </button>
        </div>
        <div className={row}>
          <span className="text-[14px]">Screen off after</span>
          <div className="flex gap-1">
            {[1, 5, 15, 30, 0].map((m) => (
              <button
                key={m}
                className={`rounded-md border px-3 py-1 text-[13px] ${
                  prefs.screenOffMin === m
                    ? "border-zinc-600 text-zinc-200"
                    : "border-zinc-800 text-zinc-500 hover:bg-zinc-800"
                }`}
                onClick={() => onPrefs({ screenOffMin: m })}
              >
                {m === 0 ? "Never" : `${m}m`}
              </button>
            ))}
          </div>
        </div>
        <p className="text-[12px] text-zinc-600">
          Big-digit countdown on the desk display while a timer runs. Connects
          over USB (Web Serial — Chrome/Edge). Plug the display in; the first
          time you start a timer, pick its USB serial port in the browser
          dialog (see docs/firmware-v2.md). Off by default.
        </p>
      </section>
      <section>
        <h2 className={h}>Todoist sync</h2>
        <div className={row}>
          <span className="text-[14px]">Timer logs → task comments</span>
          <button
            className={`${btn} text-orange-500 disabled:opacity-40`}
            disabled={unsynced === 0}
            onClick={onSyncComments}
          >
            {unsynced ? `Sync ${unsynced}` : "All synced ✓"}
          </button>
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

function ProjectChips({
  projects: chips,
  projectId,
  onProject,
}: {
  projects: Project[];
  projectId: string;
  onProject: (id: string) => void;
}) {
  if (chips.length < 2) return null;
  return (
    <div className="border-t border-zinc-900 bg-zinc-950/60">
      <div className="mx-auto flex w-full max-w-5xl items-center gap-1 overflow-x-auto px-4 py-1.5 sm:px-6 lg:px-8">
        <span className="mr-1 shrink-0 font-mono text-[11px] text-zinc-600">
          List:
        </span>
        {chips.map((p) => (
          <button
            key={p.id}
            title={`Switch to ${p.name}`}
            className={`max-w-40 shrink-0 truncate rounded px-2.5 py-0.5 text-[12px] ${
              p.id === projectId
                ? "bg-zinc-800 font-medium text-zinc-100"
                : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
            }`}
            onClick={() => p.id !== projectId && onProject(p.id)}
          >
            {p.name}
          </button>
        ))}
      </div>
    </div>
  );
}
