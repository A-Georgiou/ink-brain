// Minimal, allow-listed bridge between the overlay page and the main process.
const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = new Set([
    "live:state",
    "live:call",
    "live:transcript",
    "live:level",
    "live:turn",
    "live:activity",
    "live:toast",
    "live:setup",
    "live:flash",
    "live:approval",
    "live:explain",
    "live:control",
    "live:web",
    "live:windows",
]);

contextBridge.exposeInMainWorld("live", {
    on(channel, listener) {
        if (!CHANNELS.has(channel)) throw new Error(`Unknown channel: ${channel}`);
        const handler = (_event, payload) => listener(payload);
        ipcRenderer.on(channel, handler);
        return () => ipcRenderer.removeListener(channel, handler);
    },
    ready: () => ipcRenderer.send("live:ready"),
    submit: (turn) => ipcRenderer.send("live:submit", turn),
    setPen: (on) => ipcRenderer.send("live:pen", Boolean(on)),
    setInteractive: (on) => ipcRenderer.send("live:interactive", Boolean(on)),
    command: (name, value) => ipcRenderer.send("live:command", { name: String(name), value }),
    respond: (id, ok, payload) =>
        ipcRenderer.send("live:call-result", ok ? { id, ok: true, result: payload } : { id, ok: false, error: String(payload) }),
});
