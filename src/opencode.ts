export type TriageState =
  | "needs_you" // Agent asked a question / form option, OR finished turn and is waiting for your steer
  | "working" // OpenCode agent is actively generating / running tools
  | "queued"; // Idle / manual task / or queued for OpenCode agent

export type OpenCodeRepo = {
  label: string;
  dir: string;
};

export type OpenCodeServer = {
  /** Short slug used in Todoist `[opencode:srv=<id>]` and `~<id>` quick-add syntax */
  id: string;
  /** Display label, e.g. "MacBook Local", "Cloud Devbox", "Home Server" */
  name: string;
  /** Empty = `/opencode-api` (local Vite bridge), or remote URL e.g. `https://devbox.ts.net/api` */
  endpoint: string;
  /** Optional Basic auth password when connecting directly to `opencode serve` */
  password?: string;
  /** Default workspace directory on that server (e.g. `/Users/justinyu` or `/home/ubuntu`) */
  defaultDir?: string;
  /** Projects / repositories available on this execution server */
  repos?: OpenCodeRepo[];
  /** Whether to poll this server for live sessions */
  enabled?: boolean;
};

export type OpenCodeConfig = {
  /** Legacy primary endpoint (mirrored to default server) */
  endpoint: string;
  /** Legacy primary password (mirrored to default server) */
  password: string;
  /** When true and a target OpenCode server is connected, automatically start tasks marked `queue=1` */
  autoRunQueued: boolean;
  /** Default execution server ID when a task doesn't specify `srv=...` */
  defaultServerId: string;
  /** Configured execution servers (local laptop, remote devboxes, homelab, etc.) */
  servers: OpenCodeServer[];
};

export const DEFAULT_WORKSPACE_DIR = "/Users/justinyu";

export const KNOWN_REPOS: OpenCodeRepo[] = [
  { label: "vyond/devops", dir: "/Users/justinyu/Develop/vyond/devops" },
  { label: "vyond/eks-manifest", dir: "/Users/justinyu/Develop/vyond/eks-manifest" },
  {
    label: "vyond/qa-autotest-account-pool",
    dir: "/Users/justinyu/Develop/vyond/qa-autotest-account-pool",
  },
  { label: "vyond/turbo", dir: "/Users/justinyu/Develop/vyond/turbo" },
  { label: "vyond/next", dir: "/Users/justinyu/Develop/vyond/next" },
  {
    label: "vyond/devops-software-review-hub",
    dir: "/Users/justinyu/Develop/vyond/devops-software-review-hub",
  },
  {
    label: "vyond/devops-ai-helper",
    dir: "/Users/justinyu/Develop/vyond/devops-ai-helper",
  },
  {
    label: "my-timebox-focus-app",
    dir: "/Users/justinyu/Develop/my-diy-random-thing/my-timebox-focus-app",
  },
];

export const DEFAULT_SERVERS: OpenCodeServer[] = [
  {
    id: "local",
    name: "MacBook Local",
    endpoint: "",
    password: "",
    defaultDir: DEFAULT_WORKSPACE_DIR,
    repos: KNOWN_REPOS,
    enabled: true,
  },
  {
    id: "devbox",
    name: "Cloud Devbox",
    endpoint: "https://devbox.vyond.ts.net/api",
    password: "",
    defaultDir: "/home/ubuntu/vyond",
    repos: [
      { label: "vyond/devops", dir: "/home/ubuntu/vyond/devops" },
      { label: "vyond/eks-manifest", dir: "/home/ubuntu/vyond/eks-manifest" },
      { label: "vyond/turbo", dir: "/home/ubuntu/vyond/turbo" },
      {
        label: "vyond/qa-autotest-account-pool",
        dir: "/home/ubuntu/vyond/qa-autotest-account-pool",
      },
    ],
    enabled: false,
  },
  {
    id: "homelab",
    name: "Home Server",
    endpoint: "http://opencode:4096/api",
    password: "",
    defaultDir: "/workspace",
    repos: [
      { label: "my-timebox-focus-app", dir: "/workspace/my-timebox-focus-app" },
      { label: "homelab/infra", dir: "/workspace/infra" },
    ],
    enabled: true,
  },
];

export const DEFAULT_OC_CONFIG: OpenCodeConfig = {
  endpoint: "",
  password: "",
  autoRunQueued: true,
  defaultServerId: "local",
  servers: DEFAULT_SERVERS,
};

const OC_CFG_KEY = "tb_oc_config";

