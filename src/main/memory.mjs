// Ink Brain's memory on this Mac: facts about the user, past conversations, visuals and screen history.
import fs from "node:fs";
import path from "node:path";

const DAY = 86_400_000;
const MAX_FACTS = 200;
const KEEP_ARTEFACTS = 200;
const MIN_VISIT_MS = 20_000;
const IDLE_SECONDS = 120;
// Time in these is never recorded: password managers, the lock screen and the screen saver.
const PRIVATE_APPS = /^(1Password|Passwords|Keychain Access|Bitwarden|LastPass|Dashlane|loginwindow|ScreenSaverEngine)\b/i;

const pad = (n) => String(n).padStart(2, "0");
const dayOf = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const midnight = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
const clip = (text, max) => {
    const clean = String(text ?? "").replace(/\s+/g, " ").trim();
    return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
};

// Memory files may be missing, unreadable or half-written, so reads fall back instead of throwing.
function attempt(read, fallback) {
    try {
        return read();
    } catch {
        return fallback;
    }
}

const readJson = (file, fallback) => attempt(() => JSON.parse(fs.readFileSync(file, "utf8")), fallback);
const listDir = (dir) => attempt(() => fs.readdirSync(dir), []);

// "today 21:40", "yesterday 09:05" or "30 Oct 14:10".
export function when(at, now) {
    const date = new Date(at);
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const days = Math.round((midnight(now) - midnight(date)) / DAY);
    if (days === 0) return `today ${time}`;
    if (days === 1) return `yesterday ${time}`;
    return `${date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${time}`;
}

const duration = (ms) => {
    const m = Math.max(1, Math.round(ms / 60_000));
    return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};
const pageText = (app, page) => `${app}${page ? ` "${page}"` : ""}`;
const visitText = (v) => `${pageText(v.app, v.page)} (${duration(v.ms)})`;
const turnPlace = (t) => (t.app ? ` in ${pageText(t.app, t.page)}` : "");

export class Memory {
    #facts = null;
    #visit = null;
    #count = 0;

    constructor({ dir, now = () => new Date(), keepDays = 30 }) {
        Object.assign(this, { dir, now, keepDays });
    }

