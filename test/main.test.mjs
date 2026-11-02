import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAppPath } from "../src/main/routes.mjs";
import { siteAllowed, siteOf } from "../src/main/reader.mjs";

test("app:// paths cannot escape the served folders", () => {
    assert.match(resolveAppPath("/overlay/index.html"), /src\/overlay\/index\.html$/);
    assert.match(resolveAppPath("/vendor/three/addons/controls/OrbitControls.js"), /three\/examples\/jsm\/controls\/OrbitControls\.js$/);
    assert.equal(resolveAppPath("/overlay/../../package.json"), null);
    assert.equal(resolveAppPath("/vendor/marked/%2e%2e/%2e%2e/%2e%2e/package.json"), null);
    assert.equal(resolveAppPath("/etc/passwd"), null);
});

test("Copilot only reads allowed sites over http(s)", () => {
    assert.equal(siteOf("https://www.bbc.co.uk/news"), "bbc.co.uk");
    for (const url of ["https://www.reddit.com/r/a/comments/1", "http://old.reddit.com/"]) assert.ok(siteAllowed(url, ["reddit.com"]), url);
    for (const url of ["https://notreddit.com/", "https://reddit.com.evil.io/", "file:///etc/passwd", "javascript:alert(1)", "reddit.com"]) assert.ok(!siteAllowed(url, ["reddit.com"]), url);
});
