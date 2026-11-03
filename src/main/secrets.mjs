import fs from "node:fs";
import path from "node:path";

// API keys, encrypted with a key macOS keeps in the Keychain (Electron's safeStorage), so none is stored in plain text.
export function createSecrets(dir, crypto) {
    const file = (name) => path.join(dir, `${name}.key`);
    return {
        get(name) {
            try {
                return crypto.decryptString(fs.readFileSync(file(name)));
            } catch {
                return null;
            }
        },
        set(name, value) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            // Written beside the file, then renamed over it, so a crash never leaves half a credential.
            const temp = `${file(name)}.${process.pid}.tmp`;
            fs.writeFileSync(temp, crypto.encryptString(value), { mode: 0o600 });
            fs.renameSync(temp, file(name));
        },
    };
}