    #path(...parts) {
        return path.join(this.dir, ...parts);
    }

    #write(file, text) {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, text, { mode: 0o600 });
    }

    #append(kind, entry) {
        fs.mkdirSync(this.#path(kind), { recursive: true, mode: 0o700 });
        fs.appendFileSync(this.#path(kind, `${dayOf(this.now())}.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    }

    // Entries of a daily log from the last `days` days, oldest first; blank and corrupt lines are skipped.
    #read(kind, days) {
        const from = dayOf(new Date(this.now().getTime() - days * DAY));
        return listDir(this.#path(kind))
            .filter((name) => name.endsWith(".jsonl") && name.slice(0, 10) >= from)
            .sort()
            .flatMap((name) => fs.readFileSync(this.#path(kind, name), "utf8").split("\n"))
            .map((line) => attempt(() => JSON.parse(line)))
            .filter((entry) => entry !== undefined);
    }

    // Drops daily logs older than keepDays.
    prune() {
        const from = dayOf(new Date(this.now().getTime() - this.keepDays * DAY));
        for (const kind of ["journal", "activity"]) {
            for (const name of listDir(this.#path(kind))) if (name.endsWith(".jsonl") && name.slice(0, 10) < from) fs.rmSync(this.#path(kind, name), { force: true });
        }
    }

    // ---------------------------------------------------------------- saved memories

    facts() {
        this.#facts ??= readJson(this.#path("memories.json"), { next: 1, facts: [] });
        return this.#facts.facts;
    }

    #saveFacts() {
        this.#write(this.#path("memories.json"), `${JSON.stringify(this.#facts, null, 2)}\n`);
    }

    remember({ text, topic, replaces }) {
        const facts = this.facts();
        const clean = clip(text, 300);
        if (!clean) throw new Error("Say what to remember.");
        const at = this.now().toISOString();
        let fact = facts.find((f) => f.id === replaces);
        if (fact) Object.assign(fact, { text: clean, topic: clip(topic, 40) || fact.topic, at });
        else facts.push((fact = { id: `m${this.#facts.next++}`, text: clean, topic: clip(topic, 40) || "general", at }));
        facts.splice(0, Math.max(0, facts.length - MAX_FACTS));
        this.#saveFacts();
        return fact;
    }

    forget(id) {
        const facts = this.facts();
        const index = facts.findIndex((f) => f.id === id);
        if (index < 0) return false;
        facts.splice(index, 1);
        this.#saveFacts();
        return true;
    }

    forgetAll() {
        this.#visit = null;
        this.#facts = null;
        fs.rmSync(this.dir, { recursive: true, force: true });
    }

    // ---------------------------------------------------------------- conversations and visuals

    logTurn({ app, page, asked, answered, made = [], via }) {
        this.#append("journal", { at: this.now().toISOString(), app: clip(app, 60), page: clip(page, 120), asked: clip(asked, 400), answered: clip(answered, 700), made, via });
    }

    // The conversation to continue after a restart, if it was used within `hours`.
    conversation(hours) {
        const last = readJson(this.#path("conversation.json"), null);
        return last?.id && this.now().getTime() - Date.parse(last.at) < hours * 3_600_000 ? last.id : null;
    }

    noteConversation(id) {
        if (id) this.#write(this.#path("conversation.json"), JSON.stringify({ id, at: this.now().toISOString() }));
    }

    endConversation() {
        fs.rmSync(this.#path("conversation.json"), { force: true });
    }

    #index() {
        return readJson(this.#path("artefacts.json"), []);
    }

    // Saves a visual to reopen later; saving an id again replaces it (a panel updated in place).
    saveArtefact({ id, tool, title, page, args }) {
        const record = { id: id || `a${this.now().getTime().toString(36)}${(++this.#count).toString(36)}`, at: this.now().toISOString(), tool, title: clip(title, 100), page };
        this.#write(this.#path("artefacts", `${record.id}.json`), JSON.stringify({ ...record, args }));
        const index = [...this.#index().filter((a) => a.id !== record.id), record];
        for (const old of index.splice(0, Math.max(0, index.length - KEEP_ARTEFACTS))) fs.rmSync(this.#path("artefacts", `${old.id}.json`), { force: true });
        this.#write(this.#path("artefacts.json"), JSON.stringify(index));
        return record.id;
    }

    artefact(id) {
        return /^a[a-z0-9]+$/.test(String(id)) ? readJson(this.#path("artefacts", `${id}.json`), null) : null;
    }

    // ---------------------------------------------------------------- what was on screen

    // front is the frontmost { app, page } or null; a visit ends when it changes or the user goes idle.
    observe(front, idleSeconds = 0) {
        const now = this.now().getTime();
        const idle = idleSeconds >= IDLE_SECONDS;
        const same = this.#visit && front && this.#visit.app === front.app && this.#visit.page === clip(front.page, 120);
        if (this.#visit && (idle || !same)) this.#close(idle ? Math.max(this.#visit.from, now - idleSeconds * 1000) : now);
        if (!this.#visit && !idle && front?.app && !PRIVATE_APPS.test(front.app)) this.#visit = { app: clip(front.app, 60), page: clip(front.page, 120), from: now };
    }

    #close(end) {
        const visit = this.#visit;
        this.#visit = null;
        if (end - visit.from >= MIN_VISIT_MS) this.#append("activity", { from: new Date(visit.from).toISOString(), to: new Date(end).toISOString(), app: visit.app, page: visit.page });
    }

    flush() {
        if (this.#visit) this.#close(this.now().getTime());
    }

    // Time on each page since a moment, longest first.
    visits(since) {
        const now = this.now().getTime();
        const list = this.#read("activity", Math.ceil((now - since) / DAY) + 1).map((v) => ({ app: v.app, page: v.page, from: Date.parse(v.from), to: Date.parse(v.to) }));
        if (this.#visit) list.push({ ...this.#visit, to: now });
        const totals = new Map();
        for (const v of list) {
            const ms = v.to - Math.max(v.from, since);
            if (!(ms > 0)) continue;
            const key = `${v.app}\n${v.page}`;
            const total = totals.get(key) ?? { app: v.app, page: v.page, ms: 0, last: 0 };
            total.ms += ms;
            total.last = Math.max(total.last, v.to);
            totals.set(key, total);
        }
        return [...totals.values()].sort((a, b) => b.ms - a.ms);
    }

    // A line for every turn: what else was on screen recently.
    recentScreen(current, minutes = 30) {
        const others = this.visits(this.now().getTime() - minutes * 60_000).filter((v) => !(current && v.app === current.app && v.page === current.page));
        return others.length ? `Also on their screen in the last ${minutes} minutes: ${others.slice(0, 5).map(visitText).join("; ")}.` : "";
    }

    // ---------------------------------------------------------------- reading it back

    // What to tell a new conversation; sessions are recent CLI and App sessions as { at, where, summary }.
    digest({ sessions = [], screen = true } = {}) {
        const now = this.now();
        const lines = [];
        const facts = this.facts().slice(-40);
        if (facts.length) lines.push("Saved memories:", ...facts.map((f) => `- ${f.id} (${f.topic}): ${f.text}`));
        const talks = this.#read("journal", 3).slice(-8);
        if (talks.length) {
            lines.push("Recent conversations with you:");
            for (const t of talks) lines.push(`- ${when(t.at, now)}${turnPlace(t)}: they asked "${clip(t.asked, 140)}"; you said "${clip(t.answered, 180)}"${t.made?.length ? ` (made ${t.made.join(", ")})` : ""}`);
        }
        const day = screen ? this.visits(now.getTime() - DAY).slice(0, 8) : [];
        if (day.length) lines.push(`On their screen in the last day: ${day.map(visitText).join("; ")}.`);
        if (sessions.length) lines.push("Their recent Copilot CLI and App sessions:", ...sessions.slice(0, 6).map((s) => `- ${when(s.at, now)} ${s.where}: ${clip(s.summary, 120)}`));
        return lines.join("\n");
    }

    // Lines matching a query across everything remembered and recent sessions, best and newest first.
    recall({ query = "", days = 30, sessions = [], screen = true } = {}) {
        const now = this.now();
        const since = now.getTime() - days * DAY;
        const words = String(query).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
        const hits = [];
        const consider = (at, text, line) => {
            const lower = text.toLowerCase();
            const score = words.length ? words.filter((w) => lower.includes(w)).length : 1;
            if (score) hits.push({ score, at: new Date(at).getTime() || 0, line });
        };
        for (const f of this.facts()) consider(f.at, `${f.topic} ${f.text}`, `memory ${f.id} (${f.topic}): ${f.text}`);
        for (const t of this.#read("journal", days)) {
            consider(t.at, `${t.app} ${t.page} ${t.asked} ${t.answered}`, `${when(t.at, now)} conversation${turnPlace(t)}: they asked "${clip(t.asked, 160)}"; you said "${clip(t.answered, 240)}"${t.made?.length ? `; made ${t.made.join(", ")}` : ""}`);
        }
        for (const a of this.#index().filter((a) => Date.parse(a.at) >= since)) {
            consider(a.at, `${a.title} ${a.tool} ${a.page?.app ?? ""} ${a.page?.page ?? ""}`, `${when(a.at, now)} visual ${a.id} (${a.tool === "live_explain" ? "explanation" : "panel"}): "${a.title}"`);
        }
        for (const v of screen ? this.visits(since) : []) consider(v.last, `${v.app} ${v.page}`, `on screen ${when(v.last, now)}: ${visitText(v)}`);
        for (const s of sessions) consider(s.at, `${s.where} ${s.summary}`, `${when(s.at, now)} Copilot session ${s.where}: ${clip(s.summary, 160)}`);
        hits.sort((a, b) => b.score - a.score || b.at - a.at);
        return hits.slice(0, 15).map((hit) => hit.line);
    }
}
