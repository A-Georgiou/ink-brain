// Continue with ChatGPT: Sign in with ChatGPT lets Ink Brain use the user's ChatGPT plan, and a local adapter
// shapes the Copilot SDK's Responses requests for that route (developer instructions, namespaced tools).
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";

export const AUTH = "https://auth.openai.com";
export const API = "https://api.openai.com/v1";
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const NAMESPACE = "ink_brain";
const UNUSABLE = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);
const LIMITS = {
    subscription_sharing_usage_limit_exceeded: "ChatGPT usage limit reached. Review your plan or Ink Brain's limit at chatgpt.com/settings/usage.",
    subscription_sharing_usage_unavailable: "ChatGPT could not check your usage just now. Try again in a moment.",
    subscription_sharing_user_not_eligible: "This ChatGPT account cannot use its plan in other apps.",
};
const DONE_PAGE = "<!doctype html><meta charset=utf-8><title>Ink Brain</title><body style=\"font:16px -apple-system;padding:40px\">You can close this tab and go back to Ink Brain.";
const random = () => crypto.randomBytes(32).toString("base64url");

// This Mac's stable, opaque host ID for ChatGPT plan usage, made once.
export function hostId(file) {
    try {
        return fs.readFileSync(file, "utf8").trim();
    } catch {
        const id = `urn:uuid:${crypto.randomUUID()}`;
        fs.writeFileSync(file, id, { mode: 0o600 });
        return id;
    }
}

async function tokenRequest(auth, form, fetchImpl) {
    const response = await fetchImpl(`${auth}/api/accounts/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form), signal: AbortSignal.timeout(15_000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(`ChatGPT sign-in failed (${body.error ?? response.status}).`), { code: body.error });
    return body;
}

// Checks an ID token's RS256 signature against OpenAI's keys, then its issuer, audience, nonce and expiry.
export async function verifyIdToken(token, { issuer, audience, nonce, fetchImpl = fetch, now = Date.now() }) {
    const [head, payload, signature] = String(token).split(".");
    const header = JSON.parse(Buffer.from(head ?? "", "base64url").toString() || "{}");
    const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString() || "{}");
    const { keys = [] } = await (await fetchImpl(`${issuer}/.well-known/jwks.json`, { signal: AbortSignal.timeout(15_000) })).json();
    const jwk = header.alg === "RS256" && keys.find((key) => key.kid === header.kid);
    const signed = Boolean(jwk) && crypto.verify("RSA-SHA256", Buffer.from(`${head}.${payload}`), crypto.createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(signature ?? "", "base64url"));
    if (!signed || claims.iss !== issuer || ![claims.aud].flat().includes(audience) || claims.nonce !== nonce || !(claims.exp * 1000 > now)) throw new Error("ChatGPT sign-in could not be verified.");
    return claims;
}

// Signs in through the browser and returns the validated credential record; saved reauthorizes that account.
export async function signInWithChatGPT({ hostId: host, saved = null, open, auth = AUTH, fetchImpl = fetch, timeoutMs = 600_000 }) {
    const [state, nonce, verifier] = [random(), random(), random()];
    const server = http.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
    const params = new URLSearchParams({ client_id: saved?.client_id ?? "dynamic_agent_client", ext_agent_host_id: host, response_type: "code", redirect_uri: redirectUri, scope: SCOPES, resource: API, state, nonce, code_challenge_method: "S256", code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url") });
    if (!saved) params.set("agent_name_hint", "Ink Brain");
    if (saved?.id_token) params.set("id_token_hint", saved.id_token);
    if (saved?.email) params.set("login_hint", saved.email);
    if (saved && !saved.scopes?.includes(PLAN_SCOPE)) params.set("prompt", "consent");
    try {
        const callback = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("ChatGPT sign-in timed out. Continue with ChatGPT to try again.")), timeoutMs);
            server.on("request", (req, res) => {
                const query = new URL(req.url, redirectUri).searchParams;
                if (!req.url.startsWith("/auth/callback") || query.get("state") !== state) return res.writeHead(404).end();
                clearTimeout(timer);
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(DONE_PAGE);
                resolve(query);
            });
        });
        await open(`${auth}/api/accounts/authorize?${params}`);
        const result = await callback;
        if (result.get("error")) throw new Error(result.get("error") === "access_denied" ? "ChatGPT sign-in was cancelled." : `ChatGPT sign-in failed (${result.get("error")}).`);
        const clientId = result.get("client_id") ?? saved?.client_id;
        if (!clientId || clientId === "dynamic_agent_client" || (saved && clientId !== saved.client_id)) throw new Error("ChatGPT sign-in did not finish registering Ink Brain.");
        const tokens = await tokenRequest(auth, { grant_type: "authorization_code", client_id: clientId, code: result.get("code"), code_verifier: verifier, redirect_uri: redirectUri, resource: API }, fetchImpl);
        const claims = await verifyIdToken(tokens.id_token, { issuer: auth, audience: clientId, nonce, fetchImpl });
        if (saved?.subject && claims.sub !== saved.subject) throw new Error("That is a different ChatGPT account. Sign out first to switch.");
        return { email: claims.email ?? null, subject: claims.sub, client_id: clientId, id_token: tokens.id_token, access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000, scopes: String(tokens.scope ?? "").split(" ").filter(Boolean) };
    } finally {
        server.close();
    }
}

// What stays after signing out: the account and its registration, so signing in again reuses them.
export const signedOut = ({ email, subject, client_id: clientId, scopes }) => ({ email, subject, client_id: clientId, scopes });

// Keeps a fresh access token for the saved sign-in, refreshing one at a time since refresh tokens rotate.
export function chatgptTokens({ load, save, auth = AUTH, fetchImpl = fetch }) {
    let refreshing = null;
    async function refresh() {
        const record = load();
        try {
            const tokens = await tokenRequest(auth, { grant_type: "refresh_token", client_id: record.client_id, refresh_token: record.refresh_token, resource: API }, fetchImpl);
            save({ ...record, access_token: tokens.access_token, refresh_token: tokens.refresh_token ?? record.refresh_token, expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000, scopes: tokens.scope ? tokens.scope.split(" ") : record.scopes });
        } catch (error) {
            if (UNUSABLE.has(error.code)) save(signedOut(record));
            throw error;
        }
    }
    return async (force = false) => {
        const record = load();
        if (!record?.access_token) throw new Error("Use your ChatGPT Plus or Pro plan, with no API key: Continue with ChatGPT.");
        if (!record.scopes?.includes(PLAN_SCOPE)) throw new Error("Allow Ink Brain to use your ChatGPT plan: Continue with ChatGPT and approve plan use.");
        if (force || record.expires_at - Date.now() < 60_000) await (refreshing ??= refresh().finally(() => (refreshing = null)));
        return load().access_token;
    };
}

// Ends the renewable session at OpenAI; returns whether revocation was confirmed.
export async function revokeChatGPT(record, { auth = AUTH, fetchImpl = fetch } = {}) {
    if (!record?.refresh_token) return true;
    const body = new URLSearchParams({ token: record.refresh_token, token_type_hint: "refresh_token", client_id: record.client_id });
    return fetchImpl(`${auth}/api/accounts/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(15_000) }).then((response) => response.ok, () => false);
}

