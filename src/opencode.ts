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
  /** Preferred default model on this execution server (e.g. `anthropic/claude-3-7-sonnet`) */
  defaultModel?: string;
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
  /** Global preferred default model when no task/server model is set */
  defaultModel?: string;
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
    password: "JejvYTz1123-qJKgdA9DAvgetYODwYef18yrTw99Kb8",
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
  password: "JejvYTz1123-qJKgdA9DAvgetYODwYef18yrTw99Kb8",
  autoRunQueued: true,
  defaultServerId: "local",
  defaultModel: "",
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
          defaultModel: parsedExisting.defaultModel ?? "",
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
          password: s.password ? s.password : (preset?.password ?? ""),
          endpoint: isLegacyHomelabSample ? "http://opencode:4096/api" : s.endpoint,
          enabled: isUnconfiguredSample
            ? false
            : isLegacyHomelabSample
              ? true
              : s.enabled ?? preset?.enabled ?? true,
          defaultModel: s.defaultModel ?? preset?.defaultModel ?? "",
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
          password: parsed.password || DEFAULT_SERVERS[0].password || "",
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
      defaultModel: parsed.defaultModel ?? "",
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
          ? `Unreachable or blocked by CORS — run: opencode service set cors ${typeof window !== "undefined" ? window.location.origin : "https://tasktorun.online"} && opencode service start`
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
  custom?: boolean;
  required?: boolean;
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

export function dirToShortRepo(dir?: string, extraRepos: OpenCodeRepo[] = []): string {
  if (!dir || dir === DEFAULT_WORKSPACE_DIR) return "";
  const hit =
    extraRepos.find((r) => dir === r.dir || dir.startsWith(r.dir + "/")) ??
    KNOWN_REPOS.find((r) => dir === r.dir || dir.startsWith(r.dir + "/"));
  if (hit) return hit.label.replace(/^vyond\//, "").replace(/^homelab\//, "");
  const parts = dir.replace(/\/$/, "").split("/");
  return parts.slice(-2).join("/");
}

export function pathToRepoLabel(dir: string, defaultDir = DEFAULT_WORKSPACE_DIR): string {
  const clean = dir.replace(/\/+$/, "");
  const known = KNOWN_REPOS.find((r) => r.dir === clean);
  if (known) return known.label;
  if (clean.includes("/Develop/vyond/")) {
    return "vyond/" + clean.split("/Develop/vyond/")[1];
  }
  if (clean.includes("/vyond/")) {
    return "vyond/" + clean.split("/vyond/")[1];
  }
  const def = defaultDir.replace(/\/+$/, "");
  if (clean === def) return "~";
  if (clean.startsWith(def + "/")) {
    const rel = clean.slice(def.length + 1);
    if (rel.startsWith("Develop/")) {
      return rel.slice("Develop/".length);
    }
    return rel;
  }
  const parts = clean.split("/").filter(Boolean);
  if (parts.length === 0) return "~";
  return parts.length >= 2 ? parts.slice(-2).join("/") : parts[0];
}

export function mergeRepos(
  savedRepos: OpenCodeRepo[] = [],
  discoveredRepos: OpenCodeRepo[] = [],
): OpenCodeRepo[] {
  const byDir = new Map<string, OpenCodeRepo>();
  for (const r of savedRepos) {
    if (r && r.dir) byDir.set(r.dir.replace(/\/+$/, ""), r);
  }
  for (const r of discoveredRepos) {
    if (!r || !r.dir) continue;
    const key = r.dir.replace(/\/+$/, "");
    if (!byDir.has(key)) {
      byDir.set(key, r);
    }
  }
  return Array.from(byDir.values());
}

export function resolveRepoDir(
  repoToken?: string,
  serverId?: string,
  extraRepos: OpenCodeRepo[] = [],
): string {
  const srv = resolveServer(serverId);
  const srvRoot = srv.defaultDir?.trim() || DEFAULT_WORKSPACE_DIR;
  if (!repoToken || !repoToken.trim()) return srvRoot;
  if (repoToken.startsWith("/")) return repoToken;
  if (repoToken.startsWith("~/")) {
    return `${srvRoot.replace(/\/+$/, "")}/${repoToken.slice(2)}`;
  }
  const clean = repoToken.replace(/^@/, "").toLowerCase();
  const srvRepos = mergeRepos(getServerRepos(srv.id), extraRepos);
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
  jira?: string;
};

const META_RE = /\[opencode:([^\]]+)\]\s*$/;
const JIRA_KEY_RE = /\b([A-Z][A-Z0-9_]{1,15}-\d+)\b/;

export function extractJiraKey(text?: string | null): string {
  if (!text) return "";
  const m = text.match(JIRA_KEY_RE);
  if (!m) return "";
  // Avoid matching common non-Jira tokens like UTF-8, SHA-256, etc.
  const prefix = m[1].split("-")[0];
  if (["UTF", "SHA", "ISO", "AES", "RSA", "TLS", "HTTP", "RFC", "CVE", "ESP"].includes(prefix)) {
    return "";
  }
  return m[1];
}

