// Drives a running overlay from the terminal for development (start the app with INK_BRAIN_DEBUG=1).
import fs from "node:fs";
import net from "node:net";
import { SOCKET_PATH } from "../src/main/config.mjs";
import { RpcPeer } from "../src/shared/rpc.mjs";

// Usage: node scripts/debug.mjs <state|snapshot [file]|tool <name> <json> [image file]|turn <text> [marks json]|pen <on|off>|reload|approve [once|always|deny]|target <id>|say <text>|volume <0-1>|windows <json|live>|command <name>|memory>
const [action = "state", ...rest] = process.argv.slice(2);
const socket = net.connect(SOCKET_PATH);
await new Promise((resolve, reject) => socket.once("connect", resolve).once("error", reject));
const rpc = new RpcPeer(socket);
await rpc.request("hello", { label: "Debug client", cwd: process.cwd(), pid: process.pid, debug: true });

const request = (params) => rpc.request("debug", params, { timeoutMs: 180_000 });
try {
    if (action === "snapshot") {
        const shot = await request({ action: "snapshot" });
        const file = rest[0] ?? "overlay-snapshot.jpg";
        fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
        console.log(`Saved ${shot.width}x${shot.height} snapshot to ${file}`);
    } else if (action === "tool") {
        const result = await request({ action: "tool", name: rest[0], args: JSON.parse(rest[1] ?? "{}") });
        for (const [index, image] of (rest[2] ? result.images ?? [] : []).entries()) {
            const file = index ? rest[2].replace(/(\.\w+)?$/, `-${index + 1}$1`) : rest[2];
            fs.writeFileSync(file, Buffer.from(image.data, "base64"));
            console.log(`Saved image ${index + 1} to ${file}`);
        }
        console.log(JSON.stringify({ ...result, images: result.images?.map((image) => `${image.mimeType}, ${image.data.length} base64 chars`) }, null, 2));
    } else if (action === "turn") {
        const marks = rest.at(-1)?.startsWith("[") ? JSON.parse(rest.pop()) : [];
        console.log(JSON.stringify(await request({ action: "turn", text: rest.join(" "), marks }), null, 2));
    } else if (action === "pen") {
        console.log(JSON.stringify(await request({ action: "pen", on: rest[0] !== "off" })));
    } else if (action === "reload" || action === "approve") {
        console.log(JSON.stringify(await request({ action, decision: rest[0] })));
    } else if (action === "say") {
        console.log(JSON.stringify(await request({ action, text: rest.join(" ") })));
    } else if (action === "windows") {
        console.log(JSON.stringify(await request({ action, windows: rest[0] === "live" ? null : JSON.parse(rest[0] ?? "null") })));
    } else if (action === "command") {
        console.log(JSON.stringify(await request({ action, name: rest[0] })));
    } else if (action === "volume") {
        console.log(JSON.stringify(await request({ action, volume: Number(rest[0]) })));
    } else if (action === "memory") {
        console.log(JSON.stringify(await request({ action }), null, 2));
    } else if (action === "target") {
        console.log(JSON.stringify(await request({ action, id: rest[0] })));
    } else {
        console.log(JSON.stringify(await request({ action: "state" }), null, 2));
    }
} finally {
    rpc.close();
}