// The models this ChatGPT account can use, in the server's order.
export async function chatgptModels(token, { api = API, fetchImpl = fetch } = {}) {
    const response = await fetchImpl(`${api}/models`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`ChatGPT answered with error ${response.status}.`);
    const { models = [] } = await response.json();
    return models.filter((model) => model.visibility === "list").map((model) => model.slug);
}

// The ChatGPT plan route takes instructions as developer messages and function tools grouped in a namespace.
export function adaptRequest(body) {
    const functions = (body.tools ?? []).filter((tool) => tool.type === "function");
    const names = new Set(functions.map((tool) => tool.name));
    const input = (body.input ?? []).map((item) => (item.role === "system" ? { ...item, role: "developer" } : item.type === "function_call" && names.has(item.name) ? { ...item, namespace: NAMESPACE } : item));
    const others = (body.tools ?? []).filter((tool) => tool.type !== "function");
    const tools = functions.length ? [...others, { type: "namespace", name: NAMESPACE, description: "Ink Brain's tools for looking at, drawing on and explaining the user's screen.", tools: functions }] : others;
    return { ...body, input, tools, store: false, stream: true };
}

// Hides the namespace from calls coming back, so the SDK sees its own tools, and words plan limits plainly.
export function adaptEvent(data) {
    if (!data.includes(`"${NAMESPACE}"`) && !data.includes("subscription_sharing")) return data;
    let event;
    try {
        event = JSON.parse(data);
    } catch {
        return data;
    }
    const strip = (value) => {
        if (!value || typeof value !== "object") return;
        if (value.type === "function_call" && value.namespace === NAMESPACE) delete value.namespace;
        Object.values(value).forEach(strip);
    };
    strip(event);
    const error = event.response?.error ?? event.error;
    if (LIMITS[error?.code]) error.message = LIMITS[error.code];
    return JSON.stringify(event);
}

const adaptLine = (line) => (line.startsWith("data: ") ? `data: ${adaptEvent(line.slice(6))}` : line);

// A local endpoint the Copilot SDK talks to as if it were OpenAI; only requests carrying this run's secret get through.
export async function startAdapter({ token, api = API, fetchImpl = fetch }) {
    const secret = random();
    const server = http.createServer(async (req, res) => {
        if (req.method !== "POST" || !req.url.endsWith("/responses") || req.headers.authorization !== `Bearer ${secret}`) return res.writeHead(404).end();
        try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = JSON.stringify(adaptRequest(JSON.parse(Buffer.concat(chunks).toString())));
            const send = async (force) => fetchImpl(`${api}/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await token(force)}` }, body });
            let upstream = await send(false);
            if (upstream.status === 401) upstream = await send(true);
            const type = upstream.headers.get("content-type") ?? "application/json";
            res.writeHead(upstream.status, { "content-type": type });
            if (!type.includes("event-stream")) return res.end(adaptEvent(await upstream.text()));
            const decoder = new TextDecoder();
            let pending = "";
            for await (const chunk of upstream.body) {
                const lines = (pending + decoder.decode(chunk, { stream: true })).split("\n");
                pending = lines.pop();
                res.write(`${lines.map(adaptLine).join("\n")}\n`);
            }
            res.end(adaptLine(pending + decoder.decode()));
        } catch (error) {
            if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: error.message } }));
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { url: `http://127.0.0.1:${server.address().port}/v1`, secret, close: () => server.close() };
}