export function parseTaskDescription(desc?: string | null): TaskMeta {
  const raw = (desc ?? "").trim();
  if (!raw)
    return {
      note: "",
      prompt: "",
      repo: "",
      server: "",
      model: "",
      sessions: [],
      queued: false,
      jira: "",
    };

  let body = raw;
  let repo = "";
  let server = "";
  let model = "";
  let sessions: string[] = [];
  let queued = false;
  let jira = "";

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
      } else if (p.startsWith("jira=")) {
        jira = p.slice(5).trim().toUpperCase();
      } else if (p === "queue=1" || p === "queued=1") {
        queued = true;
      }
    }
  }

  if (!jira) {
    jira = extractJiraKey(body);
  }

  if (body === "---") {
    return { note: "", prompt: "", repo, server, model, sessions, queued, jira };
  }

  if (body.startsWith("---\n")) {
    const rest = body.slice(4).replace(/^(---\n)+/, "").trim();
    return {
      note: "",
      prompt: rest,
      repo,
      server,
      model,
      sessions,
      queued,
      jira,
    };
  }

  if (body.includes("\n---\n")) {
    const [notePart, ...promptParts] = body.split("\n---\n");
    const cleanNote = notePart.trim() === "---" ? "" : notePart.trim();
    return {
      note: cleanNote,
      prompt: promptParts
        .filter((p) => p.trim() !== "---")
        .join("\n---\n")
        .trim(),
      repo,
      server,
      model,
      sessions,
      queued,
      jira,
    };
  }

  const lines = body.split("\n");
  if (lines.length === 1) {
    return { note: lines[0].trim(), prompt: "", repo, server, model, sessions, queued, jira };
  }
  return {
    note: lines[0].trim(),
    prompt: lines.slice(1).join("\n").trim(),
    repo,
    server,
    model,
    sessions,
    queued,
    jira,
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
  if (meta.jira?.trim()) {
    tags.push(`jira=${meta.jira.trim().toUpperCase()}`);
  }
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

export type OpenCodeProjectApiItem = {
  id: string;
  canonical: string;
  vcs?: string;
  time?: {
    created?: number;
    updated?: number;
    active?: number;
  };
};

const serverProjectsCache = new Map<string, { fetchedAt: number; projects: OpenCodeRepo[] }>();

export async function fetchServerProjects(
  srv: OpenCodeServer,
  force = false,
): Promise<OpenCodeRepo[]> {
  const cached = serverProjectsCache.get(srv.id);
  if (!force && cached && Date.now() - cached.fetchedAt < 60_000) {
    return cached.projects;
  }
  const base = resolveOpenCodeBase(srv.endpoint);
  const headers = buildServerHeaders(srv);
  try {
    const res = await fetch(`${base}/project`, { headers });
    if (!res.ok) return cached?.projects ?? [];
    const list = (await res.json()) as OpenCodeProjectApiItem[];
    if (!Array.isArray(list)) return cached?.projects ?? [];

    const defaultWorkspace = srv.defaultDir?.trim() || DEFAULT_WORKSPACE_DIR;
    const repos: OpenCodeRepo[] = [];
    for (const p of list) {
      if (!p || typeof p.canonical !== "string") continue;
      const dir = p.canonical.replace(/\/+$/, "");
      if (!dir || dir === "/tmp" || dir.startsWith("/private/var")) continue;
      const label = pathToRepoLabel(dir, defaultWorkspace);
      if (!repos.some((r) => r.dir === dir)) {
        repos.push({ label, dir });
      }
    }
    repos.sort((a, b) => a.label.localeCompare(b.label));
    serverProjectsCache.set(srv.id, { fetchedAt: Date.now(), projects: repos });
    return repos;
  } catch {
    return cached?.projects ?? [];
  }
}

export type OpenCodeSlashItem = {
  id: string;
  name: string;
  description: string;
  kind: "command" | "skill" | "tool";
  argHint?: string;
};

export const BUILTIN_TOOL_SLASH_ITEMS: OpenCodeSlashItem[] = [
  {
    id: "explore",
    name: "explore",
    description: "Spawn the fast explore subagent to search files and analyze code",
    kind: "tool",
    argHint: "<query or question>",
  },
  {
    id: "websearch",
    name: "websearch",
    description: "Search the web for documentation, recent releases, or answers",
    kind: "tool",
    argHint: "<search query>",
  },
  {
    id: "webfetch",
    name: "webfetch",
    description: "Fetch and read content from an HTTP/HTTPS URL",
    kind: "tool",
    argHint: "<url> [instructions]",
  },
  {
    id: "browser",
    name: "browser",
    description: "Open and interact with pages in the OpenCode browser",
    kind: "tool",
    argHint: "<url or action>",
  },
  {
    id: "shell",
    name: "shell",
    description: "Execute a shell command in the workspace",
    kind: "tool",
    argHint: "<command>",
  },
  {
    id: "subagent",
    name: "subagent",
    description: "Run a complex multi-step task in a background subagent",
    kind: "tool",
    argHint: "<task description>",
  },
];

type ServerCatalogEntry = {
  fetchedAt: number;
  commands: Set<string>;
  skills: Set<string>;
  items: OpenCodeSlashItem[];
};

const serverSlashCatalogCache = new Map<string, ServerCatalogEntry>();

export function getCachedSlashItems(serverId?: string): OpenCodeSlashItem[] {
  const srv = resolveServer(serverId);
  return serverSlashCatalogCache.get(srv.id)?.items ?? BUILTIN_TOOL_SLASH_ITEMS;
}

export async function fetchSlashItemsForServer(
  serverId?: string,
  directory?: string,
  force = false,
): Promise<OpenCodeSlashItem[]> {
  const srv = resolveServer(serverId);
  const cacheKey = srv.id;
  const cached = serverSlashCatalogCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.fetchedAt < 60_000) {
    return cached.items;
  }
  const base = resolveOpenCodeBase(srv.endpoint);
  const headers = buildServerHeaders(srv);
  const dirQuery = directory?.trim()
    ? `?location[directory]=${encodeURIComponent(directory.trim())}`
    : "";
  try {
    const [cmdRes, skillRes] = await Promise.all([
      fetch(`${base}/command${dirQuery}`, { headers }).catch(() => null),
      fetch(`${base}/skill${dirQuery}`, { headers }).catch(() => null),
    ]);
    const commands = new Set<string>();
    const skills = new Set<string>();
    const byId = new Map<string, OpenCodeSlashItem>();

    if (cmdRes && cmdRes.ok) {
      const cmdJson = (await cmdRes.json()) as {
        data?: Array<{ name?: string; description?: string }>;
      };
      for (const c of cmdJson.data ?? []) {
        const name = c?.name?.trim();
        if (!name) continue;
        commands.add(name);
        byId.set(name, {
          id: name,
          name,
          description: c.description?.trim() || `Run /${name} command`,
          kind: "command",
        });
      }
    }

    if (skillRes && skillRes.ok) {
      const skillJson = (await skillRes.json()) as {
        data?: Array<{ id?: string; name?: string; description?: string }>;
      };
      for (const s of skillJson.data ?? []) {
        const id = (s?.id || s?.name || "").trim();
        if (!id) continue;
        skills.add(id);
        if (!byId.has(id)) {
          byId.set(id, {
            id,
            name: s?.name?.trim() || id,
            description: s?.description?.trim() || `Load ${id} skill`,
            kind: "skill",
          });
        }
      }
    }

    for (const toolItem of BUILTIN_TOOL_SLASH_ITEMS) {
      if (!byId.has(toolItem.id)) {
        byId.set(toolItem.id, toolItem);
      }
    }

    const items = Array.from(byId.values()).sort((a, b) => {
      const order = { command: 0, skill: 1, tool: 2 };
      if (order[a.kind] !== order[b.kind]) return order[a.kind] - order[b.kind];
      return a.id.localeCompare(b.id);
    });

    if (commands.size > 0 || skills.size > 0) {
      serverSlashCatalogCache.set(cacheKey, {
        fetchedAt: Date.now(),
        commands,
        skills,
        items,
      });
    }
    return items;
  } catch {
    return cached?.items ?? BUILTIN_TOOL_SLASH_ITEMS;
  }
}

export function getOpenCodeWebUrl(sessionID?: string, srv?: OpenCodeServer): string | null {
  const s = srv ?? resolveServer();
  const base = resolveOpenCodeBase(s.endpoint);
  let root = "";
  if (base === "/opencode-api" || isLocalLoopbackHttp(base)) {
    root = "http://127.0.0.1:49374";
  } else if (base.endsWith("/opencode-api")) {
    root = base.slice(0, -"/opencode-api".length);
  } else if (base.endsWith("/api")) {
    root = base.slice(0, -4);
  } else {
    root = base;
  }
  if (!root) return null;
  return sessionID ? `${root}/session/${sessionID}` : root;
}