export function loadOpenCodeConfig(): OpenCodeConfig {
  try {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const urlPass = params.get("oc_pass") || params.get("oc_password");
      const urlEndpoint = params.get("oc_endpoint");
      if (urlPass || urlEndpoint) {
        const rawExisting = localStorage.getItem(OC_CFG_KEY);
        const parsedExisting = rawExisting
          ? (JSON.parse(rawExisting) as Partial<OpenCodeConfig>)
          : {};
        const list =
          Array.isArray(parsedExisting.servers) && parsedExisting.servers.length > 0
            ? parsedExisting.servers
            : DEFAULT_SERVERS.map((s) => ({ ...s }));
        const localSrv = list.find((s) => s.id === "local") ?? list[0];
        if (localSrv) {
          if (urlPass) localSrv.password = urlPass.trim();
          if (urlEndpoint) localSrv.endpoint = urlEndpoint.trim();
        }
        saveOpenCodeConfig({
          endpoint: localSrv?.endpoint ?? "",
          password: localSrv?.password ?? "",
          autoRunQueued: parsedExisting.autoRunQueued ?? true,
          defaultServerId: parsedExisting.defaultServerId ?? "local",
          servers: list,
        });
        params.delete("oc_pass");
        params.delete("oc_password");
        params.delete("oc_endpoint");
        const nextQuery = params.toString();
        const cleanUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash}`;
        window.history.replaceState({}, "", cleanUrl);
      }
    }
    const raw = localStorage.getItem(OC_CFG_KEY);
    if (!raw) return { ...DEFAULT_OC_CONFIG, servers: [...DEFAULT_SERVERS] };
    const parsed = JSON.parse(raw) as Partial<OpenCodeConfig>;
    let servers: OpenCodeServer[];
    if (Array.isArray(parsed.servers) && parsed.servers.length > 0) {
      // Backfill repos on existing servers and seed default devbox/homelab if only single uncustomized local exists
      const mapped = parsed.servers.map((s) => {
        const preset = DEFAULT_SERVERS.find((d) => d.id === s.id);
        const isLegacyHomelabSample =
          s.id === "homelab" && s.endpoint === "https://homelab.tailnet.ts.net/api";
        const isUnconfiguredSample =
          s.id === "devbox" && s.endpoint === "https://devbox.vyond.ts.net/api";
        return {
          ...preset,
          ...s,
          endpoint: isLegacyHomelabSample ? "http://opencode:4096/api" : s.endpoint,
          enabled: isUnconfiguredSample
            ? false
            : isLegacyHomelabSample
              ? true
              : s.enabled ?? preset?.enabled ?? true,
          repos: s.repos && s.repos.length > 0 ? s.repos : preset?.repos ?? KNOWN_REPOS,
        };
      });
      if (mapped.length === 1 && mapped[0].id === "local") {
        servers = [mapped[0], ...DEFAULT_SERVERS.slice(1)];
      } else {
        servers = mapped;
      }
    } else {
      servers = [
        {
          ...DEFAULT_SERVERS[0],
          endpoint: parsed.endpoint ?? "",
          password: parsed.password ?? "",
        },
        ...DEFAULT_SERVERS.slice(1),
      ];
    }
    const defaultServerId =
      parsed.defaultServerId && servers.some((s) => s.id === parsed.defaultServerId)
        ? parsed.defaultServerId
        : servers[0].id;
    const primary = servers.find((s) => s.id === defaultServerId) ?? servers[0];
    return {
      endpoint: primary.endpoint ?? "",
      password: primary.password ?? "",
      autoRunQueued: parsed.autoRunQueued ?? true,
      defaultServerId,
      servers,
    };
  } catch {
    return { ...DEFAULT_OC_CONFIG, servers: [...DEFAULT_SERVERS] };
  }
}

export function saveOpenCodeConfig(cfg: OpenCodeConfig): void {
  try {
    localStorage.setItem(OC_CFG_KEY, JSON.stringify(cfg));
  } catch {
    /* ignore quota errors */
  }
}

export function resolveServer(serverId?: string, cfg?: OpenCodeConfig): OpenCodeServer {
  const effective = cfg ?? loadOpenCodeConfig();
  const list = effective.servers.length > 0 ? effective.servers : DEFAULT_SERVERS;
  if (serverId?.trim()) {
    const clean = serverId.trim().replace(/^~/, "").toLowerCase();
    const hit = list.find(
      (s) => s.id.toLowerCase() === clean || s.name.toLowerCase() === clean,
    );
    if (hit) return hit;
  }
  return list.find((s) => s.id === effective.defaultServerId) ?? list[0];
}

export function isLocalLoopbackHttp(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === "http:" &&
      (u.hostname === "127.0.0.1" ||
        u.hostname === "localhost" ||
        u.hostname === "::1" ||
        u.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

export function isHomelabEndpoint(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes("opencode:4096") ||
    lower.includes("192.168.50.74") ||
    lower.includes("100.107.128.96") ||
    lower.includes("opencode-homelab") ||
    lower.includes("homelab.tailnet.ts.net") ||
    lower.includes("/opencode-homelab-api")
  );
}

export function resolveOpenCodeBase(rawEndpoint?: string): string {
  const clean = (rawEndpoint ?? loadOpenCodeConfig().endpoint).trim().replace(/\/+$/, "");
  if (!clean) {
    // On static HTTPS hosts (e.g. GitHub Pages), default empty local endpoint to the standard macOS/Linux OpenCode daemon port
    if (
      typeof window !== "undefined" &&
      window.location.protocol === "https:" &&
      window.location.hostname !== "localhost" &&
      window.location.hostname !== "127.0.0.1"
    ) {
      return "http://127.0.0.1:49374/api";
    }
    return "/opencode-api";
  }

  // Route Homelab LAN HTTP endpoints via local Vite bridge (when available) or Tailscale HTTPS (when on https:)
  if (typeof window !== "undefined" && isHomelabEndpoint(clean) && clean.startsWith("http://")) {
    const isLocalVite =
      (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") &&
      (window.location.port === "5173" || window.location.port === "4173");
    if (isLocalVite) {
      return "/opencode-homelab-api";
    }
    if (window.location.protocol === "https:") {
      if (autoDiscoveredLocal?.homelabBridgeEndpoint) {
        return autoDiscoveredLocal.homelabBridgeEndpoint;
      }
      return "https://opencode-homelab.taila12039.ts.net/api";
    }
  }

  if (
    clean.endsWith("/opencode-api") ||
    clean.endsWith("/opencode-homelab-api") ||
    clean.endsWith("/api")
  ) {
    return clean;
  }
  try {
    const u = new URL(clean);
    if (u.pathname === "" || u.pathname === "/") {
      // Vite dev server uses /opencode-api; opencode serve & remote tunnels use /api
      if (u.port === "5173" || u.port === "4173") {
        return `${clean}/opencode-api`;
      }
      return `${clean}/api`;
    }
  } catch {
    /* relative path */
  }
  return clean;
}

export type LocalBridgeHealth = {
  ok: boolean;
  upstream?: string | null;
  apiEndpoint?: string | null;
  bridgeEndpoint?: string | null;
  password?: string | null;
  cors?: string | string[] | null;
  homelab?: {
    upstream?: string | null;
    apiEndpoint?: string | null;
    bridgeEndpoint?: string | null;
    tailscaleEndpoint?: string | null;
    password?: string | null;
  } | null;
};

let autoDiscoveredLocal: {
  endpoint?: string;
  password?: string;
  homelabPassword?: string;
  homelabBridgeEndpoint?: string;
  checkedAt: number;
} | null = null;

export async function discoverLocalBridge(force = false): Promise<LocalBridgeHealth | null> {
  if (typeof window === "undefined") return null;
  if (!force && autoDiscoveredLocal && Date.now() - autoDiscoveredLocal.checkedAt < 15_000) {
    return null;
  }
  const isLocalHost =
    window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  const candidates = isLocalHost
    ? ["/opencode-api/health"]
    : [
        "http://localhost:5173/opencode-api/health",
        "http://127.0.0.1:5173/opencode-api/health",
      ];
  for (const url of candidates) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
      if (!res.ok) continue;
      const data = (await res.json()) as LocalBridgeHealth;
      if (data && (data.ok || data.homelab)) {
        autoDiscoveredLocal = {
          endpoint: data.apiEndpoint || "http://127.0.0.1:49374/api",
          password: data.password || undefined,
          homelabPassword: data.homelab?.password || undefined,
          homelabBridgeEndpoint:
            data.homelab?.bridgeEndpoint || "http://localhost:5173/opencode-homelab-api",
          checkedAt: Date.now(),
        };
        const cfg = loadOpenCodeConfig();
        let mutated = false;
        if (data.password) {
          const localSrv = cfg.servers.find((s) => s.id === "local");
          if (localSrv && !localSrv.password?.trim()) {
            localSrv.password = data.password;
            if (cfg.defaultServerId === "local") cfg.password = data.password;
            mutated = true;
          }
        }
        if (data.homelab?.password) {
          for (const srv of cfg.servers) {
            if (
              (srv.id === "homelab" || isHomelabEndpoint(srv.endpoint)) &&
              !srv.password?.trim()
            ) {
              srv.password = data.homelab.password;
              if (cfg.defaultServerId === srv.id) cfg.password = data.homelab.password;
              mutated = true;
            }
          }
        }
        if (mutated) saveOpenCodeConfig(cfg);
        return data;
      }
    } catch {
      /* ignore */
    }
  }
  autoDiscoveredLocal = { checkedAt: Date.now() };
  return null;
}

function buildServerHeaders(srv: OpenCodeServer, jsonBody = false): Record<string, string> {
  const headers: Record<string, string> = {};
  if (jsonBody) headers["Content-Type"] = "application/json";
  const isHomelab = srv.id === "homelab" || isHomelabEndpoint(srv.endpoint);
  const pwd =
    srv.password?.trim() ||
    (srv.id === "local"
      ? autoDiscoveredLocal?.password?.trim()
      : isHomelab
        ? autoDiscoveredLocal?.homelabPassword?.trim()
        : "");
  if (pwd) {
    headers["Authorization"] = `Basic ${btoa(`opencode:${pwd}`)}`;
  }
  return headers;
}

export function getOpenCodeEventUrl(serverId?: string): string {
  const srv = resolveServer(serverId);
  return `${resolveOpenCodeBase(srv.endpoint)}/event`;
}

export type OpenCodeVerifyResult = {
  serverId: string;
  serverName: string;
  ok: boolean;
  endpoint: string;
  sessionCount: number;
  activeCount: number;
  latencyMs: number;
  error?: string;
  checkedAt: number;
};

export async function verifyServerConnection(
  srv: OpenCodeServer,
): Promise<OpenCodeVerifyResult> {
  if (
    (srv.id === "local" || srv.id === "homelab" || isHomelabEndpoint(srv.endpoint)) &&
    (!srv.password?.trim() ||
      (typeof window !== "undefined" && window.location.protocol === "https:"))
  ) {
    await discoverLocalBridge();
  }
  const base = resolveOpenCodeBase(srv.endpoint);
  const start = performance.now();

  if (
    typeof window !== "undefined" &&
    window.location.protocol === "https:" &&
    base.startsWith("/opencode-api")
  ) {
    return {
      serverId: srv.id,
      serverName: srv.name,
      ok: false,
      endpoint: base,
      sessionCount: 0,
      activeCount: 0,
      latencyMs: 0,
      error:
        "Empty endpoint uses /opencode-api (Vite dev server only). On GitHub Pages, set Endpoint URL to http://127.0.0.1:49374/api (with password + CORS) or http://127.0.0.1:5173/opencode-api.",
      checkedAt: Date.now(),
    };
  }

  if (
    typeof window !== "undefined" &&
    window.location.protocol === "https:" &&
    base.startsWith("http://") &&
    !isLocalLoopbackHttp(base)
  ) {
    return {
      serverId: srv.id,
      serverName: srv.name,
      ok: false,
      endpoint: base,
      sessionCount: 0,
      activeCount: 0,
      latencyMs: 0,
      error:
        "Blocked by browser Mixed Content (non-loopback HTTP endpoint requires https:// e.g. Tailscale Serve / Cloudflare Tunnel, or open app via http://).",
      checkedAt: Date.now(),
    };
  }

  try {
    const headers = buildServerHeaders(srv);
    const [sesRes, actRes] = await Promise.all([
      fetch(`${base}/session?limit=30&order=desc`, { headers }),
      fetch(`${base}/session/active`, { headers }).catch(() => null),
    ]);
    const latencyMs = Math.max(1, Math.round(performance.now() - start));

    if (!sesRes.ok) {
      let detail = `HTTP ${sesRes.status}`;
      if (sesRes.status === 401) {
        detail =
          "HTTP 401 Unauthorized — click Edit and paste your OpenCode password from ~/.config/opencode/service.json";
      } else {
        try {
          const errJson = (await sesRes.json()) as { error?: string };
          if (errJson?.error) detail = `${detail} — ${errJson.error}`;
        } catch {
          /* ignore non-json */
        }
      }
      return {
        serverId: srv.id,
        serverName: srv.name,
        ok: false,
        endpoint: base,
        sessionCount: 0,
        activeCount: 0,
        latencyMs,
        error: detail,
        checkedAt: Date.now(),
      };
    }

    const sesJson = (await sesRes.json()) as { data?: OpenCodeSessionInfo[] };
    const actJson =
      actRes && actRes.ok
        ? ((await actRes.json()) as { data?: Record<string, { type: string }> })
        : { data: {} };

    return {
      serverId: srv.id,
      serverName: srv.name,
      ok: true,
      endpoint: base,
      sessionCount: (sesJson.data ?? []).length,
      activeCount: Object.keys(actJson.data ?? {}).length,
      latencyMs,
      checkedAt: Date.now(),
    };
  } catch (e) {
    const latencyMs = Math.max(1, Math.round(performance.now() - start));
    return {
      serverId: srv.id,
      serverName: srv.name,
      ok: false,
      endpoint: base,
      sessionCount: 0,
      activeCount: 0,
      latencyMs,
      error:
        base.includes("127.0.0.1:49374") || base.includes("localhost:49374")
          ? `Unreachable or blocked by CORS — run: opencode service set cors ${typeof window !== "undefined" ? window.location.origin : "https://todolist-md.com"} && opencode service start`
          : e instanceof Error
            ? `Unreachable (${e.message})`
            : "Unreachable — check endpoint URL, Tailscale/LAN, or CORS",
      checkedAt: Date.now(),
    };
  }
}

export async function verifyAllOpenCodeServers(
  override?: Partial<OpenCodeConfig>,
): Promise<Record<string, OpenCodeVerifyResult>> {
  const cfg = { ...loadOpenCodeConfig(), ...override };
  const list = (cfg.servers.length > 0 ? cfg.servers : DEFAULT_SERVERS).filter(
    (s) => s.enabled !== false,
  );
  const results = await Promise.all(list.map((s) => verifyServerConnection(s)));
  const map: Record<string, OpenCodeVerifyResult> = {};
  for (const r of results) map[r.serverId] = r;
  return map;
}

export async function verifyOpenCodeConnection(
  override?: Partial<OpenCodeConfig>,
): Promise<OpenCodeVerifyResult> {
  const cfg = { ...loadOpenCodeConfig(), ...override };
  const srv = resolveServer(cfg.defaultServerId, cfg);
  return verifyServerConnection(srv);
}

export type OpenCodeModelRef = {
  id: string;
  providerID: string;
  variant?: string;
};

export type OpenCodeModelOption = {
  /** Combined `providerID/id` key */
  key: string;
  providerID: string;
  id: string;
  name: string;
  isDefault?: boolean;
};

export function formatModelKey(ref?: OpenCodeModelRef | null): string {
  if (!ref?.providerID || !ref?.id) return "";
  return `${ref.providerID}/${ref.id}`;
}

export function parseModelKey(key?: string): OpenCodeModelRef | undefined {
  const clean = (key ?? "").trim();
  const slash = clean.indexOf("/");
  if (slash <= 0 || slash === clean.length - 1) return undefined;
  return {
    providerID: clean.slice(0, slash),
    id: clean.slice(slash + 1),
  };
}

export function shortModelLabel(key?: string, options?: OpenCodeModelOption[]): string {
  if (!key) return "";
  const hit = options?.find((m) => m.key === key);
  if (hit) return hit.name;
  const slash = key.indexOf("/");
  return slash !== -1 ? key.slice(slash + 1) : key;
}

export type OpenCodeSessionInfo = {
  id: string;
  title?: string;
  agent?: string;
  model?: OpenCodeModelRef;
  cost?: number;
  outcome?: string;
  time: {
    created: number;
    updated: number;
    busy?: number;
    idle?: number;
    viewed?: number;
  };
  location?: {
    directory: string;
  };
};

export type OpenCodeFormOption = {
  value: string;
  label: string;
  description?: string;
};

export type OpenCodeFormField = {
  key: string;
  title?: string;
  description?: string;
  type: string;
  options?: OpenCodeFormOption[];
};

export type OpenCodeFormRequest = {
  id: string;
  sessionID: string;
  title: string;
  fields: OpenCodeFormField[];
};

export type OpenCodePermissionRequest = {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  message?: string;
};

export type OpenCodeLiveSession = {
  id: string;
  title: string;
  directory: string;
  repoShort: string;
  serverId: string;
  serverName: string;
  modelKey?: string;
  status: "running" | "question" | "ready" | "idle";
  updatedAt: number;
  busyAt?: number;
  idleAt?: number;
  viewedAt?: number;
  cost?: number;
  form?: OpenCodeFormRequest;
  permission?: OpenCodePermissionRequest;
};

export function getServerRepos(serverId?: string, cfg?: OpenCodeConfig): OpenCodeRepo[] {
  const srv = resolveServer(serverId, cfg);
  return srv.repos && srv.repos.length > 0 ? srv.repos : KNOWN_REPOS;
}

export function dirToShortRepo(dir?: string): string {
  if (!dir || dir === DEFAULT_WORKSPACE_DIR) return "";
  const hit = KNOWN_REPOS.find((r) => dir === r.dir || dir.startsWith(r.dir + "/"));
  if (hit) return hit.label.replace(/^vyond\//, "");
  const parts = dir.replace(/\/$/, "").split("/");
  return parts.slice(-2).join("/");
}

export function resolveRepoDir(repoToken?: string, serverId?: string): string {
  const srv = resolveServer(serverId);
  const srvRoot = srv.defaultDir?.trim() || DEFAULT_WORKSPACE_DIR;
  if (!repoToken || !repoToken.trim()) return srvRoot;
  if (repoToken.startsWith("/")) return repoToken;
  const clean = repoToken.replace(/^@/, "").toLowerCase();
  const srvRepos = getServerRepos(srv.id);
  const hit =
    srvRepos.find(
      (r) =>
        r.label.toLowerCase() === clean ||
        r.label.toLowerCase().endsWith(`/${clean}`) ||
        r.dir.toLowerCase().endsWith(`/${clean}`),
    ) ??
    KNOWN_REPOS.find(
      (r) =>
        r.label.toLowerCase() === clean ||
        r.label.toLowerCase().endsWith(`/${clean}`) ||
        r.dir.toLowerCase().endsWith(`/${clean}`),
    );
  if (hit) {
    if (srvRoot !== DEFAULT_WORKSPACE_DIR && hit.dir.startsWith(DEFAULT_WORKSPACE_DIR)) {
      return hit.dir.replace(DEFAULT_WORKSPACE_DIR, srvRoot.replace(/\/+$/, ""));
    }
    return hit.dir;
  }
  return `${srvRoot.replace(/\/+$/, "")}/${clean}`;
}

export type TaskMeta = {
  note: string;
  prompt: string;
  repo: string;
  server?: string;
  model?: string;
  sessions: string[];
  queued?: boolean;
};

const META_RE = /\[opencode:([^\]]+)\]\s*$/;

export function parseTaskDescription(desc?: string | null): TaskMeta {
  const raw = (desc ?? "").trim();
  if (!raw)
    return { note: "", prompt: "", repo: "", server: "", model: "", sessions: [], queued: false };

  let body = raw;
  let repo = "";
  let server = "";
  let model = "";
  let sessions: string[] = [];
  let queued = false;

  const match = body.match(META_RE);
  if (match) {
    body = body.slice(0, match.index).trim();
    const pairs = match[1].split(/\s+/);
    for (const p of pairs) {
      if (p.startsWith("ses=")) {
        sessions = p
          .slice(4)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      } else if (p.startsWith("repo=")) {
        repo = p.slice(5).trim();
      } else if (p.startsWith("srv=")) {
        server = p.slice(4).trim();
      } else if (p.startsWith("model=")) {
        model = p.slice(6).trim();
      } else if (p === "queue=1" || p === "queued=1") {
        queued = true;
      }
    }
  }

  if (body.includes("\n---\n")) {
    const [notePart, ...promptParts] = body.split("\n---\n");
    return {
      note: notePart.trim(),
      prompt: promptParts.join("\n---\n").trim(),
      repo,
      server,
      model,
      sessions,
      queued,
    };
  }

  const lines = body.split("\n");
  if (lines.length === 1) {
    return { note: lines[0].trim(), prompt: "", repo, server, model, sessions, queued };
  }
  return {
    note: lines[0].trim(),
    prompt: lines.slice(1).join("\n").trim(),
    repo,
    server,
    model,
    sessions,
    queued,
  };
}

export function formatTaskDescription(meta: TaskMeta): string {
  const note = meta.note.trim();
  const prompt = meta.prompt.trim();
  const parts: string[] = [];

  if (note && prompt) {
    parts.push(`${note}\n---\n${prompt}`);
  } else if (note) {
    parts.push(note);
  } else if (prompt) {
    parts.push(`\n---\n${prompt}`);
  }

  const tags: string[] = [];
  if (meta.server?.trim()) {
    tags.push(`srv=${meta.server.trim()}`);
  }
  if (meta.model?.trim()) {
    tags.push(`model=${meta.model.trim()}`);
  }
  if (meta.sessions.length > 0) {
    tags.push(`ses=${Array.from(new Set(meta.sessions)).join(",")}`);
  }
  if (meta.repo.trim()) {
    tags.push(`repo=${meta.repo.trim()}`);
  }
  if (meta.queued) {
    tags.push("queue=1");
  }
  if (tags.length > 0) {
    parts.push(`[opencode:${tags.join(" ")}]`);
  }

  return parts.join("\n").trim();
}

const serverModelsCache = new Map<string, { fetchedAt: number; models: OpenCodeModelOption[] }>();

async function fetchServerModels(srv: OpenCodeServer): Promise<OpenCodeModelOption[]> {
  const cached = serverModelsCache.get(srv.id);
  if (cached && Date.now() - cached.fetchedAt < 60_000) {
    return cached.models;
  }
  const base = resolveOpenCodeBase(srv.endpoint);
  const headers = buildServerHeaders(srv);
  try {
    const [modRes, defRes] = await Promise.all([
      fetch(`${base}/model`, { headers }),
      fetch(`${base}/model/default`, { headers }).catch(() => null),
    ]);
    if (!modRes.ok) return cached?.models ?? [];
    const modJson = (await modRes.json()) as {
      data?: Array<{
        id: string;
        providerID: string;
        name: string;
        type?: string;
        enabled?: boolean;
      }>;
    };
    const defJson =
      defRes && defRes.ok
        ? ((await defRes.json()) as { data?: { id?: string; providerID?: string } })
        : null;
    const defKey =
      defJson?.data?.providerID && defJson?.data?.id
        ? `${defJson.data.providerID}/${defJson.data.id}`
        : "";

    const raw = modJson.data ?? [];
    const models: OpenCodeModelOption[] = raw
      .filter((m) => m.enabled !== false && (!m.type || m.type === "chat"))
      .map((m) => {
        const key = `${m.providerID}/${m.id}`;
        return {
          key,
          providerID: m.providerID,
          id: m.id,
          name: m.name || m.id,
          isDefault: key === defKey,
        };
      });

    models.sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    serverModelsCache.set(srv.id, { fetchedAt: Date.now(), models });
    return models;
  } catch {
    return cached?.models ?? [];
  }
}

async function fetchSingleServerSnapshot(srv: OpenCodeServer): Promise<{
  ok: boolean;
  sessions: OpenCodeLiveSession[];
  models: OpenCodeModelOption[];
}> {
  if (
    (srv.id === "local" || srv.id === "homelab" || isHomelabEndpoint(srv.endpoint)) &&
    (!srv.password?.trim() ||
      (typeof window !== "undefined" && window.location.protocol === "https:"))
  ) {
    await discoverLocalBridge();
  }
  const base = resolveOpenCodeBase(srv.endpoint);
  const headers = buildServerHeaders(srv);
  try {
    const [sesRes, actRes, formRes, permRes, models] = await Promise.all([
      fetch(`${base}/session?limit=30&order=desc`, { headers }),
      fetch(`${base}/session/active`, { headers }),
      fetch(`${base}/form`, { headers }),
      fetch(`${base}/permission/request`, { headers }),
      fetchServerModels(srv),
    ]);
    if (!sesRes.ok) return { ok: false, sessions: [], models: [] };

    const sesJson = (await sesRes.json()) as { data?: OpenCodeSessionInfo[] };
    const actJson = actRes.ok
      ? ((await actRes.json()) as { data?: Record<string, { type: string }> })
      : { data: {} };
    const formJson = formRes.ok
      ? ((await formRes.json()) as { data?: OpenCodeFormRequest[] })
      : { data: [] };
    const permJson = permRes.ok
      ? ((await permRes.json()) as { data?: OpenCodePermissionRequest[] })
      : { data: [] };

    const activeMap = actJson.data ?? {};
    const formBySession = new Map<string, OpenCodeFormRequest>();
    for (const f of formJson.data ?? []) formBySession.set(f.sessionID, f);

    const permBySession = new Map<string, OpenCodePermissionRequest>();
    for (const p of permJson.data ?? []) permBySession.set(p.sessionID, p);

    const list: OpenCodeLiveSession[] = (sesJson.data ?? []).map((s) => {
      const isRunning = Boolean(activeMap[s.id]);
      const form = formBySession.get(s.id);
      const perm = permBySession.get(s.id);
      const idleAt = s.time?.idle ?? 0;
      const viewedAt = s.time?.viewed ?? 0;
      const isUnreadIdle = !isRunning && idleAt > 0 && idleAt > viewedAt;

      const status: OpenCodeLiveSession["status"] =
        form || perm
          ? "question"
          : isRunning
            ? "running"
            : isUnreadIdle
              ? "ready"
              : "idle";

      const directory = s.location?.directory ?? "";
      return {
        id: s.id,
        title: s.title?.trim() || "Untitled session",
        directory,
        repoShort: dirToShortRepo(directory),
        serverId: srv.id,
        serverName: srv.name,
        modelKey: formatModelKey(s.model) || undefined,
        status,
        updatedAt: s.time?.updated ?? s.time?.created ?? Date.now(),
        busyAt: s.time?.busy,
        idleAt: s.time?.idle,
        viewedAt: s.time?.viewed,
        cost: s.cost,
        form,
        permission: perm,
      };
    });

    return { ok: true, sessions: list, models };
  } catch {
    return { ok: false, sessions: [], models: [] };
  }
}

// Fetch live state across all enabled OpenCode servers in parallel
export async function fetchOpenCodeSnapshot(): Promise<{
  connected: boolean;
  serverOnlineById: Record<string, boolean>;
  modelsByServer: Record<string, OpenCodeModelOption[]>;
  sessions: OpenCodeLiveSession[];
}> {
  const cfg = loadOpenCodeConfig();
  const enabledServers = (cfg.servers.length > 0 ? cfg.servers : DEFAULT_SERVERS).filter(
    (s) => s.enabled !== false,
  );
  if (enabledServers.length === 0) {
    return { connected: false, serverOnlineById: {}, modelsByServer: {}, sessions: [] };
  }

  const results = await Promise.all(
    enabledServers.map(async (srv) => ({
      srv,
      res: await fetchSingleServerSnapshot(srv),
    })),
  );

  const serverOnlineById: Record<string, boolean> = {};
  const modelsByServer: Record<string, OpenCodeModelOption[]> = {};
  const allSessions: OpenCodeLiveSession[] = [];
  let anyConnected = false;

  for (const { srv, res } of results) {
    serverOnlineById[srv.id] = res.ok;
    if (res.ok) {
      anyConnected = true;
      modelsByServer[srv.id] = res.models;
      allSessions.push(...res.sessions);
    }
  }

  allSessions.sort((a, b) => b.updatedAt - a.updatedAt);

  return {
    connected: anyConnected,
    serverOnlineById,
    modelsByServer,
    sessions: allSessions,
  };
}

export async function createAndPromptOpenCodeSession(opts: {
  title: string;
  directory: string;
  promptText: string;
  serverId?: string;
  modelKey?: string;
}): Promise<string> {
  const srv = resolveServer(opts.serverId);
  const base = resolveOpenCodeBase(srv.endpoint);
  const modelRef = parseModelKey(opts.modelKey);
  const createRes = await fetch(`${base}/session`, {
    method: "POST",
    headers: buildServerHeaders(srv, true),
    body: JSON.stringify({
      title: opts.title,
      location: { directory: opts.directory },
      ...(modelRef ? { model: modelRef } : {}),
    }),
  });
  if (!createRes.ok) throw new Error(`Create session on ${srv.name} failed: ${createRes.status}`);
  const created = (await createRes.json()) as { data: { id: string } };
  const sessionID = created.data.id;

  if (opts.promptText.trim()) {
    await sendOpenCodePrompt(sessionID, opts.promptText.trim(), srv.id);
  }
  return sessionID;
}

export async function renameOpenCodeSession(
  sessionID: string,
  title: string,
  serverId?: string,
): Promise<void> {
  const cleanTitle = title.trim();
  if (!sessionID || !cleanTitle) return;
  const srv = resolveServer(serverId);
  const base = resolveOpenCodeBase(srv.endpoint);
  const res = await fetch(`${base}/session/${sessionID}`, {
    method: "PATCH",
    headers: buildServerHeaders(srv, true),
    body: JSON.stringify({ title: cleanTitle }),
  });
  if (!res.ok) throw new Error(`Rename session on ${srv.name} failed: ${res.status}`);
}

export async function switchOpenCodeSessionModel(
  sessionID: string,
  modelKey: string,
  serverId?: string,
): Promise<void> {
  const modelRef = parseModelKey(modelKey);
  if (!sessionID || !modelRef) return;
  const srv = resolveServer(serverId);
  const base = resolveOpenCodeBase(srv.endpoint);
  const res = await fetch(`${base}/session/${sessionID}/model`, {
    method: "POST",
    headers: buildServerHeaders(srv, true),
    body: JSON.stringify({ model: modelRef }),
  });
  if (!res.ok) throw new Error(`Switch model on ${srv.name} failed: ${res.status}`);
}

export async function sendOpenCodePrompt(
  sessionID: string,
  text: string,
  serverId?: string,
): Promise<void> {
  const srv = resolveServer(serverId);
  const base = resolveOpenCodeBase(srv.endpoint);
  const res = await fetch(`${base}/session/${sessionID}/prompt`, {
    method: "POST",
    headers: buildServerHeaders(srv, true),
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Prompt on ${srv.name} failed: ${res.status}`);
}

