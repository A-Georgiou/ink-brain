// Serves the overlay UI and vendored libraries over app://live with strict content security policies.
import fs from "node:fs/promises";
import path from "node:path";
import { protocol } from "electron";
import { resolveAppPath } from "./routes.mjs";

export const APP_SCHEME = {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true },
};

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".map": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
};

const OVERLAY_CSP = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "frame-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
].join("; ");

// Panels run model-written code in sandboxed, opaque-origin frames with no network access.
const SANDBOX_CSP = [
    "default-src 'none'",
    "script-src app://live 'unsafe-inline' 'unsafe-eval'",
    "style-src app://live 'unsafe-inline'",
    "img-src app://live data: blob:",
    "font-src app://live data:",
    "media-src data: blob:",
    "worker-src blob:",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
].join("; ");

export function registerAppProtocol() {
    protocol.handle("app", async (request) => {
        const url = new URL(request.url);
        const file = url.host === "live" ? resolveAppPath(url.pathname) : null;
        if (!file) return new Response("Not found", { status: 404 });
        try {
            const body = await fs.readFile(file);
            const headers = {
                "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
                "access-control-allow-origin": "*",
                "cache-control": "no-cache",
                "x-content-type-options": "nosniff",
            };
            if (file.endsWith(".html")) headers["content-security-policy"] = path.basename(file) === "sandbox.html" ? SANDBOX_CSP : OVERLAY_CSP;
            return new Response(body, { headers });
        } catch {
            return new Response("Not found", { status: 404 });
        }
    });
}