async function fetchSingleServerSnapshot(srv: OpenCodeServer): Promise<{
  ok: boolean;
  sessions: OpenCodeLiveSession[];
  models: OpenCodeModelOption[];
  projects: OpenCodeRepo[];
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
    const [sesRes, actRes, formRes, permRes, models, projects] = await Promise.all([
      fetch(`${base}/session?limit=30&order=desc`, { headers }),
      fetch(`${base}/session/active`, { headers }),
      fetch(`${base}/form`, { headers }),
      fetch(`${base}/permission/request`, { headers }),
      fetchServerModels(srv),
      fetchServerProjects(srv),
    ]);
    if (!sesRes.ok) return { ok: false, sessions: [], models: [], projects: [] };

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
        repoShort: dirToShortRepo(directory, projects),
        serverId: srv.id,
        serverName: srv.name,
        modelKey: formatModelKey(s.model) || undefined,
        status,
        updatedAt: s.time?.updated ?? s.time?.created ?? 0,
        busyAt: s.time?.busy,
        idleAt: s.time?.idle,
        viewedAt: s.time?.viewed,
        cost: s.cost,
        form,
        permission: perm,
      };
    });

    return { ok: true, sessions: list, models, projects };
  } catch {
    return { ok: false, sessions: [], models: [], projects: [] };
  }
}

// Fetch live state across all enabled OpenCode servers in parallel
export async function fetchOpenCodeSnapshot(): Promise<{
  connected: boolean;
  serverOnlineById: Record<string, boolean>;
  modelsByServer: Record<string, OpenCodeModelOption[]>;
  projectsByServer: Record<string, OpenCodeRepo[]>;
  sessions: OpenCodeLiveSession[];
}> {
  const cfg = loadOpenCodeConfig();
  const enabledServers = (cfg.servers.length > 0 ? cfg.servers : DEFAULT_SERVERS).filter(
    (s) => s.enabled !== false,
  );
  if (enabledServers.length === 0) {
    return {
      connected: false,
      serverOnlineById: {},
      modelsByServer: {},
      projectsByServer: {},
      sessions: [],
    };
  }

  const results = await Promise.all(
    enabledServers.map(async (srv) => ({
      srv,
      res: await fetchSingleServerSnapshot(srv),
    })),
  );

  const serverOnlineById: Record<string, boolean> = {};
  const modelsByServer: Record<string, OpenCodeModelOption[]> = {};
  const projectsByServer: Record<string, OpenCodeRepo[]> = {};
  const allSessions: OpenCodeLiveSession[] = [];
  let anyConnected = false;

  for (const { srv, res } of results) {
    serverOnlineById[srv.id] = res.ok;
    if (res.ok) {
      anyConnected = true;
      modelsByServer[srv.id] = res.models;
      projectsByServer[srv.id] = res.projects;
      allSessions.push(...res.sessions);
    }
  }

  allSessions.sort((a, b) => b.updatedAt - a.updatedAt);

  return {
    connected: anyConnected,
    serverOnlineById,
    modelsByServer,
    projectsByServer,
    sessions: allSessions,
  };
}