// Reply to an OpenCode question form (when the agent asks you to pick an option)
export async function replyOpenCodeForm(
  sessionID: string,
  formID: string,
  fieldKey: string,
  value: string | string[],
  serverId?: string,
): Promise<void> {
  const srv = resolveServer(serverId);
  const base = resolveOpenCodeBase(srv.endpoint);
  const res = await fetch(`${base}/session/${sessionID}/form/${formID}/reply`, {
    method: "POST",
    headers: buildServerHeaders(srv, true),
    body: JSON.stringify({
      answer: { [fieldKey]: value },
    }),
  });
  if (!res.ok) throw new Error(`Form reply on ${srv.name} failed: ${res.status}`);
}

export async function replyOpenCodePermission(
  sessionID: string,
  requestID: string,
  decision: "once" | "always" | "reject" = "once",
  serverId?: string,
): Promise<void> {
  const srv = resolveServer(serverId);
  const base = resolveOpenCodeBase(srv.endpoint);
  const res = await fetch(
    `${base}/session/${sessionID}/permission/${requestID}/reply`,
    {
      method: "POST",
      headers: buildServerHeaders(srv, true),
      body: JSON.stringify({ decision }),
    },
  );
  if (!res.ok) throw new Error(`Permission reply on ${srv.name} failed: ${res.status}`);
}

