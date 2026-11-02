// Maps app://live URL paths to files on disk, refusing anything outside the allowed directories.
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const ROUTES = [
    ["/overlay/", "src/overlay"],
    ["/shared/", "src/shared"],
    ["/vendor/marked/", "node_modules/marked/lib"],
    ["/vendor/dompurify/", "node_modules/dompurify/dist"],
    ["/vendor/mermaid/", "node_modules/mermaid/dist"],
    ["/vendor/rough/", "node_modules/roughjs/bundled"],
    ["/vendor/katex/", "node_modules/katex/dist"],
    ["/vendor/d3/", "node_modules/d3/dist"],
    ["/vendor/three/addons/", "node_modules/three/examples/jsm"],
    ["/vendor/three/", "node_modules/three/build"],
    ["/vendor/three-mesh-bvh/", "node_modules/three-mesh-bvh/build"],
    ["/vendor/three-bvh-csg/", "node_modules/three-bvh-csg/build"],
].map(([prefix, dir]) => [prefix, path.join(root, dir)]);

export function resolveAppPath(pathname) {
    for (const [prefix, dir] of ROUTES) {
        if (!pathname.startsWith(prefix)) continue;
        let relative;
        try {
            relative = decodeURIComponent(pathname.slice(prefix.length));
        } catch {
            return null;
        }
        const file = path.normalize(path.join(dir, relative));
        return file.startsWith(dir + path.sep) ? file : null;
    }
    return null;
}
