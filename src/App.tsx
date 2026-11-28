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
  extractJiraKey,
  fetchAssignedJiraIssues,
  fetchOpenCodeSessionSummary,
  fetchOpenCodeSnapshot,
  fetchServerProjects,
  findMatchingSessionsForJira,
  formatTaskDescription,
  getOpenCodeEventUrl,
  getOpenCodeWebUrl,
  interruptOpenCodeSession,
  invalidateSessionSummary,
  KNOWN_REPOS,
  loadCachedJiraIssues,
  loadOpenCodeConfig,
  mergeRepos,
  parseTaskDescription,
  pathToRepoLabel,
  renameOpenCodeSession,
  replyOpenCodeForm,
  replyOpenCodePermission,
  resolveOpenCodeBase,
  resolveRepoDir,
  resolveServer,
  saveOpenCodeConfig,
  sendOpenCodePrompt,
  shortModelLabel,
  suggestBacklogTasks,
  switchOpenCodeSessionModel,
  syncSessionToJiraIssue,
  verifyAllOpenCodeServers,
  type BacklogSignal,
  type BacklogSuggestion,
  type JiraAssignedIssue,
  type JiraPullResult,
  type OpenCodeConfig,
  type OpenCodeFormRequest,
  type OpenCodeLiveSession,
  type OpenCodeModelOption,
  type OpenCodeRepo,
  type OpenCodeServer,
  type OpenCodeVerifyResult,
  type SessionFileDiff,
  type SessionStepItem,
  type SessionSummary,
  type SessionTurn,
  type TaskMeta,
  type TriageResult,
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
  project_id?: string | null;
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
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    osc.start();
    osc.stop(ctx.currentTime + 1.5);
  } catch {
    /* audio context not supported or requires interaction */
  }
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
function parseAdd(
  raw: string,
  sections: SectionMap,
  servers?: OpenCodeServer[],
  projectsByServer?: Record<string, OpenCodeRepo[]>,
) {
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
  const discovered =
    (server && projectsByServer?.[server]) ||
    (activeSrv && projectsByServer?.[activeSrv.id]) ||
    [];
  const candidateRepos = mergeRepos(activeSrv?.repos?.length ? activeSrv.repos : KNOWN_REPOS, discovered);
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
  const tmpIdMapRef = useRef<Map<string, string>>(new Map());
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
  const [ocProjectsByServer, setOcProjectsByServer] = useState<Record<string, OpenCodeRepo[]>>({});
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
      setOcProjectsByServer((prev) => ({ ...prev, ...snap.projectsByServer }));
    }
  }, []);

  const verifyDebounceRef = useRef<number | null>(null);

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
        // Sync React state only if discoverLocalBridge() actually changed saved config in localStorage
        setOcConfig((cur) => {
          const fresh = loadOpenCodeConfig();
          return JSON.stringify(fresh) === JSON.stringify(cur) ? cur : fresh;
        });
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
        if (verifyDebounceRef.current) {
          window.clearTimeout(verifyDebounceRef.current);
        }
        verifyDebounceRef.current = window.setTimeout(() => {
          void runVerifyOpenCode(next);
        }, 400);
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
  }, [token, projectId, syncOpenCode, runVerifyOpenCode, ocConfig.defaultServerId]);

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
      if (!pendingWrites && Date.now() - lastWriteAt > 2000) {
        const fetched = arr<Task>(ts);
        setTasks((prev) => {
          const prevById = new Map(prev.map((x) => [x.id, x]));
          const tmpTasks = prev.filter((x) => x.id.startsWith("tmp-"));
          const merged = fetched.map((remoteTask) => {
            const localTask = prevById.get(remoteTask.id);
            if (!localTask) return remoteTask;
            const localMeta = parseTaskDescription(localTask.description);
            const remoteMeta = parseTaskDescription(remoteTask.description);
            if (localMeta.sessions.length > 0 && remoteMeta.sessions.length === 0) {
              return {
                ...remoteTask,
                description: formatTaskDescription({
                  ...remoteMeta,
                  jira: remoteMeta.jira || localMeta.jira,
                  server: remoteMeta.server || localMeta.server,
                  model: remoteMeta.model || localMeta.model,
                  repo: remoteMeta.repo || localMeta.repo,
                  sessions: localMeta.sessions,
                }),
              };
            }
            return remoteTask;
          });
          return [...merged, ...tmpTasks];
        });
      }
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

  const refreshProjectsForServer = useCallback(async (serverId: string) => {
    const srv = ocConfig.servers.find((s) => s.id === serverId);
    if (!srv) return [];
    try {
      const discovered = await fetchServerProjects(srv, true);
      setOcProjectsByServer((prev) => ({ ...prev, [serverId]: discovered }));
      showToast(`Refreshed ${discovered.length} projects on ~${serverId}`);
      return discovered;
    } catch {
      showToast(`Failed to refresh projects on ~${serverId}`);
      return [];
    }
  }, [ocConfig.servers]);

  const addProjectToServer = useCallback(
    (serverId: string, label: string, dir: string) => {
      const srv = ocConfig.servers.find((s) => s.id === serverId);
      if (!srv) return;
      const existing = srv.repos ?? [];
      const cleanDir = dir.trim();
      if (!cleanDir) return;
      const cleanLabel = label.trim() || pathToRepoLabel(cleanDir, srv.defaultDir);
      const nextRepos = [
        ...existing.filter((x) => x.dir !== cleanDir && x.label !== cleanLabel),
        { label: cleanLabel, dir: cleanDir },
      ];
      updateOcConfig({
        servers: ocConfig.servers.map((s) => (s.id === serverId ? { ...s, repos: nextRepos } : s)),
      });
      setOcProjectsByServer((prev) => ({
        ...prev,
        [serverId]: mergeRepos(prev[serverId] ?? [], [{ label: cleanLabel, dir: cleanDir }]),
      }));
      showToast(`Added "${cleanLabel}" to ~${serverId}`);
    },
    [ocConfig.servers, updateOcConfig],
  );

  const handleSyncServerProjects = useCallback(
    async (serverId: string) => {
      const srv = ocConfig.servers.find((s) => s.id === serverId);
      if (!srv) return 0;
      try {
        const discovered = await fetchServerProjects(srv, true);
        if (discovered.length === 0) {
          showToast(`No projects returned by ${srv.name}`);
          return 0;
        }
        const merged = mergeRepos(srv.repos ?? [], discovered);
        const addedCount = merged.length - (srv.repos?.length ?? 0);
        updateOcConfig({
          servers: ocConfig.servers.map((s) => (s.id === serverId ? { ...s, repos: merged } : s)),
        });
        setOcProjectsByServer((prev) => ({ ...prev, [serverId]: discovered }));
        showToast(
          `✓ Synced ${discovered.length} projects from ${srv.name} (${addedCount > 0 ? `+${addedCount} new` : "all up to date"})`,
        );
        return discovered.length;
      } catch (err) {
        showToast(`Failed to sync projects: ${String(err)}`);
        return 0;
      }
    },
    [ocConfig.servers, updateOcConfig],
  );

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
      jira?: string;
      mode?: "save" | "drive" | "agent";
    },
  ) => {
    const p = parseAdd(raw, sections, ocConfig.servers);
    if (!p.content) return;
    const sectionId = (p.sectionName && sections[p.sectionName.toLowerCase()]) || fallbackSection;
    const repo = extra?.repo || p.repo || "";
    const jiraKey = (extra?.jira || extractJiraKey(p.content) || "").toUpperCase();
    const explicitServer = extra?.server || p.server;
    const hasAgentContext = Boolean(
      explicitServer ||
      repo ||
      jiraKey ||
      extra?.prompt ||
      p.prompt ||
      extra?.mode === "agent" ||
      (extra?.sessions && extra.sessions.length > 0),
    );
    const targetSrv = hasAgentContext
      ? resolveServer(explicitServer || ocConfig.defaultServerId, ocConfig)
      : null;
    const serverId = targetSrv ? targetSrv.id : "";
    const model = hasAgentContext
      ? (extra?.model || targetSrv?.defaultModel || ocConfig.defaultModel || "")
      : "";
    const prompt = extra?.prompt || p.prompt || "";
    const note = extra?.note || "";
    const linkedSessions = extra?.sessions ? [...extra.sessions] : [];

    // If launching OpenCode agent immediately on task creation (or queueing if target server is offline)
    let queuedForAgent = false;
    const isTargetOnline = serverId ? (ocServerOnlineById[serverId] ?? ocConnected) : false;
    if (extra?.mode === "agent" && serverId) {
      if (isTargetOnline) {
        try {
          const sessionTitle =
            jiraKey && !p.content.toUpperCase().includes(jiraKey)
              ? `[${jiraKey}] ${p.content}`
              : p.content;
          const initialPrompt =
            jiraKey && !(prompt || p.content).toUpperCase().includes(jiraKey)
              ? `[Jira: ${jiraKey}] ${prompt || p.content}`
              : prompt || p.content;
          const sid = await createAndPromptOpenCodeSession({
            title: sessionTitle,
            directory: resolveRepoDir(repo, serverId),
            promptText: initialPrompt,
            serverId,
            modelKey: model || undefined,
          });
          linkedSessions.push(sid);
          if (jiraKey) {
            void syncSessionToJiraIssue({
              jiraKey,
              sessionID: sid,
              sessionTitle,
              serverId,
              repo,
            });
          }
          void syncOpenCode();
          window.setTimeout(() => void syncOpenCode(), 900);
          window.setTimeout(() => void syncOpenCode(), 2200);
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
      jira: jiraKey || undefined,
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

    // swap the optimistic tmp id for the real one, preserving any local edits / session links added while in-flight
    const swap = (created: unknown) => {
      if (created && typeof (created as Task).id === "string") {
        const real = created as Task;
        tmpIdMapRef.current.set(tmp.id, real.id);
        const latestLocal = tasksRef.current.find((x) => x.id === tmp.id);
        const mergedContent = latestLocal?.content ?? real.content;
        const mergedDesc = latestLocal?.description ?? real.description;
        setTasks((ts) =>
          ts.map((x) =>
            x.id === tmp.id
              ? {
                  ...real,
                  content: mergedContent,
                  description: mergedDesc,
                  duration: x.duration ?? real.duration,
                  section_id: x.section_id ?? real.section_id,
                }
              : x,
          ),
        );
        setDrivingTaskId((cur) => (cur === tmp.id ? real.id : cur));
        setExpandedId((cur) => (cur === tmp.id ? real.id : cur));
        if (
          latestLocal &&
          (latestLocal.content !== tmp.content ||
            (latestLocal.description ?? "") !== (tmp.description ?? ""))
        ) {
          void mutate(token, {
            path: `/tasks/${real.id}`,
            method: "POST",
            body: {
              content: latestLocal.content,
              description: latestLocal.description ?? "",
            },
          }).catch(() => {});
        }
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
    const resolvedId = tmpIdMapRef.current.get(id) ?? id;
    const prev = tasksRef.current;
    const existingTask = prev.find((x) => x.id === resolvedId || x.id === id);
    setTasks((ts) =>
      ts.map((x) => (x.id === resolvedId || x.id === id ? { ...x, ...fields } : x)),
    );
    // If task creation POST /tasks is still in flight, swap() will persist the updated fields once real ID arrives
    if (resolvedId.startsWith("tmp-")) return;
    try {
      await mutate(token, { path: `/tasks/${resolvedId}`, method: "POST", body: fields });
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
    async (
      t: Task,
      customPrompt?: string,
      serverOverride?: string,
      modelOverride?: string,
      repoOverride?: string,
      noteOverride?: string,
      keepSection = false,
    ) => {
      const resolvedId = tmpIdMapRef.current.get(t.id) ?? t.id;
      const currentTask =
        tasksRef.current.find((x) => x.id === resolvedId || x.id === t.id) ?? t;
      if (drivingTaskId === currentTask.id || drivingTaskId === t.id) setDrivingTaskId(null);

      // When triggering manually from Backlog (or another non-focus section), move directly to Focus
      if (!keepSection && roles.focus && currentTask.section_id !== roles.focus) {
        void moveTo(currentTask, roles.focus);
        setView((curView) => (curView === "backlog" ? "focus" : curView));
      }
      setExpandedId(currentTask.id);

      const meta = parseTaskDescription(currentTask.description);
      const jiraKey = (meta.jira || extractJiraKey(currentTask.content) || "").toUpperCase();
      const effectiveNote = noteOverride ?? meta.note;
      const repoLabel = repoOverride ?? meta.repo;
      const rawPromptText = customPrompt?.trim() || meta.prompt || currentTask.content;
      const latestSid = meta.sessions[meta.sessions.length - 1];
      const existingLive = latestSid ? ocSessions.find((s) => s.id === latestSid) : undefined;
      const targetSrv = resolveServer(
        serverOverride || existingLive?.serverId || meta.server || ocConfig.defaultServerId,
        ocConfig,
      );
      const serverId = targetSrv.id;
      // For an existing session, preserve its active model (`existingLive.modelKey`) unless an explicit modelOverride was given.
      const modelKey = latestSid
        ? (modelOverride || existingLive?.modelKey || meta.model || "")
        : (modelOverride ||
            meta.model ||
            targetSrv.defaultModel ||
            ocConfig.defaultModel ||
            "");

      let sid = latestSid;
      try {
        if (!sid) {
          const sessionTitle =
            jiraKey && !currentTask.content.toUpperCase().includes(jiraKey)
              ? `[${jiraKey}] ${currentTask.content}`
              : currentTask.content;
          const initialPromptText =
            jiraKey && !rawPromptText.toUpperCase().includes(jiraKey)
              ? `[Jira: ${jiraKey}] ${rawPromptText}`
              : rawPromptText;
          sid = await createAndPromptOpenCodeSession({
            title: sessionTitle,
            directory: resolveRepoDir(repoLabel, serverId),
            promptText: initialPromptText,
            serverId,
            modelKey: modelKey || undefined,
            onSessionCreated: (createdSid) => {
              const linked = Array.from(new Set([...meta.sessions, createdSid]));
              const optimisticDesc = formatTaskDescription({
                note: effectiveNote,
                prompt: customPrompt?.trim() ? customPrompt.trim() : meta.prompt,
                repo: repoLabel,
                server: serverId,
                model: modelKey || undefined,
                sessions: linked,
                queued: false,
                jira: jiraKey || undefined,
              });
              setTasks((ts) =>
                ts.map((x) =>
                  x.id === currentTask.id || x.id === t.id
                    ? { ...x, description: optimisticDesc }
                    : x,
                ),
              );
              if (jiraKey) {
                void syncSessionToJiraIssue({
                  jiraKey,
                  sessionID: createdSid,
                  sessionTitle,
                  serverId,
                  repo: repoLabel,
                });
              }
              invalidateSessionSummary(createdSid);
              void syncOpenCode();
              window.setTimeout(() => void syncOpenCode(), 400);
              window.setTimeout(() => void syncOpenCode(), 1200);
            },
          });
        } else {
          if (modelOverride && modelOverride !== existingLive?.modelKey) {
            await switchOpenCodeSessionModel(sid, modelOverride, serverId).catch(() => {});
          }
          // Optimistically mark session as running and clear any pending question/permission
          setOcSessions((prev) =>
            prev.map((s) =>
              s.id === sid
                ? { ...s, status: "running", form: undefined, permission: undefined }
                : s,
            ),
          );
          invalidateSessionSummary(sid);
          window.setTimeout(() => void syncOpenCode(), 250);
          window.setTimeout(() => void syncOpenCode(), 900);
          window.setTimeout(() => void syncOpenCode(), 2000);
          await sendOpenCodePrompt(sid, rawPromptText, serverId, {
            pendingFormId: existingLive?.form?.id,
            pendingPermissionId: existingLive?.permission?.id,
          });
        }
      } catch {
        const nextDesc = formatTaskDescription({
          note: effectiveNote,
          prompt: customPrompt?.trim() ? customPrompt.trim() : meta.prompt,
          repo: repoLabel,
          server: serverId,
          model: modelKey || undefined,
          sessions: meta.sessions,
          queued: true,
          jira: jiraKey || undefined,
        });
        if (nextDesc !== (currentTask.description ?? "")) {
          await updateTask(currentTask.id, { description: nextDesc }).catch(() => {});
        }
        showToast(`"${serverId}" offline — queued in Todoist`);
        return;
      }

      const freshId = tmpIdMapRef.current.get(t.id) ?? resolvedId;
      const freshTask =
        tasksRef.current.find((x) => x.id === freshId || x.id === t.id) ?? currentTask;
      const freshMeta = parseTaskDescription(freshTask.description);
      const nextSessions = Array.from(new Set([...meta.sessions, ...freshMeta.sessions, sid]));
      invalidateSessionSummary(sid);
      const nextDesc = formatTaskDescription({
        note: noteOverride ?? freshMeta.note ?? effectiveNote,
        prompt: !latestSid && customPrompt?.trim() ? customPrompt.trim() : freshMeta.prompt || meta.prompt,
        repo: repoOverride ?? (freshMeta.repo || repoLabel),
        server: serverId,
        model: modelKey || undefined,
        sessions: nextSessions,
        queued: false,
        jira: freshMeta.jira || jiraKey || undefined,
      });
      void syncOpenCode();
      window.setTimeout(() => void syncOpenCode(), 900);
      window.setTimeout(() => void syncOpenCode(), 2200);
      showToast(`Sent to ${serverId} (${sid.slice(0, 10)})`);
      if (nextDesc !== (freshTask.description ?? "")) {
        await updateTask(freshTask.id, { description: nextDesc }).catch(() => {});
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drivingTaskId, syncOpenCode, token, ocSessions, ocConfig, roles.focus],
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

  const launchingQueueRef = useRef<Set<string>>(new Set());

  // ponytail: single sequential auto-loop reuses handToAgent + native OpenCode question tool
  const [autoPilot, setAutoPilot] = useState(false);

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

  useEffect(() => {
    if (!autoPilot || !ocConnected) return;
    if (ocSessions.some((s) => s.status === "running")) return;

    const focusList = sortTasks(
      tasks.filter((t) => !t.id.startsWith("tmp-") && t.section_id === roles.focus),
    );
    const backlogList = sortTasks(
      tasks.filter(
        (t) =>
          !t.id.startsWith("tmp-") &&
          (t.section_id == null || t.section_id === roles.backlog),
      ),
    );
    const isUnstarted = (t: Task) =>
      !launchingQueueRef.current.has(t.id) &&
      parseTaskDescription(t.description).sessions.length === 0;

    const nextFocus = focusList.find(isUnstarted);
    const nextBacklog = backlogList.find(isUnstarted);
    const target = nextFocus ?? nextBacklog;
    if (!target) {
      setAutoPilot(false);
      showToast("Auto-Loop finished all unstarted Focus & Backlog tasks");
      return;
    }

    const meta = parseTaskDescription(target.description);
    const srv = resolveServer(meta.server || ocConfig.defaultServerId, ocConfig);
    if (!ocServerOnlineById[srv.id]) return;

    const isBacklog = !nextFocus;
    const base = meta.prompt || meta.note || target.content;
    const prompt = isBacklog
      ? `Rough backlog idea: "${target.content}"\n${base}\n\nDo NOT implement yet. Inspect the codebase, propose a concise 3-bullet plan, and call the \`question\` tool to ask for my confirmation and any missing requirements.`
      : `${base}\n\nComplete the majority of this task end-to-end (implement, verify/build, and summarize what was done). If blocked by an ambiguity or decision, call the \`question\` tool and wait for my answer. Do NOT close the Todoist task; leave it parked for my review.`;

    launchingQueueRef.current.add(target.id);
    void handToAgent(
      target,
      prompt,
      srv.id,
      undefined,
      undefined,
      undefined,
      isBacklog,
    ).finally(() => {
      launchingQueueRef.current.delete(target.id);
    });
  }, [
    autoPilot,
    ocConnected,
    ocSessions,
    tasks,
    roles.focus,
    roles.backlog,
    ocConfig,
    ocServerOnlineById,
    handToAgent,
  ]);

  // Approve or reject pending OpenCode tool permission inline
  const approvePermission = async (
    t: Task,
    decision: "once" | "always" | "reject" = "once",
  ) => {
    const meta = parseTaskDescription(t.description);
    const live = ocSessions.find(
      (s) => meta.sessions.includes(s.id) && s.permission,
    );
    if (!live?.permission) return;
    try {
      await replyOpenCodePermission(live.id, live.permission.id, decision, live.serverId);
      invalidateSessionSummary(live.id);
      syncOpenCode();
      showToast(
        decision === "reject"
          ? `Rejected on ${live.serverId}`
          : decision === "always"
            ? `Allowed always on ${live.serverId}`
            : `Approved on ${live.serverId}`,
      );
    } catch {
      showToast("Permission reply failed");
    }
  };

  // Stop / interrupt a running OpenCode session inline without completing the task
  const stopTaskSession = async (t: Task) => {
    const meta = parseTaskDescription(t.description);
    const running = ocSessions.filter(
      (s) =>
        meta.sessions.includes(s.id) &&
        (s.status === "running" || s.status === "question"),
    );
    if (running.length === 0) return;
    setOcSessions((prev) =>
      prev.map((s) =>
        running.some((r) => r.id === s.id)
          ? { ...s, status: "idle", form: undefined, permission: undefined }
          : s,
      ),
    );
    for (const s of running) {
      await interruptOpenCodeSession(s.id, s.serverId);
      invalidateSessionSummary(s.id);
    }
    void syncOpenCode();
    showToast(`Stopped agent on ${running[0].serverId}`);
  };

  // Answer pending OpenCode question / option picker inline (supports single option, multi-question map, multiselect, and optional steer text)
  const answerFormOption = async (
    t: Task,
    fieldKeyOrAnswers: string | Record<string, string | string[]>,
    value?: string | string[],
    label?: string,
    steerPrompt?: string,
  ) => {
    const meta = parseTaskDescription(t.description);
    const live = ocSessions.find((s) => meta.sessions.includes(s.id) && s.form);
    if (!live?.form) {
      if (steerPrompt?.trim()) {
        await handToAgent(t, steerPrompt.trim(), live?.serverId || meta.server);
      }
      return;
    }
    const formId = live.form.id;
    const normalizedAnswers: Record<string, string | string[]> =
      typeof fieldKeyOrAnswers === "string"
        ? (() => {
            const field = live.form?.fields.find((f) => f.key === fieldKeyOrAnswers);
            const rawVal = value ?? "";
            const finalVal =
              field?.type === "multiselect" && !Array.isArray(rawVal)
                ? [String(rawVal)]
                : rawVal;
            return { [fieldKeyOrAnswers]: finalVal };
          })()
        : Object.fromEntries(
            Object.entries(fieldKeyOrAnswers).map(([k, v]) => {
              const field = live.form?.fields.find((f) => f.key === k);
              if (field?.type === "multiselect" && !Array.isArray(v)) {
                return [k, [String(v)]];
              }
              return [k, v];
            }),
          );

    // Optimistically clear pending form and mark session running immediately
    setOcSessions((prev) =>
      prev.map((s) =>
        s.id === live.id ? { ...s, status: "running", form: undefined } : s,
      ),
    );
    try {
      await replyOpenCodeForm(
        live.id,
        formId,
        normalizedAnswers,
        undefined,
        live.serverId,
        steerPrompt,
      );
      invalidateSessionSummary(live.id);
      void syncOpenCode();
      window.setTimeout(() => void syncOpenCode(), 400);
      window.setTimeout(() => void syncOpenCode(), 1200);
      showToast(
        steerPrompt?.trim()
          ? `Answered & steered on ${live.serverId}`
          : `Selected "${label || "answer"}" on ${live.serverId}`,
      );
    } catch {
      void syncOpenCode();
      showToast("Couldn't submit option to OpenCode");
    }
  };

  // completing from the list: interrupt any still-running OpenCode agent, keep OpenCode session history intact,
  // and stamp session IDs + human/agent minutes into the Todoist task comment & session log.
  const completeWithLog = (t: Task) => {
    if (drivingTaskId === t.id) setDrivingTaskId(null);
    const meta = parseTaskDescription(t.description);

    // If any linked OpenCode session is still running or blocked on a question, interrupt it so it stops burning tokens
    for (const sid of meta.sessions) {
      const live = ocSessions.find((s) => s.id === sid);
      if (live?.status === "running" || live?.status === "question") {
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
  const needsYouFocusCount = focusTasks.filter(
    (t) => resolveTaskTriage(t, ocSessions).triage === "needs_you",
  ).length;
  const totalServerCount = ocConfig.servers.length;
  const onlineServerCount = ocConfig.servers.filter((s) => ocServerOnlineById[s.id]).length;

  return (
    <div className="min-h-screen md:h-screen flex flex-col">
      <header className="shrink-0 z-10 border-b border-zinc-800/80 bg-zinc-950/95 backdrop-blur">
        <div
          className={`mx-auto flex w-full items-center justify-between gap-2 px-3 py-1.5 sm:px-4 ${
            view === "focus" || view === "backlog" ? "max-w-none" : "max-w-5xl"
          }`}
        >
          {/* Left: Brand + Inline List Switcher + OpenCode Status */}
          <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2">
            <span className="hidden shrink-0 text-[13px] font-semibold tracking-tight text-zinc-100 sm:inline">
              Timebox
            </span>

            {projects.length >= 2 && (
              <div className="flex min-w-0 items-center gap-1 overflow-x-auto border-zinc-800/80 sm:border-l sm:pl-2 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                <span className="hidden shrink-0 font-mono text-[10px] text-zinc-500 lg:inline">
                  List:
                </span>
                {projects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    title={`Switch to ${p.name}`}
                    className={`max-w-32 shrink-0 truncate rounded px-2 py-0.5 text-[11px] transition-colors ${
                      p.id === projectId
                        ? "bg-zinc-800 font-medium text-zinc-100"
                        : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
                    }`}
                    onClick={() => p.id !== projectId && switchProject(p.id)}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}

            <div className="hidden shrink-0 items-center gap-1.5 md:flex">
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
                className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-zinc-800/90 bg-zinc-900/70 px-2 py-0.5 font-mono text-[10.5px] leading-none tabular-nums text-zinc-400 transition-colors hover:border-zinc-700 hover:bg-zinc-800/80 hover:text-zinc-200"
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
                    {needsYouFocusCount > 0 && (
                      <>
                        <span className="text-zinc-700" aria-hidden="true">
                          ·
                        </span>
                        <span className="font-medium text-orange-400">
                          {needsYouFocusCount} need you
                        </span>
                      </>
                    )}
                    {runningOcCount > 0 && (
                      <>
                        <span className="text-zinc-700" aria-hidden="true">
                          ·
                        </span>
                        <span className="font-medium text-zinc-200">
                          {runningOcCount} working
                        </span>
                      </>
                    )}
                  </>
                ) : queuedForAgentTasks.length > 0 ? (
                  <span className="text-amber-400">{queuedForAgentTasks.length}q</span>
                ) : (
                  <span className="text-zinc-500">offline</span>
                )}
              </button>
              {ocConnected && (
                <button
                  type="button"
                  onClick={() => setAutoPilot((v) => !v)}
                  className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[10.5px] leading-none transition-colors ${
                    autoPilot
                      ? "border-orange-500/60 bg-orange-500/15 text-orange-300"
                      : "border-zinc-800/90 bg-zinc-900/70 text-zinc-400 hover:border-zinc-700 hover:bg-zinc-800/80 hover:text-zinc-200"
                  }`}
                  title="Auto-loop through unstarted Focus (execute) and Backlog (spec & ask) tasks one at a time"
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      autoPilot ? "bg-orange-400 animate-pulse" : "bg-zinc-600"
                    }`}
                  />
                  <span>{autoPilot ? "Auto-Loop ON" : "Auto-Loop"}</span>
                </button>
              )}
            </div>
          </div>

          {/* Right: Views + Help & Settings */}
          <div className="flex shrink-0 items-center gap-1">
            <nav className="flex shrink-0 items-center gap-0.5">
              {(["focus", "backlog", "review", "analysis"] as const).map((v) => (
                <button
                  key={v}
                  className="whitespace-nowrap rounded px-2 py-1 text-[12px] capitalize text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 data-[active=true]:bg-zinc-800/90 data-[active=true]:font-medium data-[active=true]:text-zinc-100"
                  data-active={view === v}
                  onClick={() => setView(v)}
                >
                  {v}
                  {v === "focus" && needsYouFocusCount > 0 && (
                    <span className="ml-1 font-mono text-[10.5px] tabular-nums text-orange-400">
                      {needsYouFocusCount}
                    </span>
                  )}
                  {v === "backlog" && backlogTasks.length > 0 && (
                    <span className="ml-1 font-mono text-[10.5px] tabular-nums text-zinc-500">
                      {backlogTasks.length}
                    </span>
                  )}
                </button>
              ))}
            </nav>
            <div className="flex shrink-0 items-center gap-0.5 border-l border-zinc-800/80 pl-1">
              <button
                className="rounded px-1.5 py-1 text-[12px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                title="How it works (?)"
                onClick={() => setShowRef((s) => !s)}
              >
                ?
              </button>
              <button
                className={`rounded px-1.5 py-1 text-[12px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 ${view === "settings" ? "text-zinc-200" : ""}`}
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
        </div>
      </header>
      <main
        className={`mx-auto w-full flex-1 min-h-0 flex flex-col px-2.5 sm:px-4 ${
          view === "focus" || view === "backlog"
            ? "py-1.5 max-w-none overflow-y-auto md:overflow-hidden"
            : "pt-5 pb-10 max-w-5xl overflow-y-auto"
        }`}
      >
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
            onSyncServerProjects={handleSyncServerProjects}
            ocModelsByServer={ocModelsByServer}
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
          <BacklogView
            backlogTasks={backlogTasks}
            focusTasks={focusTasks}
            sessions={sessions}
            sections={sections}
            backlogId={roles.backlog}
            focusId={roles.focus}
            durations={prefs.durations}
            defaultMinutes={prefs.defaultMinutes}
            spentBy={spentBy}
            expandedId={expandedId}
            ocConnected={ocConnected}
            ocServers={ocConfig.servers}
            ocServerOnlineById={ocServerOnlineById}
            ocVerifyById={ocVerifyById}
            ocModelsByServer={ocModelsByServer}
            ocProjectsByServer={ocProjectsByServer}
            onAddProject={addProjectToServer}
            onRefreshProjects={refreshProjectsForServer}
            defaultServerId={ocConfig.defaultServerId}
            ocSessions={ocSessions}
            onOpenOcSettings={() => setView("settings")}
            humanSecBy={humanSecBy}
            agentSecBy={agentSecBy}
            onToggle={toggleRow}
            onHandToAgent={handToAgent}
            onApprove={approvePermission}
            onAnswerForm={answerFormOption}
            onInterrupt={stopTaskSession}
            onStart={(t, minutes) => {
              if (roles.focus && t.section_id !== roles.focus) {
                void moveTo(t, roles.focus);
              }
              setExpandedId(t.id);
              setView("focus");
              setActive({ task: t, minutes });
            }}
            onMove={
              roles.focus
                ? (x) => {
                    void moveTo(x, roles.focus!);
                    setExpandedId(x.id);
                    setView("focus");
                    showToast(`Moved "${x.content}" to Focus`);
                  }
                : undefined
            }
            onMoveProject={otherProjects.length ? moveToProject : undefined}
            projects={otherProjects}
            onAdd={(raw, extra) => {
              if (extra?.mode === "agent" && roles.focus) {
                void addTask(raw, roles.focus, extra);
                setView("focus");
              } else {
                void addTask(raw, roles.backlog, { ...extra, mode: "save" });
              }
            }}
            onComplete={completeWithLog}
            onUpdate={updateTask}
            onDuration={changeDuration}
            onDelete={deleteTask}
          />
        ) : (
          <FocusView
            focusTasks={focusTasks}
            bufferTasks={bufferTasks}
            backlogTasks={backlogTasks}
            sessions={sessions}
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
            ocVerifyById={ocVerifyById}
            ocModelsByServer={ocModelsByServer}
            ocProjectsByServer={ocProjectsByServer}
            onAddProject={addProjectToServer}
            onRefreshProjects={refreshProjectsForServer}
            defaultServerId={ocConfig.defaultServerId}
            ocSessions={ocSessions}
            unlinkedOcSessions={unlinkedOcSessions}
            queuedTasks={queuedForAgentTasks}
            autoRunQueued={ocConfig.autoRunQueued}
            onRunQueued={() => void runQueuedTasks()}
            onOpenOcSettings={() => setView("settings")}
            humanSecBy={humanSecBy}
            agentSecBy={agentSecBy}
            onToggle={toggleRow}
            onHandToAgent={handToAgent}
            onApprove={approvePermission}
            onAnswerForm={answerFormOption}
            onInterrupt={stopTaskSession}
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
  const rawMeta = parseTaskDescription(t.description);
  const meta: TaskMeta = {
    ...rawMeta,
    jira: rawMeta.jira || extractJiraKey(t.content) || undefined,
  };
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
  jira?: string;
  mode?: "save" | "drive" | "agent";
};

function JiraPullStage({
  data,
  loading,
  allTasks,
  ocSessions,
  defaultServerId,
  onRefresh,
  onPullIssue,
  onSelectExistingTask,
  onLinkSessionToExisting,
  onClose,
}: {
  data: JiraPullResult | null;
  loading: boolean;
  allTasks: Task[];
  ocSessions: OpenCodeLiveSession[];
  defaultServerId: string;
  onRefresh: () => void;
  onPullIssue: (
    issue: JiraAssignedIssue,
    target: "focus" | "backlog" | "agent",
    matchedSessionIds: string[],
  ) => void;
  onSelectExistingTask: (taskId: string) => void;
  onLinkSessionToExisting: (task: Task, sessionId: string, jiraKey: string) => void;
  onClose?: () => void;
}) {
  const issues = data?.issues ?? [];

  const findExistingTask = (jiraKey: string): Task | undefined => {
    const clean = jiraKey.toUpperCase();
    return allTasks.find((t) => {
      const m = parseTaskDescription(t.description);
      const k = (m.jira || extractJiraKey(t.content) || "").toUpperCase();
      return k === clean;
    });
  };

  return (
    <div className="rounded-xl border border-zinc-800/90 bg-zinc-950 p-5 space-y-4 shadow-sm flex-1 flex flex-col justify-between">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/80 pb-3 font-mono text-[11px]">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-blue-400 animate-pulse" />
          <span className="font-semibold uppercase tracking-wider text-blue-400">
            🎫 Assigned Jira Issues ({issues.length})
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-zinc-500">
            {loading
              ? `● querying Atlassian MCP on ${data?.serverName || defaultServerId}…`
              : data?.serverName
                ? `via ${data.serverName} MCP`
                : "assignee = currentUser()"}
          </span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            title="Refresh assigned Jira tickets via OpenCode Atlassian MCP"
            className="rounded border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[10px] text-zinc-300 hover:border-zinc-700 hover:text-zinc-100 disabled:opacity-50"
          >
            {loading ? "Syncing…" : "⟲ Refresh"}
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title="Close Jira panel (Esc)"
              className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
            >
              ✕ Esc
            </button>
          )}
        </div>
      </div>

      {data?.error && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-950/30 px-3.5 py-2.5 text-[12px] text-amber-300">
          {data.error}
        </div>
      )}

      {loading && issues.length === 0 ? (
        <div className="py-12 text-center font-mono text-[12px] text-zinc-500 space-y-1.5">
          <p className="text-zinc-300">
            ● Fetching Jira issues where <code className="text-blue-300">assignee = currentUser()</code>…
          </p>
          <p className="text-[11px] text-zinc-600">
            OpenCode is calling Atlassian MCP and matching active sessions by ticket key.
          </p>
        </div>
      ) : issues.length === 0 ? (
        <div className="py-10 text-center text-[13px] text-zinc-500 space-y-3">
          <p>No open Jira issues loaded yet.</p>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="rounded-md bg-orange-600 px-3.5 py-1.5 text-[12px] font-medium text-white hover:bg-orange-500 disabled:opacity-50"
          >
            🎫 Fetch My Assigned Jira Issues
          </button>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto pr-1 [scrollbar-width:thin] [scrollbar-color:rgba(113,113,122,0.3)_transparent]">
          <ul className="space-y-2.5">
            {issues.map((issue) => {
              const existingTask = findExistingTask(issue.key);
              const existingMeta = existingTask
                ? parseTaskDescription(existingTask.description)
                : null;
              const liveMatches = findMatchingSessionsForJira(issue.key, ocSessions);
              const matchedIds = Array.from(
                new Set([
                  ...(issue.matchedSessionIds ?? []),
                  ...liveMatches.map((s) => s.id),
                ]),
              );
              const unlinkedMatch = existingTask
                ? matchedIds.find((sid) => !existingMeta?.sessions.includes(sid))
                : undefined;

              return (
                <li
                  key={issue.key}
                  className="group flex flex-col gap-2 rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-3.5 transition-colors hover:border-zinc-700 hover:bg-zinc-900/70"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
                        {issue.url ? (
                          <a
                            href={issue.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="rounded border border-blue-500/40 bg-blue-950/50 px-1.5 py-0.5 font-semibold text-blue-300 hover:border-blue-400"
                            title="Open issue in Jira"
                          >
                            {issue.key} ↗
                          </a>
                        ) : (
                          <span className="rounded border border-blue-500/40 bg-blue-950/50 px-1.5 py-0.5 font-semibold text-blue-300">
                            {issue.key}
                          </span>
                        )}
                        <span className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-zinc-300">
                          {issue.status}
                        </span>
                        {issue.priority && (
                          <span className="rounded border border-zinc-800 bg-zinc-900/80 px-1.5 py-0.5 text-zinc-400">
                            {issue.priority}
                          </span>
                        )}
                        {issue.suggestedRepo && (
                          <span className="rounded border border-zinc-800 bg-zinc-900/80 px-1.5 py-0.5 text-zinc-400">
                            @{shortRepo(issue.suggestedRepo)}
                          </span>
                        )}
                        {matchedIds.map((sid) => {
                          const live = ocSessions.find((s) => s.id === sid);
                          return (
                            <span
                              key={sid}
                              className="inline-flex items-center gap-1 rounded border border-orange-500/40 bg-orange-950/40 px-1.5 py-0.5 text-orange-300"
                              title={
                                live
                                  ? `Matched OpenCode session: ${live.title} (${live.serverId})`
                                  : `Matched OpenCode session ${sid}`
                              }
                            >
                              🔗 {sid.slice(0, 10)}
                              {live ? ` · ${live.serverId}` : ""}
                            </span>
                          );
                        })}
                      </div>
                      <p className="text-[14px] font-medium leading-snug text-zinc-100">
                        {issue.summary}
                      </p>
                      {issue.description && (
                        <p className="line-clamp-2 text-[12px] text-zinc-400">
                          {issue.description}
                        </p>
                      )}
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-1.5 pt-0.5 font-mono text-[11px]">
                      {existingTask ? (
                        <>
                          {unlinkedMatch && (
                            <button
                              type="button"
                              onClick={() =>
                                onLinkSessionToExisting(existingTask, unlinkedMatch, issue.key)
                              }
                              title={`Link session ${unlinkedMatch} to this task and Jira ticket`}
                              className="rounded border border-orange-500/50 bg-orange-950/60 px-2.5 py-1 font-medium text-orange-300 hover:border-orange-500"
                            >
                              🔗 Link {unlinkedMatch.slice(0, 8)}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => onSelectExistingTask(existingTask.id)}
                            className="rounded border border-emerald-500/40 bg-emerald-950/40 px-2.5 py-1 text-emerald-300 hover:border-emerald-400"
                          >
                            ✓ Open Task
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => onPullIssue(issue, "agent", matchedIds)}
                            title={
                              matchedIds.length > 0
                                ? `Pull into Focus and link session ${matchedIds[0].slice(0, 10)}`
                                : `Pull into Focus and start OpenCode agent on ${defaultServerId}`
                            }
                            className="rounded border border-orange-500/50 bg-orange-950/60 px-2.5 py-1 font-medium text-orange-300 hover:border-orange-500 hover:bg-orange-900/80"
                          >
                            {matchedIds.length > 0 ? "🔗 Pull & Link" : "◈ Run Agent"}
                          </button>
                          <button
                            type="button"
                            onClick={() => onPullIssue(issue, "focus", matchedIds)}
                            title="Pull into Focus queue"
                            className="rounded border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-zinc-300 hover:border-zinc-700 hover:text-zinc-100"
                          >
                            🎯 Focus
                          </button>
                          <button
                            type="button"
                            onClick={() => onPullIssue(issue, "backlog", matchedIds)}
                            title="Add to Backlog queue"
                            className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                          >
                            ＋ Backlog
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function TriageStage({
  suggestions,
  loading,
  source,
  serverName,
  modelLabel,
  backlogTasks,
  defaultServerId,
  onPickFocus,
  onPickStart,
  onPickAgent,
  onRefresh,
  onClose,
}: {
  suggestions: BacklogSuggestion[];
  loading: boolean;
  source?: "opencode" | "heuristic";
  serverName?: string;
  modelLabel?: string;
  backlogTasks: Task[];
  defaultServerId: string;
  onPickFocus: (t: Task) => void;
  onPickStart: (t: Task, minutes: number) => void;
  onPickAgent: (t: Task, serverId?: string) => void;
  onRefresh: () => void;
  onClose?: () => void;
}) {
  const renderPriorityBadge = (p: number) => {
    switch (p) {
      case 4:
        return (
          <span className="rounded border border-red-500/40 bg-red-950/50 px-1.5 py-0.5 font-mono text-[11px] text-red-300">
            [P4]
          </span>
        );
      case 3:
        return (
          <span className="rounded border border-amber-500/40 bg-amber-950/50 px-1.5 py-0.5 font-mono text-[11px] text-amber-300">
            [P3]
          </span>
        );
      case 2:
        return (
          <span className="rounded border border-blue-500/40 bg-blue-950/50 px-1.5 py-0.5 font-mono text-[11px] text-blue-300">
            [P2]
          </span>
        );
      default:
        return (
          <span className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-[11px] text-zinc-400">
            [P1]
          </span>
        );
    }
  };

  const renderSignalBadge = (sig: BacklogSignal) => {
    switch (sig) {
      case "blocker":
        return (
          <span
            key={sig}
            className="inline-flex items-center gap-1 rounded border border-red-500/40 bg-red-950/40 px-1.5 py-0.5 font-mono text-[11px] text-red-300"
          >
            ⚡ blocker
          </span>
        );
      case "deadline":
        return (
          <span
            key={sig}
            className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-950/40 px-1.5 py-0.5 font-mono text-[11px] text-amber-300"
          >
            ⏰ deadline
          </span>
        );
      case "agent":
        return (
          <span
            key={sig}
            className="inline-flex items-center gap-1 rounded border border-orange-500/40 bg-orange-950/40 px-1.5 py-0.5 font-mono text-[11px] text-orange-300"
          >
            ◈ agent
          </span>
        );
      case "recent":
        return (
          <span
            key={sig}
            className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300"
          >
            ⟲ recent
          </span>
        );
      case "quick":
        return (
          <span
            key={sig}
            className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300"
          >
            ⚡ quick
          </span>
        );
    }
  };

  return (
    <div className="rounded-xl border border-zinc-800/90 bg-zinc-950 p-5 space-y-4 shadow-sm flex-1 flex flex-col justify-between">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/80 pb-3 font-mono text-[11px]">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-orange-500 animate-pulse" />
          <span className="font-semibold uppercase tracking-wider text-orange-400">
            ⚡ Triage · {suggestions.length} picks from Backlog ({backlogTasks.length})
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-zinc-500">
            {loading
              ? "● evaluating backlog…"
              : source === "opencode"
                ? `${serverName || "OpenCode"} · ${modelLabel || "model"}`
                : "heuristic rank"}
          </span>
          <button
            type="button"
            onClick={onRefresh}
            title="Refresh recommendations"
            className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
          >
            ⟲
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title="Close triage (Esc)"
              className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
            >
              ✕ Esc
            </button>
          )}
        </div>
      </div>

      {loading && suggestions.length === 0 ? (
        <div className="py-12 text-center font-mono text-[12px] text-zinc-500 space-y-1">
          <p className="text-zinc-300">● Reading backlog ({backlogTasks.length} tasks)</p>
          <p className="text-[11px] text-zinc-600">
            Checking priorities, deadlines, continuity, and agent readiness…
          </p>
        </div>
      ) : suggestions.length === 0 ? (
        <div className="py-8 text-center text-[13px] text-zinc-500">
          <p>No remaining suggestions in backlog.</p>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto pr-1 [scrollbar-width:thin] [scrollbar-color:rgba(113,113,122,0.3)_transparent]">
          <ul className="space-y-3">
            {suggestions.map((s, idx) => {
              const t = backlogTasks.find((item) => item.id === s.taskId);
              if (!t) return null;
              const meta = parseTaskDescription(t.description);
              const repoDisplay = shortRepo(meta.repo);

              return (
                <li
                  key={t.id}
                  className="group flex flex-col gap-2 rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-3.5 transition-colors hover:border-zinc-700 hover:bg-zinc-900/70"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-zinc-700 bg-zinc-900 font-mono text-[11px] font-medium text-orange-400">
                        {idx + 1}
                      </span>
                      <div className="min-w-0 space-y-1.5">
                        <p className="text-[15px] font-medium leading-snug text-zinc-100">
                          {t.content}
                        </p>
                        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
                          {renderPriorityBadge(t.priority)}
                          {repoDisplay && (
                            <span className="rounded border border-zinc-800 bg-zinc-900/80 px-1.5 py-0.5 text-zinc-400">
                              {repoDisplay}
                            </span>
                          )}
                          <span className="rounded border border-zinc-800 bg-zinc-900/80 px-1.5 py-0.5 text-zinc-400">
                            ⏱ {s.suggestedMinutes}m
                          </span>
                          {s.signals.map((sig) => renderSignalBadge(sig))}
                        </div>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5 pt-0.5 font-mono text-[11px]">
                      {s.strategy === "agent" ? (
                        <>
                          <button
                            type="button"
                            onClick={() => onPickAgent(t, s.targetServerId)}
                            title={`Delegate to OpenCode (${s.targetServerId || defaultServerId}) (Key ${idx + 1})`}
                            className="rounded border border-orange-500/50 bg-orange-950/60 px-2.5 py-1 font-medium text-orange-300 hover:border-orange-500 hover:bg-orange-900/80"
                          >
                            {idx + 1}: ◈ Run {s.targetServerId || defaultServerId}
                          </button>
                          <button
                            type="button"
                            onClick={() => onPickFocus(t)}
                            title="Pull into Focus queue"
                            className="rounded border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                          >
                            🎯 Focus
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => onPickFocus(t)}
                            title={`Pull into Focus queue (Key ${idx + 1})`}
                            className="rounded border border-orange-500/50 bg-orange-950/60 px-2.5 py-1 font-medium text-orange-300 hover:border-orange-500 hover:bg-orange-900/80"
                          >
                            {idx + 1}: 🎯 Focus
                          </button>
                          <button
                            type="button"
                            onClick={() => onPickStart(t, s.suggestedMinutes)}
                            title={`Move to Focus and start ${s.suggestedMinutes}m timer`}
                            className="rounded border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                          >
                            ▶ {s.suggestedMinutes}m
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function FocusView({
  focusTasks,
  bufferTasks,
  backlogTasks,
  sessions,
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
  ocVerifyById,
  ocModelsByServer,
  ocProjectsByServer,
  onAddProject,
  onRefreshProjects,
  defaultServerId,
  ocSessions,
  unlinkedOcSessions,
  queuedTasks,
  autoRunQueued,
  onRunQueued,
  onOpenOcSettings,
  humanSecBy,
  agentSecBy,
  onToggle,
  onHandToAgent,
  onApprove,
  onAnswerForm,
  onInterrupt,
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
  backlogTasks: Task[];
  sessions: Session[];
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
  ocVerifyById?: Record<string, OpenCodeVerifyResult>;
  ocModelsByServer: Record<string, OpenCodeModelOption[]>;
  ocProjectsByServer?: Record<string, OpenCodeRepo[]>;
  onAddProject?: (serverId: string, label: string, dir: string) => void;
  onRefreshProjects?: (serverId: string) => Promise<unknown>;
  defaultServerId: string;
  ocSessions: OpenCodeLiveSession[];
  unlinkedOcSessions: OpenCodeLiveSession[];
  queuedTasks: Task[];
  autoRunQueued: boolean;
  onRunQueued: () => void;
  onOpenOcSettings: () => void;
  humanSecBy: Record<string, number>;
  agentSecBy: Record<string, number>;
  onToggle: (id: string) => void;
  onHandToAgent: (
    t: Task,
    prompt?: string,
    serverId?: string,
    model?: string,
    repo?: string,
    note?: string,
  ) => void;
  onApprove: (t: Task, decision?: "once" | "always" | "reject") => void;
  onAnswerForm: (
    t: Task,
    fieldKeyOrAnswers: string | Record<string, string | string[]>,
    value?: string | string[],
    label?: string,
    steerPrompt?: string,
  ) => void;
  onInterrupt: (t: Task) => void;
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

  const [triageOpen, setTriageOpen] = useState(
    () => focusTasks.length === 0 && backlogTasks.length > 0,
  );
  const [triageLoading, setTriageLoading] = useState(false);
  const [triageData, setTriageData] = useState<TriageResult | null>(null);

  const [jiraOpen, setJiraOpen] = useState(false);
  const [jiraLoading, setJiraLoading] = useState(false);
  const [jiraData, setJiraData] = useState<JiraPullResult | null>(() => loadCachedJiraIssues());

  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(load("tb_sidebar_width", 340));
    return saved >= 240 && saved <= 760 ? saved : 340;
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() =>
    load("tb_sidebar_collapsed", false),
  );
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      save("tb_sidebar_collapsed", next);
      return next;
    });
  }, []);
  const [isResizing, setIsResizing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(expandedId);
  const [mobileShowStage, setMobileShowStage] = useState(false);

  useEffect(() => {
    if (expandedId) setSelectedId(expandedId);
  }, [expandedId]);

  const runJiraPull = useCallback(async () => {
    setJiraLoading(true);
    try {
      const res = await fetchAssignedJiraIssues({
        serverId: defaultServerId,
        liveSessions: ocSessions,
        availableRepos: ocProjectsByServer?.[defaultServerId],
      });
      setJiraData(res);
    } catch {
      /* ignore */
    } finally {
      setJiraLoading(false);
    }
  }, [defaultServerId, ocSessions, ocProjectsByServer]);

  const handlePullJiraIssue = (
    issue: JiraAssignedIssue,
    target: "focus" | "backlog" | "agent",
    matchedSessionIds: string[],
  ) => {
    const title = `[${issue.key}] ${issue.summary}`;
    const noteParts = [issue.url, issue.description].filter(Boolean);
    const hasMatchedSession = matchedSessionIds.length > 0;
    onAdd(title, target === "backlog" ? undefined : focusId, {
      jira: issue.key,
      repo: issue.suggestedRepo || undefined,
      server: defaultServerId,
      note: noteParts.join("\n"),
      prompt: `Work on Jira issue ${issue.key}: ${issue.summary}`,
      sessions: matchedSessionIds,
      mode: target === "agent" && !hasMatchedSession ? "agent" : "save",
    });
    if (hasMatchedSession) {
      void syncSessionToJiraIssue({
        jiraKey: issue.key,
        sessionID: matchedSessionIds[0],
        sessionTitle: title,
        serverId: defaultServerId,
        repo: issue.suggestedRepo,
      });
    }
  };

  const handleLinkJiraSessionToExisting = (task: Task, sessionId: string, jiraKey: string) => {
    const meta = parseTaskDescription(task.description);
    const nextSessions = Array.from(new Set([...meta.sessions, sessionId]));
    const picked = ocSessions.find((s) => s.id === sessionId);
    const nextDesc = formatTaskDescription({
      ...meta,
      jira: meta.jira || jiraKey,
      server: picked?.serverId || meta.server || defaultServerId,
      repo: meta.repo || picked?.repoShort || "",
      sessions: nextSessions,
    });
    void onUpdate(task.id, { description: nextDesc });
    void syncSessionToJiraIssue({
      jiraKey,
      sessionID: sessionId,
      sessionTitle: task.content,
      serverId: picked?.serverId || meta.server || defaultServerId,
      repo: meta.repo || picked?.repoShort,
    });
  };

  const runTriage = useCallback(async () => {
    if (backlogTasks.length === 0) return;
    setTriageLoading(true);
    try {
      const recentRepos = sessions
        .filter((s) => s.repo && Date.now() - s.timestamp < 24 * 3600_000)
        .map((s) => s.repo!)
        .filter(Boolean);
      const res = await suggestBacklogTasks({
        backlogTasks,
        focusTasks,
        recentRepos,
        serverId: defaultServerId,
        defaultMinutes,
      });
      setTriageData(res);
    } catch {
      /* ignore */
    } finally {
      setTriageLoading(false);
    }
  }, [backlogTasks, focusTasks, sessions, defaultServerId, defaultMinutes]);

  useEffect(() => {
    if (triageOpen && !triageData && !triageLoading && backlogTasks.length > 0) {
      void runTriage();
    }
  }, [triageOpen, triageData, triageLoading, backlogTasks.length, runTriage]);

  const handlePickFocus = (t: Task) => {
    if (focusId) onMove(t);
    setTriageData((prev) =>
      prev
        ? {
            ...prev,
            suggestions: prev.suggestions.filter((s) => s.taskId !== t.id),
          }
        : null,
    );
  };

  const handlePickStart = (t: Task, minutes: number) => {
    if (focusId) onMove(t);
    onStart(t, minutes);
    setTriageData((prev) =>
      prev
        ? {
            ...prev,
            suggestions: prev.suggestions.filter((s) => s.taskId !== t.id),
          }
        : null,
    );
  };

  const handlePickAgent = (t: Task, serverId?: string) => {
    if (focusId) onMove(t);
    onHandToAgent(t, undefined, serverId);
    setTriageData((prev) =>
      prev
        ? {
            ...prev,
            suggestions: prev.suggestions.filter((s) => s.taskId !== t.id),
          }
        : null,
    );
  };

  useEffect(() => {
    if (!triageOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;

      if (e.key === "Escape") {
        e.preventDefault();
        setTriageOpen(false);
        return;
      }

      if (e.key === "1" || e.key === "2" || e.key === "3") {
        const idx = Number(e.key) - 1;
        const s = triageData?.suggestions?.[idx];
        if (s) {
          e.preventDefault();
          const targetTask = backlogTasks.find((item) => item.id === s.taskId);
          if (targetTask) {
            if (s.strategy === "agent") {
              handlePickAgent(targetTask, s.targetServerId);
            } else {
              handlePickFocus(targetTask);
            }
          }
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [triageOpen, triageData, backlogTasks]);

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    setIsResizing(true);

    const onMovePtr = (ev: PointerEvent) => {
      const maxW = Math.min(760, Math.max(360, window.innerWidth - 420));
      const next = Math.max(280, Math.min(maxW, startW + (ev.clientX - startX)));
      setSidebarWidth(next);
      save("tb_sidebar_width", next);
    };
    const onUpPtr = () => {
      setIsResizing(false);
      window.removeEventListener("pointermove", onMovePtr);
      window.removeEventListener("pointerup", onUpPtr);
    };
    window.addEventListener("pointermove", onMovePtr);
    window.addEventListener("pointerup", onUpPtr);
  };

  const resetSidebarWidth = () => {
    setSidebarWidth(340);
    save("tb_sidebar_width", 340);
  };

  const combinedTasks = useMemo(() => {
    const seen = new Set<string>();
    const list: Task[] = [];
    for (const t of [...focusTasks, ...bufferTasks]) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        list.push(t);
      }
    }
    return list;
  }, [focusTasks, bufferTasks]);

  const laneNeedsYou = useMemo(() => {
    return combinedTasks.filter((t) => {
      const r = resolveTaskTriage(t, ocSessions);
      return r.triage === "needs_you" && Boolean(r.liveSession?.form || r.liveSession?.permission);
    });
  }, [combinedTasks, ocSessions]);

  const laneParked = useMemo(() => {
    return combinedTasks.filter((t) => {
      const r = resolveTaskTriage(t, ocSessions);
      return r.triage === "needs_you" && !r.liveSession?.form && !r.liveSession?.permission;
    });
  }, [combinedTasks, ocSessions]);

  const laneWorking = useMemo(
    () => combinedTasks.filter((t) => resolveTaskTriage(t, ocSessions).triage === "working"),
    [combinedTasks, ocSessions],
  );

  const laneQueuedFocus = useMemo(
    () => focusTasks.filter((t) => resolveTaskTriage(t, ocSessions).triage === "queued"),
    [focusTasks, ocSessions],
  );

  const laneQueuedBuffer = useMemo(
    () => bufferTasks.filter((t) => resolveTaskTriage(t, ocSessions).triage === "queued"),
    [bufferTasks, ocSessions],
  );

  const orderedBoardTasks = useMemo(
    () => [...laneNeedsYou, ...laneParked, ...laneWorking, ...laneQueuedFocus, ...laneQueuedBuffer],
    [laneNeedsYou, laneParked, laneWorking, laneQueuedFocus, laneQueuedBuffer],
  );

  const selectedTask =
    orderedBoardTasks.find((t) => t.id === selectedId) ??
    laneNeedsYou[0] ??
    laneParked[0] ??
    laneWorking[0] ??
    laneQueuedFocus[0] ??
    laneQueuedBuffer[0] ??
    null;

  const selectTask = (id: string, openMobile = false) => {
    setTriageOpen(false);
    setJiraOpen(false);
    setSelectedId(id);
    if (expandedId !== id) onToggle(id);
    if (openMobile) setMobileShowStage(true);
  };

  const advanceAfterAction = (actedId: string) => {
    const nextWaiting = laneNeedsYou.find((t) => t.id !== actedId);
    if (nextWaiting) {
      setSelectedId(nextWaiting.id);
      if (expandedId !== nextWaiting.id) onToggle(nextWaiting.id);
    } else {
      setSelectedId(actedId);
    }
  };

  const renderSidebarCard = (t: Task, isBuffer = false) => {
    const { triage, liveSession, meta } = resolveTaskTriage(t, ocSessions);
    const active = selectedTask?.id === t.id;
    const isAgentTask = Boolean(
      liveSession || meta.server || meta.repo || meta.prompt || meta.queued || (meta.sessions && meta.sessions.length > 0),
    );
    const assignedServerId = liveSession?.serverId || meta.server || (isAgentTask ? defaultServerId : "");
    const isAssignedOnline = assignedServerId ? (ocServerOnlineById[assignedServerId] ?? ocConnected) : false;
    const repoShort = shortRepo(meta.repo || liveSession?.repoShort);
    const targetBadge = isAgentTask
      ? [
          ocServers.length > 1 || (meta.server && meta.server !== defaultServerId)
            ? assignedServerId
            : null,
          repoShort,
        ]
          .filter(Boolean)
          .join("/")
      : null;
    const aSec = agentSecBy[t.id] ?? 0;
    const hSec = humanSecBy[t.id] ?? 0;
    const spent = (spentBy[t.id] ?? 0) + Math.floor(hSec / 60);
    const planned = t.duration?.amount ?? defaultMinutes;
    const isQueuedForAgent = !liveSession && Boolean(meta.queued);

    const statusLabel = liveSession?.form
      ? "Question"
      : liveSession?.permission
        ? "Permission"
        : triage === "needs_you"
          ? "Parked · Ready for review"
          : triage === "working"
            ? `Processing${aSec > 0 ? ` · ${fmt(aSec)}` : ""}`
            : isQueuedForAgent
              ? `Queued for ${assignedServerId}`
              : isBuffer
                ? "Buffer"
                : `${spent > 0 ? `${spent}m/` : ""}${planned}m`;

    return (
      <li key={t.id}>
        <div
          onClick={() => selectTask(t.id, true)}
          className={`group flex cursor-pointer flex-col gap-1 rounded-lg border px-2.5 py-2 transition-all duration-150 ${
            active
              ? "border-orange-500 bg-zinc-900/95 shadow-sm"
              : triage === "needs_you"
                ? "border-zinc-800/90 bg-zinc-900/55 hover:border-zinc-700 hover:bg-zinc-900/80"
                : "border-zinc-800/75 bg-zinc-900/30 hover:border-zinc-700 hover:bg-zinc-900/65"
          } ${isNew(t) ? "row-new" : ""}`}
        >
          <div className="flex items-center justify-between gap-1.5 font-mono text-[10.5px]">
            <div className="flex min-w-0 items-center gap-1.5">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  advanceAfterAction(t.id);
                  onComplete(t);
                }}
                title="Mark task Done"
                aria-label="Mark task Done"
                className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border border-zinc-700 text-[9px] text-transparent transition-colors hover:border-orange-500 hover:text-orange-400"
              >
                ✓
              </button>
              <span
                className={
                  triage === "needs_you"
                    ? liveSession?.form || liveSession?.permission
                      ? "font-medium text-orange-400"
                      : "font-medium text-emerald-400"
                    : triage === "working"
                      ? "text-zinc-200"
                      : isQueuedForAgent
                        ? "text-amber-400"
                        : "text-zinc-500"
                }
              >
                {statusLabel}
              </span>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              {meta.jira && (
                <span className="rounded border border-blue-500/30 bg-blue-950/40 px-1 py-0.2 font-mono text-[9.5px] text-blue-300">
                  {meta.jira}
                </span>
              )}
              {targetBadge && <span className="text-zinc-500">{targetBadge}</span>}
              {triage === "working" && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onInterrupt(t);
                  }}
                  title="Stop running agent"
                  className="rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:border-red-500/40 hover:text-red-400"
                >
                  Stop
                </button>
              )}
              {triage === "queued" && isBuffer && focusId && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onMove(t);
                  }}
                  title="Move to Focus"
                  className="rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                >
                  → Focus
                </button>
              )}
              {triage === "queued" && !isAgentTask && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onStart(t, planned);
                  }}
                  title={`Start ${planned}m Pomodoro timer`}
                  aria-label={`Start ${planned}m Pomodoro timer`}
                  className="rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-[10px] font-medium text-zinc-200 hover:border-orange-500/60 hover:text-orange-300 transition-colors"
                >
                  ⏱ Start
                </button>
              )}
              {triage === "queued" && isAgentTask && (!isQueuedForAgent || isAssignedOnline) && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    selectTask(t.id, false);
                    onHandToAgent(t, undefined, assignedServerId);
                  }}
                  title={
                    isAssignedOnline
                      ? `Run on ${assignedServerId}`
                      : `Queue for ${assignedServerId}`
                  }
                  className="rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-[10px] font-medium text-orange-400 hover:border-orange-500/60 hover:text-orange-300"
                >
                  Run
                </button>
              )}
            </div>
          </div>

          <p className="line-clamp-2 text-[13.5px] font-medium leading-snug text-zinc-100">
            {t.content}
          </p>

          {liveSession?.form && (
            <p className="truncate text-[11.5px] text-orange-300/90">
              {liveSession.form.fields?.[0]?.title || liveSession.form.title}
            </p>
          )}
          {liveSession?.permission && (
            <p className="truncate font-mono text-[10.5px] text-orange-300/90">
              Allow {liveSession.permission.action}: {liveSession.permission.resources.join(" ")}
            </p>
          )}
        </div>
      </li>
    );
  };

  const isAuthRequired =
    !ocConnected &&
    Object.values(ocVerifyById ?? {}).some((v) => v?.error?.includes("401"));

  return (
    <div className="flex-1 min-h-0 flex flex-col md:h-full">
      {/* Draggable Triage Sidebar + Wide Main Stage */}
      <div
        className={`flex flex-1 min-h-0 flex-col md:flex-row items-stretch ${
          isResizing ? "select-none cursor-col-resize" : ""
        }`}
      >
        {/* LEFT TRIAGE SIDEBAR */}
        <aside
          aria-label="Focus task queues"
          style={{ "--sidebar-w": `${sidebarWidth}px` } as React.CSSProperties}
          className={`w-full shrink-0 space-y-3 md:w-[var(--sidebar-w)] md:h-full md:overflow-y-auto md:pr-1 [scrollbar-width:thin] [scrollbar-color:rgba(113,113,122,0.3)_transparent] ${
            sidebarCollapsed
              ? "hidden"
              : mobileShowStage && selectedTask
                ? "hidden md:block"
                : "block"
          }`}
        >
          {queuedTasks.length > 0 && (
            <div className="flex items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-900/90 px-2.5 py-1.5 text-[11.5px]">
              <div className="flex min-w-0 items-center gap-1.5 text-zinc-300">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400 animate-pulse" />
                <span className="truncate">
                  {ocConnected
                    ? autoRunQueued
                      ? `Launching ${queuedTasks.length} queued…`
                      : `${queuedTasks.length} queued`
                    : isAuthRequired
                      ? `${queuedTasks.length} queued (auth req)`
                      : `${queuedTasks.length} queued offline`}
                </span>
              </div>
              {ocConnected && !autoRunQueued ? (
                <button
                  type="button"
                  onClick={onRunQueued}
                  className="shrink-0 rounded bg-orange-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-orange-500"
                >
                  ▶ Run
                </button>
              ) : !ocConnected ? (
                <button
                  type="button"
                  onClick={onOpenOcSettings}
                  className="shrink-0 rounded border border-orange-500/40 bg-orange-950/30 px-2 py-0.5 text-[11px] font-medium text-orange-400 hover:border-orange-500"
                >
                  ⚙
                </button>
              ) : null}
            </div>
          )}

          {showPlan && (
            <div className="flex items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-[11.5px]">
              <span className="truncate text-zinc-400">Pull up to {cap} tasks</span>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  className="rounded bg-orange-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-orange-500"
                  onClick={() => {
                    setTriageOpen(true);
                    setMobileShowStage(true);
                    if (!triageData && !triageLoading) void runTriage();
                  }}
                >
                  ⚡ Triage
                </button>
                <button
                  className="px-1 text-zinc-500 hover:text-zinc-300"
                  onClick={() => {
                    save("tb_plan_dismissed", todayStr());
                    setDismissed(todayStr());
                  }}
                  title="Dismiss"
                >
                  ×
                </button>
              </div>
            </div>
          )}

          {/* GROUP 1: WAITING FOR YOUR ANSWER (only rendered when non-empty) */}
          {laneNeedsYou.length > 0 && (
            <section className="space-y-1.5">
              <div className="flex items-center justify-between px-1">
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-orange-500" />
                  <h2 className="text-[11px] font-semibold uppercase tracking-wider text-orange-400">
                    Waiting for Your Answer
                  </h2>
                </div>
                <span className="font-mono text-[11px] tabular-nums text-orange-400">
                  {laneNeedsYou.length}
                </span>
              </div>
              <ul className="space-y-1">
                {laneNeedsYou.map((t) => renderSidebarCard(t, t.section_id === bufferId))}
              </ul>
            </section>
          )}

          {/* GROUP 1B: PARKED (AGENT FINISHED · READY FOR REVIEW) */}
          {laneParked.length > 0 && (
            <section className="space-y-1.5">
              <div className="flex items-center justify-between px-1">
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  <h2 className="text-[11px] font-semibold uppercase tracking-wider text-emerald-400">
                    Parked (Ready for Review)
                  </h2>
                </div>
                <span className="font-mono text-[11px] tabular-nums text-emerald-400">
                  {laneParked.length}
                </span>
              </div>
              <ul className="space-y-1">
                {laneParked.map((t) => renderSidebarCard(t, t.section_id === bufferId))}
              </ul>
            </section>
          )}

          {/* GROUP 2: AGENT PROCESSING (only rendered when non-empty) */}
          {laneWorking.length > 0 && (
            <section className="space-y-1.5">
              <div className="flex items-center justify-between px-1">
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-zinc-200 animate-pulse" />
                  <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
                    Agent Processing
                  </h2>
                </div>
                <span className="font-mono text-[11px] tabular-nums text-zinc-400">
                  {laneWorking.length}
                </span>
              </div>
              <ul className="space-y-1">
                {laneWorking.map((t) => renderSidebarCard(t, t.section_id === bufferId))}
              </ul>
            </section>
          )}

          {/* GROUP 3: READY IN FOCUS & BUFFER */}
          <section className="space-y-1.5">
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-zinc-600" />
                <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                  Focus
                </h2>
                <span
                  title={
                    focusTasks.length > cap
                      ? `Too many priorities — Focus holds ${cap}. Move something back to Backlog.`
                      : `Focus capacity: ${focusTasks.length}/${cap}`
                  }
                  className={`rounded px-1.5 py-0.2 font-mono text-[10px] tabular-nums ${
                    focusTasks.length > cap
                      ? "border border-amber-500/40 bg-amber-950/40 text-amber-300"
                      : "text-zinc-500"
                  }`}
                >
                  {focusTasks.length}/{cap}
                  {focusTasks.length > cap ? " over" : ""}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setTriageOpen(false);
                    setJiraOpen(true);
                    setMobileShowStage(true);
                    if (!jiraData?.issues?.length && !jiraLoading) void runJiraPull();
                  }}
                  className="inline-flex items-center gap-1 rounded border border-blue-500/40 bg-zinc-900/80 px-1.5 py-0.5 font-mono text-[10px] font-medium text-blue-400 hover:border-blue-500 hover:text-blue-300"
                  title="Pull assigned Jira issues via Atlassian MCP"
                >
                  🎫 Jira
                </button>
                {backlogTasks.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setJiraOpen(false);
                      setTriageOpen(true);
                      setMobileShowStage(true);
                      if (!triageData && !triageLoading) void runTriage();
                    }}
                    className="inline-flex items-center gap-1 rounded border border-orange-500/40 bg-zinc-900/80 px-1.5 py-0.5 font-mono text-[10px] font-medium text-orange-400 hover:border-orange-500 hover:text-orange-300"
                    title="Triage top tasks from Backlog"
                  >
                    ⚡ Triage
                  </button>
                )}
                <button
                  type="button"
                  onClick={toggleSidebar}
                  className="hidden md:inline-flex items-center justify-center rounded border border-zinc-800 bg-zinc-900/80 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                  title="Collapse task list sidebar"
                >
                  «
                </button>
              </div>
            </div>

            {laneQueuedFocus.length === 0 && laneQueuedBuffer.length === 0 ? (
              <div className="rounded-lg border border-zinc-900 bg-zinc-950/50 p-2.5 space-y-1.5">
                <div className="flex items-center justify-between text-[11.5px] text-zinc-400">
                  <span>No queued tasks ({focusTasks.length}/{cap})</span>
                  <span className="font-mono text-[10.5px] text-zinc-500">
                    {backlogTasks.length} in backlog
                  </span>
                </div>
                {backlogTasks.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setTriageOpen(true);
                      setMobileShowStage(true);
                      if (!triageData && !triageLoading) void runTriage();
                    }}
                    className="flex w-full items-center justify-center gap-1.5 rounded border border-orange-500/40 bg-orange-950/30 px-2.5 py-1.5 text-[12px] font-medium text-orange-400 hover:border-orange-500 hover:bg-orange-950/50 transition-colors"
                  >
                    <span>⚡ Triage Backlog ({backlogTasks.length})</span>
                  </button>
                )}
              </div>
            ) : (
              <ul className="space-y-1">
                {laneQueuedFocus.map((t) => renderSidebarCard(t, false))}
                {laneQueuedBuffer.map((t) => renderSidebarCard(t, true))}
              </ul>
            )}

            {focusId && (
              <AddRow
                ocConnected={ocConnected}
                ocServers={ocServers}
                ocServerOnlineById={ocServerOnlineById}
                ocModelsByServer={ocModelsByServer}
                ocProjectsByServer={ocProjectsByServer}
                onAddProject={onAddProject}
                onRefreshProjects={onRefreshProjects}
                defaultServerId={defaultServerId}
                placeholder="＋ Add to Focus… (~server @repo // prompt or Tab)"
                hotkey="n"
                sections={sections}
                onAdd={(raw, extra) => onAdd(raw, focusId, extra)}
              />
            )}

            {bufferId && (
              <AddRow
                ocConnected={ocConnected}
                ocServers={ocServers}
                ocServerOnlineById={ocServerOnlineById}
                ocModelsByServer={ocModelsByServer}
                ocProjectsByServer={ocProjectsByServer}
                onAddProject={onAddProject}
                onRefreshProjects={onRefreshProjects}
                defaultServerId={defaultServerId}
                placeholder="＋ Add to Buffer… (hotkey b)"
                hotkey="b"
                sections={sections}
                onAdd={(raw, extra) => onAdd(raw, bufferId, extra)}
              />
            )}
          </section>

          {unlinkedOcSessions.length > 0 && (
            <section className="border-t border-zinc-900 pt-2">
              <p className="mb-1 px-1 text-[11px] text-zinc-500">
                Unlinked sessions (24h)
              </p>
              <ul className="space-y-0.5">
                {unlinkedOcSessions.slice(0, 6).map((s) => (
                  <li
                    key={s.id}
                    className="flex min-h-7 items-center justify-between gap-2 rounded px-1.5 text-[12px] text-zinc-400 hover:bg-zinc-900"
                  >
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          s.status === "running"
                            ? "bg-zinc-300 animate-pulse"
                            : "bg-orange-500"
                        }`}
                      />
                      {ocServers.length > 1 && (
                        <span className="shrink-0 rounded border border-zinc-800 bg-zinc-900 px-1 py-0.2 font-mono text-[10px] text-zinc-400">
                          {s.serverId}
                        </span>
                      )}
                      <span className="truncate text-zinc-300">{s.title}</span>
                      {s.repoShort && (
                        <span className="shrink-0 font-mono text-[10px] text-zinc-600">
                          {s.repoShort}
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        onClick={() => onTrackOcSession(s)}
                        className="text-[11px] text-zinc-400 hover:text-orange-500"
                        title="Create a Todoist Focus task linked to this session"
                      >
                        ＋ Track
                      </button>
                      <button
                        onClick={() => onIgnoreOcSession(s.id)}
                        className="px-1 text-[11px] text-zinc-600 hover:text-zinc-400"
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
        </aside>

        {/* DRAGGABLE RESIZE HANDLE (Desktop md+) */}
        {!sidebarCollapsed && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Drag to resize sidebar (double-click to reset)"
            title="Drag to resize sidebar · Double-click to reset"
            onPointerDown={startResize}
            onDoubleClick={resetSidebarWidth}
            className="group hidden md:flex w-3 shrink-0 cursor-col-resize items-stretch justify-center self-stretch py-1 select-none md:h-full"
          >
            <div
              className={`w-px transition-colors duration-150 ${
                isResizing
                  ? "w-0.5 bg-orange-500"
                  : "bg-zinc-800/80 group-hover:w-0.5 group-hover:bg-orange-500/80"
              }`}
            />
          </div>
        )}

        {/* RIGHT MAIN STAGE WORKSPACE */}
        <div
          className={`min-w-0 flex-1 min-h-0 flex flex-col md:h-full ${
            mobileShowStage && (selectedTask || triageOpen || jiraOpen) ? "block" : "hidden md:flex"
          }`}
        >
          {mobileShowStage && (selectedTask || triageOpen || jiraOpen) && (
            <button
              type="button"
              onClick={() => {
                setMobileShowStage(false);
                setTriageOpen(false);
                setJiraOpen(false);
              }}
              className="mb-2 inline-flex items-center gap-1.5 text-[12px] font-medium text-orange-400 md:hidden"
            >
              ← Back to Focus queues
              {laneNeedsYou.length > 0 ? ` (${laneNeedsYou.length} waiting)` : ""}
            </button>
          )}

          {jiraOpen ? (
            <JiraPullStage
              data={jiraData}
              loading={jiraLoading}
              allTasks={[...focusTasks, ...bufferTasks, ...backlogTasks]}
              ocSessions={ocSessions}
              defaultServerId={defaultServerId}
              onRefresh={runJiraPull}
              onPullIssue={handlePullJiraIssue}
              onSelectExistingTask={(taskId) => {
                setJiraOpen(false);
                selectTask(taskId, true);
              }}
              onLinkSessionToExisting={handleLinkJiraSessionToExisting}
              onClose={() => setJiraOpen(false)}
            />
          ) : triageOpen && backlogTasks.length > 0 ? (
            <TriageStage
              suggestions={triageData?.suggestions ?? []}
              loading={triageLoading}
              source={triageData?.source}
              serverName={triageData?.serverName}
              modelLabel={triageData?.modelLabel}
              backlogTasks={backlogTasks}
              defaultServerId={defaultServerId}
              onPickFocus={handlePickFocus}
              onPickStart={handlePickStart}
              onPickAgent={handlePickAgent}
              onRefresh={runTriage}
              onClose={() => setTriageOpen(false)}
            />
          ) : selectedTask ? (
            <div className="flex-1 min-h-0 flex flex-col md:h-full">
              <TaskRow
                key={selectedTask.id}
                t={selectedTask}
                large
                stageMode
                sidebarCollapsed={sidebarCollapsed}
                onToggleSidebar={toggleSidebar}
                durations={durations}
                defaultMinutes={defaultMinutes}
                spentBy={spentBy}
                ocConnected={ocConnected}
                ocServers={ocServers}
                ocServerOnlineById={ocServerOnlineById}
                ocVerifyById={ocVerifyById}
                onOpenOcSettings={onOpenOcSettings}
                ocModelsByServer={ocModelsByServer}
                ocProjectsByServer={ocProjectsByServer}
                onAddProject={onAddProject}
                onRefreshProjects={onRefreshProjects}
                defaultServerId={defaultServerId}
                ocSessions={ocSessions}
                humanSec={humanSecBy[selectedTask.id] ?? 0}
                agentSec={agentSecBy[selectedTask.id] ?? 0}
                expanded={true}
                onToggle={() => setMobileShowStage(false)}
                onHandToAgent={(p, srvId, mdl, rp, nt) => {
                  setSelectedId(selectedTask.id);
                  onHandToAgent(selectedTask, p, srvId, mdl, rp, nt);
                }}
                onApprove={(dec) => {
                  onApprove(selectedTask, dec);
                  if (dec !== "reject") advanceAfterAction(selectedTask.id);
                }}
                onAnswerForm={(k, v, l, st) => {
                  onAnswerForm(selectedTask, k, v, l, st);
                  advanceAfterAction(selectedTask.id);
                }}
                onInterrupt={() => onInterrupt(selectedTask)}
                onStart={onStart}
                onMove={
                  selectedTask.section_id === bufferId && focusId ? onMove : undefined
                }
                onComplete={() => {
                  advanceAfterAction(selectedTask.id);
                  onComplete(selectedTask);
                }}
                onDemote={onDemote}
                onMoveProject={onMoveProject}
                projects={projects}
                onUpdate={onUpdate}
                onDuration={onDuration}
                onDelete={(taskToDelete) => {
                  advanceAfterAction(taskToDelete.id);
                  onDelete(taskToDelete);
                }}
              />
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-8 text-center">
              {sidebarCollapsed && (
                <button
                  type="button"
                  onClick={toggleSidebar}
                  className="mb-3 rounded border border-zinc-800 bg-zinc-900 px-2.5 py-1 font-mono text-[11px] text-zinc-300 hover:border-zinc-700"
                >
                  » Show Sidebar
                </button>
              )}
              <p className="text-[15px] font-medium text-zinc-200">
                No active tasks in Focus
              </p>
              <p className="mt-1 text-[13px] text-zinc-500">
                Add a task in the left sidebar or pull tasks from your Backlog to begin.
              </p>
              <div className="mt-4 flex items-center justify-center gap-2">
                {backlogTasks.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setTriageOpen(true);
                      if (!triageData && !triageLoading) void runTriage();
                    }}
                    className="rounded-md bg-orange-600 px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-orange-500"
                  >
                    ⚡ Triage Backlog ({backlogTasks.length})
                  </button>
                )}
                <button
                  type="button"
                  onClick={onGoBacklog}
                  className="rounded-md border border-zinc-700 bg-zinc-900 px-3.5 py-1.5 text-[13px] text-zinc-300 hover:border-zinc-600 hover:text-zinc-100"
                >
                  Browse Backlog →
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BacklogView({
  backlogTasks,
  focusTasks,
  sessions,
  sections,
  focusId,
  durations,
  defaultMinutes,
  spentBy,
  expandedId,
  ocConnected,
  ocServers,
  ocServerOnlineById,
  ocVerifyById,
  ocModelsByServer,
  ocProjectsByServer,
  onAddProject,
  onRefreshProjects,
  defaultServerId,
  ocSessions,
  onOpenOcSettings,
  humanSecBy,
  agentSecBy,
  onToggle,
  onHandToAgent,
  onApprove,
  onAnswerForm,
  onInterrupt,
  onStart,
  onMove,
  onMoveProject,
  projects,
  onAdd,
  onComplete,
  onUpdate,
  onDuration,
  onDelete,
}: {
  backlogTasks: Task[];
  focusTasks: Task[];
  sessions: Session[];
  sections: SectionMap;
  backlogId?: string;
  focusId?: string;
  durations: number[];
  defaultMinutes: number;
  spentBy: Record<string, number>;
  expandedId: string | null;
  ocConnected: boolean;
  ocServers: OpenCodeServer[];
  ocServerOnlineById: Record<string, boolean>;
  ocVerifyById?: Record<string, OpenCodeVerifyResult>;
  ocModelsByServer: Record<string, OpenCodeModelOption[]>;
  ocProjectsByServer?: Record<string, OpenCodeRepo[]>;
  onAddProject?: (serverId: string, label: string, dir: string) => void;
  onRefreshProjects?: (serverId: string) => Promise<unknown>;
  defaultServerId: string;
  ocSessions: OpenCodeLiveSession[];
  onOpenOcSettings: () => void;
  humanSecBy: Record<string, number>;
  agentSecBy: Record<string, number>;
  onToggle: (id: string) => void;
  onHandToAgent: (
    t: Task,
    prompt?: string,
    serverId?: string,
    model?: string,
    repo?: string,
    note?: string,
  ) => void;
  onApprove: (t: Task, decision?: "once" | "always" | "reject") => void;
  onAnswerForm: (
    t: Task,
    fieldKeyOrAnswers: string | Record<string, string | string[]>,
    value?: string | string[],
    label?: string,
    steerPrompt?: string,
  ) => void;
  onInterrupt: (t: Task) => void;
  onStart?: (t: Task, minutes: number) => void;
  onMove?: (t: Task) => void;
  onMoveProject?: (t: Task, projectId: string) => void;
  projects?: Project[];
  onAdd: (raw: string, extra?: AddExtra) => void;
  onComplete: (t: Task) => void;
  onUpdate: (id: string, fields: { content?: string; description?: string }) => Promise<void>;
  onDuration: (t: Task, minutes: number) => void;
  onDelete: (t: Task) => void;
}) {
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(load("tb_sidebar_width", 340));
    return saved >= 240 && saved <= 760 ? saved : 340;
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() =>
    load("tb_sidebar_collapsed", false),
  );
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      save("tb_sidebar_collapsed", next);
      return next;
    });
  }, []);
  const [isResizing, setIsResizing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(expandedId);
  const [mobileShowStage, setMobileShowStage] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const [triageOpen, setTriageOpen] = useState(false);
  const [triageLoading, setTriageLoading] = useState(false);
  const [triageData, setTriageData] = useState<TriageResult | null>(null);

  const [jiraOpen, setJiraOpen] = useState(false);
  const [jiraLoading, setJiraLoading] = useState(false);
  const [jiraData, setJiraData] = useState<JiraPullResult | null>(() => loadCachedJiraIssues());

  useEffect(() => {
    if (expandedId && backlogTasks.some((t) => t.id === expandedId)) {
      setSelectedId(expandedId);
    }
  }, [expandedId, backlogTasks]);

  const runJiraPull = useCallback(async () => {
    setJiraLoading(true);
    try {
      const res = await fetchAssignedJiraIssues({
        serverId: defaultServerId,
        liveSessions: ocSessions,
        availableRepos: ocProjectsByServer?.[defaultServerId],
      });
      setJiraData(res);
    } catch {
      /* ignore */
    } finally {
      setJiraLoading(false);
    }
  }, [defaultServerId, ocSessions, ocProjectsByServer]);

  const handlePullJiraIssue = (
    issue: JiraAssignedIssue,
    target: "focus" | "backlog" | "agent",
    matchedSessionIds: string[],
  ) => {
    const title = `[${issue.key}] ${issue.summary}`;
    const noteParts = [issue.url, issue.description].filter(Boolean);
    const hasMatchedSession = matchedSessionIds.length > 0;
    onAdd(
      `${title}${target === "focus" ? " #Focus" : ""}`,
      {
        jira: issue.key,
        repo: issue.suggestedRepo || undefined,
        server: defaultServerId,
        note: noteParts.join("\n"),
        prompt: `Work on Jira issue ${issue.key}: ${issue.summary}`,
        sessions: matchedSessionIds,
        mode: target === "agent" && !hasMatchedSession ? "agent" : "save",
      },
    );
    if (hasMatchedSession) {
      void syncSessionToJiraIssue({
        jiraKey: issue.key,
        sessionID: matchedSessionIds[0],
        sessionTitle: title,
        serverId: defaultServerId,
        repo: issue.suggestedRepo,
      });
    }
  };

  const handleLinkJiraSessionToExisting = (task: Task, sessionId: string, jiraKey: string) => {
    const meta = parseTaskDescription(task.description);
    const nextSessions = Array.from(new Set([...meta.sessions, sessionId]));
    const picked = ocSessions.find((s) => s.id === sessionId);
    const nextDesc = formatTaskDescription({
      ...meta,
      jira: meta.jira || jiraKey,
      server: picked?.serverId || meta.server || defaultServerId,
      repo: meta.repo || picked?.repoShort || "",
      sessions: nextSessions,
    });
    void onUpdate(task.id, { description: nextDesc });
    void syncSessionToJiraIssue({
      jiraKey,
      sessionID: sessionId,
      sessionTitle: task.content,
      serverId: picked?.serverId || meta.server || defaultServerId,
      repo: meta.repo || picked?.repoShort,
    });
  };

  const runTriage = useCallback(async () => {
    if (backlogTasks.length === 0) return;
    setTriageLoading(true);
    try {
      const recentRepos = sessions
        .filter((s) => s.repo && Date.now() - s.timestamp < 24 * 3600_000)
        .map((s) => s.repo!)
        .filter(Boolean);
      const res = await suggestBacklogTasks({
        backlogTasks,
        focusTasks,
        recentRepos,
        serverId: defaultServerId,
        defaultMinutes,
      });
      setTriageData(res);
    } catch {
      /* ignore */
    } finally {
      setTriageLoading(false);
    }
  }, [backlogTasks, focusTasks, sessions, defaultServerId, defaultMinutes]);

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    setIsResizing(true);

    const onMovePtr = (ev: PointerEvent) => {
      const maxW = Math.min(760, Math.max(360, window.innerWidth - 420));
      const next = Math.max(280, Math.min(maxW, startW + (ev.clientX - startX)));
      setSidebarWidth(next);
      save("tb_sidebar_width", next);
    };
    const onUpPtr = () => {
      setIsResizing(false);
      window.removeEventListener("pointermove", onMovePtr);
      window.removeEventListener("pointerup", onUpPtr);
    };
    window.addEventListener("pointermove", onMovePtr);
    window.addEventListener("pointerup", onUpPtr);
  };

  const resetSidebarWidth = () => {
    setSidebarWidth(340);
    save("tb_sidebar_width", 340);
  };

  const selectedTask =
    backlogTasks.find((t) => t.id === selectedId) ?? backlogTasks[0] ?? null;

  const selectTask = (id: string, openMobile = false) => {
    setTriageOpen(false);
    setJiraOpen(false);
    setSelectedId(id);
    if (expandedId !== id) onToggle(id);
    if (openMobile) setMobileShowStage(true);
  };

  const backlogNeedsYou = useMemo(
    () =>
      backlogTasks.filter((t) => {
        const r = resolveTaskTriage(t, ocSessions);
        return r.triage === "needs_you" && Boolean(r.liveSession?.form || r.liveSession?.permission);
      }),
    [backlogTasks, ocSessions],
  );
  const backlogParked = useMemo(
    () =>
      backlogTasks.filter((t) => {
        const r = resolveTaskTriage(t, ocSessions);
        return r.triage === "needs_you" && !r.liveSession?.form && !r.liveSession?.permission;
      }),
    [backlogTasks, ocSessions],
  );
  const backlogWorking = useMemo(
    () => backlogTasks.filter((t) => resolveTaskTriage(t, ocSessions).triage === "working"),
    [backlogTasks, ocSessions],
  );
  const backlogQueued = useMemo(
    () => backlogTasks.filter((t) => resolveTaskTriage(t, ocSessions).triage === "queued"),
    [backlogTasks, ocSessions],
  );
  const visibleTasks = showAll ? backlogQueued : backlogQueued.slice(0, PAGE);

  const renderBacklogCard = (t: Task) => {
    const { triage, liveSession, meta } = resolveTaskTriage(t, ocSessions);
    const active = !triageOpen && selectedTask?.id === t.id;
    const isAgentTask = Boolean(
      liveSession ||
        meta.server ||
        meta.repo ||
        meta.prompt ||
        meta.queued ||
        (meta.sessions && meta.sessions.length > 0),
    );
    const assignedServerId =
      liveSession?.serverId || meta.server || (isAgentTask ? defaultServerId : "");
    const isAssignedOnline = assignedServerId
      ? (ocServerOnlineById[assignedServerId] ?? ocConnected)
      : false;
    const repoShort = shortRepo(meta.repo || liveSession?.repoShort);
    const targetBadge = isAgentTask
      ? [
          ocServers.length > 1 || (meta.server && meta.server !== defaultServerId)
            ? assignedServerId
            : null,
          repoShort,
        ]
          .filter(Boolean)
          .join("/")
      : null;
    const hSec = humanSecBy[t.id] ?? 0;
    const spent = (spentBy[t.id] ?? 0) + Math.floor(hSec / 60);
    const planned = t.duration?.amount ?? defaultMinutes;
    const isQueuedForAgent = !liveSession && Boolean(meta.queued);
    const priLabel =
      t.priority === 4
        ? "P1"
        : t.priority === 3
          ? "P2"
          : t.priority === 2
            ? "P3"
            : null;

    return (
      <li key={t.id}>
        <div
          onClick={() => selectTask(t.id, true)}
          className={`group flex cursor-pointer flex-col gap-1 rounded-lg border px-2.5 py-2 transition-all duration-150 ${
            active
              ? "border-orange-500 bg-zinc-900/95 shadow-sm"
              : "border-zinc-800/75 bg-zinc-900/30 hover:border-zinc-700 hover:bg-zinc-900/65"
          } ${isNew(t) ? "row-new" : ""}`}
        >
          <div className="flex items-center justify-between gap-1.5 font-mono text-[10.5px]">
            <div className="flex min-w-0 items-center gap-1.5">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onComplete(t);
                }}
                title="Mark task Done"
                aria-label="Mark task Done"
                className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border border-zinc-700 text-[9px] text-transparent transition-colors hover:border-orange-500 hover:text-orange-400"
              >
                ✓
              </button>
              {priLabel && (
                <span
                  className={
                    t.priority === 4
                      ? "font-medium text-orange-400"
                      : t.priority === 3
                        ? "text-zinc-300"
                        : "text-zinc-400"
                  }
                >
                  {priLabel}
                </span>
              )}
              <span
                className={
                  triage === "needs_you"
                    ? liveSession?.form || liveSession?.permission
                      ? "font-medium text-orange-400"
                      : "font-medium text-emerald-400"
                    : triage === "working"
                      ? "text-zinc-200"
                      : "text-zinc-500"
                }
              >
                {liveSession?.form
                  ? "Question"
                  : liveSession?.permission
                    ? "Permission"
                    : triage === "needs_you"
                      ? "Parked · Ready for review"
                      : triage === "working"
                        ? "Processing"
                        : isQueuedForAgent
                          ? `Queued for ${assignedServerId}`
                          : `${spent > 0 ? `${spent}m/` : ""}${planned}m`}
              </span>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              {meta.jira && (
                <span className="rounded border border-blue-500/30 bg-blue-950/40 px-1 py-0.2 font-mono text-[9.5px] text-blue-300">
                  {meta.jira}
                </span>
              )}
              {targetBadge && <span className="text-zinc-500">{targetBadge}</span>}
              {onMove && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onMove(t);
                  }}
                  title="Move to Focus"
                  className="rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                >
                  → Focus
                </button>
              )}
              {triage === "queued" && !isAgentTask && onStart && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onStart(t, planned);
                  }}
                  title={`Move to Focus & start ${planned}m timer`}
                  aria-label={`Move to Focus & start ${planned}m timer`}
                  className="rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-[10px] font-medium text-zinc-200 hover:border-orange-500/60 hover:text-orange-300 transition-colors"
                >
                  ⏱ Start
                </button>
              )}
              {triage === "queued" && isAgentTask && (!isQueuedForAgent || isAssignedOnline) && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onHandToAgent(t, undefined, assignedServerId);
                  }}
                  title={
                    isAssignedOnline
                      ? `Move to Focus & run on ${assignedServerId}`
                      : `Move to Focus & queue for ${assignedServerId}`
                  }
                  className="rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-[10px] font-medium text-orange-400 hover:border-orange-500/60 hover:text-orange-300"
                >
                  Run
                </button>
              )}
            </div>
          </div>

          <p className="line-clamp-2 text-[13.5px] font-medium leading-snug text-zinc-100">
            {t.content}
          </p>
        </div>
      </li>
    );
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col md:h-full">
      <div
        className={`flex flex-1 min-h-0 flex-col md:flex-row items-stretch ${
          isResizing ? "select-none cursor-col-resize" : ""
        }`}
      >
        {/* LEFT BACKLOG SIDEBAR */}
        <aside
          aria-label="Backlog task queue"
          style={{ "--sidebar-w": `${sidebarWidth}px` } as React.CSSProperties}
          className={`w-full shrink-0 space-y-3 md:w-[var(--sidebar-w)] md:h-full md:overflow-y-auto md:pr-1 [scrollbar-width:thin] [scrollbar-color:rgba(113,113,122,0.3)_transparent] ${
            sidebarCollapsed
              ? "hidden"
              : mobileShowStage && (selectedTask || triageOpen)
                ? "hidden md:block"
                : "block"
          }`}
        >
          {backlogNeedsYou.length > 0 && (
            <section className="space-y-1.5">
              <div className="flex items-center justify-between px-1">
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-orange-500" />
                  <h2 className="text-[11px] font-semibold uppercase tracking-wider text-orange-400">
                    Waiting for Your Answer
                  </h2>
                </div>
                <span className="font-mono text-[11px] tabular-nums text-orange-400">
                  {backlogNeedsYou.length}
                </span>
              </div>
              <ul className="space-y-1">
                {backlogNeedsYou.map((t) => renderBacklogCard(t))}
              </ul>
            </section>
          )}

          {backlogParked.length > 0 && (
            <section className="space-y-1.5">
              <div className="flex items-center justify-between px-1">
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  <h2 className="text-[11px] font-semibold uppercase tracking-wider text-emerald-400">
                    Parked (Ready for Review)
                  </h2>
                </div>
                <span className="font-mono text-[11px] tabular-nums text-emerald-400">
                  {backlogParked.length}
                </span>
              </div>
              <ul className="space-y-1">
                {backlogParked.map((t) => renderBacklogCard(t))}
              </ul>
            </section>
          )}

          {backlogWorking.length > 0 && (
            <section className="space-y-1.5">
              <div className="flex items-center justify-between px-1">
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-zinc-200 animate-pulse" />
                  <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
                    Agent Processing
                  </h2>
                </div>
                <span className="font-mono text-[11px] tabular-nums text-zinc-400">
                  {backlogWorking.length}
                </span>
              </div>
              <ul className="space-y-1">
                {backlogWorking.map((t) => renderBacklogCard(t))}
              </ul>
            </section>
          )}

          <section className="space-y-2">
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-zinc-500" />
                <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
                  Backlog
                </h2>
                <span className="font-mono text-[11px] tabular-nums text-zinc-500">
                  {backlogTasks.length}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setTriageOpen(false);
                    setJiraOpen(true);
                    setMobileShowStage(true);
                    if (!jiraData?.issues?.length && !jiraLoading) void runJiraPull();
                  }}
                  className="inline-flex items-center gap-1 rounded border border-blue-500/40 bg-zinc-900/80 px-1.5 py-0.5 font-mono text-[10px] font-medium text-blue-400 hover:border-blue-500 hover:text-blue-300"
                  title="Pull assigned Jira issues via Atlassian MCP"
                >
                  🎫 Jira
                </button>
                {backlogTasks.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setJiraOpen(false);
                      setTriageOpen(true);
                      setMobileShowStage(true);
                      if (!triageData && !triageLoading) void runTriage();
                    }}
                    className="inline-flex items-center gap-1 rounded border border-orange-500/40 bg-zinc-900/80 px-1.5 py-0.5 font-mono text-[10px] font-medium text-orange-400 hover:border-orange-500 hover:text-orange-300"
                    title="Triage top tasks into Focus"
                  >
                    ⚡ Triage
                  </button>
                )}
                <button
                  type="button"
                  onClick={toggleSidebar}
                  className="hidden md:inline-flex items-center justify-center rounded border border-zinc-800 bg-zinc-900/80 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                  title="Collapse backlog sidebar"
                >
                  «
                </button>
              </div>
            </div>

            <AddRow
              alwaysOpen
              ocConnected={ocConnected}
              ocServers={ocServers}
              ocServerOnlineById={ocServerOnlineById}
              ocModelsByServer={ocModelsByServer}
              ocProjectsByServer={ocProjectsByServer}
              onAddProject={onAddProject}
              onRefreshProjects={onRefreshProjects}
              defaultServerId={defaultServerId}
              placeholder="＋ Add to Backlog… (~server @repo // prompt or Tab)"
              hotkey="n"
              sections={sections}
              onAdd={(raw, extra) => onAdd(raw, extra)}
            />

            {backlogTasks.length === 0 ? (
              <p className="rounded-lg border border-zinc-900 bg-zinc-950/50 px-3 py-3 text-[12px] text-zinc-500">
                Your parking lot for ideas. Dump anything here — it waits without interrupting you.
              </p>
            ) : (
              <>
                <ul className="space-y-1">
                  {visibleTasks.map((t) => renderBacklogCard(t))}
                </ul>
                {!showAll && backlogQueued.length > PAGE && (
                  <button className={`${btn} mt-1 w-full`} onClick={() => setShowAll(true)}>
                    Show all {backlogQueued.length}…
                  </button>
                )}
              </>
            )}
          </section>
        </aside>

        {/* DRAGGABLE RESIZE HANDLE */}
        {!sidebarCollapsed && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Drag to resize sidebar (double-click to reset)"
            title="Drag to resize sidebar · Double-click to reset"
            onPointerDown={startResize}
            onDoubleClick={resetSidebarWidth}
            className="group hidden md:flex w-3 shrink-0 cursor-col-resize items-stretch justify-center self-stretch py-1 select-none md:h-full"
          >
            <div
              className={`w-px transition-colors duration-150 ${
                isResizing
                  ? "w-0.5 bg-orange-500"
                  : "bg-zinc-800/80 group-hover:w-0.5 group-hover:bg-orange-500/80"
              }`}
            />
          </div>
        )}

        {/* RIGHT MAIN STAGE WORKSPACE */}
        <div
          className={`min-w-0 flex-1 min-h-0 flex flex-col md:h-full ${
            mobileShowStage && (selectedTask || triageOpen || jiraOpen) ? "block" : "hidden md:flex"
          }`}
        >
          {mobileShowStage && (selectedTask || triageOpen || jiraOpen) && (
            <button
              type="button"
              onClick={() => {
                setMobileShowStage(false);
                setTriageOpen(false);
                setJiraOpen(false);
              }}
              className="mb-2 inline-flex items-center gap-1.5 text-[12px] font-medium text-orange-400 md:hidden"
            >
              ← Back to Backlog ({backlogTasks.length})
            </button>
          )}

          {jiraOpen ? (
            <JiraPullStage
              data={jiraData}
              loading={jiraLoading}
              allTasks={[...focusTasks, ...backlogTasks]}
              ocSessions={ocSessions}
              defaultServerId={defaultServerId}
              onRefresh={runJiraPull}
              onPullIssue={handlePullJiraIssue}
              onSelectExistingTask={(taskId) => {
                setJiraOpen(false);
                selectTask(taskId, true);
              }}
              onLinkSessionToExisting={handleLinkJiraSessionToExisting}
              onClose={() => setJiraOpen(false)}
            />
          ) : triageOpen && backlogTasks.length > 0 ? (
            <TriageStage
              suggestions={triageData?.suggestions ?? []}
              loading={triageLoading}
              source={triageData?.source}
              serverName={triageData?.serverName}
              modelLabel={triageData?.modelLabel}
              backlogTasks={backlogTasks}
              defaultServerId={defaultServerId}
              onPickFocus={(t) => {
                onMove?.(t);
              }}
              onPickStart={(t, minutes) => {
                onStart?.(t, minutes);
              }}
              onPickAgent={(t, serverId) => {
                onHandToAgent(t, undefined, serverId);
              }}
              onRefresh={runTriage}
              onClose={() => setTriageOpen(false)}
            />
          ) : selectedTask ? (
            <div className="flex-1 min-h-0 flex flex-col md:h-full">
              <TaskRow
                key={selectedTask.id}
                t={selectedTask}
                large
                stageMode
                sidebarCollapsed={sidebarCollapsed}
                onToggleSidebar={toggleSidebar}
                durations={durations}
                defaultMinutes={defaultMinutes}
                spentBy={spentBy}
                ocConnected={ocConnected}
                ocServers={ocServers}
                ocServerOnlineById={ocServerOnlineById}
                ocVerifyById={ocVerifyById}
                onOpenOcSettings={onOpenOcSettings}
                ocModelsByServer={ocModelsByServer}
                ocProjectsByServer={ocProjectsByServer}
                onAddProject={onAddProject}
                onRefreshProjects={onRefreshProjects}
                defaultServerId={defaultServerId}
                ocSessions={ocSessions}
                humanSec={humanSecBy[selectedTask.id] ?? 0}
                agentSec={agentSecBy[selectedTask.id] ?? 0}
                expanded={true}
                onToggle={() => setMobileShowStage(false)}
                onHandToAgent={(p, srvId, mdl, rp, nt) =>
                  onHandToAgent(selectedTask, p, srvId, mdl, rp, nt)
                }
                onApprove={(dec) => onApprove(selectedTask, dec)}
                onAnswerForm={(k, v, l, st) => onAnswerForm(selectedTask, k, v, l, st)}
                onInterrupt={() => onInterrupt(selectedTask)}
                onStart={onStart}
                onMove={focusId ? onMove : undefined}
                onComplete={() => onComplete(selectedTask)}
                onMoveProject={onMoveProject}
                projects={projects}
                onUpdate={onUpdate}
                onDuration={onDuration}
                onDelete={onDelete}
              />
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-8 text-center">
              {sidebarCollapsed && (
                <button
                  type="button"
                  onClick={toggleSidebar}
                  className="mb-3 rounded border border-zinc-800 bg-zinc-900 px-2.5 py-1 font-mono text-[11px] text-zinc-300 hover:border-zinc-700"
                >
                  » Show Sidebar
                </button>
              )}
              <p className="text-[15px] font-medium text-zinc-200">Backlog is empty</p>
              <p className="mt-1 text-[13px] text-zinc-500">
                Add ideas or upcoming tasks in the left sidebar — trigger any task to move it directly into Focus.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function InlineDiffViewer({
  files,
  onAcceptAndComplete,
}: {
  files: SessionFileDiff[];
  onAcceptAndComplete?: () => void;
}) {
  const [activeIdx, setActiveIdx] = useState(0);
  if (files.length === 0) return null;
  const safeIdx = activeIdx < files.length ? activeIdx : 0;
  const activeFile = files[safeIdx];
  const patchLines = activeFile.patch ? activeFile.patch.split("\n") : [];

  return (
    <div
      className="mt-2.5 overflow-hidden rounded-lg border border-zinc-800/90 bg-zinc-950 font-mono text-[11px]"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/80 bg-zinc-900/70 px-2.5 py-1.5">
        <div className="flex items-center gap-1.5 overflow-x-auto">
          {files.map((f, idx) => (
            <button
              key={f.file}
              type="button"
              onClick={() => setActiveIdx(idx)}
              className={`inline-flex shrink-0 items-center gap-1 rounded px-2 py-0.5 transition-colors ${
                idx === safeIdx
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
              title={f.file}
            >
              <span>{f.shortFile}</span>
              <span className="text-emerald-400">+{f.additions}</span>
              <span className="text-red-400">-{f.deletions}</span>
            </button>
          ))}
        </div>
        {onAcceptAndComplete && (
          <button
            type="button"
            onClick={onAcceptAndComplete}
            className="shrink-0 rounded border border-emerald-500/40 bg-emerald-600/20 px-2 py-0.5 font-sans text-[11px] font-medium text-emerald-300 transition-colors hover:bg-emerald-600/30"
          >
            ✓ Accept &amp; Mark Done
          </button>
        )}
      </div>

      <div className="space-y-0.5 overflow-x-auto p-2.5 leading-relaxed">
        {patchLines.length === 0 ? (
          <div className="text-zinc-500">
            Modified {activeFile.file} (+{activeFile.additions} -{activeFile.deletions})
          </div>
        ) : (
          patchLines.map((line, i) => {
            const isAdd = line.startsWith("+") && !line.startsWith("+++");
            const isDel = line.startsWith("-") && !line.startsWith("---");
            const isHunk = line.startsWith("@@");
            return (
              <div
                key={i}
                className={`whitespace-pre rounded-sm px-1.5 ${
                  isAdd
                    ? "bg-emerald-500/12 text-emerald-300"
                    : isDel
                      ? "bg-red-500/12 text-red-300"
                      : isHunk
                        ? "text-zinc-500"
                        : "text-zinc-400"
                }`}
              >
                {line}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function TurnReasoningSteps({
  steps,
  hasOpaqueReasoning,
  isRunning,
}: {
  steps: SessionStepItem[];
  hasOpaqueReasoning?: boolean;
  isRunning?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const reasoningSteps = steps.filter(
    (s): s is Extract<SessionStepItem, { kind: "reasoning" }> => s.kind === "reasoning",
  );
  const toolSteps = steps.filter(
    (s): s is Extract<SessionStepItem, { kind: "tool" }> => s.kind === "tool",
  );
  const hasReasoning = reasoningSteps.length > 0 || Boolean(hasOpaqueReasoning);
  const totalCount = steps.length + (hasOpaqueReasoning && reasoningSteps.length === 0 ? 1 : 0);

  if (totalCount === 0 && !isRunning) return null;

  const runningTool = [...toolSteps].reverse().find((s) => s.status === "running");
  const lastTool = toolSteps[toolSteps.length - 1];
  const uniqueToolNames = Array.from(new Set(toolSteps.map((s) => s.name))).slice(0, 4);

  let headerText = "";
  if (isRunning) {
    if (runningTool) {
      headerText = `Running ${runningTool.label}`;
    } else if (lastTool) {
      headerText = `Working · ${lastTool.label}`;
    } else {
      headerText = "Thinking…";
    }
  } else if (hasReasoning && toolSteps.length > 0) {
    headerText = `Reasoning & ${toolSteps.length} ${toolSteps.length === 1 ? "step" : "steps"}${
      uniqueToolNames.length ? ` (${uniqueToolNames.join(", ")})` : ""
    }`;
  } else if (hasReasoning) {
    headerText =
      reasoningSteps.length > 1 ? `Reasoning (${reasoningSteps.length} thoughts)` : "Reasoning";
  } else {
    headerText = `${toolSteps.length} ${toolSteps.length === 1 ? "step" : "steps"}${
      uniqueToolNames.length ? ` (${uniqueToolNames.join(", ")})` : ""
    }`;
  }

  return (
    <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/70 text-[12px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left font-mono text-[11px] text-zinc-400 transition-colors hover:text-zinc-200"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-zinc-500">{open ? "▾" : "▸"}</span>
          {isRunning && (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-orange-500 animate-pulse" />
          )}
          <span className={`truncate ${isRunning ? "text-zinc-200 font-medium" : "text-zinc-400"}`}>
            {headerText}
          </span>
        </div>
        {totalCount > 0 && (
          <span className="shrink-0 text-[10px] text-zinc-500">
            {open ? "Hide" : `${totalCount} ${totalCount === 1 ? "item" : "items"}`}
          </span>
        )}
      </button>

      {open && totalCount > 0 && (
        <div className="space-y-2 border-t border-zinc-800/70 px-3 py-2.5">
          {hasOpaqueReasoning && reasoningSteps.length === 0 && (
            <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-500 italic">
              <span>✦</span>
              <span>Model reasoning</span>
            </div>
          )}
          {steps.map((step, idx) =>
            step.kind === "reasoning" ? (
              <div
                key={idx}
                className="border-l-2 border-zinc-700/80 pl-2.5 py-0.5 text-[12px] leading-relaxed text-zinc-400"
              >
                <SimpleMarkdown text={step.text} />
              </div>
            ) : (
              <div
                key={idx}
                className={`flex items-center gap-2 font-mono text-[11px] ${
                  step.status === "running"
                    ? "text-zinc-100 font-medium"
                    : step.status === "error"
                      ? "text-red-400"
                      : "text-zinc-400"
                }`}
              >
                {step.status === "running" ? (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-orange-500 animate-pulse" />
                ) : step.status === "error" ? (
                  <span className="shrink-0 text-red-400">✕</span>
                ) : (
                  <span className="shrink-0 text-zinc-500">✓</span>
                )}
                <span className="shrink-0 rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-300">
                  {step.name}
                </span>
                {step.detail && <span className="truncate text-zinc-400">{step.detail}</span>}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function SessionThread({
  turns,
  pendingSteer,
  isRunning,
  serverLabel,
  fallbackText,
  fallbackTool,
}: {
  turns: SessionTurn[];
  pendingSteer: { text: string; sentAt: number } | null;
  isRunning: boolean;
  serverLabel: string;
  fallbackText?: string;
  fallbackTool?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const turnRefs = useRef<(HTMLDivElement | null)[]>([]);
  const highlightTimerRef = useRef<number | null>(null);

  const [activeIndex, setActiveIndex] = useState(0);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const displayTurns = useMemo(() => {
    const list: SessionTurn[] = [...turns];
    if (list.length === 0 && (fallbackText || fallbackTool)) {
      list.push({
        id: "fallback-assistant",
        role: "assistant",
        text: fallbackText || "",
        tools: fallbackTool ? [fallbackTool] : [],
        steps: fallbackTool
          ? [{ kind: "tool", name: fallbackTool, detail: "", label: fallbackTool, status: "running" }]
          : [],
      });
    }
    if (pendingSteer) {
      const cleanPending = pendingSteer.text.trim();
      const alreadyInTurns = list.some(
        (t) =>
          t.role === "user" &&
          (t.text.trim() === cleanPending ||
            (t.timestamp != null && t.timestamp >= pendingSteer.sentAt - 2000)),
      );
      if (!alreadyInTurns && cleanPending) {
        list.push({
          id: `pending-user-${pendingSteer.sentAt}`,
          role: "user",
          text: cleanPending,
          tools: [],
          steps: [],
          timestamp: pendingSteer.sentAt,
        });
        list.push({
          id: `pending-asst-${pendingSteer.sentAt}`,
          role: "assistant",
          text: "",
          tools: [],
          steps: [],
          isStreaming: true,
          timestamp: pendingSteer.sentAt,
        });
      }
    }
    const last = list[list.length - 1];
    if (last && last.role === "user" && (isRunning || pendingSteer)) {
      list.push({
        id: `live-asst-${last.id}`,
        role: "assistant",
        text: "",
        tools: [],
        steps: [],
        isStreaming: true,
      });
    }
    return list;
  }, [turns, pendingSteer, isRunning, fallbackText, fallbackTool]);

  // Compute 1-based prompt/response indexes and jump targets between paired turns
  const turnMeta = useMemo(() => {
    let promptCount = 0;
    let responseCount = 0;

    const metaList = displayTurns.map((turn) => {
      if (turn.role === "user") {
        promptCount++;
        return {
          role: "user" as const,
          number: promptCount,
          nextResponseIdx: -1,
          prevPromptIdx: -1,
        };
      }
      responseCount++;
      return {
        role: "assistant" as const,
        number: responseCount,
        nextResponseIdx: -1,
        prevPromptIdx: -1,
      };
    });

    for (let i = 0; i < displayTurns.length; i++) {
      if (displayTurns[i].role === "user") {
        for (let j = i + 1; j < displayTurns.length; j++) {
          if (displayTurns[j].role === "assistant") {
            metaList[i].nextResponseIdx = j;
            break;
          }
        }
      } else {
        for (let j = i - 1; j >= 0; j--) {
          if (displayTurns[j].role === "user") {
            metaList[i].prevPromptIdx = j;
            break;
          }
        }
      }
    }

    return {
      metaList,
      totalPrompts: promptCount,
      totalResponses: responseCount,
    };
  }, [displayTurns]);

  // Smooth-scroll to target turn and briefly highlight it
  const scrollToTurn = useCallback(
    (targetIdx: number) => {
      if (targetIdx < 0 || targetIdx >= displayTurns.length) return;
      setActiveIndex(targetIdx);
      const targetTurn = displayTurns[targetIdx];
      if (targetTurn) {
        setHighlightedId(targetTurn.id);
        if (highlightTimerRef.current) {
          window.clearTimeout(highlightTimerRef.current);
        }
        highlightTimerRef.current = window.setTimeout(() => {
          setHighlightedId(null);
        }, 1600);
      }

      const el = turnRefs.current[targetIdx];
      if (!el) return;

      const scrollContainer = el.closest(".overflow-y-auto") as HTMLElement | null;
      if (scrollContainer) {
        const containerRect = scrollContainer.getBoundingClientRect();
        const targetRect = el.getBoundingClientRect();
        const currentScrollTop = scrollContainer.scrollTop;
        // Leave room for sticky navigation bar
        const offsetTop = targetRect.top - containerRect.top + currentScrollTop - 48;
        scrollContainer.scrollTo({
          top: Math.max(0, offsetTop),
          behavior: "smooth",
        });
      } else {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    },
    [displayTurns],
  );

  // Sync activeIndex with manual scroll position
  const handleContainerScroll = useCallback(() => {
    const scrollContainer = containerRef.current?.closest(".overflow-y-auto") as HTMLElement | null;
    if (!scrollContainer) return;
    const containerRect = scrollContainer.getBoundingClientRect();
    const threshold = containerRect.top + 70;

    let bestIdx = 0;
    let minDiff = Infinity;
    for (let i = 0; i < displayTurns.length; i++) {
      const el = turnRefs.current[i];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.top <= threshold && rect.bottom >= threshold) {
        bestIdx = i;
        break;
      }
      const diff = Math.abs(rect.top - threshold);
      if (diff < minDiff) {
        minDiff = diff;
        bestIdx = i;
      }
    }
    setActiveIndex(bestIdx);
  }, [displayTurns.length]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const scrollContainer = el.closest(".overflow-y-auto") as HTMLElement | null;
    if (!scrollContainer) return;

    let ticking = false;
    const onScroll = () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          handleContainerScroll();
          ticking = false;
        });
        ticking = true;
      }
    };

    scrollContainer.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollContainer.removeEventListener("scroll", onScroll);
  }, [handleContainerScroll]);

  // Keyboard navigation: Alt+ArrowUp for prev turn, Alt+ArrowDown for next turn
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (displayTurns.length <= 1) return;
      if (e.altKey && e.key === "ArrowUp") {
        e.preventDefault();
        scrollToTurn(Math.max(0, activeIndex - 1));
      } else if (e.altKey && e.key === "ArrowDown") {
        e.preventDefault();
        scrollToTurn(Math.min(displayTurns.length - 1, activeIndex + 1));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeIndex, displayTurns.length, scrollToTurn]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) {
        window.clearTimeout(highlightTimerRef.current);
      }
    };
  }, []);

  const copyText = (id: string, text: string) => {
    if (!text) return;
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopiedId(id);
        window.setTimeout(() => {
          setCopiedId((curr) => (curr === id ? null : curr));
        }, 1500);
      })
      .catch(() => {});
  };

  if (displayTurns.length === 0) return null;

  const currentTurn = displayTurns[activeIndex] ?? displayTurns[0];
  const currentTurnMeta = turnMeta.metaList[activeIndex] ?? turnMeta.metaList[0];

  return (
    <div ref={containerRef} className="space-y-2 relative">
      {/* Sticky Thread Navigation Bar (Visible when there are 2+ turns) */}
      {displayTurns.length > 1 && (
        <div className="sticky top-0 z-20 -mx-1 px-1 py-0.5 bg-zinc-950/85 backdrop-blur-md">
          <div className="flex items-center justify-between gap-2 rounded-md border border-zinc-800/80 bg-zinc-900/90 px-2 py-1 shadow-sm">
            {/* Left: Indicator & Active Turn Tag */}
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-400 shrink-0">
                {currentTurn.role === "user" ? (
                  <span className="inline-flex items-center gap-1 font-semibold text-amber-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                    Prompt #{currentTurnMeta.number}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 font-semibold text-sky-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
                    Response #{currentTurnMeta.number}
                  </span>
                )}
              </span>
              <span className="font-mono text-[10px] text-zinc-500 shrink-0">
                ({activeIndex + 1}/{displayTurns.length})
              </span>
              <span className="hidden sm:inline-flex items-center gap-1 border-l border-zinc-800 pl-2 font-mono text-[10px] text-zinc-400">
                <span>
                  {turnMeta.totalPrompts} {turnMeta.totalPrompts === 1 ? "prompt" : "prompts"}
                </span>
                <span>·</span>
                <span>
                  {turnMeta.totalResponses}{" "}
                  {turnMeta.totalResponses === 1 ? "response" : "responses"}
                </span>
              </span>
            </div>

            {/* Right: Up / Down Navigation Buttons */}
            <div className="flex items-center gap-1 shrink-0">
              {/* Up Button */}
              <button
                type="button"
                onClick={() => scrollToTurn(activeIndex - 1)}
                disabled={activeIndex <= 0}
                className="inline-flex items-center gap-0.5 rounded border border-zinc-700/60 bg-zinc-800/80 px-1.5 py-0.2 font-mono text-[10px] font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-750 hover:text-white disabled:pointer-events-none disabled:opacity-30"
                title="Navigate to previous prompt/response [Alt+↑]"
                aria-label="Previous prompt or response"
              >
                <svg className="w-3 h-3 text-zinc-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M5 15l7-7 7 7" />
                </svg>
                <span>Up</span>
              </button>

              {/* Down Button */}
              <button
                type="button"
                onClick={() => scrollToTurn(activeIndex + 1)}
                disabled={activeIndex >= displayTurns.length - 1}
                className="inline-flex items-center gap-0.5 rounded border border-zinc-700/60 bg-zinc-800/80 px-1.5 py-0.2 font-mono text-[10px] font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-750 hover:text-white disabled:pointer-events-none disabled:opacity-30"
                title="Navigate to next prompt/response [Alt+↓]"
                aria-label="Next prompt or response"
              >
                <span>Down</span>
                <svg className="w-3 h-3 text-zinc-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {/* Jump to bottom / latest */}
              {activeIndex < displayTurns.length - 1 && (
                <button
                  type="button"
                  onClick={() => scrollToTurn(displayTurns.length - 1)}
                  className="inline-flex items-center gap-0.5 rounded border border-zinc-700/60 bg-zinc-800/60 px-1.5 py-0.2 font-mono text-[10px] text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
                  title="Jump to latest response"
                  aria-label="Jump to latest response"
                >
                  <svg className="w-3 h-3 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M19 13l-7 7-7-7m14-8l-7 7-7-7" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Message List */}
      {displayTurns.map((turn, idx) => {
        const isLast = idx === displayTurns.length - 1;
        const isTurnRunning =
          turn.role === "assistant" &&
          isLast &&
          (isRunning || Boolean(turn.isStreaming) || Boolean(pendingSteer));
        const meta = turnMeta.metaList[idx];

        if (turn.role === "user") {
          return (
            <div
              key={turn.id}
              ref={(el) => {
                turnRefs.current[idx] = el;
              }}
              data-turn-id={turn.id}
              data-turn-role="user"
              className={`rounded-lg border border-zinc-800/90 border-l-[3px] border-l-amber-500 bg-gradient-to-r from-amber-500/[0.06] via-zinc-900/85 to-zinc-900/70 px-3 py-2 space-y-1.5 shadow-sm transition-all duration-300 ${
                highlightedId === turn.id
                  ? "ring-2 ring-amber-400/80 shadow-lg shadow-amber-500/10"
                  : ""
              }`}
            >
              <div className="flex items-center justify-between gap-2 border-b border-zinc-800/60 pb-1 font-mono text-[10px] tracking-wider text-zinc-400">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.2 font-mono text-[9.5px] font-semibold tracking-wider text-amber-300">
                    PROMPT #{meta.number}
                  </span>
                  <span className="text-zinc-400 font-medium uppercase text-[9.5px]">You</span>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {turn.timestamp && (
                    <span className="font-mono text-[10px] text-zinc-500 mr-1">
                      {new Date(turn.timestamp).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  )}

                  {/* Copy Prompt Text */}
                  {turn.text && (
                    <button
                      type="button"
                      onClick={() => copyText(turn.id, turn.text)}
                      className="inline-flex items-center gap-1 rounded border border-zinc-700/60 bg-zinc-800/70 px-1.5 py-0.2 font-mono text-[9.5px] text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 transition-colors"
                      title="Copy prompt text"
                    >
                      {copiedId === turn.id ? (
                        <span className="text-emerald-400 font-medium">Copied</span>
                      ) : (
                        <span>Copy</span>
                      )}
                    </button>
                  )}

                  {/* Jump to Corresponding Response */}
                  {meta.nextResponseIdx >= 0 && (
                    <button
                      type="button"
                      onClick={() => scrollToTurn(meta.nextResponseIdx)}
                      className="inline-flex items-center gap-1 rounded border border-zinc-700/60 bg-zinc-800/80 px-1.5 py-0.2 font-mono text-[9.5px] text-zinc-300 hover:border-zinc-500 hover:bg-zinc-750 hover:text-white transition-colors"
                      title="Jump to corresponding response"
                    >
                      <span>Response ↓</span>
                    </button>
                  )}
                </div>
              </div>

              <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-zinc-100 font-normal">
                {turn.text}
              </p>
            </div>
          );
        }

        return (
          <div
            key={turn.id}
            ref={(el) => {
              turnRefs.current[idx] = el;
            }}
            data-turn-id={turn.id}
            data-turn-role="assistant"
            className={`rounded-lg border border-zinc-800/80 border-l-[3px] border-l-sky-500/70 bg-zinc-950/75 px-3 py-2.5 space-y-2 transition-all duration-300 ${
              highlightedId === turn.id
                ? "ring-2 ring-sky-400/80 shadow-lg shadow-sky-500/10"
                : ""
            }`}
          >
            {/* Assistant Header */}
            <div className="flex items-center justify-between gap-2 border-b border-zinc-800/60 pb-1">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="inline-flex items-center gap-1 rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.2 font-mono text-[9.5px] font-semibold tracking-wider text-sky-300">
                  RESPONSE #{meta.number}
                </span>
                <span className="truncate font-mono text-[10.5px] text-zinc-400">
                  {serverLabel}
                </span>
                {isTurnRunning && (
                  <span className="inline-flex items-center gap-1 rounded bg-orange-500/15 border border-orange-500/30 px-1.5 py-0.2 font-mono text-[9.5px] text-orange-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-orange-500 animate-pulse" />
                    Responding…
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1 shrink-0">
                {turn.timestamp && (
                  <span className="font-mono text-[10px] text-zinc-500 mr-1">
                    {new Date(turn.timestamp).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                )}

                {/* Copy Response Markdown */}
                {turn.text && (
                  <button
                    type="button"
                    onClick={() => copyText(turn.id, turn.text)}
                    className="inline-flex items-center gap-1 rounded border border-zinc-700/60 bg-zinc-800/70 px-1.5 py-0.2 font-mono text-[9.5px] text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 transition-colors"
                    title="Copy response markdown"
                  >
                    {copiedId === turn.id ? (
                      <span className="text-emerald-400 font-medium">Copied</span>
                    ) : (
                      <span>Copy</span>
                    )}
                  </button>
                )}

                {/* Jump to Preceding Prompt */}
                {meta.prevPromptIdx >= 0 && (
                  <button
                    type="button"
                    onClick={() => scrollToTurn(meta.prevPromptIdx)}
                    className="inline-flex items-center gap-1 rounded border border-zinc-700/60 bg-zinc-800/80 px-1.5 py-0.2 font-mono text-[9.5px] text-zinc-300 hover:border-zinc-500 hover:bg-zinc-750 hover:text-white transition-colors"
                    title="Jump to user prompt"
                  >
                    <span>↑ Prompt</span>
                  </button>
                )}
              </div>
            </div>

            {/* Reasoning & Tool Steps */}
            <TurnReasoningSteps
              steps={turn.steps}
              hasOpaqueReasoning={turn.hasOpaqueReasoning}
              isRunning={isTurnRunning}
            />

            {/* Response Body */}
            {turn.text ? (
              <div className="pt-0.5">
                <SimpleMarkdown text={turn.text} />
              </div>
            ) : isTurnRunning ? (
              <div className="flex items-center gap-2 rounded-lg border border-zinc-800/50 bg-zinc-900/40 px-3 py-2 font-mono text-[11.5px] text-zinc-400">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-orange-500 animate-pulse" />
                <span>{serverLabel} is responding…</span>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function TaskRow({
  t,
  large,
  stageMode = false,
  sidebarCollapsed,
  onToggleSidebar,
  expanded,
  onToggle,
  onHandToAgent,
  onApprove,
  onAnswerForm,
  onInterrupt,
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
  ocVerifyById = {},
  onOpenOcSettings,
  ocModelsByServer = {},
  ocProjectsByServer = {},
  onAddProject,
  onRefreshProjects,
  defaultServerId = "local",
  ocSessions,
  humanSec,
  agentSec = 0,
}: {
  t: Task;
  large?: boolean;
  stageMode?: boolean;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  expanded: boolean;
  onToggle: () => void;
  onHandToAgent: (
    prompt?: string,
    serverId?: string,
    model?: string,
    repo?: string,
    note?: string,
  ) => void;
  onApprove: (decision?: "once" | "always" | "reject") => void;
  onAnswerForm: (
    fieldKeyOrAnswers: string | Record<string, string | string[]>,
    value?: string | string[],
    label?: string,
    steerPrompt?: string,
  ) => void;
  onInterrupt?: () => void;
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
  ocVerifyById?: Record<string, OpenCodeVerifyResult>;
  onOpenOcSettings?: () => void;
  ocModelsByServer?: Record<string, OpenCodeModelOption[]>;
  ocProjectsByServer?: Record<string, OpenCodeRepo[]>;
  onAddProject?: (serverId: string, label: string, dir: string) => void;
  onRefreshProjects?: (serverId: string) => Promise<unknown>;
  defaultServerId?: string;
  ocSessions: OpenCodeLiveSession[];
  humanSec: number;
  agentSec?: number;
}) {
  const rootRef = useRef<HTMLLIElement>(null);
  const [zen, setZen] = useState(false);
  const [showDiff, setShowDiff] = useState(false);

  useEffect(() => {
    if (!expanded) setZen(false);
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const down = (e: PointerEvent) => {
      if (!stageMode && !zen && rootRef.current && !rootRef.current.contains(e.target as Node))
        onToggle();
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
        } else if (!stageMode) {
          onToggle();
        }
      }
    };
    if (!stageMode) document.addEventListener("pointerdown", down);
    window.addEventListener("keydown", key);
    return () => {
      if (!stageMode) document.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", key);
    };
  }, [expanded, zen, stageMode, onToggle]);

  const { triage, liveSession, meta } = resolveTaskTriage(t, ocSessions);
  const ui = TRIAGE_UI[triage];
  const hasQuestion = Boolean(liveSession?.form);
  const needsApproval = Boolean(liveSession?.permission);
  const isBlockedOnHuman = hasQuestion || needsApproval;
  const isQueuedForAgent = !liveSession && Boolean(meta.queued);
  const isAgentTask = Boolean(
    liveSession || meta.server || meta.repo || meta.prompt || meta.queued || (meta.sessions && meta.sessions.length > 0),
  );
  const assignedServerId = liveSession?.serverId || meta.server || (isAgentTask ? defaultServerId : "");
  const isAssignedServerOnline = assignedServerId ? (ocServerOnlineById[assignedServerId] ?? ocConnected) : false;

  const activeSid = meta.sessions[meta.sessions.length - 1] ?? "";
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [lastSteerAt, setLastSteerAt] = useState(0);

  useEffect(() => {
    if (!activeSid) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    const loadSummary = (force = false) => {
      fetchOpenCodeSessionSummary(
        activeSid,
        liveSession?.updatedAt,
        assignedServerId,
        force,
      ).then((res) => {
        if (!cancelled && res) setSummary(res);
      });
    };
    loadSummary(lastSteerAt > 0);
    const recentlySteered = lastSteerAt > 0 && Date.now() - lastSteerAt < 20_000;
    const shouldPoll =
      liveSession?.status === "running" ||
      recentlySteered ||
      !summary?.lastAssistantText;
    const iv = shouldPoll ? window.setInterval(() => loadSummary(true), 1000) : undefined;
    return () => {
      cancelled = true;
      if (iv) window.clearInterval(iv);
    };
  }, [
    activeSid,
    liveSession?.updatedAt,
    liveSession?.status,
    expanded,
    assignedServerId,
    summary?.lastAssistantText,
    lastSteerAt,
  ]);

  const spent = (spentBy[t.id] ?? 0) + Math.floor(humanSec / 60);
  const planned = t.duration?.amount ?? defaultMinutes;
  const over = spent > planned;
  const aiMin = Math.floor(agentSec / 60);

  const repoShort = shortRepo(meta.repo || liveSession?.repoShort);
  const showServerBadge = isAgentTask && (ocServers.length > 1 || (meta.server && meta.server !== defaultServerId));
  const activeModelKey = liveSession?.modelKey || meta.model || "";
  const activeModelShort = shortModelLabel(
    activeModelKey,
    assignedServerId ? ocModelsByServer[assignedServerId] : undefined,
  );
  const targetBadge = isAgentTask
    ? [
        showServerBadge ? assignedServerId : null,
        repoShort,
        meta.model ? activeModelShort : null,
      ]
        .filter(Boolean)
        .join("/")
    : null;

  const filesChanged = summary?.filesChanged ?? [];
  const totalAdditions = summary?.totalAdditions ?? 0;
  const totalDeletions = summary?.totalDeletions ?? 0;
  const recentTools = summary?.recentTools ?? [];

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
  const subline =
    triage === "working" && recentTools.length > 0
      ? ""
      : isQueuedForAgent
        ? `Queued for ${assignedServerId}${meta.prompt ? ` · ${meta.prompt.split("\n")[0]}` : ""}`
        : latestReplyOneLine || meta.note || meta.prompt.split("\n")[0] || "";

  const diffBadgeEl = filesChanged.length > 0 && (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setShowDiff((s) => !s);
      }}
      className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] transition-colors ${
        triage === "needs_you" && !isBlockedOnHuman
          ? "border-amber-500/35 bg-amber-500/10 text-zinc-200 hover:border-amber-400/60"
          : "border-zinc-800 bg-zinc-900/90 text-zinc-300 hover:border-zinc-700"
      }`}
      title="Click to toggle inline file diff"
    >
      <span>
        {showDiff ? "▾" : "▸"}{" "}
        {triage === "working" && filesChanged.length === 1
          ? `editing ${filesChanged[0].shortFile}`
          : `${filesChanged.length} ${filesChanged.length === 1 ? "file" : "files"}`}
      </span>
      <span className="text-emerald-400">+{totalAdditions}</span>
      <span className="text-red-400">-{totalDeletions}</span>
    </button>
  );

  const dur = (
    <div className="flex shrink-0 items-center gap-2 font-mono text-[12px] tabular-nums">
      {isQueuedForAgent ? (
        <span className="inline-flex items-center gap-1.5 text-[12px] text-amber-400">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
          Queued
        </span>
      ) : hasQuestion ? (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-orange-500/15 px-2.5 py-0.5 text-[11px] font-medium text-orange-400">
          <span className="h-1.5 w-1.5 rounded-full bg-orange-500" />
          Question
        </span>
      ) : needsApproval ? (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-orange-500/15 px-2.5 py-0.5 text-[11px] font-medium text-orange-400">
          <span className="h-1.5 w-1.5 rounded-full bg-orange-500" />
          Permission
        </span>
      ) : triage === "working" ? (
        <span className="inline-flex items-center gap-1.5 text-[12px] text-zinc-200">
          <span className="h-1.5 w-1.5 rounded-full bg-zinc-200 animate-pulse" />
          Working{agentSec > 0 ? ` · ${fmt(agentSec)}` : ""}
        </span>
      ) : triage === "needs_you" ? (
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] ${
            filesChanged.length > 0
              ? "border border-amber-400/35 bg-amber-500/10 text-amber-300"
              : ui.labelCls
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              filesChanged.length > 0 ? "bg-amber-400" : ui.dot
            }`}
          />
          {filesChanged.length > 0 ? "Review Diff" : ui.label}
        </span>
      ) : null}

      {aiMin > 0 && triage !== "working" && (
        <span className="hidden text-zinc-500 sm:inline">ai {aiMin}m</span>
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
      {triage === "working" && onInterrupt && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onInterrupt();
          }}
          title="Stop running agent session"
          aria-label="Stop running agent session"
          className="shrink-0 rounded border border-zinc-800 bg-zinc-900 px-2 py-0.5 font-mono text-[11px] text-zinc-400 transition-colors hover:border-red-500/40 hover:text-red-400"
        >
          ■ Stop
        </button>
      )}
      {!liveSession && !onMove && !isQueuedForAgent && (
        <button
          className="shrink-0 rounded px-2 py-1 text-[12px] text-orange-500 transition-colors duration-150 hover:bg-zinc-800"
          title={
            isAgentTask
              ? isAssignedServerOnline
                ? `Run on ${assignedServerId}`
                : `Queue for ${assignedServerId}`
              : `Start ${planned}m Pomodoro timer`
          }
          aria-label={
            isAgentTask
              ? isAssignedServerOnline
                ? `Run on ${assignedServerId}`
                : `Queue for ${assignedServerId}`
              : `Start ${planned}m Pomodoro timer`
          }
          onClick={() => {
            if (isAgentTask) {
              onHandToAgent(undefined, assignedServerId);
            } else if (onStart) {
              onStart(t, planned);
            }
          }}
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

  const rowLeftBorder = stageMode
    ? "border border-zinc-800/90 bg-zinc-900/40 px-3 py-2 sm:px-3.5 sm:py-2 flex-1 min-h-0 flex flex-col md:h-full"
    : expanded
      ? "border-l-2 border-l-orange-500 bg-zinc-900/80 ring-1 ring-zinc-800"
      : isBlockedOnHuman
        ? "border-l-2 border-l-orange-500 bg-zinc-900/60"
        : triage === "needs_you" && filesChanged.length > 0
          ? "border-l-2 border-l-amber-400/90 bg-zinc-900/45"
          : `border-l-2 ${ui.leftBar || pBar(t.priority)}`;

  return (
    <li
      ref={rootRef}
      className={`rounded-xl transition-colors duration-150 ${rowLeftBorder} ${
        !expanded && !stageMode ? "hover:bg-zinc-900/65" : ""
      } ${isNew(t) ? "row-new" : ""}`}
    >
      {expanded ? (
        <RowEditor
          t={t}
          large={large}
          stageMode={stageMode}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={onToggleSidebar}
          zen={zen}
          onToggleZen={() => setZen((z) => !z)}
          dur={dur}
          actions={actions}
          durations={durations}
          defaultMinutes={defaultMinutes}
          ocConnected={ocConnected}
          ocServers={ocServers}
          ocServerOnlineById={ocServerOnlineById}
          ocVerifyById={ocVerifyById}
          onOpenOcSettings={onOpenOcSettings}
          ocModelsByServer={ocModelsByServer}
          ocProjectsByServer={ocProjectsByServer}
          onAddProject={onAddProject}
          onRefreshProjects={onRefreshProjects}
          defaultServerId={defaultServerId}
          ocSessions={ocSessions}
          liveSession={liveSession}
          summary={summary}
          onClose={onToggle}
          onUpdate={onUpdate}
          onDuration={onDuration}
          onHandToAgent={(p, srvId, mdl, rp, nt) => {
            setLastSteerAt(Date.now());
            onHandToAgent(p, srvId, mdl, rp, nt);
          }}
          onApprove={onApprove}
          onAnswerForm={onAnswerForm}
          onStartCountdown={
            onStart ? () => onStart(t, t.duration?.amount ?? defaultMinutes) : undefined
          }
          onMove={onMove}
          onDemote={onDemote}
          onMoveProject={onMoveProject}
          projects={projects}
          onComplete={onComplete}
          onDelete={onDelete}
        />
      ) : (
        <div className="px-3 py-2">
          <div className="flex items-start justify-between gap-2.5">
            {onComplete && (
              <button
                type="button"
                onClick={onComplete}
                title="Mark task Done"
                aria-label="Mark task Done"
                className="mt-1 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded border border-zinc-700 text-[10px] text-transparent transition-colors hover:border-orange-500 hover:text-orange-400"
              >
                ✓
              </button>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={`truncate text-left ${
                    large
                      ? "text-[15px] font-medium text-zinc-100"
                      : "text-[14px] text-zinc-200"
                  }`}
                  onClick={onToggle}
                >
                  {t.content}
                </button>
                {targetBadge && (
                  <span className="shrink-0 font-mono text-[11px] text-zinc-500">
                    {targetBadge}
                  </span>
                )}
                {diffBadgeEl}
              </div>

              {/* Live Tool Pipeline Breadcrumb when Agent is Working */}
              {triage === "working" && recentTools.length > 0 && (
                <div
                  className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono text-[11px]"
                  onClick={onToggle}
                >
                  {recentTools.map((step, i) => {
                    const isLast = i === recentTools.length - 1;
                    return (
                      <span key={i} className="inline-flex items-center gap-1.5">
                        {i > 0 && <span className="text-zinc-700">→</span>}
                        <span
                          className={
                            isLast
                              ? "inline-flex items-center gap-1.5 rounded border border-zinc-700/80 bg-zinc-800/90 px-2 py-0.5 text-zinc-100"
                              : "rounded bg-zinc-900 px-1.5 py-0.5 text-zinc-400"
                          }
                        >
                          {isLast ? (
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-200 animate-pulse" />
                          ) : (
                            <span className="text-zinc-500">✓</span>
                          )}
                          <span className="truncate max-w-64">{step.label}</span>
                        </span>
                      </span>
                    );
                  })}
                </div>
              )}

              {subline && (
                <button
                  type="button"
                  onClick={onToggle}
                  className={`mt-0.5 block w-full truncate text-left text-[12px] ${
                    isQueuedForAgent
                      ? "text-amber-400/90"
                      : triage === "needs_you"
                        ? "text-zinc-300"
                        : "text-zinc-500"
                  }`}
                >
                  {subline}
                </button>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2 pt-0.5">
              {dur}
              {actions}
            </div>
          </div>

          {/* Inline Question Shelf directly on collapsed card (1-click answer or inline steer) */}
          {liveSession?.form && (
            <div className="mt-2.5">
              <QuestionFormCard
                form={liveSession.form}
                fallbackTitle={formQuestionTitle}
                variant="compact"
                onSubmitAnswers={(answers, summaryLabel, steerPrompt) =>
                  onAnswerForm(answers, undefined, summaryLabel, steerPrompt)
                }
                onSteer={(steerText) => onHandToAgent(steerText)}
              />
            </div>
          )}

          {/* Inline Permission Approval Bar directly on collapsed card */}
          {liveSession?.permission && (
            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-orange-500/40 bg-zinc-950 px-3 py-2 text-[12px]">
              <div className="min-w-0 truncate font-mono text-zinc-200">
                <span className="text-orange-400">
                  Allow {liveSession.permission.action}:{" "}
                </span>
                {liveSession.permission.resources.join(" ")}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => onApprove("once")}
                  className="rounded bg-orange-600 px-2.5 py-1 font-medium text-white hover:bg-orange-500"
                >
                  Allow once
                </button>
                <button
                  type="button"
                  onClick={() => onApprove("always")}
                  className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-200 hover:border-zinc-600"
                >
                  Always
                </button>
                <button
                  type="button"
                  onClick={() => onApprove("reject")}
                  className="rounded px-2 py-1 text-zinc-400 hover:bg-zinc-900 hover:text-red-400"
                >
                  Reject
                </button>
              </div>
            </div>
          )}

          {/* Inline Collapsible Diff Viewer */}
          {showDiff && filesChanged.length > 0 && (
            <InlineDiffViewer
              files={filesChanged}
              onAcceptAndComplete={onComplete}
            />
          )}
        </div>
      )}
    </li>
  );
}

function QuestionFormCard({
  form,
  fallbackTitle,
  variant = "stage",
  selectedByField: controlledSelected,
  onSelectedChange,
  onSubmitAnswers,
  onSteer,
}: {
  form: OpenCodeFormRequest;
  fallbackTitle?: string;
  variant?: "compact" | "stage" | "zen";
  selectedByField?: Record<string, string | string[]>;
  onSelectedChange?: (next: Record<string, string | string[]>) => void;
  onSubmitAnswers: (
    answers: Record<string, string | string[]>,
    summaryLabel: string,
    steerPrompt?: string,
  ) => void;
  onSteer: (steerText: string) => void;
}) {
  const [internalSelected, setInternalSelected] = useState<Record<string, string | string[]>>({});
  const [inlineSteer, setInlineSteer] = useState("");
  const selected = controlledSelected ?? internalSelected;

  const updateSelected = (next: Record<string, string | string[]>) => {
    if (onSelectedChange) {
      onSelectedChange(next);
    } else {
      setInternalSelected(next);
    }
  };

  useEffect(() => {
    setInternalSelected({});
    setInlineSteer("");
  }, [form.id]);

  const isMulti =
    form.fields.length > 1 || form.fields.some((f) => f.type === "multiselect");
  const selectedCount = Object.keys(selected).length;
  const hasSelections = selectedCount > 0;
  const cleanSteer = inlineSteer.trim();

  const buildSummaryLabel = (ans: Record<string, string | string[]>) => {
    const parts: string[] = [];
    for (const f of form.fields) {
      const v = ans[f.key];
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        if (v.length > 0) parts.push(v.join(", "));
      } else if (v) {
        const opt = f.options?.find((o) => o.value === v);
        parts.push(opt?.label || v);
      }
    }
    return parts.join(" · ") || "answer";
  };

  const handleOptionClick = (
    field: OpenCodeFormRequest["fields"][number],
    optValue: string,
    optLabel: string,
  ) => {
    if (!isMulti && !cleanSteer) {
      onSubmitAnswers({ [field.key]: optValue }, optLabel);
      return;
    }
    const next = { ...selected };
    if (field.type === "multiselect") {
      const prevArr = Array.isArray(next[field.key]) ? (next[field.key] as string[]) : [];
      const exists = prevArr.includes(optValue);
      const updated = exists
        ? prevArr.filter((x) => x !== optValue)
        : [...prevArr, optValue];
      if (updated.length > 0) {
        next[field.key] = updated;
      } else {
        delete next[field.key];
      }
    } else {
      if (next[field.key] === optValue) {
        delete next[field.key];
      } else {
        next[field.key] = optValue;
      }
    }
    updateSelected(next);
  };

  const handleSubmit = () => {
    if (hasSelections) {
      onSubmitAnswers(
        selected,
        buildSummaryLabel(selected),
        cleanSteer || undefined,
      );
      updateSelected({});
      setInlineSteer("");
      return;
    }
    if (cleanSteer) {
      onSteer(cleanSteer);
      setInlineSteer("");
    }
  };

  const containerCls =
    variant === "compact"
      ? "space-y-3 rounded-lg border border-zinc-800/90 bg-zinc-950/90 p-3"
      : variant === "zen"
        ? "space-y-3.5 rounded-xl border border-orange-500/40 bg-zinc-950/90 p-4 text-[13px]"
        : "space-y-3.5 rounded-xl border border-orange-500/35 bg-zinc-950/80 p-3.5 text-[13px]";

  const gridCls =
    variant === "compact"
      ? "grid gap-1.5 sm:grid-cols-3"
      : variant === "zen"
        ? "grid gap-2 pt-1 sm:grid-cols-2"
        : "grid gap-2 pt-1 sm:grid-cols-2 xl:grid-cols-3";

  return (
    <div className={containerCls}>
      {form.fields.map((field, fIdx) => {
        const curVal = selected[field.key];
        return (
          <div key={field.key} className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span
                className={
                  variant === "compact"
                    ? "text-[13px] font-medium text-zinc-100"
                    : "text-[15px] font-semibold text-zinc-100"
                }
              >
                {form.fields.length > 1 ? `${fIdx + 1}. ` : ""}
                {field.title || fallbackTitle || form.title}
              </span>
              {field.type === "multiselect" && (
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-orange-400/90">
                  Multi-select
                </span>
              )}
            </div>
            {field.description && (
              <p className={variant === "compact" ? "text-[12px] text-zinc-400" : "text-[13px] text-zinc-400"}>
                {field.description}
              </p>
            )}
            {field.options && field.options.length > 0 && (
              <div className={gridCls}>
                {field.options.map((opt, idx) => {
                  const isPicked = Array.isArray(curVal)
                    ? curVal.includes(opt.value)
                    : curVal === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => handleOptionClick(field, opt.value, opt.label)}
                      className={`group flex flex-col items-start rounded-lg border px-3 py-2 text-left transition-colors ${
                        isPicked
                          ? "border-orange-500 bg-orange-950/35 text-orange-100"
                          : "border-zinc-800 bg-zinc-900/70 hover:border-orange-500/70 hover:bg-zinc-900"
                      }`}
                    >
                      <div className="flex w-full items-center justify-between gap-1.5">
                        <span
                          className={`text-[12px] sm:text-[13px] font-medium ${
                            isPicked
                              ? "text-orange-300"
                              : "text-zinc-100 group-hover:text-orange-400"
                          }`}
                        >
                          {idx + 1}. {opt.label}
                        </span>
                        {isPicked && (
                          <span className="shrink-0 font-mono text-[11px] font-bold text-orange-400">
                            ✓
                          </span>
                        )}
                      </div>
                      {opt.description && (
                        <span className="mt-0.5 line-clamp-2 text-[11px] sm:text-[12px] leading-snug text-zinc-400">
                          {opt.description}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* Inline Steer / Custom Reply bar inside the question card */}
      <div className="flex items-center gap-2 border-t border-zinc-800/80 pt-2.5">
        <input
          type="text"
          value={inlineSteer}
          onChange={(e) => setInlineSteer(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          placeholder={
            hasSelections
              ? "Add steer note to your selection (optional, Enter to submit)…"
              : "Or steer agent / type custom answer instead (Enter to send)…"
          }
          className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-900/90 px-3 py-1.5 text-[12px] sm:text-[13px] text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-orange-500/70"
        />
        {(hasSelections || cleanSteer || isMulti) && (
          <button
            type="button"
            disabled={!hasSelections && !cleanSteer}
            onClick={handleSubmit}
            className="shrink-0 rounded-lg bg-orange-600 px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {hasSelections && cleanSteer
              ? "Submit + Steer →"
              : hasSelections
                ? `Submit${form.fields.length > 1 ? ` (${selectedCount}/${form.fields.length})` : ""} →`
                : "Steer →"}
          </button>
        )}
      </div>
    </div>
  );
}

function RowEditor({
  t,
  large,
  stageMode = false,
  sidebarCollapsed,
  onToggleSidebar,
  zen = false,
  onToggleZen,
  dur,
  actions,
  durations,
  defaultMinutes = 5,
  ocConnected = false,
  ocServers = [],
  ocServerOnlineById = {},
  ocVerifyById = {},
  onOpenOcSettings,
  ocModelsByServer = {},
  ocProjectsByServer = {},
  onAddProject,
  onRefreshProjects,
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
  onMove,
  onDemote,
  onMoveProject,
  projects,
  onComplete,
  onDelete,
}: {
  t: Task;
  large?: boolean;
  stageMode?: boolean;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  zen?: boolean;
  onToggleZen?: () => void;
  dur: ReactNode;
  actions: ReactNode;
  durations: number[];
  defaultMinutes?: number;
  ocConnected?: boolean;
  ocServers?: OpenCodeServer[];
  ocServerOnlineById?: Record<string, boolean>;
  ocVerifyById?: Record<string, OpenCodeVerifyResult>;
  onOpenOcSettings?: () => void;
  ocModelsByServer?: Record<string, OpenCodeModelOption[]>;
  ocProjectsByServer?: Record<string, OpenCodeRepo[]>;
  onAddProject?: (serverId: string, label: string, dir: string) => void;
  onRefreshProjects?: (serverId: string) => Promise<unknown>;
  defaultServerId?: string;
  ocSessions: OpenCodeLiveSession[];
  liveSession?: OpenCodeLiveSession;
  summary: SessionSummary | null;
  onClose: () => void;
  onUpdate: (id: string, fields: { content?: string; description?: string }) => Promise<void>;
  onDuration: (t: Task, minutes: number) => void;
  onHandToAgent: (
    prompt?: string,
    serverId?: string,
    model?: string,
    repo?: string,
    note?: string,
  ) => void;
  onApprove: (decision?: "once" | "always" | "reject") => void;
  onAnswerForm: (
    fieldKeyOrAnswers: string | Record<string, string | string[]>,
    value?: string | string[],
    label?: string,
    steerPrompt?: string,
  ) => void;
  onStartCountdown?: () => void;
  onMove?: (t: Task) => void;
  onDemote?: (t: Task) => void;
  onMoveProject?: (t: Task, projectId: string) => void;
  projects?: Project[];
  onComplete?: () => void;
  onDelete: (t: Task) => void;
}) {
  const initialMeta = useMemo(() => parseTaskDescription(t.description), [t.description]);
  const { triage } = useMemo(() => resolveTaskTriage(t, ocSessions), [t, ocSessions]);
  const [title, setTitle] = useState(t.content);
  const [note, setNote] = useState(initialMeta.note);
  const [prompt, setPrompt] = useState(initialMeta.prompt);
  const [repo, setRepo] = useState(initialMeta.repo);
  const [server, setServer] = useState(
    liveSession?.serverId || initialMeta.server || "",
  );
  const [model, setModel] = useState(liveSession?.modelKey || initialMeta.model || "");
  const [sessions, setSessions] = useState<string[]>(initialMeta.sessions);
  const [queued, setQueued] = useState<boolean>(Boolean(initialMeta.queued));
  const [jira, setJira] = useState<string>(
    initialMeta.jira || extractJiraKey(t.content) || "",
  );
  const [jiraSyncState, setJiraSyncState] = useState<"" | "syncing" | "synced" | "error">("");
  const [saveState, setSaveState] = useState<"" | "saving" | "saved">("");
  const [confirming, setConfirming] = useState(false);
  const [showMeta, setShowMeta] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [zenNotesOpen, setZenNotesOpen] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [draftFormAnswers, setDraftFormAnswers] = useState<Record<string, string | string[]>>({});
  const [pendingSteer, setPendingSteer] = useState<{ text: string; sentAt: number } | null>(null);

  useEffect(() => {
    setDraftFormAnswers({});
  }, [liveSession?.form?.id]);
  const hasSessionOutput = Boolean(
    sessions.length > 0 ||
      initialMeta.sessions.length > 0 ||
      liveSession ||
      summary?.lastAssistantText ||
      summary?.lastToolCall ||
      (summary?.turns && summary.turns.length > 0) ||
      pendingSteer,
  );

  const unlinkedExplicitlyRef = useRef(false);
  const userChangedModelRef = useRef(false);
  const userChangedServerRef = useRef(false);
  const userChangedRepoRef = useRef(false);
  const threadScrollRef = useRef<HTMLDivElement>(null);
  const zenThreadScrollRef = useRef<HTMLDivElement>(null);
  const followLiveRef = useRef(true);

  useEffect(() => {
    if (liveSession?.modelKey && !userChangedModelRef.current) {
      setModel(liveSession.modelKey);
      if (metaLive.current.model !== liveSession.modelKey) {
        metaLive.current = { ...metaLive.current, model: liveSession.modelKey };
        scheduleFlush();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSession?.modelKey]);

  useEffect(() => {
    if (initialMeta.sessions.length > 0 && !unlinkedExplicitlyRef.current) {
      setSessions((prev) => {
        const merged = Array.from(new Set([...prev, ...initialMeta.sessions]));
        return merged.length === prev.length && merged.every((x, i) => x === prev[i])
          ? prev
          : merged;
      });
    }
    setQueued(Boolean(initialMeta.queued));
    if (!userChangedServerRef.current && initialMeta.server && initialMeta.server !== server) {
      setServer(initialMeta.server);
    }
    if (!userChangedModelRef.current && initialMeta.model && !model && !liveSession?.modelKey) {
      setModel(initialMeta.model);
    }
    if (!userChangedRepoRef.current && initialMeta.repo && !repo) {
      setRepo(initialMeta.repo);
    }
    if (initialMeta.jira && !jira) {
      setJira(initialMeta.jira);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMeta]);

  const effectiveJira = (jira || extractJiraKey(title) || "").toUpperCase();
  const matchingJiraSessions = useMemo(
    () => findMatchingSessionsForJira(effectiveJira, ocSessions),
    [effectiveJira, ocSessions],
  );
  const unlinkedJiraSession = useMemo(
    () => matchingJiraSessions.find((s) => !sessions.includes(s.id)),
    [matchingJiraSessions, sessions],
  );

  const titleLive = useRef(title);
  titleLive.current = title;
  const metaLive = useRef<TaskMeta>({
    note,
    prompt,
    repo,
    server,
    model,
    sessions,
    queued,
    jira: effectiveJira || undefined,
  });
  metaLive.current = {
    note,
    prompt,
    repo,
    server,
    model,
    sessions,
    queued,
    jira: effectiveJira || undefined,
  };
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
    const latestDescMeta = parseTaskDescription(tLive.current.description);
    const mergedSessions = unlinkedExplicitlyRef.current
      ? metaLive.current.sessions
      : Array.from(new Set([...metaLive.current.sessions, ...latestDescMeta.sessions]));
    const formattedDesc = formatTaskDescription({
      ...metaLive.current,
      sessions: mergedSessions,
    });
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
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const inputVal = hasSessionOutput ? replyText : prompt;
  useEffect(() => {
    const el = promptRef.current;
    if (el) {
      el.style.height = "0";
      const minH = zen && !hasSessionOutput ? 88 : 26;
      el.style.height = `${Math.max(minH, el.scrollHeight)}px`;
    }
  }, [inputVal, hasSessionOutput, zen]);

  useEffect(() => {
    const el = noteRef.current;
    if (el) {
      el.style.height = "0";
      el.style.height = `${Math.max(72, el.scrollHeight)}px`;
    }
  }, [note, stageMode]);

  const [showCustomFolder, setShowCustomFolder] = useState(false);
  const [customFolderDir, setCustomFolderDir] = useState("");
  const [refreshingProjects, setRefreshingProjects] = useState(false);

  const activeSrvObj = ocServers.find((s) => s.id === server) ?? ocServers[0];
  const discoveredProjects = ocProjectsByServer?.[server] ?? [];
  const serverRepos = mergeRepos(
    activeSrvObj?.repos?.length ? activeSrvObj.repos : KNOWN_REPOS,
    discoveredProjects,
  );
  const serverModels = ocModelsByServer[server] ?? [];
  const defaultModelObj = serverModels.find((m) => m.isDefault);
  const isTargetServerOnline = ocServerOnlineById[server] ?? ocConnected;
  const targetLabel = repo ? `${server}/${shortRepo(repo)}` : server;

  const handleAddCustomFolder = () => {
    const rawDir = customFolderDir.trim();
    if (!rawDir) return;
    const srvRoot = activeSrvObj?.defaultDir || "/Users/justinyu";
    const resolvedDir = rawDir.startsWith("~/")
      ? `${srvRoot.replace(/\/+$/, "")}/${rawDir.slice(2)}`
      : rawDir;
    const derivedLabel = pathToRepoLabel(resolvedDir, srvRoot);
    if (onAddProject) {
      onAddProject(server, derivedLabel, resolvedDir);
    }
    setRepo(derivedLabel);
    metaLive.current = { ...metaLive.current, repo: derivedLabel };
    scheduleFlush();
    setCustomFolderDir("");
    setShowCustomFolder(false);
  };

  const activeSid =
    sessions[sessions.length - 1] ??
    (!unlinkedExplicitlyRef.current
      ? initialMeta.sessions[initialMeta.sessions.length - 1]
      : "") ??
    "";
  const turns = summary?.turns ?? [];

  const scrollThreadToBottom = useCallback((smooth = true) => {
    for (const ref of [threadScrollRef, zenThreadScrollRef]) {
      const el = ref.current;
      if (el) {
        el.scrollTo({
          top: el.scrollHeight,
          behavior: smooth ? "smooth" : "auto",
        });
      }
    }
  }, []);

  // Clear optimistic pendingSteer once the server turn list includes it (or after timeout)
  useEffect(() => {
    if (!pendingSteer) return;
    const clean = pendingSteer.text.trim();
    const matched = turns.some(
      (turn) =>
        turn.role === "user" &&
        (turn.text.trim() === clean ||
          (turn.timestamp != null && turn.timestamp >= pendingSteer.sentAt - 2000)),
    );
    if (matched && liveSession?.status !== "running") {
      setPendingSteer(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setPendingSteer(null);
    }, 15_000);
    return () => window.clearTimeout(timer);
  }, [pendingSteer, turns, liveSession?.status]);

  // Follow live response as new steps, reasoning, and text stream in
  useEffect(() => {
    if (!followLiveRef.current) return;
    if (pendingSteer || liveSession?.status === "running" || turns.length > 0) {
      const id = window.requestAnimationFrame(() => scrollThreadToBottom(Boolean(pendingSteer)));
      return () => window.cancelAnimationFrame(id);
    }
  }, [
    turns.length,
    summary?.lastAssistantText,
    summary?.lastToolCall,
    summary?.recentTools?.length,
    liveSession?.status,
    pendingSteer,
    scrollThreadToBottom,
  ]);

  const handleThreadScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    followLiveRef.current = distFromBottom < 140;
  };

  const handleModelChange = (nextModel: string) => {
    userChangedModelRef.current = true;
    setModel(nextModel);
    metaLive.current = { ...metaLive.current, model: nextModel };
    scheduleFlush();
    if (activeSid && isTargetServerOnline && nextModel) {
      switchOpenCodeSessionModel(activeSid, nextModel, server).catch(() => {});
    }
  };

  const handleSelectNoneHuman = () => {
    userChangedServerRef.current = true;
    userChangedRepoRef.current = true;
    userChangedModelRef.current = true;
    unlinkedExplicitlyRef.current = true;
    setServer("");
    setRepo("");
    setModel("");
    setSessions([]);
    setQueued(false);
    metaLive.current = {
      ...metaLive.current,
      server: "",
      repo: "",
      model: "",
      sessions: [],
      queued: false,
    };
    scheduleFlush();
  };

  const handleSelectServer = (sId: string) => {
    userChangedServerRef.current = true;
    userChangedRepoRef.current = true;
    const s = ocServers.find((x) => x.id === sId);
    const nextRepos = s?.repos?.length ? s.repos : KNOWN_REPOS;
    const nextRepo = nextRepos.some((r) => r.label === repo)
      ? repo
      : (nextRepos[0]?.label ?? "");
    setServer(sId);
    setRepo(nextRepo);
    metaLive.current = {
      ...metaLive.current,
      server: sId,
      repo: nextRepo,
    };
    scheduleFlush();
  };

  const submitToAgent = () => {
    clearTimeout(debRef.current);
    if (!server) {
      if (onStartCountdown) onStartCountdown();
      return;
    }
    unlinkedExplicitlyRef.current = false;
    followLiveRef.current = true;
    const v = titleLive.current.trim();
    if (v && v !== tLive.current.content) persist({ content: v });
    const explicitModelOverride = userChangedModelRef.current
      ? (model || undefined)
      : undefined;
    if (hasSessionOutput) {
      const cleanReply = replyText.trim();
      const hasDraftAnswers = Boolean(
        liveSession?.form && Object.keys(draftFormAnswers).length > 0,
      );
      if (hasDraftAnswers && liveSession?.form) {
        const summaryParts: string[] = [];
        for (const f of liveSession.form.fields) {
          const val = draftFormAnswers[f.key];
          if (val === undefined) continue;
          if (Array.isArray(val)) {
            if (val.length > 0) summaryParts.push(val.join(", "));
          } else if (val) {
            const opt = f.options?.find((o) => o.value === val);
            summaryParts.push(opt?.label || val);
          }
        }
        if (cleanReply) {
          setPendingSteer({ text: cleanReply, sentAt: Date.now() });
        }
        onAnswerForm(
          draftFormAnswers,
          undefined,
          summaryParts.join(" · ") || "answer",
          cleanReply || undefined,
        );
        setDraftFormAnswers({});
        setReplyText("");
        window.setTimeout(() => scrollThreadToBottom(true), 40);
        return;
      }
      const msg =
        cleanReply || (!activeSid ? prompt.trim() || titleLive.current.trim() : "");
      if (!msg) {
        promptRef.current?.focus();
        return;
      }
      setPendingSteer({ text: msg, sentAt: Date.now() });
      onHandToAgent(msg, server, explicitModelOverride, repo, note);
      setReplyText("");
      window.setTimeout(() => scrollThreadToBottom(true), 40);
    } else {
      const initialMsg = prompt.trim() || titleLive.current.trim();
      if (initialMsg) {
        setPendingSteer({ text: initialMsg, sentAt: Date.now() });
      }
      onHandToAgent(
        prompt,
        server,
        activeSid ? explicitModelOverride : (model || undefined),
        repo,
        note,
      );
      window.setTimeout(() => scrollThreadToBottom(true), 40);
    }
  };

  const targetPickerEl = (
    <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
      <span className="text-zinc-500">Target:</span>
      <button
        type="button"
        onClick={handleSelectNoneHuman}
        title="Switch to Human (clear server, detach agent)"
        className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 transition-colors ${
          !server
            ? "bg-zinc-200 font-medium text-zinc-950"
            : "bg-zinc-800/70 text-zinc-400 hover:text-zinc-200"
        }`}
      >
        <span>None (Human)</span>
      </button>
      {ocServers.map((s) => {
        const active = server === s.id;
        const online = ocServerOnlineById[s.id];
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => handleSelectServer(s.id)}
            title={`Run on ${s.id} (${online ? "online" : "offline"})`}
            className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 transition-colors ${
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

      {server && (
        <>
          <span className="text-zinc-600">/</span>
          <div className="flex items-center gap-1">
            <select
              value={repo}
              onChange={(e) => {
                if (e.target.value === "__add_custom__") {
                  setShowCustomFolder(true);
                  return;
                }
                userChangedRepoRef.current = true;
                setShowCustomFolder(false);
                setRepo(e.target.value);
                metaLive.current = { ...metaLive.current, repo: e.target.value };
                scheduleFlush();
              }}
              className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-zinc-200 outline-none"
            >
              <option value="">~ ({activeSrvObj?.defaultDir || "/Users/justinyu"})</option>
              {serverRepos.map((r) => (
                <option key={r.label} value={r.label}>
                  {shortRepo(r.label)} ({r.dir})
                </option>
              ))}
              <option value="__add_custom__">+ Open other folder…</option>
            </select>
            <button
              type="button"
              disabled={refreshingProjects}
              onClick={async () => {
                if (onRefreshProjects) {
                  setRefreshingProjects(true);
                  try {
                    await onRefreshProjects(server);
                  } finally {
                    setRefreshingProjects(false);
                  }
                }
              }}
              title="Refresh project folders from OpenCode"
              className="rounded border border-zinc-800 bg-zinc-900/80 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200 disabled:opacity-50"
            >
              {refreshingProjects ? "…" : "⟳"}
            </button>
          </div>
        </>
      )}
    </div>
  );

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

  const currentProject = projects?.find((p) => p.id === t.project_id);
  const currentProjectName = currentProject?.name;

  const configCapsuleEl = (
    <button
      type="button"
      onClick={() => setConfigOpen((o) => !o)}
      title="Configure Target, Model, Folder, and Project routing"
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px] transition-colors ${
        configOpen
          ? "border-orange-500/50 bg-orange-500/10 text-orange-300"
          : "border-zinc-800 bg-zinc-900/80 text-zinc-300 hover:border-zinc-700 hover:text-zinc-100"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          !server
            ? "bg-zinc-500"
            : isTargetServerOnline
              ? "bg-orange-500"
              : "bg-zinc-600"
        }`}
      />
      <span className="truncate max-w-44 sm:max-w-72">
        {!server
          ? "👤 Human"
          : `${server}${repo ? `/${shortRepo(repo)}` : ""}${model ? ` · ${shortModelLabel(model)}` : ""}`}
      </span>
      {currentProjectName && (
        <span className="text-zinc-500 hidden sm:inline">#{currentProjectName}</span>
      )}
      <span className="text-zinc-500 text-[9px]">{configOpen ? "▲" : "▼"}</span>
    </button>
  );

  const configDrawerEl = configOpen ? (
    <div className="rounded-xl border border-zinc-800/90 bg-zinc-950/95 p-3 space-y-2.5 text-[12px] shadow-lg">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {targetPickerEl}
        {server && (
          <div className="flex items-center gap-1.5 font-mono text-[11px]">
            <span className="text-zinc-500">Model:</span>
            {modelSelectEl}
          </div>
        )}
      </div>

      {server && (
        <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] border-t border-zinc-900 pt-2 text-zinc-400">
          <div className="flex items-center gap-1.5 min-w-0 flex-1 truncate">
            <span className="text-zinc-600">Dir:</span>
            <span className="truncate text-zinc-400">
              {liveSession?.directory ||
                serverRepos.find((r) => r.label === repo)?.dir ||
                activeSrvObj?.defaultDir ||
                "/Users/justinyu"}
            </span>
          </div>
          {activeSid && (
            <div className="flex shrink-0 items-center gap-2">
              {getOpenCodeWebUrl(activeSid, activeSrvObj) && (
                <a
                  href={getOpenCodeWebUrl(activeSid, activeSrvObj)!}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open session in OpenCode Web UI"
                  className="text-orange-400 hover:text-orange-300"
                >
                  Web ↗
                </a>
              )}
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(`opencode -s ${activeSid}`)}
                title={`Copy "opencode -s ${activeSid}"`}
                className="text-zinc-500 hover:text-zinc-300"
              >
                {activeSid.slice(0, 10)} 📋
              </button>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-zinc-900 pt-2 font-mono text-[11px]">
        {onMoveProject && projects && projects.length > 0 && !t.id.startsWith("tmp-") && (
          <label className="flex items-center gap-1.5 text-zinc-400">
            <span className="text-zinc-500">Project list:</span>
            <select
              aria-label="Move to another list"
              value={t.project_id || ""}
              onChange={(e) => e.target.value && onMoveProject(t, e.target.value)}
              className="rounded border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-zinc-200 outline-none hover:border-zinc-700"
            >
              <option value="" disabled>
                {currentProjectName || "Move to project…"}
              </option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {effectiveJira && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-zinc-500">Jira:</span>
            <span className="inline-flex items-center gap-1 rounded border border-blue-500/40 bg-blue-950/40 px-1.5 py-0.5 text-blue-300">
              🎫 {effectiveJira}
            </span>
            {unlinkedJiraSession && (
              <button
                type="button"
                onClick={() => {
                  unlinkedExplicitlyRef.current = false;
                  const next = Array.from(new Set([...sessions, unlinkedJiraSession.id]));
                  setSessions(next);
                  if (unlinkedJiraSession.serverId) setServer(unlinkedJiraSession.serverId);
                  if (unlinkedJiraSession.repoShort && !repo) {
                    setRepo(unlinkedJiraSession.repoShort);
                  }
                  metaLive.current = {
                    ...metaLive.current,
                    sessions: next,
                    server: unlinkedJiraSession.serverId || server,
                    repo: repo || unlinkedJiraSession.repoShort || "",
                  };
                  flush();
                }}
                title={`Auto-matched OpenCode session "${unlinkedJiraSession.title}" (${unlinkedJiraSession.serverId})`}
                className="inline-flex items-center gap-1 rounded border border-orange-500/50 bg-orange-950/50 px-2 py-0.5 text-orange-300 hover:border-orange-400"
              >
                🔗 Link {unlinkedJiraSession.id.slice(0, 10)}
              </button>
            )}
            {activeSid && (
              <button
                type="button"
                disabled={jiraSyncState === "syncing"}
                onClick={async () => {
                  setJiraSyncState("syncing");
                  const res = await syncSessionToJiraIssue({
                    jiraKey: effectiveJira,
                    sessionID: activeSid,
                    sessionTitle: title,
                    serverId: server || defaultServerId,
                    repo,
                  });
                  setJiraSyncState(res.ok ? "synced" : "error");
                  window.setTimeout(() => setJiraSyncState(""), 3000);
                }}
                title={`Link OpenCode session ${activeSid} onto Jira ticket ${effectiveJira} via Atlassian MCP`}
                className="rounded border border-blue-500/30 bg-blue-950/30 px-2 py-0.5 text-blue-300 hover:border-blue-400 disabled:opacity-50"
              >
                {jiraSyncState === "syncing"
                  ? "Linking to Jira…"
                  : jiraSyncState === "synced"
                    ? `✓ Linked in ${effectiveJira}`
                    : jiraSyncState === "error"
                      ? "⚠ Retry Jira Link"
                      : "🔗 Sync to Jira"}
              </button>
            )}
          </div>
        )}
      </div>

      {showCustomFolder && (
        <div className="flex w-full items-center gap-1.5 rounded border border-zinc-800 bg-zinc-950/70 p-1.5">
          <input
            type="text"
            placeholder={`Path (e.g. ~/Develop/my-project or ${activeSrvObj?.defaultDir || "/Users/justinyu"}/...)`}
            value={customFolderDir}
            onChange={(e) => setCustomFolderDir(e.target.value)}
            className="flex-1 bg-transparent px-2 py-1 font-mono text-[11px] text-zinc-100 outline-none placeholder:text-zinc-600"
            autoFocus
          />
          <button
            type="button"
            onClick={handleAddCustomFolder}
            className="shrink-0 rounded bg-orange-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-orange-500"
          >
            Add & Select
          </button>
          <button
            type="button"
            onClick={() => setShowCustomFolder(false)}
            className="shrink-0 text-[11px] text-zinc-500 hover:text-zinc-300"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  ) : null;

  const [isBrowserFs, setIsBrowserFs] = useState(
    typeof document !== "undefined" && Boolean(document.fullscreenElement),
  );

  useEffect(() => {
    const onFsChange = () => {
      setIsBrowserFs(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  const toggleBrowserFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  if (zen) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950 text-zinc-100 overflow-hidden select-text">
        {/* ZEN TOP BAR */}
        <header className="shrink-0 border-b border-zinc-800/80 bg-zinc-950/95 px-4 py-3 sm:px-8 sm:py-3.5 backdrop-blur">
          <div className="mx-auto flex w-full max-w-none items-center justify-between gap-3 sm:gap-6">
            <div className="flex min-w-0 flex-1 items-center gap-2.5 sm:gap-3.5">
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-orange-500/30 bg-orange-500/10 px-2.5 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wider text-orange-400">
                <span className="h-1.5 w-1.5 rounded-full bg-orange-500 animate-pulse" />
                Zen Mode
              </span>

              <input
                autoFocus
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  scheduleFlush();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                placeholder="Task title…"
                className="min-w-0 flex-1 bg-transparent text-[18px] sm:text-[22px] lg:text-[24px] font-semibold tracking-[-0.015em] text-zinc-100 placeholder:text-zinc-600 outline-none"
              />

              {saveState && (
                <span className="shrink-0 font-mono text-[12px] text-zinc-500">
                  {saveState === "saving" ? "Saving…" : "Saved ✓"}
                </span>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
              <DurationChips
                t={t}
                durations={durations}
                defaultMinutes={defaultMinutes}
                onDuration={onDuration}
              />

              {onStartCountdown && (
                <button
                  type="button"
                  onClick={onStartCountdown}
                  title="Open classic countdown timer"
                  className="rounded-lg border border-zinc-800 bg-zinc-900/80 px-2.5 py-1.5 text-[12px] text-zinc-300 hover:border-zinc-700 hover:bg-zinc-800 hover:text-white transition-colors"
                >
                  ⏱ Timer
                </button>
              )}

              {onComplete && (
                <button
                  type="button"
                  onClick={onComplete}
                  title="Mark Task Done"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-[12px] font-medium text-zinc-200 hover:border-zinc-700 hover:bg-zinc-800 hover:text-white transition-colors"
                >
                  <span>✓</span>
                  <span className="hidden sm:inline">Done</span>
                </button>
              )}

              <button
                type="button"
                onClick={toggleBrowserFullscreen}
                title={isBrowserFs ? "Exit Native Fullscreen (F11)" : "Enter Native Fullscreen (F11)"}
                aria-label={isBrowserFs ? "Exit Native Fullscreen" : "Enter Native Fullscreen"}
                className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 font-mono text-[13px] text-zinc-400 hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
              >
                {isBrowserFs ? "⤡" : "⛶"}
              </button>

              {onToggleZen && (
                <button
                  type="button"
                  onClick={onToggleZen}
                  title="Exit Zen Mode (Esc or ⌘E)"
                  aria-label="Exit Zen Mode"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-orange-500/40 bg-orange-600/10 px-3 py-1.5 text-[12px] font-medium text-orange-400 hover:bg-orange-600/20 hover:text-orange-300 transition-colors"
                >
                  <span>⤡</span>
                  <span className="hidden sm:inline">Exit Zen</span>
                  <span className="hidden md:inline font-mono text-[10px] text-orange-400/70">Esc</span>
                </button>
              )}
            </div>
          </div>
        </header>

        {/* ZEN WORKSPACE */}
        <div className="flex-1 min-h-0 w-full max-w-none mx-auto p-4 sm:p-6 lg:p-8 flex flex-col">
          {!hasSessionOutput ? (
            /* ===============================================================
               CLEAN SETUP: Expansive full-screen writing & dispatch canvas
               =============================================================== */
            <div className="grid h-full min-h-0 gap-6 lg:grid-cols-12 overflow-y-auto lg:overflow-hidden">
              {/* LEFT: Expansive Task Notes & Spec Editor (Full Height) */}
              <div className="flex flex-col h-full min-h-[360px] lg:min-h-0 rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5 sm:p-6 backdrop-blur-sm lg:col-span-7 xl:col-span-8">
                <div className="flex items-center justify-between pb-3 border-b border-zinc-800/60">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-orange-500/70" />
                    <h3 className="text-[13px] font-semibold uppercase tracking-wider text-zinc-300">
                      Task Notes & Context
                    </h3>
                  </div>
                  <span className="font-mono text-[11px] text-zinc-500">
                    {note.trim() ? `${note.trim().split(/\s+/).filter(Boolean).length} words` : "Empty"} · Markdown enabled
                  </span>
                </div>
                <textarea
                  value={note}
                  onChange={(e) => {
                    setNote(e.target.value);
                    scheduleFlush();
                  }}
                  placeholder="Deep focus scratchpad… Write detailed specifications, steps, links, API snippets, or problem diagnosis here. Everything auto-saves to your task description."
                  className="flex-1 min-h-[280px] lg:min-h-0 w-full resize-none bg-transparent pt-4 text-[15px] sm:text-[16px] leading-relaxed text-zinc-100 placeholder:text-zinc-600 outline-none selection:bg-orange-500/30 font-normal"
                />
              </div>

              {/* RIGHT: Clean Agent Dispatch & Target Configuration */}
              <div className="flex flex-col h-full min-h-0 justify-between gap-5 rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-5 sm:p-6 backdrop-blur-sm lg:col-span-5 xl:col-span-4">
                <div className="space-y-4">
                  <div className="flex items-center justify-between pb-3 border-b border-zinc-800/60">
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${isTargetServerOnline ? "bg-orange-500" : "bg-zinc-600"}`} />
                      <h3 className="text-[13px] font-semibold uppercase tracking-wider text-zinc-300">
                        Agent Target
                      </h3>
                    </div>
                    <span className="font-mono text-[11px] text-zinc-500">
                      {isTargetServerOnline ? "Server Online" : "Server Offline (Queues)"}
                    </span>
                  </div>

                  {/* Target Server Buttons */}
                  <div className="space-y-1.5">
                    <label className="block font-mono text-[11px] text-zinc-500 uppercase tracking-wider">
                      Execution Server
                    </label>
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          setServer("");
                          setRepo("");
                          setModel("");
                          metaLive.current = { ...metaLive.current, server: "", repo: "", model: "" };
                          scheduleFlush();
                        }}
                        className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-mono text-[12px] transition-colors ${
                          !server
                            ? "bg-zinc-200 font-medium text-zinc-950"
                            : "bg-zinc-800/70 text-zinc-400 hover:text-zinc-200"
                        }`}
                      >
                        <span>None (Human)</span>
                      </button>
                      {ocServers.map((s) => {
                        const active = server === s.id;
                        const online = ocServerOnlineById[s.id];
                        return (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => {
                              const nextRepos = s.repos?.length ? s.repos : KNOWN_REPOS;
                              const nextRepo = nextRepos.some((r) => r.label === repo) ? repo : (nextRepos[0]?.label ?? "");
                              setServer(s.id);
                              setRepo(nextRepo);
                              metaLive.current = { ...metaLive.current, server: s.id, repo: nextRepo };
                              scheduleFlush();
                            }}
                            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-mono text-[12px] transition-colors ${
                              active
                                ? "bg-zinc-200 font-medium text-zinc-950"
                                : "bg-zinc-800/70 text-zinc-400 hover:text-zinc-200"
                            }`}
                          >
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${
                                online ? (active ? "bg-orange-600" : "bg-orange-500") : "bg-zinc-600"
                              }`}
                            />
                            <span>{s.id}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Project Directory Picker */}
                  <div className="space-y-1.5">
                    <label className="block font-mono text-[11px] text-zinc-500 uppercase tracking-wider">
                      Target Project
                    </label>
                    <div className="flex items-center gap-2">
                      <select
                        value={repo}
                        onChange={(e) => {
                          if (e.target.value === "__add_custom__") {
                            setShowCustomFolder(true);
                            return;
                          }
                          setShowCustomFolder(false);
                          setRepo(e.target.value);
                          metaLive.current = { ...metaLive.current, repo: e.target.value };
                          scheduleFlush();
                        }}
                        className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-[12px] text-zinc-200 outline-none hover:border-zinc-700"
                      >
                        <option value="">~ ({activeSrvObj?.defaultDir || "/Users/justinyu"})</option>
                        {serverRepos.map((r) => (
                          <option key={r.label} value={r.label}>
                            {shortRepo(r.label)} ({r.dir})
                          </option>
                        ))}
                        <option value="__add_custom__">+ Open other folder…</option>
                      </select>
                      <button
                        type="button"
                        disabled={refreshingProjects}
                        onClick={async () => {
                          if (onRefreshProjects) {
                            setRefreshingProjects(true);
                            try {
                              await onRefreshProjects(server);
                            } finally {
                              setRefreshingProjects(false);
                            }
                          }
                        }}
                        title="Refresh projects from OpenCode"
                        className="shrink-0 rounded-lg border border-zinc-800 bg-zinc-900/80 px-2.5 py-2 font-mono text-[11px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200 disabled:opacity-50"
                      >
                        {refreshingProjects ? "…" : "⟳"}
                      </button>
                    </div>

                    {showCustomFolder && (
                      <div className="mt-2 flex w-full items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950/90 p-2">
                        <input
                          type="text"
                          placeholder={`Path (e.g. ~/Develop/my-project)`}
                          value={customFolderDir}
                          onChange={(e) => setCustomFolderDir(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleAddCustomFolder();
                            if (e.key === "Escape") setShowCustomFolder(false);
                          }}
                          className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-orange-500"
                          autoFocus
                        />
                        <button
                          type="button"
                          onClick={handleAddCustomFolder}
                          className="shrink-0 rounded bg-orange-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-orange-500"
                        >
                          Add & Select
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowCustomFolder(false)}
                          className="shrink-0 text-[11px] text-zinc-500 hover:text-zinc-300"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>

                  {/* AI Model Selection */}
                  <div className="space-y-1.5">
                    <label className="block font-mono text-[11px] text-zinc-500 uppercase tracking-wider">
                      Model Selection
                    </label>
                    <div className="w-full">
                      {modelSelectEl}
                    </div>
                  </div>

                  {/* Move to another Todoist list if available */}
                  {onMoveProject && projects && projects.length > 0 && !t.id.startsWith("tmp-") && (
                    <div className="space-y-1.5">
                      <label className="block font-mono text-[11px] text-zinc-500 uppercase tracking-wider">
                        Todoist Project
                      </label>
                      <select
                        aria-label="Move to another list"
                        className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-[12px] text-zinc-300 outline-none hover:border-zinc-700"
                        value=""
                        onChange={(e) => e.target.value && onMoveProject(t, e.target.value)}
                      >
                        <option value="" disabled>
                          Move to another list…
                        </option>
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Queued Banner if Queued */}
                  {queued && !liveSession && (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-zinc-950/90 px-3.5 py-2 text-[12px]">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-amber-300">
                          ⏳ Queued in Todoist — will start when {server} connects
                        </span>
                        {!isTargetServerOnline &&
                          ocVerifyById?.[server]?.error?.includes("401") &&
                          onOpenOcSettings && (
                            <button
                              type="button"
                              onClick={onOpenOcSettings}
                              className="rounded border border-amber-500/50 bg-amber-950/60 px-2 py-0.5 text-[11px] font-medium text-amber-200 hover:bg-amber-900/60"
                            >
                              Set password ⚙
                            </button>
                          )}
                      </div>
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
                  )}
                </div>

                {/* Prompt Composer & Launch Action */}
                <div className="space-y-3 pt-4 border-t border-zinc-800/60">
                  <div className="flex items-center justify-between">
                    <label className="font-mono text-[11px] text-zinc-400 uppercase tracking-wider">
                      Initial Prompt for {targetLabel}
                    </label>
                    <span className="font-mono text-[11px] text-zinc-500">
                      Press ⌘↵ to start
                    </span>
                  </div>

                  <textarea
                    ref={promptRef}
                    rows={5}
                    value={prompt}
                    onChange={(e) => {
                      setPrompt(e.target.value);
                      scheduleFlush();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        submitToAgent();
                      }
                    }}
                    placeholder={`Describe the objective for OpenCode on ${targetLabel}…`}
                    className="w-full resize-none rounded-xl border border-zinc-800 bg-zinc-950/90 p-3.5 text-[14px] leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-orange-500/70 transition-colors"
                  />

                  <div className="flex items-center justify-between pt-1">
                    <div className="flex items-center gap-2">
                      {onDemote && (
                        <button
                          type="button"
                          onClick={() => onDemote(t)}
                          className="rounded-lg border border-zinc-800 px-3 py-1.5 text-[12px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
                        >
                          ↓ Move to Backlog
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => (confirming ? onDelete(t) : setConfirming(true))}
                        className={`text-[12px] px-2 py-1 transition-colors ${
                          confirming ? "text-red-500 font-medium" : "text-zinc-600 hover:text-zinc-400"
                        }`}
                      >
                        {confirming ? "Confirm Delete?" : "Delete"}
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={submitToAgent}
                      className="inline-flex items-center gap-2 rounded-xl bg-orange-600 px-5 py-2.5 text-[13px] font-semibold text-white shadow-lg shadow-orange-950/40 hover:bg-orange-500 transition-colors cursor-pointer"
                    >
                      <span>▶</span>
                      <span>{isTargetServerOnline ? `Run on ${targetLabel}` : `Queue for ${targetLabel}`}</span>
                      <span className="font-mono text-[11px] text-orange-200/80">⌘↵</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* ===============================================================
               ACTIVE SESSION SETUP: Full-height & full-width prompt/response stream
               =============================================================== */
            <div className="flex flex-1 min-h-0 flex-col rounded-xl border border-zinc-800/80 bg-zinc-900/30 px-4 py-2.5 backdrop-blur-sm overflow-hidden">
              {/* Compact 1-line Session Bar */}
              <div className="shrink-0 flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-zinc-800/60 font-mono text-[11px]">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${isTargetServerOnline ? "bg-orange-500" : "bg-zinc-600"}`} />
                  {configCapsuleEl}
                  {server && (
                    <span className="hidden lg:inline truncate text-zinc-500 max-w-xs">
                      {liveSession?.directory || serverRepos.find((r) => r.label === repo)?.dir || activeSrvObj?.defaultDir}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setZenNotesOpen((o) => !o)}
                    className={`rounded border px-2 py-0.5 text-[10.5px] transition-colors ${
                      zenNotesOpen || note.trim()
                        ? "border-orange-500/40 bg-orange-500/10 text-orange-300"
                        : "border-zinc-800 bg-zinc-900/80 text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    📝 Notes{note.trim() ? ` (${note.trim().split(/\s+/).filter(Boolean).length}w)` : ""}
                  </button>
                  {sessions.length > 1 && (
                    <select
                      value={activeSid}
                      onChange={(e) => {
                        const val = e.target.value;
                        unlinkedExplicitlyRef.current = !val;
                        const next = val ? Array.from(new Set([...sessions, val])) : [];
                        setSessions(next);
                        metaLive.current = { ...metaLive.current, sessions: next };
                        scheduleFlush();
                      }}
                      className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 font-mono text-[10.5px] text-zinc-300 outline-none"
                    >
                      {sessions.map((sid) => (
                        <option key={sid} value={sid}>
                          {sid.slice(0, 10)}
                        </option>
                      ))}
                    </select>
                  )}
                  {getOpenCodeWebUrl(activeSid, activeSrvObj) && (
                    <a
                      href={getOpenCodeWebUrl(activeSid, activeSrvObj)!}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-orange-400 hover:text-orange-300"
                    >
                      Web ↗
                    </a>
                  )}
                  {activeSid && (
                    <button
                      type="button"
                      onClick={() => navigator.clipboard?.writeText(`opencode -s ${activeSid}`)}
                      title={`Copy CLI command: opencode -s ${activeSid}`}
                      className="rounded border border-zinc-800 bg-zinc-900/60 px-1.5 py-0.5 text-[10.5px] text-zinc-400 hover:text-zinc-200"
                    >
                      {activeSid.slice(0, 10)} ↗
                    </button>
                  )}
                </div>
              </div>

              {configOpen && <div className="shrink-0 pt-2">{configDrawerEl}</div>}

              {zenNotesOpen && (
                <div className="shrink-0 pt-2">
                  <textarea
                    value={note}
                    onChange={(e) => {
                      setNote(e.target.value);
                      scheduleFlush();
                    }}
                    placeholder="Task notes, references, next steps…"
                    rows={3}
                    className="w-full resize-none rounded-lg border border-zinc-800 bg-zinc-950/90 p-2.5 text-[13px] leading-relaxed text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-700"
                  />
                </div>
              )}

              {/* Scrollable Workstream Body (Full Height) */}
              <div
                ref={zenThreadScrollRef}
                onScroll={handleThreadScroll}
                className="flex-1 min-h-0 overflow-y-auto space-y-3 py-2 pr-1"
              >
                {(turns.length > 0 ||
                  pendingSteer ||
                  summary?.lastAssistantText ||
                  summary?.lastToolCall) && (
                  <SessionThread
                    turns={turns}
                    pendingSteer={pendingSteer}
                    isRunning={liveSession?.status === "running"}
                    serverLabel={targetLabel}
                    fallbackText={summary?.lastAssistantText}
                    fallbackTool={summary?.lastToolCall}
                  />
                )}

                {liveSession?.form && (
                  <QuestionFormCard
                    form={liveSession.form}
                    variant="zen"
                    selectedByField={draftFormAnswers}
                    onSelectedChange={setDraftFormAnswers}
                    onSubmitAnswers={(answers, summaryLabel, steerPrompt) => {
                      if (steerPrompt) {
                        setPendingSteer({ text: steerPrompt, sentAt: Date.now() });
                      }
                      onAnswerForm(answers, undefined, summaryLabel, steerPrompt);
                      setDraftFormAnswers({});
                      window.setTimeout(() => scrollThreadToBottom(true), 40);
                    }}
                    onSteer={(steerText) => {
                      setPendingSteer({ text: steerText, sentAt: Date.now() });
                      onHandToAgent(
                        steerText,
                        server,
                        userChangedModelRef.current ? (model || undefined) : undefined,
                        repo,
                        note,
                      );
                      window.setTimeout(() => scrollThreadToBottom(true), 40);
                    }}
                  />
                )}

                {liveSession?.permission && (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-orange-500/40 bg-zinc-950/90 px-4 py-2.5 text-[12px]">
                    <div className="min-w-0 truncate font-mono text-zinc-200">
                      <span className="text-orange-400">Allow {liveSession.permission.action}: </span>
                      {liveSession.permission.resources.join(" ")}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => onApprove("once")}
                        className="rounded bg-orange-600 px-3 py-1 font-medium text-white hover:bg-orange-500"
                      >
                        Allow once
                      </button>
                      <button
                        type="button"
                        onClick={() => onApprove("always")}
                        className="rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-zinc-200 hover:border-zinc-600"
                      >
                        Always
                      </button>
                      <button
                        type="button"
                        onClick={() => onApprove("reject")}
                        className="rounded px-2.5 py-1 text-zinc-400 hover:bg-zinc-900 hover:text-red-400"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                )}

                {summary?.filesChanged && summary.filesChanged.length > 0 && (
                  <InlineDiffViewer
                    files={summary.filesChanged}
                    onAcceptAndComplete={onComplete}
                  />
                )}
              </div>

              {/* Compact Bottom Steer Composer */}
              <div className="shrink-0 mt-1.5 flex items-end gap-2 rounded-xl border border-zinc-800 bg-zinc-950/95 px-3 py-1.5 focus-within:border-orange-500/70">
                <textarea
                  ref={promptRef}
                  rows={1}
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      submitToAgent();
                    }
                  }}
                  placeholder={`Steer OpenCode on ${targetLabel} (⌘↵ to send)…`}
                  className="min-w-0 flex-1 resize-none overflow-y-auto max-h-36 bg-transparent py-0.5 text-[13.5px] leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-600"
                />
                <div className="flex shrink-0 items-center gap-1.5 pb-0.5">
                  {modelSelectEl}
                  <button
                    type="button"
                    onClick={submitToAgent}
                    title="Send (⌘↵)"
                    aria-label="Send"
                    className="inline-flex h-7 items-center gap-1 rounded-lg bg-orange-600 px-3 text-[12px] font-semibold text-white hover:bg-orange-500 transition-colors cursor-pointer"
                  >
                    <span>↑</span>
                    <span>Send</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={stageMode ? "flex-1 min-h-0 flex flex-col md:h-full" : undefined}>
      <div className={stageMode ? "flex-1 min-h-0 flex flex-col md:h-full" : undefined}>
        {stageMode ? (
          <div className="shrink-0 space-y-1.5 pb-1.5 border-b border-zinc-800/80">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {onToggleSidebar && (
                  <button
                    type="button"
                    onClick={onToggleSidebar}
                    className="hidden md:inline-flex h-6 items-center justify-center rounded border border-zinc-800 bg-zinc-900/80 px-1.5 font-mono text-[11px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                    title={sidebarCollapsed ? "Expand task list sidebar" : "Collapse task list sidebar"}
                    aria-label={sidebarCollapsed ? "Expand task list sidebar" : "Collapse task list sidebar"}
                  >
                    {sidebarCollapsed ? "»" : "«"}
                  </button>
                )}
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    triage === "needs_you"
                      ? "bg-orange-500"
                      : triage === "working"
                        ? "bg-zinc-200 animate-pulse"
                        : "bg-zinc-600"
                  }`}
                />
                <input
                  className="min-w-0 flex-1 bg-transparent text-[15px] sm:text-[16px] font-semibold tracking-[-0.01em] text-zinc-100 outline-none placeholder:text-zinc-600"
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    scheduleFlush();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                  placeholder="Task title…"
                />
                {saveState && (
                  <span className="shrink-0 font-mono text-[11px] text-zinc-500">
                    {saveState === "saving" ? "Saving…" : "Saved ✓"}
                  </span>
                )}
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-1.5 font-mono text-[11px]">
                {effectiveJira && !configOpen && (
                  <span className="inline-flex items-center gap-1 rounded border border-blue-500/40 bg-blue-950/40 px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-blue-300">
                    🎫 {effectiveJira}
                  </span>
                )}
                {configCapsuleEl}
                <button
                  type="button"
                  onClick={() => setNotesOpen((o) => !o)}
                  title="Toggle task notes & context"
                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors ${
                    notesOpen || note.trim()
                      ? "border-orange-500/40 bg-orange-500/10 text-orange-300"
                      : "border-zinc-800 bg-zinc-900/80 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                  }`}
                >
                  <span>📝</span>
                  <span className="hidden sm:inline">Notes</span>
                  {note.trim() && (
                    <span className="text-[10px] text-orange-300/80">
                      {note.trim().split(/\s+/).filter(Boolean).length}w
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setShowMeta((s) => !s)}
                  title="More task options (Jira, session link, timer durations)"
                  className={`rounded-md border px-1.5 py-0.5 font-mono text-[11px] transition-colors ${
                    showMeta
                      ? "border-orange-500/40 bg-orange-500/10 text-orange-300"
                      : "border-zinc-800 bg-zinc-900/80 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                  }`}
                >
                  ⋯
                </button>
                {dur}
                {actions}
                {onComplete && (
                  <button
                    type="button"
                    onClick={onComplete}
                    title="Mark task Done"
                    aria-label="Done"
                    className="inline-flex h-6 items-center justify-center rounded border border-zinc-800 bg-zinc-900 px-2 font-sans text-[11px] font-medium text-zinc-200 transition-colors hover:border-zinc-700 hover:bg-zinc-800 hover:text-white"
                  >
                    ✓ Done
                  </button>
                )}
                {onToggleZen && (
                  <button
                    type="button"
                    onClick={onToggleZen}
                    className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[12px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                    title="Full screen focus mode (⌘E or F)"
                    aria-label="Full screen focus mode"
                  >
                    ⤢
                  </button>
                )}
              </div>
            </div>

            {configDrawerEl}

            {notesOpen && (
              <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/90 p-2.5">
                <textarea
                  ref={noteRef}
                  value={note}
                  onChange={(e) => {
                    setNote(e.target.value);
                    scheduleFlush();
                  }}
                  placeholder="Task notes, specs, steps, links, API snippets, or context…"
                  rows={2}
                  className="w-full resize-none overflow-hidden bg-transparent text-[13px] leading-relaxed text-zinc-100 placeholder:text-zinc-600 outline-none"
                />
              </div>
            )}
          </div>
        ) : (
          <div
            className={`flex items-center gap-2.5 px-3 ${large ? "min-h-13" : "min-h-10"}`}
            onClick={(e) => {
              if (!(e.target as HTMLElement).closest("input,button,select,textarea"))
                onClose();
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
                scheduleFlush();
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
            {configCapsuleEl}
            {dur}
            {actions}
            {onToggleZen && (
              <button
                type="button"
                onClick={onToggleZen}
                className="shrink-0 rounded px-2 py-1 font-mono text-[13px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                title="Full screen focus mode (⌘E or F)"
                aria-label="Full screen focus mode"
              >
                ⤢
              </button>
            )}
          </div>
        )}

        <div className={stageMode ? "flex-1 min-h-0 flex flex-col pt-1.5" : "row-expand"}>
          <div
            className={
              stageMode
                ? "flex-1 min-h-0 flex flex-col"
                : "space-y-3 border-t border-zinc-800/70 px-3.5 pt-3 pb-3.5"
            }
          >
            {!stageMode && configDrawerEl}

            {/* Scrollable workspace region — uses maximum available window height */}
            <div
              ref={threadScrollRef}
              onScroll={handleThreadScroll}
              className={
                stageMode
                  ? "flex-1 min-h-0 overflow-y-auto space-y-2.5 pr-1 py-1 [scrollbar-width:thin] [scrollbar-color:rgba(113,113,122,0.3)_transparent]"
                  : "max-h-96 overflow-y-auto space-y-3 pr-1"
              }
            >
              {/* 2. Live OpenCode Thread (User prompts/steers + default-collapsed Reasoning & Steps + Assistant responses) */}
              {(turns.length > 0 ||
                pendingSteer ||
                summary?.lastAssistantText ||
                summary?.lastToolCall) && (
                <SessionThread
                  turns={turns}
                  pendingSteer={pendingSteer}
                  isRunning={liveSession?.status === "running"}
                  serverLabel={targetLabel}
                  fallbackText={summary?.lastAssistantText}
                  fallbackTool={summary?.lastToolCall}
                />
              )}

              {/* 3. OpenCode Question / Option Picker */}
              {liveSession?.form && (
                <QuestionFormCard
                  form={liveSession.form}
                  variant="stage"
                  selectedByField={draftFormAnswers}
                  onSelectedChange={setDraftFormAnswers}
                  onSubmitAnswers={(answers, summaryLabel, steerPrompt) => {
                    if (steerPrompt) {
                      setPendingSteer({ text: steerPrompt, sentAt: Date.now() });
                    }
                    onAnswerForm(answers, undefined, summaryLabel, steerPrompt);
                    setDraftFormAnswers({});
                    window.setTimeout(() => scrollThreadToBottom(true), 40);
                  }}
                  onSteer={(steerText) => {
                    setPendingSteer({ text: steerText, sentAt: Date.now() });
                    onHandToAgent(
                      steerText,
                      server,
                      userChangedModelRef.current ? (model || undefined) : undefined,
                      repo,
                      note,
                    );
                    window.setTimeout(() => scrollThreadToBottom(true), 40);
                  }}
                />
              )}

              {/* Fallback if a tool permission is pending */}
              {liveSession?.permission && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-orange-500/40 bg-zinc-950 px-3 py-2 text-[12px]">
                  <div className="min-w-0 truncate font-mono text-zinc-200">
                    <span className="text-orange-400">Allow {liveSession.permission.action}: </span>
                    {liveSession.permission.resources.join(" ")}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onApprove("once")}
                      className="rounded bg-orange-600 px-2.5 py-1 font-medium text-white hover:bg-orange-500"
                    >
                      Allow once
                    </button>
                    <button
                      type="button"
                      onClick={() => onApprove("always")}
                      className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-200 hover:border-zinc-600"
                    >
                      Always
                    </button>
                    <button
                      type="button"
                      onClick={() => onApprove("reject")}
                      className="rounded px-2 py-1 text-zinc-400 hover:bg-zinc-900 hover:text-red-400"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              )}

              {/* Inline File Diff Viewer inside Expanded Drawer */}
              {summary?.filesChanged && summary.filesChanged.length > 0 && (
                <InlineDiffViewer
                  files={summary.filesChanged}
                  onAcceptAndComplete={onComplete}
                />
              )}

              {/* 4. Queued Banner (when waiting for an offline server) */}
              {queued && !liveSession && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-500/30 bg-zinc-950 px-3 py-1.5 text-[12px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-amber-300">
                      ⏳ Queued in Todoist — will start when {server} connects
                    </span>
                    {!isTargetServerOnline &&
                      ocVerifyById?.[server]?.error?.includes("401") &&
                      onOpenOcSettings && (
                        <button
                          type="button"
                          onClick={onOpenOcSettings}
                          className="rounded border border-amber-500/50 bg-amber-950/60 px-2 py-0.5 text-[11px] font-medium text-amber-200 hover:bg-amber-900/60"
                        >
                          Set password ⚙
                        </button>
                      )}
                  </div>
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

            {/* 5. Compact Single-Line Steer / Prompt Composer */}
            <div
              className={`flex items-end gap-2 rounded-lg border border-zinc-800/90 bg-zinc-950 px-2.5 py-1.5 focus-within:border-zinc-700 ${
                stageMode ? "shrink-0 mt-1.5" : "mt-2"
              }`}
            >
              <textarea
                ref={promptRef}
                className="min-w-0 flex-1 resize-none overflow-y-auto max-h-36 bg-transparent py-0.5 text-[13px] sm:text-[13.5px] leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-600"
                placeholder={
                  !server
                    ? "Add notes, steps, or scratchpad for this focus session…"
                    : hasSessionOutput
                      ? `Steer OpenCode on ${targetLabel}… (⌘↵ to send)`
                      : `Prompt for ${targetLabel}… (⌘↵ to run)`
                }
                rows={1}
                value={inputVal}
                onChange={(e) => {
                  if (hasSessionOutput && server) {
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
              <div className="flex shrink-0 items-center gap-1 pb-0.5 text-[12px]">
                {!stageMode && (
                  <button
                    type="button"
                    onClick={() => setShowMeta((s) => !s)}
                    className="rounded px-1.5 py-0.5 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
                    title="More options"
                  >
                    ⋯
                  </button>
                )}
                {onMove && (
                  <button
                    type="button"
                    onClick={() => onMove(t)}
                    title="Move task to Focus"
                    aria-label="Move to Focus"
                    className="inline-flex h-6.5 items-center justify-center gap-1 rounded border border-zinc-800 bg-zinc-900 px-2 text-[11.5px] font-medium text-orange-400 transition-colors hover:border-orange-500/50 hover:bg-zinc-800 hover:text-orange-300"
                  >
                    → Focus
                  </button>
                )}
                {onDemote && (
                  <button
                    type="button"
                    onClick={() => onDemote(t)}
                    title="Move to Backlog"
                    aria-label="Move to Backlog"
                    className="inline-flex h-6.5 items-center justify-center rounded px-1.5 text-[11.5px] text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-zinc-200"
                  >
                    ↓ Backlog
                  </button>
                )}
                {!stageMode && onComplete && (
                  <button
                    type="button"
                    onClick={onComplete}
                    title="Done"
                    aria-label="Done"
                    className="inline-flex h-6.5 items-center justify-center rounded px-2 text-[11.5px] font-medium text-zinc-200 transition-colors hover:bg-zinc-900 hover:text-zinc-100"
                  >
                    ✓ Done
                  </button>
                )}
                <button
                  type="button"
                  onClick={submitToAgent}
                  title={
                    !server
                      ? "Start Pomodoro countdown timer (⌘↵)"
                      : hasSessionOutput
                        ? "Send (⌘↵)"
                        : isTargetServerOnline
                          ? onMove
                            ? `Run on ${targetLabel} & move to Focus (⌘↵)`
                            : `Run on ${targetLabel} (⌘↵)`
                          : `Queue for ${targetLabel} (⌘↵)`
                  }
                  aria-label={
                    !server
                      ? "Start Timer"
                      : hasSessionOutput
                        ? "Send"
                        : isTargetServerOnline
                          ? onMove
                            ? `Run on ${targetLabel} & move to Focus`
                            : `Run on ${targetLabel}`
                          : `Queue for ${targetLabel}`
                  }
                  className="inline-flex h-6.5 items-center justify-center gap-1 rounded bg-orange-600 px-2.5 text-[12px] font-medium text-white transition-colors hover:bg-orange-500"
                >
                  {!server
                    ? "⏱ Start"
                    : hasSessionOutput
                      ? "↑ Send"
                      : onMove
                        ? `▶ Run & Focus →`
                        : "▶ Run"}
                </button>
              </div>
            </div>

            {/* 6. Secondary Options Drawer */}
            {showMeta && (
              <div className="space-y-2 border-t border-zinc-800/60 pt-2.5 text-[12px]">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-1.5 text-zinc-400">
                    <span className="text-zinc-500">Jira</span>
                    <input
                      type="text"
                      value={jira}
                      placeholder={extractJiraKey(title) || "DEVOPS-123"}
                      onChange={(e) => {
                        const val = e.target.value.toUpperCase().trim();
                        setJira(val);
                        metaLive.current = {
                          ...metaLive.current,
                          jira: val || extractJiraKey(titleLive.current) || undefined,
                        };
                        scheduleFlush();
                      }}
                      className="w-28 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-[11px] text-blue-300 outline-none placeholder:text-zinc-600 focus:border-blue-500/60"
                    />
                  </label>
                  <label className="flex items-center gap-1.5 text-zinc-400">
                    <span className="text-zinc-500">Session</span>
                    <select
                      value={activeSid}
                      onChange={(e) => {
                        const val = e.target.value;
                        unlinkedExplicitlyRef.current = !val;
                        const next = val ? Array.from(new Set([...sessions, val])) : [];
                        setSessions(next);
                        metaLive.current = { ...metaLive.current, sessions: next };
                        const picked = ocSessions.find((s) => s.id === val);
                        if (picked?.repoShort && !repo) setRepo(picked.repoShort);
                        if (picked?.serverId) setServer(picked.serverId);
                        if (picked?.modelKey) setModel(picked.modelKey);
                        scheduleFlush();
                        if (val && effectiveJira) {
                          void syncSessionToJiraIssue({
                            jiraKey: effectiveJira,
                            sessionID: val,
                            sessionTitle: titleLive.current,
                            serverId: picked?.serverId || server || defaultServerId,
                            repo: repo || picked?.repoShort,
                          });
                        }
                      }}
                      className="max-w-52 truncate rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-[11px] text-zinc-300 outline-none"
                    >
                      <option value="">Auto-create</option>
                      {activeSid && !ocSessions.some((s) => s.id === activeSid) && (
                        <option value={activeSid}>
                          [{server}] {activeSid.slice(0, 10)}
                        </option>
                      )}
                      {ocSessions.map((s) => {
                        const isMatch = matchingJiraSessions.some((m) => m.id === s.id);
                        return (
                          <option key={s.id} value={s.id}>
                            {isMatch ? `★ [${effectiveJira}] ` : ""}[{s.serverId}] {s.id.slice(0, 10)} · {s.title.slice(0, 22)}
                          </option>
                        );
                      })}
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
  disableAgentAction = false,
  ocConnected = false,
  ocServers = [],
  ocServerOnlineById = {},
  ocModelsByServer = {},
  ocProjectsByServer = {},
  onAddProject,
  onRefreshProjects,
  defaultServerId = "local",
  sections,
  onAdd,
}: {
  placeholder: string;
  hotkey?: string;
  alwaysOpen?: boolean;
  inline?: boolean;
  disableAgentAction?: boolean;
  ocConnected?: boolean;
  ocServers?: OpenCodeServer[];
  ocServerOnlineById?: Record<string, boolean>;
  ocModelsByServer?: Record<string, OpenCodeModelOption[]>;
  ocProjectsByServer?: Record<string, OpenCodeRepo[]>;
  onAddProject?: (serverId: string, label: string, dir: string) => void;
  onRefreshProjects?: (serverId: string) => Promise<unknown>;
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
  const [showCustomFolder, setShowCustomFolder] = useState(false);
  const [customFolderDir, setCustomFolderDir] = useState("");
  const [refreshingProjects, setRefreshingProjects] = useState(false);
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

  const parsed = parseAdd(v, sections, ocServers, ocProjectsByServer);
  const effectiveServerId =
    parsed.server ||
    (showDetails
      ? pickedServerId === "none"
        ? ""
        : pickedServerId
      : parsed.repo || parsed.prompt || promptText.trim()
        ? defaultServerId
        : "");
  const activeSrvObj =
    ocServers.find((s) => s.id === (effectiveServerId || defaultServerId)) ?? ocServers[0];
  const discoveredProjects = ocProjectsByServer?.[effectiveServerId || defaultServerId] ?? [];
  const serverRepos = mergeRepos(
    activeSrvObj?.repos?.length ? activeSrvObj.repos : KNOWN_REPOS,
    discoveredProjects,
  );
  const serverModels = ocModelsByServer[effectiveServerId || defaultServerId] ?? [];
  const defaultModelObj = serverModels.find((m) => m.isDefault);
  const effectiveRepo = parsed.repo || (showDetails ? pickedRepo : "");
  const isTargetServerOnline = effectiveServerId
    ? (ocServerOnlineById[effectiveServerId] ?? ocConnected)
    : false;
  const targetLabel = effectiveRepo
    ? `${effectiveServerId || "agent"}/${shortRepo(effectiveRepo)}`
    : effectiveServerId || "Human";

  const handleAddCustomFolder = () => {
    const rawDir = customFolderDir.trim();
    if (!rawDir) return;
    const srvRoot = activeSrvObj?.defaultDir || "/Users/justinyu";
    const resolvedDir = rawDir.startsWith("~/")
      ? `${srvRoot.replace(/\/+$/, "")}/${rawDir.slice(2)}`
      : rawDir;
    const derivedLabel = pathToRepoLabel(resolvedDir, srvRoot);
    if (onAddProject) {
      onAddProject(effectiveServerId || defaultServerId, derivedLabel, resolvedDir);
    }
    setPickedRepo(derivedLabel);
    setCustomFolderDir("");
    setShowCustomFolder(false);
  };

  const submit = (mode: "save" | "drive" | "agent" = "save") => {
    const raw = v.trim();
    if (!raw) return;
    const combinedPrompt = [parsed.prompt, promptText.trim()].filter(Boolean).join("\n");
    const agentMode = mode === "agent";
    const serverToUse =
      effectiveServerId || (agentMode ? defaultServerId : undefined);
    onAdd(raw, {
      repo: effectiveRepo || undefined,
      server: serverToUse || undefined,
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
              submit(disableAgentAction ? "save" : "agent");
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
            <button
              type="button"
              onClick={() => {
                setPickedServerId("none");
                setPickedRepo("");
              }}
              className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 font-mono text-[11px] ${
                !effectiveServerId
                  ? "bg-zinc-200 font-medium text-zinc-950"
                  : "bg-zinc-800/70 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <span>None (Human)</span>
            </button>
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

            <div className="flex items-center gap-1">
              <select
                value={pickedRepo}
                onChange={(e) => {
                  if (e.target.value === "__add_custom__") {
                    setShowCustomFolder(true);
                    return;
                  }
                  setShowCustomFolder(false);
                  setPickedRepo(e.target.value);
                }}
                className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 font-mono text-[11px] text-zinc-200 outline-none"
              >
                <option value="">~ ({activeSrvObj?.defaultDir || "/Users/justinyu"})</option>
                {serverRepos.map((r) => (
                  <option key={r.label} value={r.label}>
                    {shortRepo(r.label)} ({r.dir})
                  </option>
                ))}
                <option value="__add_custom__">+ Open other folder…</option>
              </select>

              <button
                type="button"
                disabled={refreshingProjects}
                onClick={async () => {
                  if (onRefreshProjects) {
                    setRefreshingProjects(true);
                    try {
                      await onRefreshProjects(effectiveServerId);
                    } finally {
                      setRefreshingProjects(false);
                    }
                  }
                }}
                title="Refresh projects from OpenCode"
                className="rounded border border-zinc-800 bg-zinc-900/80 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200 disabled:opacity-50"
              >
                {refreshingProjects ? "…" : "⟳"}
              </button>
            </div>

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

          {showCustomFolder && (
            <div className="flex w-full items-center gap-1.5 rounded border border-zinc-800 bg-zinc-950/70 p-1.5">
              <input
                type="text"
                placeholder={`Path (e.g. ~/Develop/my-project or ${activeSrvObj?.defaultDir || "/Users/justinyu"}/...)`}
                value={customFolderDir}
                onChange={(e) => setCustomFolderDir(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddCustomFolder();
                  if (e.key === "Escape") setShowCustomFolder(false);
                }}
                className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-[11px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-orange-500"
                autoFocus
              />
              <button
                type="button"
                onClick={handleAddCustomFolder}
                className="shrink-0 rounded bg-orange-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-orange-500"
              >
                Add & Select
              </button>
              <button
                type="button"
                onClick={() => setShowCustomFolder(false)}
                className="shrink-0 text-[11px] text-zinc-500 hover:text-zinc-300"
              >
                Cancel
              </button>
            </div>
          )}

          <textarea
            ref={promptRef}
            rows={2}
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit(disableAgentAction ? "save" : "agent");
              }
            }}
            placeholder={`Prompt for ${targetLabel}…`}
            className="w-full resize-none rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-[13px] leading-relaxed text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-700"
          />

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-[11px] text-zinc-500">
              {disableAgentAction
                ? "Enter or ⌘Enter saves to Backlog"
                : isTargetServerOnline
                ? `${effectiveServerId} online · ⌘Enter runs agent`
                : `${effectiveServerId} offline · ⌘Enter queues in Todoist`}
            </span>
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={() => submit("save")} className={btn}>
                Save task
              </button>
              {!disableAgentAction && (
                <button
                  type="button"
                  onClick={() => submit("agent")}
                  className="rounded bg-orange-600 px-3 py-1 text-[12px] font-medium text-white hover:bg-orange-500"
                >
                  {isTargetServerOnline
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
  const safeMinutes = minutes && Number.isFinite(minutes) && minutes > 0 ? minutes : 5;
  const [left, setLeft] = useState(safeMinutes * 60);
  const [paused, setPaused] = useState(false);
  const [timesUp, setTimesUp] = useState(false);
  const [waited, setWaited] = useState(0); // minutes sat in the time-up dialog
  const [over, setOver] = useState(0); // seconds past the planned end
  const endRef = useRef(Date.now() + safeMinutes * 60_000);
  const elapsedRef = useRef(0); // seconds actually run
  const totalRef = useRef(safeMinutes * 60);
  const alarmedRef = useRef(false);
  const autoStoppedRef = useRef(false);
  const pausedRef = useRef(false);
  const pauseStarted = useRef(0);
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;
  // assigned below logAndExit so the interval can trigger the walk-away auto-stop
  const stopRef = useRef<() => void>(() => {});
  const completeRef = useRef<() => void>(() => {}); // device "mark complete" event

  const canNotify = typeof Notification !== "undefined";

  useEffect(() => {
    try {
      if (canNotify && Notification.permission === "default") {
        void Notification.requestPermission().catch?.(() => {});
      }
    } catch {
      /* ignore notification permission errors */
    }
    deviceStart(task, safeMinutes, endRef.current);
    const hb = setInterval(() => deviceUpdate(endRef.current), 10_000); // device heartbeat-timeout is 25s
    const ev = setInterval(async () => {
      try {
        for (const e of await deviceEvents()) {
          if (e.type === "extend") extend(e.minutes ?? 5); // device right-half tap
          else if (e.type === "complete") completeRef.current(); // device right-half hold
          else stopRef.current(); // device left-half hold → log & stop
        }
      } catch {
        /* device events error ignored */
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
      const taskTitle = task?.content ?? "Focus";
      document.title = ov > 0 ? `+${fmt(ov)} - ${taskTitle}` : `${fmt(rem)} - ${taskTitle}`;
      if (rem <= 0 && !alarmedRef.current) {
        alarmedRef.current = true;
        try {
          if (canNotify && Notification.permission === "granted") {
            const n = new Notification("Time's up!", { body: taskTitle });
            n.onclick = () => window.focus();
          }
        } catch {
          /* notification failure ignored */
        }
        if (!gentle) {
          try {
            alarm();
          } catch {
            /* audio context failure ignored */
          }
          document.body.classList.add("flash");
          setTimeout(() => document.body.classList.remove("flash"), 4000);
          setTimesUp(true);
        }
      }
      // unanswered time-up = user probably walked away: ring once more, then log & stop
      if (ov >= AUTO_STOP_SEC && !autoStoppedRef.current) {
        autoStoppedRef.current = true;
        if (!gentle) {
          try {
            alarm();
          } catch {
            /* ignore */
          }
        }
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
  }, [task?.content, gentle, safeMinutes]);

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
  useEffect(() => {
    pausedRef.current = paused;
    if (paused) {
      document.title = `⏸ paused - ${task?.content ?? "Focus"}`;
      pauseStarted.current = Date.now();
      deviceSetPaused(true, endRef.current); // device freezes its digits at end − now
    } else if (pauseStarted.current) {
      endRef.current += Date.now() - pauseStarted.current;
      pauseStarted.current = 0;
      deviceSetPaused(false, endRef.current); // device thaws at the shifted end
    }
  }, [paused, task?.content]);

  const frac = Math.max(0, left / totalRef.current);

  const logAndExit = (completed: boolean) => {
    const secs = elapsedRef.current;
    onLog({
      task_id: task.id,
      task_name: task.content,
      planned_minutes: safeMinutes,
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
  onSyncServerProjects,
  ocModelsByServer = {},
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
  onSyncServerProjects?: (serverId: string) => Promise<number | void>;
  ocModelsByServer?: Record<string, OpenCodeModelOption[]>;
}) {
  const [activeTab, setActiveTab] = useState<"fleet" | "focus" | "hardware" | "system">("fleet");
  const [editingSrvId, setEditingSrvId] = useState<string | null>(null);
  const [newRepoLabel, setNewRepoLabel] = useState("");
  const [newRepoDir, setNewRepoDir] = useState("");
  const [syncingSrvId, setSyncingSrvId] = useState<string | null>(null);
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  const [newEndpoint, setNewEndpoint] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newDir, setNewDir] = useState("/Users/justinyu");
  const [showAddServer, setShowAddServer] = useState(false);

  const card = "rounded-lg border border-zinc-800/90 bg-zinc-900/40 p-4 space-y-3";
  const row = "flex items-center justify-between gap-4 py-2 border-b border-zinc-800/40 last:border-b-0";
  const toggle = (on: boolean) =>
    `relative h-6 w-10 shrink-0 rounded-full transition-colors ${on ? "bg-orange-500" : "bg-zinc-700"}`;

  const onlineServerCount = ocConfig.servers.filter(
    (s) => ocServerOnlineById[s.id] ?? ocVerifyById[s.id]?.ok ?? false,
  ).length;

  // Aggregate all discovered models across servers
  const allDiscoveredModels = useMemo(() => {
    const map = new Map<string, OpenCodeModelOption>();
    for (const srv of ocConfig.servers) {
      const list = ocModelsByServer[srv.id] ?? [];
      for (const m of list) {
        if (!map.has(m.key)) {
          map.set(m.key, m);
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [ocConfig.servers, ocModelsByServer]);

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
    <div className="w-full space-y-6">
      {/* Header & Section Navigation */}
      <div className="flex flex-col gap-4 border-b border-zinc-800/80 pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-[17px] font-semibold text-zinc-100 tracking-tight">Console Settings</h1>
            <p className="text-[12px] text-zinc-400">
              Configure execution fleet, default AI models, focus protocols, and hardware display.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <a
              href="?mock=1"
              className="rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[12px] text-zinc-300 hover:border-zinc-700 hover:text-zinc-100 transition-colors"
              title="Open interactive Multi-Server Flight Deck mockup"
            >
              Flight Deck Mockup ↗
            </a>
            <button
              type="button"
              disabled={ocVerifying}
              onClick={onVerifyOpenCode}
              className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1 text-[12px] font-medium text-orange-400 hover:border-zinc-700 hover:text-orange-300 disabled:opacity-50 transition-colors"
            >
              {ocVerifying ? "Verifying fleet…" : "Verify fleet"}
            </button>
          </div>
        </div>

        {/* Clean Segmented Tabs */}
        <div className="flex items-center gap-1.5 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 p-1">
          <button
            type="button"
            onClick={() => setActiveTab("fleet")}
            className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-[13px] font-medium transition-all ${
              activeTab === "fleet"
                ? "bg-zinc-800 text-zinc-100 shadow-sm"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <span>⚡ Fleet &amp; Agents</span>
            <span
              className={`inline-flex items-center rounded-full px-1.5 py-0.2 font-mono text-[10px] ${
                onlineServerCount > 0
                  ? "border border-emerald-800/40 bg-emerald-950/70 text-emerald-400"
                  : "bg-zinc-800 text-zinc-500"
              }`}
            >
              {onlineServerCount}/{ocConfig.servers.length} online
            </span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("focus")}
            className={`rounded-md px-3 py-1.5 text-[13px] font-medium transition-all ${
              activeTab === "focus"
                ? "bg-zinc-800 text-zinc-100 shadow-sm"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            ⏱ Focus &amp; Timer
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("hardware")}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-all ${
              activeTab === "hardware"
                ? "bg-zinc-800 text-zinc-100 shadow-sm"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <span>📟 Hardware &amp; Sync</span>
            {prefs.deviceOn && (
              <span className="h-1.5 w-1.5 rounded-full bg-orange-400" title="ESP32 companion enabled" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("system")}
            className={`rounded-md px-3 py-1.5 text-[13px] font-medium transition-all ${
              activeTab === "system"
                ? "bg-zinc-800 text-zinc-100 shadow-sm"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            ⚙ System &amp; Data
          </button>
        </div>
      </div>

      {/* TAB 1: FLEET & AGENTS */}
      {activeTab === "fleet" && (
        <div className="space-y-6">
          {queuedCount > 0 && (
            <div className="flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-950/20 px-3.5 py-2.5 text-[12px] text-amber-300">
              <span className="flex items-center gap-2">
                <span>⏳</span>
                <span>
                  <strong>{queuedCount}</strong> task{queuedCount === 1 ? "" : "s"} queued in Todoist
                </span>
              </span>
              {ocConnected && (
                <button
                  type="button"
                  onClick={onRunQueued}
                  className="rounded bg-orange-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-orange-500 transition-colors"
                >
                  ▶ Run queued now
                </button>
              )}
            </div>
          )}

          {/* Global Default Model Card */}
          <div className="rounded-lg border border-zinc-800/90 bg-zinc-900/40 p-4 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-[13px] font-semibold text-zinc-100">Global Default Model</h3>
                  <span className="rounded bg-orange-500/10 px-1.5 py-0.5 font-mono text-[10px] text-orange-400 border border-orange-500/20">
                    Agent Dispatch
                  </span>
                </div>
                <p className="mt-0.5 text-[12px] text-zinc-500">
                  Default model used for newly created sessions or queued runs when not overridden per task or server.
                </p>
              </div>

              <select
                aria-label="Global Default OpenCode Model"
                value={ocConfig.defaultModel ?? ""}
                onChange={(e) => onOcConfig({ defaultModel: e.target.value })}
                className="max-w-xs truncate rounded-md border border-zinc-800 bg-zinc-950 px-3 py-1.5 font-mono text-[12px] text-zinc-200 outline-none focus:border-zinc-700"
              >
                <option value="">(Server default — let each node decide)</option>
                {allDiscoveredModels.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.name} ({m.providerID})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Execution Fleet Nodes List */}
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-[13px] font-semibold text-zinc-100">
                  Execution Servers &amp; Projects ({ocConfig.servers.length})
                </h3>
                <p className="text-[12px] text-zinc-500">
                  Workspaces, project roots, and per-node default models.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowAddServer(true)}
                className="rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[12px] text-zinc-300 hover:border-zinc-700 hover:text-zinc-100"
              >
                ＋ Add server
              </button>
            </div>

            <ul className="space-y-3">
              {ocConfig.servers.map((srv) => {
                const vRes = ocVerifyById[srv.id];
                const isOnline = ocServerOnlineById[srv.id] ?? vRes?.ok ?? false;
                const isDefault = ocConfig.defaultServerId === srv.id;
                const isEditing = editingSrvId === srv.id;
                const resolvedBase = resolveOpenCodeBase(srv.endpoint);
                const srvRepos = srv.repos ?? [];
                const srvModels = ocModelsByServer[srv.id] ?? [];

                return (
                  <li
                    key={srv.id}
                    className="rounded-lg border border-zinc-800/90 bg-zinc-900/40 p-4 text-[13px] space-y-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-2.5 w-2.5 shrink-0 rounded-full transition-all ${
                            ocVerifying
                              ? "bg-orange-400 animate-ping"
                              : isOnline
                                ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]"
                                : "bg-zinc-600"
                          }`}
                        />
                        <span className="font-semibold text-zinc-100">{srv.name}</span>
                        <span className="font-mono text-[12px] text-zinc-500">~{srv.id}</span>
                        {isDefault ? (
                          <span className="rounded bg-orange-950/50 border border-orange-500/30 px-1.5 py-0.5 font-mono text-[10px] text-orange-400">
                            primary default
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onOcConfig({ defaultServerId: srv.id })}
                            className="rounded bg-zinc-800/80 px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
                          >
                            Set primary
                          </button>
                        )}
                      </div>

                      <div className="flex items-center gap-2.5 text-[12px]">
                        <span
                          className={`font-mono text-[11px] ${
                            vRes?.ok ? "text-emerald-400" : "text-zinc-500"
                          }`}
                        >
                          {vRes?.ok
                            ? `${vRes.latencyMs}ms · ${vRes.sessionCount} active ses`
                            : isOnline
                              ? "online"
                              : "offline"}
                        </span>
                        <button
                          type="button"
                          onClick={() => setEditingSrvId(isEditing ? null : srv.id)}
                          className="rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1 text-[11px] text-zinc-300 hover:border-zinc-700 hover:text-zinc-100"
                        >
                          {isEditing ? "Close" : "Edit node"}
                        </button>
                      </div>
                    </div>

                    <div className="font-mono text-[11px] text-zinc-500">
                      {resolvedBase}
                      {!srv.endpoint.trim() && resolvedBase === "/opencode-api" ? " (local Vite bridge)" : ""} ·{" "}
                      {srv.defaultDir || "/Users/justinyu"}
                    </div>

                    {vRes && !vRes.ok && vRes.error && (
                      <p className="rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 font-mono text-[11px] text-zinc-400">
                        {vRes.error}
                      </p>
                    )}

                    {/* Per-Server Default Model */}
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-zinc-800/60 bg-zinc-950/60 px-3 py-2 text-[12px]">
                      <div className="flex items-center gap-1.5">
                        <span className="text-zinc-400">Default Model for ~{srv.id}:</span>
                      </div>
                      <select
                        aria-label={`Default Model for ${srv.name}`}
                        value={srv.defaultModel ?? ""}
                        onChange={(e) => updateServerField(srv.id, { defaultModel: e.target.value })}
                        className="max-w-xs truncate rounded border border-zinc-800 bg-zinc-900 px-2.5 py-1 font-mono text-[11px] text-zinc-200 outline-none focus:border-zinc-700"
                      >
                        <option value="">
                          {ocConfig.defaultModel
                            ? `Inherit global (${shortModelLabel(ocConfig.defaultModel)})`
                            : "(Server default)"}
                        </option>
                        {srvModels.map((m) => (
                          <option key={m.key} value={m.key}>
                            {m.name} ({m.providerID}){m.isDefault ? " [node default]" : ""}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Associated Projects / Repos */}
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="mr-0.5 text-[11px] text-zinc-500">Projects:</span>
                      {onSyncServerProjects && (
                        <button
                          type="button"
                          disabled={syncingSrvId === srv.id}
                          onClick={async () => {
                            setSyncingSrvId(srv.id);
                            try {
                              await onSyncServerProjects(srv.id);
                            } finally {
                              setSyncingSrvId(null);
                            }
                          }}
                          className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 font-mono text-[10px] text-orange-400 hover:border-orange-500/50 hover:text-orange-300 disabled:opacity-50"
                          title="Fetch all projects known to OpenCode on this server"
                        >
                          {syncingSrvId === srv.id ? "Syncing…" : "⟳ Sync from OpenCode"}
                        </button>
                      )}
                      {srvRepos.length === 0 ? (
                        <span className="font-mono text-[11px] text-zinc-600">
                          ~ ({srv.defaultDir || "/Users/justinyu"})
                        </span>
                      ) : (
                        srvRepos.map((r) => (
                          <span
                            key={r.label}
                            title={r.dir}
                            className="inline-flex items-center gap-1 rounded border border-zinc-800/80 bg-zinc-950/80 px-2 py-0.5 font-mono text-[11px] text-zinc-300"
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
                      <div className="space-y-3 border-t border-zinc-800/80 pt-3 text-[12px]">
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
                                const rawDir = newRepoDir.trim();
                                const srvRoot = srv.defaultDir || "/workspace";
                                const dir = rawDir.startsWith("~/")
                                  ? `${srvRoot.replace(/\/+$/, "")}/${rawDir.slice(2)}`
                                  : rawDir;
                                if (!dir) return;
                                const lbl = newRepoLabel.trim() || pathToRepoLabel(dir, srvRoot);
                                updateServerField(srv.id, {
                                  repos: [
                                    ...srvRepos.filter((x) => x.label !== lbl && x.dir !== dir),
                                    { label: lbl, dir },
                                  ],
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
                className="w-full rounded-lg border border-dashed border-zinc-800 py-2.5 text-[12px] text-zinc-400 hover:border-zinc-700 hover:bg-zinc-900/40 hover:text-zinc-200 transition-colors"
              >
                ＋ Add execution server (devbox, cloud VM, or homelab)
              </button>
            ) : (
              <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/70 p-4 text-[12px]">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-zinc-200">New Execution Server</span>
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
                    placeholder="ID slug (e.g. devbox-2)"
                    value={newId}
                    onChange={(e) => setNewId(e.target.value)}
                  />
                  <input
                    className={`${input} py-1.5 text-[12px]`}
                    placeholder="Display name (e.g. Cloud Devbox)"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                  />
                </div>
                <input
                  className={`${input} py-1.5 font-mono text-[12px]`}
                  placeholder="Endpoint URL (e.g. https://devbox.vyond.ts.net/api)"
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
                <div className="flex justify-end pt-1">
                  <button
                    type="button"
                    onClick={addServer}
                    disabled={!newId.trim()}
                    className="rounded bg-orange-600 px-3.5 py-1.5 text-[12px] font-medium text-white hover:bg-orange-500 disabled:opacity-40 transition-colors"
                  >
                    Save Execution Server
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Automation Options */}
          <div className="rounded-lg border border-zinc-800/90 bg-zinc-900/40 p-4 space-y-3">
            <h3 className="text-[13px] font-semibold text-zinc-100">Automation &amp; Queueing</h3>
            <div className={row}>
              <div>
                <span className="text-[13px] font-medium text-zinc-200">
                  Auto-run queued tasks when server connects
                </span>
                <p className="text-[12px] text-zinc-500">
                  Automatically start tasks marked <code className="font-mono text-zinc-400">queue=1</code> as soon as their target execution node comes online.
                </p>
              </div>
              <button
                type="button"
                className={toggle(ocConfig.autoRunQueued)}
                onClick={() => onOcConfig({ autoRunQueued: !ocConfig.autoRunQueued })}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                    ocConfig.autoRunQueued ? "left-4.5" : "left-0.5"
                  }`}
                />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: FOCUS & TIMER */}
      {activeTab === "focus" && (
        <div className="space-y-6">
          <div className={card}>
            <div>
              <h3 className="text-[13px] font-semibold text-zinc-100">Focus Task Capacity</h3>
              <p className="text-[12px] text-zinc-500">
                Maximum active tasks allowed simultaneously in the Focus section.
              </p>
            </div>
            <div className="max-w-xs">
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
              <p className="mt-1 text-[11px] text-zinc-500">
                Any positive number. Defaults to 3 if empty or invalid.
              </p>
            </div>
          </div>

          <div className={card}>
            <div>
              <h3 className="text-[13px] font-semibold text-zinc-100">Duration Presets</h3>
              <p className="text-[12px] text-zinc-500">
                Quick timebox intervals (minutes) available for timer presets.
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {prefs.durations.map((d) => (
                <span
                  key={d}
                  className="rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1 font-mono text-[12px] text-zinc-300"
                >
                  {d}m
                </span>
              ))}
            </div>
            <input
              className={`${input} font-mono text-[13px]`}
              defaultValue={prefs.durations.join(", ")}
              onBlur={(e) => {
                const ds = e.target.value
                  .split(",")
                  .map((s) => parseInt(s.trim(), 10))
                  .filter((n) => n > 0 && n <= 480);
                if (ds.length) onPrefs({ durations: [...new Set(ds)].sort((a, b) => a - b) });
              }}
            />
          </div>

          <div className={card}>
            <h3 className="text-[13px] font-semibold text-zinc-100">Session Behavior</h3>
            <div className={row}>
              <div>
                <span className="text-[13px] text-zinc-200">Default duration (no estimate)</span>
                <p className="text-[11px] text-zinc-500">Fallback duration for unestimated tasks</p>
              </div>
              <select
                className={`${input} w-24 py-1.5`}
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
              <div>
                <span className="text-[13px] text-zinc-200">On complete action</span>
                <p className="text-[11px] text-zinc-500">Move task to Done section or close it directly</p>
              </div>
              <div className="flex gap-1">
                {(["done", "close"] as const).map((m) => (
                  <button
                    key={m}
                    className={`rounded-md border px-3 py-1 text-[12px] font-medium transition-colors ${
                      prefs.completeAction === m
                        ? "border-zinc-600 bg-zinc-800 text-zinc-100"
                        : "border-zinc-800 text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300"
                    }`}
                    onClick={() => onPrefs({ completeAction: m })}
                  >
                    {m === "done" ? "Move to Done" : "Close task"}
                  </button>
                ))}
              </div>
            </div>

            <div className={row}>
              <div>
                <span className="text-[13px] text-zinc-200">Celebrate on complete</span>
                <p className="text-[11px] text-zinc-500">Subtle completion burst</p>
              </div>
              <button
                type="button"
                className={toggle(prefs.celebrate)}
                onClick={() => onPrefs({ celebrate: !prefs.celebrate })}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                    prefs.celebrate ? "left-4.5" : "left-0.5"
                  }`}
                />
              </button>
            </div>

            <div className={row}>
              <div>
                <span className="text-[13px] text-zinc-200">Timer end alert</span>
                <p className="text-[11px] text-zinc-500">Audio chime behavior when time expires</p>
              </div>
              <div className="flex gap-1">
                {(["hard", "gentle"] as const).map((m) => (
                  <button
                    key={m}
                    className={`rounded-md border px-3 py-1 text-[12px] font-medium capitalize transition-colors ${
                      prefs.timerEnd === m
                        ? "border-zinc-600 bg-zinc-800 text-zinc-100"
                        : "border-zinc-800 text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300"
                    }`}
                    onClick={() => onPrefs({ timerEnd: m })}
                  >
                    {m === "hard" ? "Hard stop" : "Gentle"}
                  </button>
                ))}
              </div>
            </div>

            <div className={row}>
              <div>
                <span className="text-[13px] text-zinc-200">Buffer section</span>
                <p className="text-[11px] text-zinc-500">Holding area between Backlog and Focus</p>
              </div>
              <button
                type="button"
                className={toggle(prefs.bufferOn)}
                onClick={() => onPrefs({ bufferOn: !prefs.bufferOn })}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                    prefs.bufferOn ? "left-4.5" : "left-0.5"
                  }`}
                />
              </button>
            </div>

            <div className={row}>
              <div>
                <span className="text-[13px] text-zinc-200">Morning ritual banner</span>
                <p className="text-[11px] text-zinc-500">Daily planning prompt when starting morning work</p>
              </div>
              <button
                type="button"
                className={toggle(prefs.planBanner)}
                onClick={() => onPrefs({ planBanner: !prefs.planBanner })}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                    prefs.planBanner ? "left-4.5" : "left-0.5"
                  }`}
                />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: HARDWARE & SYNC */}
      {activeTab === "hardware" && (
        <div className="space-y-6">
          {/* ESP32 Companion Display */}
          <div className={card}>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-[13px] font-semibold text-zinc-100">ESP32 Companion Desk Display</h3>
                <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                  docs/firmware-v2.md
                </span>
              </div>
              <p className="text-[12px] text-zinc-500">
                Physical big-digit countdown display on your desk over Web Serial USB or LAN.
              </p>
            </div>

            <div className={row}>
              <div>
                <span className="text-[13px] text-zinc-200">Trigger display over USB / LAN</span>
                <p className="text-[11px] text-zinc-500">
                  Sends countdown and state packets to connected ESP32 display
                </p>
              </div>
              <button
                type="button"
                className={toggle(prefs.deviceOn)}
                onClick={() => onPrefs({ deviceOn: !prefs.deviceOn })}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                    prefs.deviceOn ? "left-4.5" : "left-0.5"
                  }`}
                />
              </button>
            </div>

            <div className={row}>
              <div>
                <span className="text-[13px] text-zinc-200">Screen off after idle</span>
                <p className="text-[11px] text-zinc-500">Sleep timeout when no active session is running</p>
              </div>
              <div className="flex gap-1">
                {[1, 5, 15, 30, 0].map((m) => (
                  <button
                    key={m}
                    className={`rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors ${
                      prefs.screenOffMin === m
                        ? "border-zinc-600 bg-zinc-800 text-zinc-100"
                        : "border-zinc-800 text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300"
                    }`}
                    onClick={() => onPrefs({ screenOffMin: m })}
                  >
                    {m === 0 ? "Never" : `${m}m`}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Todoist Project & Roles Mapping */}
          <div className={card}>
            <div>
              <h3 className="text-[13px] font-semibold text-zinc-100">Todoist Project &amp; Sections</h3>
              <p className="text-[12px] text-zinc-500">
                Connected Todoist task project and role section mappings.
              </p>
            </div>

            <div className="space-y-2">
              <label className="block text-[11px] font-medium text-zinc-400">Target Todoist Project</label>
              <ProjectSelect token={token} projectId={projectId} onProject={onProject} />
            </div>

            <div className="space-y-2 pt-2">
              <label className="block text-[11px] font-medium text-zinc-400">Section Roles</label>
              <MappingScreen {...mappingProps} />
            </div>

            <div className="border-t border-zinc-800/60 pt-3">
              <div className={row}>
                <div>
                  <span className="text-[13px] text-zinc-200">Timer logs → task comments</span>
                  <p className="text-[11px] text-zinc-500">
                    Back up actual vs planned session records to task comments
                  </p>
                </div>
                <button
                  type="button"
                  className={`${btn} text-orange-500 disabled:opacity-40 font-medium`}
                  disabled={unsynced === 0}
                  onClick={onSyncComments}
                >
                  {unsynced ? `Sync ${unsynced} logs` : "All synced ✓"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: SYSTEM & DATA */}
      {activeTab === "system" && (
        <div className="space-y-6">
          {/* Diagnostics Card */}
          <div className={card}>
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-[13px] font-semibold text-zinc-100">Fleet Health &amp; Diagnostics</h3>
                <p className="text-[12px] text-zinc-500">
                  Connectivity check and ping latency for each registered node.
                </p>
              </div>
              <button
                type="button"
                disabled={ocVerifying}
                onClick={onVerifyOpenCode}
                className="rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1 text-[11px] text-orange-400 hover:border-zinc-700 disabled:opacity-50"
              >
                {ocVerifying ? "Testing…" : "Run test"}
              </button>
            </div>

            <div className="divide-y divide-zinc-800/60 rounded border border-zinc-800/80 bg-zinc-950/60 font-mono text-[12px]">
              {ocConfig.servers.map((s) => {
                const v = ocVerifyById[s.id];
                const online = ocServerOnlineById[s.id] ?? v?.ok ?? false;
                const models = ocModelsByServer[s.id] ?? [];
                return (
                  <div key={s.id} className="flex items-center justify-between p-2.5">
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-2 w-2 rounded-full ${online ? "bg-emerald-400" : "bg-zinc-600"}`}
                      />
                      <span className="text-zinc-200">{s.name}</span>
                      <span className="text-zinc-500">~{s.id}</span>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] text-zinc-400">
                      <span>{models.length} models</span>
                      <span>{v?.ok ? `${v.latencyMs}ms` : online ? "connected" : "unreachable"}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Quick Links & Documentation */}
          <div className={card}>
            <h3 className="text-[13px] font-semibold text-zinc-100">Help &amp; Workflows</h3>
            <div className="flex flex-wrap gap-4 pt-1">
              <button
                type="button"
                className="text-[13px] font-medium text-orange-400 hover:text-orange-300 transition-colors"
                onClick={onViewGuide}
              >
                📖 View guide again
              </button>
              <button
                type="button"
                className="text-[13px] font-medium text-orange-400 hover:text-orange-300 transition-colors"
                onClick={onTheory}
              >
                💡 How the focus protocol works
              </button>
              <a
                href="?mock=1"
                className="text-[13px] font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                🚀 Open Flight Deck Mockup
              </a>
            </div>
          </div>

          {/* Danger Zone */}
          <div className="rounded-lg border border-red-950/60 bg-red-950/10 p-4 space-y-2">
            <h3 className="text-[13px] font-semibold text-red-400">Danger Zone</h3>
            <p className="text-[12px] text-zinc-400">
              Clear your Todoist authentication tokens, OpenCode server registry, and all cached sessions.
            </p>
            <div className="pt-1">
              <button
                type="button"
                className="rounded border border-red-900/60 bg-red-950/40 px-3 py-1.5 text-[12px] font-medium text-red-300 hover:bg-red-900/40 transition-colors"
                onClick={() => {
                  if (window.confirm("Are you sure you want to reset all tokens, server configs, and cached state?")) {
                    onReset();
                  }
                }}
              >
                Reset token &amp; all local data
              </button>
            </div>
          </div>
        </div>
      )}
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