export async function interruptOpenCodeSession(
  sessionID: string,
  serverId?: string,
): Promise<void> {
  const srv = resolveServer(serverId);
  const base = resolveOpenCodeBase(srv.endpoint);
  await fetch(`${base}/session/${sessionID}/interrupt`, {
    method: "POST",
    headers: buildServerHeaders(srv),
  }).catch(() => {});
}

export type SessionTurn = {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools: string[];
  timestamp?: number;
};

export type SessionSummary = {
  lastAssistantText: string;
  lastToolCall?: string;
  turns: SessionTurn[];
  updatedAt?: number;
};

const summaryCache = new Map<string, { updatedAt: number; summary: SessionSummary }>();

export function invalidateSessionSummary(sessionID: string) {
  summaryCache.delete(sessionID);
}

export async function fetchOpenCodeSessionSummary(
  sessionID: string,
  knownUpdatedAt = 0,
  serverId?: string,
): Promise<SessionSummary | null> {
  const cached = summaryCache.get(sessionID);
  if (cached && knownUpdatedAt > 0 && cached.updatedAt >= knownUpdatedAt) {
    return cached.summary;
  }
  const srv = resolveServer(serverId);
  const base = resolveOpenCodeBase(srv.endpoint);
  try {
    const res = await fetch(`${base}/session/${sessionID}/message?limit=30`, {
      headers: buildServerHeaders(srv),
    });
    if (!res.ok) return cached?.summary ?? null;
    const json = (await res.json()) as {
      data?: Array<{
        id?: string;
        type?: string;
        time?: { created?: number; completed?: number };
        content?: Array<{
          type?: string;
          text?: string;
          name?: string;
          state?: { status?: string; input?: { command?: string; path?: string } };
        }>;
      }>;
    };
    const msgs = json.data ?? [];
    let lastAssistantText = "";
    let lastToolCall: string | undefined;
    let updatedAt = knownUpdatedAt;
    const rawTurns: SessionTurn[] = [];

    for (const m of msgs) {
      if (m.type !== "assistant" && m.type !== "user") continue;
      if (!updatedAt && m.time?.created) updatedAt = m.time.created;

      const textParts: string[] = [];
      const tools: string[] = [];

      for (const part of m.content ?? []) {
        if (part.type === "text" && part.text?.trim()) {
          textParts.push(part.text.trim());
        } else if (part.type === "tool" && part.name) {
          const detail = part.state?.input?.command || part.state?.input?.path || "";
          const label = detail ? `${part.name}: ${detail}` : part.name;
          tools.push(label);
          if (!lastToolCall && m.type === "assistant") lastToolCall = label;
        }
      }

      const joinedText = textParts.join("\n\n").trim();
      if (!lastAssistantText && m.type === "assistant" && joinedText) {
        lastAssistantText = joinedText;
      }

      if (joinedText || tools.length > 0) {
        rawTurns.push({
          id: m.id ?? String(rawTurns.length),
          role: m.type,
          text: joinedText,
          tools,
          timestamp: m.time?.created,
        });
      }
    }

    const turns = rawTurns.slice(0, 20).reverse();

    const summary: SessionSummary = {
      lastAssistantText,
      lastToolCall,
      turns,
      updatedAt,
    };
    summaryCache.set(sessionID, { updatedAt: updatedAt || Date.now(), summary });
    return summary;
  } catch {
    return cached?.summary ?? null;
  }
}
