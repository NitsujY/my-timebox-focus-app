import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Local OpenCode daemon bridge: discovers `opencode service status` + `~/.config/opencode/service.json`
// and proxies `/opencode-api/*` -> `http://127.0.0.1:<port>/api/*` with Basic auth.
function opencodeBridgePlugin(): Plugin {
  let cachedBase = "";
  let cachedAt = 0;

  function resolveService(): { base: string; auth: string } | null {
    try {
      if (!cachedBase || Date.now() - cachedAt > 10_000) {
        const out = execSync("opencode service status", {
          encoding: "utf8",
          timeout: 1500,
        }).trim();
        if (out.startsWith("http")) {
          cachedBase = out.replace(/\/$/, "");
          cachedAt = Date.now();
        }
      }
      if (!cachedBase) return null;
      const cfgPath = join(homedir(), ".config", "opencode", "service.json");
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { password?: string };
      const auth = cfg.password
        ? "Basic " + Buffer.from(`opencode:${cfg.password}`).toString("base64")
        : "";
      return { base: cachedBase, auth };
    } catch {
      return null;
    }
  }

  return {
    name: "opencode-local-bridge",
    configureServer(server) {
      server.middlewares.use("/opencode-api", async (req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");
        if (req.method === "OPTIONS") {
          res.statusCode = 204;
          res.end();
          return;
        }

      if (req.url === "/health" || req.url?.startsWith("/health?")) {
        const svc = resolveService();
        const cfgPath = join(homedir(), ".config", "opencode", "service.json");
        let serviceCfg: { password?: string; cors?: string | string[] } = {};
        try {
          serviceCfg = JSON.parse(readFileSync(cfgPath, "utf8")) as {
            password?: string;
            cors?: string | string[];
          };
        } catch {
          /* ignore */
        }
        res.statusCode = svc ? 200 : 503;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            ok: Boolean(svc),
            upstream: svc?.base ?? null,
            apiEndpoint: svc ? `${svc.base}/api` : null,
            bridgeEndpoint: `http://127.0.0.1:${server.config.server.port || 5173}/opencode-api`,
            password: serviceCfg.password ?? null,
            cors: serviceCfg.cors ?? null,
          }),
        );
        return;
      }

      const svc = resolveService();
      if (!svc) {
        res.statusCode = 503;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "OpenCode service not running" }));
        return;
      }
        const targetUrl = `${svc.base}/api${req.url || ""}`;
        try {
          const chunks: Buffer[] = [];
          if (req.method !== "GET" && req.method !== "HEAD") {
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
          }
          const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
          const upstream = await fetch(targetUrl, {
            method: req.method || "GET",
            headers: {
              ...(svc.auth ? { Authorization: svc.auth } : {}),
              ...(body ? { "Content-Type": "application/json" } : {}),
              Accept: req.headers.accept || "application/json",
            },
            body,
          });
          res.statusCode = upstream.status;
          const ct = upstream.headers.get("content-type");
          if (ct) res.setHeader("Content-Type", ct);

          if (ct?.includes("text/event-stream") && upstream.body) {
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            const reader = upstream.body.getReader();
            req.on("close", () => reader.cancel().catch(() => {}));
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(Buffer.from(value));
            }
            res.end();
          } else {
            const text = await upstream.text();
            res.end(text);
          }
        } catch (err) {
          cachedBase = ""; // force re-discovery on next request
          res.statusCode = 502;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  };
}

export default defineConfig({
  // ponytail: relative base so Pages works under any repo name
  base: "./",
  plugins: [
    opencodeBridgePlugin(),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Timebox Focus",
        short_name: "Timebox",
        description: "A timeboxing focus timer",
        theme_color: "#4f46e5",
        background_color: "#ffffff",
        display: "standalone",
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          {
            src: "pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      // ponytail: enabled in dev so PWA install can be tested with `npm run dev`
      devOptions: { enabled: true },
    }),
  ],
});