export async function createAndPromptOpenCodeSession(opts: {
  title: string;
  directory: string;
  promptText: string;
  serverId?: string;
  modelKey?: string;
  onSessionCreated?: (sessionID: string) => void;
}): Promise<string> {
  const srv = resolveServer(opts.serverId);
  const cfg = loadOpenCodeConfig();
  const base = resolveOpenCodeBase(srv.endpoint);
  const cachedModels = serverModelsCache.get(srv.id)?.models;
  const discoveredDefaultModel = cachedModels?.find((m) => m.isDefault)?.key;
  const effectiveModelKey =
    opts.modelKey || srv.defaultModel || cfg.defaultModel || discoveredDefaultModel;
  const modelRef = parseModelKey(effectiveModelKey);
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
  opts.onSessionCreated?.(sessionID);

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

export async function cancelOpenCodeForm(
  sessionID: string,
  formID: string,
  serverId?: string,
  message?: string,
): Promise<void> {
  const srv = resolveServer(serverId);
  const base = resolveOpenCodeBase(srv.endpoint);
  const query = message ? `?message=${encodeURIComponent(message)}` : "";
  await fetch(`${base}/session/${sessionID}/form/${formID}${query}`, {
    method: "DELETE",
    headers: buildServerHeaders(srv),
  }).catch(() => {});
}

export async function sendOpenCodePrompt(
  sessionID: string,
  text: string,
  serverId?: string,
  opts?: {
    pendingFormId?: string;
    pendingPermissionId?: string;
  },
): Promise<void> {
  const srv = resolveServer(serverId);
  const base = resolveOpenCodeBase(srv.endpoint);
  const headers = buildServerHeaders(srv);

  // Discover any pending forms on this session so steering while a question is open never deadlocks
  const formIds = new Set<string>();
  if (opts?.pendingFormId) formIds.add(opts.pendingFormId);
  try {
    const formRes = await fetch(`${base}/session/${sessionID}/form`, { headers });
    if (formRes.ok) {
      const formJson = (await formRes.json()) as { data?: Array<{ id?: string }> };
      for (const f of formJson.data ?? []) {
        if (f?.id) formIds.add(f.id);
      }
    }
  } catch {
    /* ignore form discovery errors */
  }

  // Ensure command & skill catalog is warm when user uses `/` or `@`
  const trimmed = text.trim();
  if ((trimmed.includes("/") || trimmed.includes("@")) && !serverSlashCatalogCache.has(srv.id)) {
    await fetchSlashItemsForServer(srv.id).catch(() => {});
  }
  const catalog = serverSlashCatalogCache.get(srv.id);

  // Detect any `/skill-id` or `@skill-id` mentions that match registered skills on this server
  const skillIdSet = new Set<string>();
  if (catalog && catalog.skills.size > 0) {
    const tokenRegex = /(?:^|\s)[/@]([a-zA-Z0-9_:-]+(?:\/[a-zA-Z0-9_:-]+)*)/g;
    let m: RegExpExecArray | null;
    while ((m = tokenRegex.exec(trimmed)) !== null) {
      const candidate = m[1];
      if (catalog.skills.has(candidate)) {
        skillIdSet.add(candidate);
      }
    }
  }

  let dispatched = false;
  let effectiveText = text;

  if (trimmed.startsWith("/")) {
    const slashMatch = trimmed
      .slice(1)
      .match(/^([a-zA-Z0-9_:-]+(?:\/[a-zA-Z0-9_:-]+)*)(?:\s+([\s\S]*))?$/);
    if (slashMatch) {
      const [, slashName, rawArgs = ""] = slashMatch;
      const restArgs = rawArgs.trim();

      if (catalog?.commands.has(slashName)) {
        // 1a. Execute registered OpenCode slash command via `/session/:id/command`
        const matchedSkills = Array.from(skillIdSet).map((id) => ({ id }));
        const cmdRes = await fetch(`${base}/session/${sessionID}/command`, {
          method: "POST",
          headers: buildServerHeaders(srv, true),
          body: JSON.stringify({
            name: slashName,
            text: restArgs,
            ...(matchedSkills.length > 0 ? { skills: matchedSkills } : {}),
            delivery: "steer",
          }),
        }).catch(() => null);
        if (cmdRes && cmdRes.ok) {
          dispatched = true;
        }
      } else if (catalog?.skills.has(slashName)) {
        // 1b. Registered skill invoked with `/skill-id [args]`
        skillIdSet.add(slashName);
        if (!restArgs) {
          effectiveText = `/${slashName}`;
        }
      } else {
        // 1c. Built-in tool / subagent slash shortcut
        if (slashName === "explore" && restArgs) {
          effectiveText = `Use the explore subagent to investigate: ${restArgs}`;
        } else if (slashName === "websearch" && restArgs) {
          effectiveText = `Use the websearch tool to search for: ${restArgs}`;
        } else if (slashName === "webfetch" && restArgs) {
          effectiveText = `Use the webfetch tool to fetch and read: ${restArgs}`;
        } else if (slashName === "browser") {
          if (catalog?.skills.has("browser")) skillIdSet.add("browser");
          if (restArgs) {
            effectiveText = `Use the browser tool to: ${restArgs}`;
          }
        } else if (slashName === "shell" && restArgs) {
          effectiveText = `Use the shell tool to run: \`${restArgs}\``;
        } else if (slashName === "subagent" && restArgs) {
          effectiveText = `Use a subagent to execute: ${restArgs}`;
        }
      }
    }
  }

  // 1. Admit the steer prompt (with any matched skill attachments) to the session inbox first
  if (!dispatched) {
    const matchedSkills = Array.from(skillIdSet).map((id) => ({ id }));
    const res = await fetch(`${base}/session/${sessionID}/prompt`, {
      method: "POST",
      headers: buildServerHeaders(srv, true),
      body: JSON.stringify({
        text: effectiveText,
        ...(matchedSkills.length > 0 ? { skills: matchedSkills } : {}),
        delivery: "steer",
      }),
    });
    if (!res.ok) throw new Error(`Prompt on ${srv.name} failed: ${res.status}`);
  }

  // 2. If the session was blocked on a pending question form, cancel the form so the agent unblocks and processes the steer
  if (formIds.size > 0) {
    await Promise.all(
      Array.from(formIds).map((fid) =>
        fetch(`${base}/session/${sessionID}/form/${fid}`, {
          method: "DELETE",
          headers,
        }).catch(() => {}),
      ),
    );
  }

  // 3. If the session was blocked on a pending permission request, reject it so the steer can proceed
  if (opts?.pendingPermissionId) {
    await replyOpenCodePermission(
      sessionID,
      opts.pendingPermissionId,
      "reject",
      serverId,
    ).catch(() => {});
  }
}

// Reply to an OpenCode question form (when the agent asks you to pick one or more options, optionally with extra steer instructions)
export async function replyOpenCodeForm(
  sessionID: string,
  formID: string,
  fieldKeyOrAnswers: string | Record<string, string | string[]>,
  value?: string | string[],
  serverId?: string,
  steerPrompt?: string,
): Promise<void> {
  const srv = resolveServer(serverId);
  const base = resolveOpenCodeBase(srv.endpoint);
  const answer: Record<string, string | string[]> =
    typeof fieldKeyOrAnswers === "string"
      ? { [fieldKeyOrAnswers]: value ?? "" }
      : fieldKeyOrAnswers;

  if (steerPrompt?.trim()) {
    await fetch(`${base}/session/${sessionID}/prompt`, {
      method: "POST",
      headers: buildServerHeaders(srv, true),
      body: JSON.stringify({ text: steerPrompt.trim(), delivery: "steer" }),
    }).catch(() => {});
  }

  const res = await fetch(`${base}/session/${sessionID}/form/${formID}/reply`, {
    method: "POST",
    headers: buildServerHeaders(srv, true),
    body: JSON.stringify({
      answer,
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
  const headers = buildServerHeaders(srv);
  try {
    const formRes = await fetch(`${base}/session/${sessionID}/form`, { headers });
    if (formRes.ok) {
      const formJson = (await formRes.json()) as { data?: Array<{ id?: string }> };
      await Promise.all(
        (formJson.data ?? []).map((f) =>
          f?.id
            ? fetch(`${base}/session/${sessionID}/form/${f.id}`, {
                method: "DELETE",
                headers,
              }).catch(() => {})
            : Promise.resolve(),
        ),
      );
    }
  } catch {
    /* ignore */
  }
  await fetch(`${base}/session/${sessionID}/interrupt`, {
    method: "POST",
    headers,
  }).catch(() => {});
}

export type SessionFileDiff = {
  file: string;
  shortFile: string;
  additions: number;
  deletions: number;
  patch: string;
};

export type SessionToolStep = {
  name: string;
  detail: string;
  label: string;
  status: "running" | "completed" | "error";
};

export type SessionStepItem =
  | {
      kind: "reasoning";
      text: string;
    }
  | {
      kind: "tool";
      name: string;
      detail: string;
      label: string;
      status: "running" | "completed" | "error";
    };

export type SessionTurn = {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools: string[];
  steps: SessionStepItem[];
  hasOpaqueReasoning?: boolean;
  isStreaming?: boolean;
  timestamp?: number;
};

export type SessionSummary = {
  lastAssistantText: string;
  lastToolCall?: string;
  recentTools: SessionToolStep[];
  filesChanged: SessionFileDiff[];
  totalAdditions: number;
  totalDeletions: number;
  turns: SessionTurn[];
  updatedAt?: number;
};

const summaryCache = new Map<
  string,
  { updatedAt: number; fetchedAt: number; summary: SessionSummary }
>();

export function invalidateSessionSummary(sessionID: string) {
  const existing = summaryCache.get(sessionID);
  if (existing) {
    summaryCache.set(sessionID, {
      updatedAt: 0,
      fetchedAt: 0,
      summary: existing.summary,
    });
  }
}

function shortFilePath(p: string): string {
  const clean = p.trim().replace(/^\/+/, "");
  const parts = clean.split("/");
  return parts.length > 2 ? parts.slice(-2).join("/") : clean;
}

function stripPatchHeader(patch: string): string {
  const lines = patch.split("\n");
  const idx = lines.findIndex((l) => l.startsWith("@@"));
  const body = idx !== -1 ? lines.slice(idx) : lines;
  return body.slice(0, 60).join("\n");
}

function buildFallbackPatch(oldStr?: string, newStr?: string): {
  patch: string;
  additions: number;
  deletions: number;
} {
  const oldLines = oldStr ? oldStr.split("\n") : [];
  const newLines = newStr ? newStr.split("\n") : [];
  const delPreview = oldLines.slice(0, 18).map((l) => `- ${l}`);
  const addPreview = newLines.slice(0, 24).map((l) => `+ ${l}`);
  const header = `@@ -1,${oldLines.length} +1,${newLines.length} @@`;
  return {
    patch: [header, ...delPreview, ...addPreview].join("\n"),
    additions: newLines.length,
    deletions: oldLines.length,
  };
}

export async function fetchOpenCodeSessionSummary(
  sessionID: string,
  knownUpdatedAt = 0,
  serverId?: string,
  forceRefresh = false,
): Promise<SessionSummary | null> {
  const cached = summaryCache.get(sessionID);
  if (
    !forceRefresh &&
    cached &&
    cached.summary.lastAssistantText &&
    Date.now() - cached.fetchedAt < 2500 &&
    knownUpdatedAt > 0 &&
    cached.updatedAt >= knownUpdatedAt
  ) {
    return cached.summary;
  }
  const srv = resolveServer(serverId);
  const base = resolveOpenCodeBase(srv.endpoint);
  try {
    const res = await fetch(`${base}/session/${sessionID}/message?limit=50`, {
      headers: buildServerHeaders(srv),
    });
    if (!res.ok) return cached?.summary ?? null;
    const json = (await res.json()) as {
      data?: Array<{
        id?: string;
        type?: string;
        text?: string;
        skill?: string;
        name?: string;
        metadata?: { displayText?: string };
        error?: { message?: string };
        time?: { created?: number; completed?: number };
        content?: Array<{
          type?: string;
          text?: string;
          name?: string;
          state?: {
            status?: string;
            input?: {
              command?: string;
              path?: string;
              pattern?: string;
              query?: string;
              url?: string;
              id?: string;
              description?: string;
              oldString?: string;
              newString?: string;
              content?: string;
              questions?: Array<{
                header?: string;
                question?: string;
              }>;
            };
            metadata?: {
              answers?: string[][];
              files?: Array<{
                file?: string;
                patch?: string;
                additions?: number;
                deletions?: number;
              }>;
            };
          };
        }>;
      }>;
    };
    const msgs = json.data ?? [];
    let lastAssistantText = "";
    let lastErrorText = "";
    let lastToolCall: string | undefined;
    let updatedAt = knownUpdatedAt;
    const groupedTurns: SessionTurn[] = [];
    const allToolSteps: SessionToolStep[] = [];
    const fileDiffMap = new Map<string, SessionFileDiff>();

    // Walk chronologically from oldest to newest so turns, reasoning, tool steps & file diffs accumulate in order
    const chronological = [...msgs].reverse();
    for (const m of chronological) {
      const msgTime = m.time?.completed ?? m.time?.created ?? 0;
      if (msgTime > updatedAt) updatedAt = msgTime;

      if (m.error?.message?.trim()) {
        lastErrorText = `⚠️ ${m.error.message.trim()}`;
        const prevTurn = groupedTurns[groupedTurns.length - 1];
        if (prevTurn && prevTurn.role === "assistant" && !prevTurn.text) {
          prevTurn.text = lastErrorText;
        }
      }

      if (m.type === "user") {
        lastErrorText = "";
        const userParts: string[] = [];
        const directUserText = (m.text || m.metadata?.displayText || "").trim();
        if (directUserText) userParts.push(directUserText);
        for (const part of m.content ?? []) {
          if (part.type === "text" && part.text?.trim()) {
            const pt = part.text.trim();
            if (!userParts.includes(pt)) userParts.push(pt);
          }
        }
        const joinedUser = userParts.join("\n\n").trim();
        if (joinedUser) {
          groupedTurns.push({
            id: m.id ?? `user_${groupedTurns.length}`,
            role: "user",
            text: joinedUser,
            tools: [],
            steps: [],
            timestamp: m.time?.created,
          });
        }
        continue;
      }

      if (m.type === "skill") {
        const skillLabel = (m.skill || m.name || "").trim();
        if (skillLabel) {
          const prevTurn = groupedTurns[groupedTurns.length - 1];
          if (!prevTurn || prevTurn.role !== "user" || !prevTurn.text.includes(skillLabel)) {
            groupedTurns.push({
              id: m.id ?? `skill_${groupedTurns.length}`,
              role: "user",
              text: `/${skillLabel}`,
              tools: [],
              steps: [],
              timestamp: m.time?.created,
            });
          }
        }
        continue;
      }

      if (m.type !== "assistant") continue;

      let curTurn = groupedTurns[groupedTurns.length - 1];
      if (!curTurn || curTurn.role !== "assistant") {
        curTurn = {
          id: m.id ?? `asst_${groupedTurns.length}`,
          role: "assistant",
          text: "",
          tools: [],
          steps: [],
          timestamp: m.time?.created,
        };
        groupedTurns.push(curTurn);
      }

      for (const part of m.content ?? []) {
        if (part.type === "reasoning") {
          const rText = part.text?.trim() ?? "";
          if (rText) {
            curTurn.steps.push({ kind: "reasoning", text: rText });
          } else {
            curTurn.hasOpaqueReasoning = true;
          }
          continue;
        }

        if (part.type === "tool" && part.name) {
          const inp = part.state?.input;
          const questionDetail =
            part.name === "question" && Array.isArray(inp?.questions)
              ? (() => {
                  const ans = part.state?.metadata?.answers;
                  const picked = Array.isArray(ans)
                    ? ans.flatMap((a) => (Array.isArray(a) ? a : [])).filter(Boolean)
                    : [];
                  const headers = inp.questions
                    .map((q) => q.header || q.question || "")
                    .filter(Boolean)
                    .join(", ");
                  if (picked.length > 0) {
                    return `${headers ? `${headers} → ` : ""}${picked.join(", ")}`;
                  }
                  return headers;
                })()
              : "";
          const rawDetail =
            questionDetail ||
            inp?.command?.replace(/\s+/g, " ").trim() ||
            (inp?.path && inp?.pattern
              ? `${inp.pattern} in ${shortFilePath(inp.path)}`
              : inp?.path
                ? shortFilePath(inp.path)
                : inp?.pattern ||
                  inp?.query ||
                  inp?.url ||
                  inp?.id ||
                  inp?.description ||
                  "");
          const shortDetail =
            rawDetail && rawDetail.length > 56 ? `${rawDetail.slice(0, 53)}…` : rawDetail;
          const label = shortDetail ? `${part.name} ${shortDetail}` : part.name;
          const st = part.state?.status;
          const status: SessionToolStep["status"] =
            st === "running" || st === "pending" || st === "streaming"
              ? "running"
              : st === "error"
                ? "error"
                : "completed";
          const stepObj: SessionToolStep = {
            name: part.name,
            detail: shortDetail || "",
            label,
            status,
          };
          allToolSteps.push(stepObj);
          curTurn.tools.push(label);
          curTurn.steps.push({ kind: "tool", ...stepObj });
          lastToolCall = label;

          const metaFiles = part.state?.metadata?.files;
          if (Array.isArray(metaFiles) && metaFiles.length > 0) {
            for (const mf of metaFiles) {
              const file = mf.file?.trim();
              if (!file) continue;
              const prev = fileDiffMap.get(file);
              const cleanPatch = mf.patch ? stripPatchHeader(mf.patch) : "";
              const add = typeof mf.additions === "number" ? mf.additions : 0;
              const del = typeof mf.deletions === "number" ? mf.deletions : 0;
              fileDiffMap.set(file, {
                file,
                shortFile: shortFilePath(file),
                additions: (prev?.additions ?? 0) + add,
                deletions: (prev?.deletions ?? 0) + del,
                patch: cleanPatch || prev?.patch || "",
              });
            }
          } else if (
            (part.name === "edit" || part.name === "write") &&
            part.state?.input?.path
          ) {
            const file = part.state.input.path.trim();
            const prev = fileDiffMap.get(file);
            const fb =
              part.name === "edit"
                ? buildFallbackPatch(part.state.input.oldString, part.state.input.newString)
                : buildFallbackPatch(undefined, part.state.input.content);
            fileDiffMap.set(file, {
              file,
              shortFile: shortFilePath(file),
              additions: (prev?.additions ?? 0) + fb.additions,
              deletions: (prev?.deletions ?? 0) + fb.deletions,
              patch: fb.patch || prev?.patch || "",
            });
          }
          continue;
        }

        if (part.type === "text" && part.text?.trim()) {
          const cleanText = part.text.trim();
          curTurn.text = curTurn.text ? `${curTurn.text}\n\n${cleanText}` : cleanText;
        }
      }

      if (m.error?.message?.trim() && !curTurn.text) {
        curTurn.text = `⚠️ ${m.error.message.trim()}`;
      }
    }

    for (let i = groupedTurns.length - 1; i >= 0; i--) {
      const t = groupedTurns[i];
      if (t.role === "assistant" && t.text.trim()) {
        lastAssistantText = t.text.trim();
        break;
      }
    }

    if (!lastAssistantText) {
      lastAssistantText = lastErrorText || cached?.summary.lastAssistantText || "";
    }

    const turns = groupedTurns.slice(-24);
    const filesChanged = Array.from(fileDiffMap.values());
    let totalAdditions = 0;
    let totalDeletions = 0;
    for (const f of filesChanged) {
      totalAdditions += f.additions;
      totalDeletions += f.deletions;
    }

    const summary: SessionSummary = {
      lastAssistantText,
      lastToolCall,
      recentTools: allToolSteps.slice(-4),
      filesChanged,
      totalAdditions,
      totalDeletions,
      turns,
      updatedAt,
    };
    summaryCache.set(sessionID, {
      updatedAt: lastAssistantText ? updatedAt : 0,
      fetchedAt: Date.now(),
      summary,
    });
    return summary;
  } catch {
    return cached?.summary ?? null;
  }
}

export async function deleteOpenCodeSession(
  sessionID: string,
  serverId?: string,
): Promise<void> {
  if (!sessionID) return;
  const srv = resolveServer(serverId);
  const base = resolveOpenCodeBase(srv.endpoint);
  try {
    await fetch(`${base}/session/${sessionID}`, {
      method: "DELETE",
      headers: buildServerHeaders(srv),
    });
  } catch {
    /* ignore deletion errors */
  }
}

export type BacklogSignal = "blocker" | "deadline" | "recent" | "agent" | "quick";

export type TriageTaskInput = {
  id: string;
  content: string;
  priority: number;
  description?: string | null;
  due?: { datetime?: string; date: string } | null;
  duration?: { amount: number; unit: string } | null;
  added_at?: string;
};

export type BacklogSuggestion = {
  taskId: string;
  score: number;
  suggestedMinutes: number;
  strategy: "focus" | "agent";
  signals: BacklogSignal[];
  targetServerId?: string;
  targetRepo?: string;
};

export type TriageResult = {
  suggestions: BacklogSuggestion[];
  source: "opencode" | "heuristic";
  serverName?: string;
  modelLabel?: string;
};

export async function suggestBacklogTasks(opts: {
  backlogTasks: TriageTaskInput[];
  focusTasks?: TriageTaskInput[];
  recentRepos?: string[];
  serverId?: string;
  defaultMinutes?: number;
}): Promise<TriageResult> {
  const { backlogTasks, focusTasks = [], recentRepos = [], defaultMinutes = 25 } = opts;
  if (backlogTasks.length === 0) {
    return { suggestions: [], source: "heuristic" };
  }

  // 1. Compute high-precision heuristic baseline
  const recentRepoSet = new Set(recentRepos.map((r) => r.toLowerCase().trim()).filter(Boolean));
  for (const ft of focusTasks) {
    const meta = parseTaskDescription(ft.description);
    if (meta.repo) recentRepoSet.add(meta.repo.toLowerCase().trim());
  }

  const BLOCKER_RE = /\b(block|fix|bug|broken|fail|error|panic|crash|incident|p0|p1|urgent)\b/i;
  const today = new Date().toISOString().split("T")[0];

  const scored: BacklogSuggestion[] = backlogTasks.map((t) => {
    const meta = parseTaskDescription(t.description);
    const signals: BacklogSignal[] = [];
    let score = (t.priority || 1) * 25; // 25 to 100

    // Deadline signal
    if (t.due?.date) {
      if (t.due.date <= today) {
        signals.push("deadline");
        score += 45;
      }
    }

    // Blocker signal
    if (BLOCKER_RE.test(t.content) || (meta.note && BLOCKER_RE.test(meta.note))) {
      signals.push("blocker");
      score += 35;
    }

    // Continuity / recent repo signal
    const taskRepo = meta.repo.toLowerCase().trim();
    if (taskRepo && recentRepoSet.has(taskRepo)) {
      signals.push("recent");
      score += 30;
    }

    // Agent delegation ready signal
    const isAgent = Boolean(meta.queued || meta.prompt || (meta.repo && meta.prompt));
    if (isAgent) {
      signals.push("agent");
      score += 20;
    }

    // Quick win signal
    const dur = t.duration?.amount ?? defaultMinutes;
    if (dur <= 20) {
      signals.push("quick");
      score += 15;
    }

    return {
      taskId: t.id,
      score,
      suggestedMinutes: dur,
      strategy: isAgent ? "agent" : "focus",
      signals,
      targetServerId: meta.server || opts.serverId,
      targetRepo: meta.repo,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  const heuristicTop = scored.slice(0, 3);

  // 2. Try OpenCode if server is online
  const srv = resolveServer(opts.serverId);
  const cfg = loadOpenCodeConfig();
  const isOnline = srv.enabled !== false;

  if (!isOnline) {
    return {
      suggestions: heuristicTop,
      source: "heuristic",
    };
  }

  try {
    const base = resolveOpenCodeBase(srv.endpoint);
    const testRes = await fetch(`${base}/session?limit=1`, {
      headers: buildServerHeaders(srv),
      signal: AbortSignal.timeout(2000),
    });
    if (!testRes.ok) {
      return { suggestions: heuristicTop, source: "heuristic" };
    }

    const candidates = scored.slice(0, 8).map((s) => {
      const t = backlogTasks.find((item) => item.id === s.taskId)!;
      const meta = parseTaskDescription(t.description);
      return {
        id: t.id,
        title: t.content,
        priority: `P${t.priority || 1}`,
        repo: meta.repo || undefined,
        agentPrompt: meta.prompt || undefined,
        duration: `${s.suggestedMinutes}m`,
      };
    });

    const promptText = `Select top 3 tasks from this backlog to pull into focus right now.
Return ONLY valid JSON array with up to 3 objects: [{"taskId": string, "strategy": "focus" | "agent", "signals": string[]}]
Signals: "blocker", "deadline", "recent", "agent", "quick".
Candidates:
${JSON.stringify(candidates, null, 2)}`;

    const sessionId = await createAndPromptOpenCodeSession({
      title: `[Triage] Backlog Suggestions`,
      directory: srv.defaultDir || DEFAULT_WORKSPACE_DIR,
      promptText,
      serverId: srv.id,
      modelKey: srv.defaultModel || cfg.defaultModel,
    });

    const pollStart = Date.now();
    let assistantReply = "";
    while (Date.now() - pollStart < 5000) {
      await new Promise((r) => setTimeout(r, 500));
      const msgRes = await fetch(`${base}/session/${sessionId}/message?limit=5`, {
        headers: buildServerHeaders(srv),
      });
      if (!msgRes.ok) break;
      const json = await msgRes.json();
      const msgs = (json.data ?? []) as Array<{
        type?: string;
        text?: string;
        content?: Array<{ type?: string; text?: string }>;
      }>;
      const assistant = msgs.find((m) => m.type === "assistant");
      if (assistant) {
        const text =
          assistant.text ||
          assistant.content?.map((c) => c.text).filter(Boolean).join("\n") ||
          "";
        if (text.trim()) {
          assistantReply = text.trim();
          break;
        }
      }
    }

    void deleteOpenCodeSession(sessionId, srv.id);

    if (assistantReply) {
      const match = assistantReply.match(/\[[\s\S]*\]/);
      if (match) {
        const parsed = JSON.parse(match[0]) as Array<{
          taskId: string;
          strategy?: "focus" | "agent";
          signals?: BacklogSignal[];
        }>;
        if (Array.isArray(parsed) && parsed.length > 0) {
          const validSuggestions: BacklogSuggestion[] = [];
          for (const item of parsed) {
            const orig = scored.find((s) => s.taskId === item.taskId);
            if (orig) {
              const combinedSignals = Array.from(
                new Set([...(item.signals || []), ...orig.signals]),
              ).filter((sig): sig is BacklogSignal =>
                ["blocker", "deadline", "recent", "agent", "quick"].includes(sig),
              );
              validSuggestions.push({
                ...orig,
                strategy: item.strategy === "agent" ? "agent" : orig.strategy,
                signals: combinedSignals,
              });
            }
          }
          if (validSuggestions.length > 0) {
            return {
              suggestions: validSuggestions.slice(0, 3),
              source: "opencode",
              serverName: srv.name,
              modelLabel: srv.defaultModel || "OpenCode",
            };
          }
        }
      }
    }
  } catch {
    /* fallback to heuristic */
  }

  return {
    suggestions: heuristicTop,
    source: "heuristic",
  };
}

export type JiraAssignedIssue = {
  key: string;
  summary: string;
  status: string;
  priority?: string;
  url?: string;
  description?: string;
  suggestedRepo?: string;
  matchedSessionIds?: string[];
};

export type JiraPullResult = {
  issues: JiraAssignedIssue[];
  serverName?: string;
  fetchedAt: number;
  error?: string;
};

const JIRA_CACHE_KEY = "tb_jira_assigned_cache";

export function loadCachedJiraIssues(): JiraPullResult | null {
  try {
    const raw = localStorage.getItem(JIRA_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as JiraPullResult;
    if (!parsed || !Array.isArray(parsed.issues)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCachedJiraIssues(res: JiraPullResult): void {
  try {
    localStorage.setItem(JIRA_CACHE_KEY, JSON.stringify(res));
  } catch {
    /* ignore quota errors */
  }
}

export function inferRepoFromJiraText(
  key: string,
  summary: string,
  description = "",
  availableRepos: OpenCodeRepo[] = KNOWN_REPOS,
): string {
  const combined = `${key} ${summary} ${description}`.toLowerCase();
  const repos = availableRepos.length > 0 ? availableRepos : KNOWN_REPOS;

  // Match explicit repo slug mentions first
  for (const r of repos) {
    const slug = r.label.replace(/^vyond\//, "").replace(/^homelab\//, "").toLowerCase();
    if (slug.length >= 4 && combined.includes(slug)) {
      return r.label;
    }
  }

  if (/\b(eks|k8s|kubernetes|helm|ingress|argocd|manifest)\b/.test(combined)) {
    return "vyond/eks-manifest";
  }
  if (/\b(qa|autotest|account-pool)\b/.test(combined)) {
    return "vyond/qa-autotest-account-pool";
  }
  if (/\b(review-hub|software-review)\b/.test(combined)) {
    return "vyond/devops-software-review-hub";
  }
  if (/\b(ai-helper)\b/.test(combined)) {
    return "vyond/devops-ai-helper";
  }
  if (/\b(turbo)\b/.test(combined)) {
    return "vyond/turbo";
  }
  if (/\b(next)\b/.test(combined)) {
    return "vyond/next";
  }
  if (key.toUpperCase().startsWith("DEVOPS-")) {
    return "vyond/devops";
  }
  return "";
}

export function findMatchingSessionsForJira(
  jiraKey?: string | null,
  sessions: OpenCodeLiveSession[] = [],
): OpenCodeLiveSession[] {
  const clean = (jiraKey ?? "").trim().toUpperCase();
  if (!clean) return [];
  return sessions.filter((s) => {
    const titleUpper = (s.title ?? "").toUpperCase();
    const dirUpper = (s.directory ?? "").toUpperCase();
    return titleUpper.includes(clean) || dirUpper.includes(clean);
  });
}

async function pollAssistantReply(
  base: string,
  srv: OpenCodeServer,
  sessionId: string,
  timeoutMs = 22_000,
): Promise<string> {
  const pollStart = Date.now();
  let latestText = "";
  while (Date.now() - pollStart < timeoutMs) {
    await new Promise((r) => setTimeout(r, 700));
    const [msgRes, actRes] = await Promise.all([
      fetch(`${base}/session/${sessionId}/message?limit=8`, {
        headers: buildServerHeaders(srv),
      }),
      fetch(`${base}/session/active`, {
        headers: buildServerHeaders(srv),
      }).catch(() => null),
    ]);
    if (!msgRes.ok) break;
    const json = await msgRes.json();
    const actJson =
      actRes && actRes.ok
        ? ((await actRes.json()) as { data?: Record<string, unknown> })
        : { data: {} };
    const isStillRunning = Boolean(actJson.data?.[sessionId]);

    const msgs = (json.data ?? []) as Array<{
      type?: string;
      text?: string;
      content?: Array<{ type?: string; text?: string }>;
    }>;
    const assistant = msgs.find((m) => m.type === "assistant");
    if (assistant) {
      const text =
        assistant.text ||
        assistant.content
          ?.filter((c) => !c.type || c.type === "text")
          .map((c) => c.text)
          .filter(Boolean)
          .join("\n") ||
        "";
      if (text.trim()) {
        latestText = text.trim();
        if (!isStillRunning && /\[[\s\S]*\]/.test(latestText)) {
          return latestText;
        }
      }
    }
    if (!isStillRunning && latestText) {
      return latestText;
    }
  }
  return latestText;
}

export async function fetchAssignedJiraIssues(opts?: {
  serverId?: string;
  jql?: string;
  liveSessions?: OpenCodeLiveSession[];
  availableRepos?: OpenCodeRepo[];
}): Promise<JiraPullResult> {
  const srv = resolveServer(opts?.serverId);
  const cfg = loadOpenCodeConfig();
  const base = resolveOpenCodeBase(srv.endpoint);

  try {
    const testRes = await fetch(`${base}/session?limit=1`, {
      headers: buildServerHeaders(srv),
      signal: AbortSignal.timeout(2500),
    });
    if (!testRes.ok) {
      return {
        issues: loadCachedJiraIssues()?.issues ?? [],
        serverName: srv.name,
        fetchedAt: Date.now(),
        error: `OpenCode server "${srv.name}" returned HTTP ${testRes.status}`,
      };
    }
  } catch {
    return {
      issues: loadCachedJiraIssues()?.issues ?? [],
      serverName: srv.name,
      fetchedAt: Date.now(),
      error: `OpenCode server "${srv.name}" is unreachable. Start or connect OpenCode to query Jira MCP.`,
    };
  }

  const jql =
    opts?.jql?.trim() ||
    "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";

  const promptText = `Use the Atlassian Jira MCP tools (in execute: search for atlassian JQL / getAccessibleAtlassianResources / searchJiraIssuesUsingJql) to fetch Jira issues matching this JQL:
${jql}
(Limit to 15 issues).
Return ONLY a raw JSON array (no markdown prose outside JSON) where each item has:
[
  {
    "key": "DEVOPS-123",
    "summary": "Issue title",
    "status": "In Progress",
    "priority": "Medium",
    "url": "https://<site>.atlassian.net/browse/DEVOPS-123",
    "description": "Short 1-2 sentence summary or linked OpenCode session ID if mentioned"
  }
]`;

  let sessionId = "";
  try {
    sessionId = await createAndPromptOpenCodeSession({
      title: `[MCP] Pull Assigned Jira Issues`,
      directory: srv.defaultDir || DEFAULT_WORKSPACE_DIR,
      promptText,
      serverId: srv.id,
      modelKey: srv.defaultModel || cfg.defaultModel,
    });

    const reply = await pollAssistantReply(base, srv, sessionId, 24_000);
    void deleteOpenCodeSession(sessionId, srv.id);

    const match = reply.match(/\[[\s\S]*\]/);
    if (!match) {
      return {
        issues: loadCachedJiraIssues()?.issues ?? [],
        serverName: srv.name,
        fetchedAt: Date.now(),
        error: reply
          ? `Could not parse Jira response: ${reply.slice(0, 140)}`
          : "Timed out waiting for Atlassian MCP response from OpenCode.",
      };
    }

    const parsed = JSON.parse(match[0]) as Array<{
      key?: string;
      summary?: string;
      status?: string;
      priority?: string;
      url?: string;
      description?: string;
    }>;

    const liveSessions = opts?.liveSessions ?? [];
    const repos = opts?.availableRepos ?? getServerRepos(srv.id, cfg);

    const issues: JiraAssignedIssue[] = (Array.isArray(parsed) ? parsed : [])
      .filter((item) => item && typeof item.key === "string" && item.key.trim())
      .map((item) => {
        const key = item.key!.trim().toUpperCase();
        const summary = (item.summary ?? "").trim() || key;
        const desc = (item.description ?? "").trim();
        const matched = findMatchingSessionsForJira(key, liveSessions).map((s) => s.id);
        // Also extract any `ses_...` IDs mentioned inside the Jira ticket description/comments
        const sesInDesc = Array.from(desc.matchAll(/\b(ses_[A-Za-z0-9]+)\b/g)).map((m) => m[1]);
        const matchedSessionIds = Array.from(new Set([...matched, ...sesInDesc]));
        return {
          key,
          summary,
          status: (item.status ?? "To Do").trim(),
          priority: item.priority?.trim(),
          url: item.url?.trim(),
          description: desc || undefined,
          suggestedRepo: inferRepoFromJiraText(key, summary, desc, repos) || undefined,
          matchedSessionIds,
        };
      });

    const result: JiraPullResult = {
      issues,
      serverName: srv.name,
      fetchedAt: Date.now(),
    };
    saveCachedJiraIssues(result);
    return result;
  } catch (e) {
    if (sessionId) void deleteOpenCodeSession(sessionId, srv.id);
    return {
      issues: loadCachedJiraIssues()?.issues ?? [],
      serverName: srv.name,
      fetchedAt: Date.now(),
      error: e instanceof Error ? e.message : "Failed to query Jira MCP via OpenCode",
    };
  }
}

export async function syncSessionToJiraIssue(opts: {
  jiraKey: string;
  sessionID: string;
  sessionTitle?: string;
  serverId?: string;
  repo?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const cleanKey = opts.jiraKey.trim().toUpperCase();
  if (!cleanKey || !opts.sessionID) {
    return { ok: false, error: "Missing Jira key or OpenCode session ID" };
  }
  const srv = resolveServer(opts.serverId);
  const cfg = loadOpenCodeConfig();
  const base = resolveOpenCodeBase(srv.endpoint);
  const webUrl =
    getOpenCodeWebUrl(opts.sessionID, srv) || `http://127.0.0.1:49374/session/${opts.sessionID}`;
  const label = `OpenCode Session [${srv.id}] ${opts.sessionID}${opts.sessionTitle ? ` — ${opts.sessionTitle}` : ""}`;

  const promptText = `Link OpenCode session "${opts.sessionID}" to Jira issue ${cleanKey} using the Atlassian MCP:
1. Call getAccessibleAtlassianResources to get cloudId.
2. Call tools.atlassian.addGraphContext({
  cloudId,
  relationshipType: "jira-work-item-links-jira-work-item-remote-link",
  objectIdentifier: "${cleanKey}",
  targetObjectIdentifier: "${webUrl}",
  title: ${JSON.stringify(label)}
}).
3. Reply with ONLY: {"ok": true}`;

  let helperSid = "";
  try {
    helperSid = await createAndPromptOpenCodeSession({
      title: `[MCP] Link ${opts.sessionID.slice(0, 10)} → ${cleanKey}`,
      directory: srv.defaultDir || DEFAULT_WORKSPACE_DIR,
      promptText,
      serverId: srv.id,
      modelKey: srv.defaultModel || cfg.defaultModel,
    });
    await pollAssistantReply(base, srv, helperSid, 18_000);
    void deleteOpenCodeSession(helperSid, srv.id);
    return { ok: true };
  } catch (e) {
    if (helperSid) void deleteOpenCodeSession(helperSid, srv.id);
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Failed to link session in Jira",
    };
  }
}
