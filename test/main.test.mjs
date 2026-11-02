import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAppPath } from "../src/main/routes.mjs";

test("app:// paths cannot escape the served folders", () => {
    assert.match(resolveAppPath("/overlay/index.html"), /src\/overlay\/index\.html$/);
    assert.match(resolveAppPath("/vendor/three/addons/controls/OrbitControls.js"), /three\/examples\/jsm\/controls\/OrbitControls\.js$/);
    assert.equal(resolveAppPath("/overlay/../../package.json"), null);
    assert.equal(resolveAppPath("/vendor/marked/%2e%2e/%2e%2e/%2e%2e/package.json"), null);
    assert.equal(resolveAppPath("/etc/passwd"), null);
});
