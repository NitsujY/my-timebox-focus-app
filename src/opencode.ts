export type TriageState =
  | "needs_you" // Agent asked a question / form option, OR finished turn and is waiting for your steer
  | "working" // OpenCode agent is actively generating / running tools
  | "queued"; // Idle / manual task / not currently running an agent

export type OpenCodeSessionInfo = {
  id: string;
  title?: string;
  agent?: string;
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
  status: "running" | "question" | "ready" | "idle";
  updatedAt: number;
  busyAt?: number;
  idleAt?: number;
  viewedAt?: number;
  cost?: number;
  form?: OpenCodeFormRequest;
  permission?: OpenCodePermissionRequest;
};

export const KNOWN_REPOS: { label: string; dir: string }[] = [
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

export const DEFAULT_WORKSPACE_DIR = "/Users/justinyu";

export function dirToShortRepo(dir?: string): string {
  if (!dir || dir === DEFAULT_WORKSPACE_DIR) return "";
  const hit = KNOWN_REPOS.find((r) => dir === r.dir || dir.startsWith(r.dir + "/"));
  if (hit) return hit.label.replace(/^vyond\//, "");
  const parts = dir.replace(/\/$/, "").split("/");
  return parts.slice(-2).join("/");
}

export function resolveRepoDir(repoToken?: string): string {
  if (!repoToken || !repoToken.trim()) return DEFAULT_WORKSPACE_DIR;
  if (repoToken.startsWith("/")) return repoToken;
  const clean = repoToken.replace(/^@/, "").toLowerCase();
  const hit = KNOWN_REPOS.find(
    (r) =>
      r.label.toLowerCase() === clean ||
      r.label.toLowerCase().endsWith(`/${clean}`) ||
      r.dir.toLowerCase().endsWith(`/${clean}`),
  );
  return hit ? hit.dir : `/Users/justinyu/Develop/vyond/${clean}`;
}

export type TaskMeta = {
  note: string;
  prompt: string;
  repo: string;
  sessions: string[];
};

const META_RE = /\[opencode:([^\]]+)\]\s*$/;

export function parseTaskDescription(desc?: string | null): TaskMeta {
  const raw = (desc ?? "").trim();
  if (!raw) return { note: "", prompt: "", repo: "", sessions: [] };

  let body = raw;
  let repo = "";
  let sessions: string[] = [];

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
      }
    }
  }

  if (body.includes("\n---\n")) {
    const [notePart, ...promptParts] = body.split("\n---\n");
    return {
      note: notePart.trim(),
      prompt: promptParts.join("\n---\n").trim(),
      repo,
      sessions,
    };
  }

  const lines = body.split("\n");
  if (lines.length === 1) {
    return { note: lines[0].trim(), prompt: "", repo, sessions };
  }
  return {
    note: lines[0].trim(),
    prompt: lines.slice(1).join("\n").trim(),
    repo,
    sessions,
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
  if (meta.sessions.length > 0) {
    tags.push(`ses=${Array.from(new Set(meta.sessions)).join(",")}`);
  }
  if (meta.repo.trim()) {
    tags.push(`repo=${meta.repo.trim()}`);
  }
  if (tags.length > 0) {
    parts.push(`[opencode:${tags.join(" ")}]`);
  }

  return parts.join("\n").trim();
}

// Fetch live state from the Vite `/opencode-api` proxy (including `/form` questions!)
export async function fetchOpenCodeSnapshot(): Promise<{
  connected: boolean;
  sessions: OpenCodeLiveSession[];
}> {
  try {
    const [sesRes, actRes, formRes, permRes] = await Promise.all([
      fetch("/opencode-api/session?limit=30&order=desc"),
      fetch("/opencode-api/session/active"),
      fetch("/opencode-api/form"),
      fetch("/opencode-api/permission/request"),
    ]);
    if (!sesRes.ok) return { connected: false, sessions: [] };

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

    return { connected: true, sessions: list };
  } catch {
    return { connected: false, sessions: [] };
  }
}

export async function createAndPromptOpenCodeSession(opts: {
  title: string;
  directory: string;
  promptText: string;
}): Promise<string> {
  const createRes = await fetch("/opencode-api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: opts.title,
      location: { directory: opts.directory },
    }),
  });
  if (!createRes.ok) throw new Error(`Create session failed: ${createRes.status}`);
  const created = (await createRes.json()) as { data: { id: string } };
  const sessionID = created.data.id;

  if (opts.promptText.trim()) {
    await sendOpenCodePrompt(sessionID, opts.promptText.trim());
  }
  return sessionID;
}

export async function sendOpenCodePrompt(sessionID: string, text: string): Promise<void> {
  const res = await fetch(`/opencode-api/session/${sessionID}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Prompt failed: ${res.status}`);
}

// Reply to an OpenCode question form (when the agent asks you to pick an option)
export async function replyOpenCodeForm(
  sessionID: string,
  formID: string,
  fieldKey: string,
  value: string | string[],
): Promise<void> {
  const res = await fetch(`/opencode-api/session/${sessionID}/form/${formID}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      answer: { [fieldKey]: value },
    }),
  });
  if (!res.ok) throw new Error(`Form reply failed: ${res.status}`);
}

export async function replyOpenCodePermission(
  sessionID: string,
  requestID: string,
  decision: "once" | "always" | "reject" = "once",
): Promise<void> {
  const res = await fetch(
    `/opencode-api/session/${sessionID}/permission/${requestID}/reply`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    },
  );
  if (!res.ok) throw new Error(`Permission reply failed: ${res.status}`);
}

export async function interruptOpenCodeSession(sessionID: string): Promise<void> {
  await fetch(`/opencode-api/session/${sessionID}/interrupt`, {
    method: "POST",
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
): Promise<SessionSummary | null> {
  const cached = summaryCache.get(sessionID);
  if (cached && knownUpdatedAt > 0 && cached.updatedAt >= knownUpdatedAt) {
    return cached.summary;
  }
  try {
    const res = await fetch(`/opencode-api/session/${sessionID}/message?limit=30`);
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
