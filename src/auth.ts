// Todoist OAuth (PKCE public client) — coexists with pasted API tokens.
// Both paths end at a bearer token in tb_token; the API layer doesn't care which.
// client_id is the URL of public/oauth-client-metadata.json (Todoist's zero-registration
// flow, no client secret) — edit that file with the deployed domain before shipping.
// Locally (localhost can't host the metadata doc) just paste an API token instead.

const AUTHORIZE_URL = "https://app.todoist.com/oauth/authorize";
const TOKEN_URL = "https://api.todoist.com/oauth/access_token";
const CLIENT_ID = `${location.origin}/oauth-client-metadata.json`;
const REDIRECT_URI = `${location.origin}/`;

export const load = <T,>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
};
export const save = (k: string, v: unknown) =>
  localStorage.setItem(k, JSON.stringify(v));

const b64url = (bytes: Uint8Array<ArrayBuffer> | ArrayBuffer) =>
  btoa(
    String.fromCharCode(
      ...(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes),
    ),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export async function startOAuth() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem("tb_pkce", JSON.stringify({ verifier, state }));
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("scope", "data:read_write");
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  location.assign(url.toString());
}

// returns the access token when this page load is an OAuth redirect, else null
export async function handleOAuthCallback(): Promise<string | null> {
  const q = new URLSearchParams(location.search);
  if (q.get("error")) throw new Error(`Todoist auth: ${q.get("error")}`);
  const code = q.get("code");
  if (!code) return null;
  const raw = sessionStorage.getItem("tb_pkce");
  sessionStorage.removeItem("tb_pkce");
  history.replaceState(null, "", REDIRECT_URI); // strip ?code&state
  const saved = raw
    ? (JSON.parse(raw) as { verifier: string; state: string })
    : null;
  if (!saved || saved.state !== q.get("state"))
    throw new Error("OAuth state mismatch — try connecting again");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: saved.verifier,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  saveTokens(await res.json());
  return load("tb_token", "");
}

const saveTokens = (d: { access_token: string; refresh_token?: string }) => {
  save("tb_token", d.access_token);
  if (d.refresh_token) save("tb_refresh", d.refresh_token);
};

// OAuth tokens expire after 1h; dedupe concurrent refreshes (rotation + 401 storms)
let refreshing: Promise<string> | null = null;
export function refreshToken(): Promise<string> {
  return (refreshing ??= (async () => {
    const rt = load("tb_refresh", "");
    if (!rt) throw new Error("401 Unauthorized");
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: rt,
      }),
    });
    if (!res.ok) {
      localStorage.removeItem("tb_token");
      localStorage.removeItem("tb_refresh");
      throw new Error("Todoist session expired — reconnect");
    }
    const d = await res.json();
    saveTokens({ access_token: d.access_token, refresh_token: d.refresh_token ?? rt });
    return d.access_token as string;
  })().finally(() => {
    refreshing = null;
  }));
}
