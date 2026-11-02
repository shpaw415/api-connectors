/** Isolated security regression: never uses the installed config, vault or server.
 * Run: bun scripts/security-test.ts
 * Tests source and flattened release layouts, with synthetic HOME and CLI stub.
 */
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dir, "..");
const temp = await mkdtemp("/tmp/opencode/api-connectors-security-");
const bun = process.execPath;
let checks = 0;
try {
  const source = await readFile(join(root, "files/server.ts"), "utf8");
  const core = await readFile(join(root, "files/core.js"), "utf8");
  for (const layout of ["source", "frozen"]) {
    const dir = join(temp, layout);
    const home = join(dir, "home");
    const bin = join(dir, "bin");
    await mkdir(join(home, ".config/open-bot"), { recursive: true });
    await mkdir(bin);
    const marker = join(dir, "cli-called");
    await writeFile(join(bin, "ob-plugin"), `#!${bun}\nawait Bun.write(${JSON.stringify(marker)}, "unexpected mutation"); process.exit(99);\n`);
    await chmod(join(bin, "ob-plugin"), 0o700);
    await writeFile(join(home, ".config/open-bot/plugin-api-connectors.json"), JSON.stringify({ settings: { enabled: "true" }, vault: {} }));
    const coreName = layout === "source" ? "core.js" : "ob-plugin-api-connectors-core.js";
    await writeFile(join(dir, coreName), core);
    // Only redirect the installed absolute core import into the disposable layout.
    assert(source.includes('"/usr/local/bin/ob-plugin-api-connectors-core.js"'));
    const entry = join(dir, "server.ts");
    await writeFile(entry, source.replace('"/usr/local/bin/ob-plugin-api-connectors-core.js"', JSON.stringify(`./${coreName}`)));
    for (const name of ["index.html", "app.ts", "styles.css"]) {
      await writeFile(join(dir, name), await readFile(join(root, "files", name)));
    }
    const ui = join(dir, "frozen.html");
    if (layout === "frozen") {
      const built = Bun.spawnSync([bun, "build", "--compile", "--target=browser", join(dir, "index.html"), "--outfile", ui]);
      assert.equal(built.exitCode, 0, built.stderr.toString());
      assert((await readFile(ui, "utf8")).includes("<html"), "compiled UI must be HTML");
    }
    for (const token of [undefined, "", "synthetic-security-token"]) {
      // Reserve an available port, then hand it to the short-lived child.
      const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
      const port = reservation.port!;
      await reservation.stop(true);
      const env: Record<string, string> = { HOME: home, PATH: bin, OPEN_BOT_PAGE_PORT: String(port) };
      if (token !== undefined) env.OPEN_BOT_PAGE_TOKEN = token;
      if (layout === "frozen") env.OPEN_BOT_PAGE_UI = ui;
      const proc = Bun.spawn([bun, "--hot", entry], { env, stdout: "ignore", stderr: "pipe" });
      const base = `http://127.0.0.1:${port}`;
      try {
        let ready = false;
        for (let n = 0; n < 100; n++) {
          try { ready = (await fetch(base + "/healthz")).ok; } catch {}
          if (ready || proc.exitCode !== null) break;
          await Bun.sleep(40);
        }
        assert(ready, "isolated server did not become ready");
        assert((await (await fetch(base + "/")).text()).includes("Connexions API")); checks++;
        const headersToReject = [{}, { "x-open-bot-page-token": "wrong" }, { "x-open-bot-page-token": "dev-preview" }];
        for (const headers of headersToReject) {
          for (const [path, method, body] of [
            ["/api/status", "GET", undefined],
            ["/api/settings", "POST", '{"enabled":"false"}'],
            ["/api/save", "POST", '{"provider":"github","value":"synthetic"}'],
            ["/api/oauth/start", "POST", '{"provider":"google"}'],
          ] as const) {
            const res = await fetch(base + path, { method, body, headers });
            assert.equal(res.status, 401, `${layout}, token=${token ? "set" : "absent"}, ${method} ${path}, header=${JSON.stringify(headers)}`); checks++;
          }
        }
        if (token) {
          const headers = { "x-open-bot-page-token": token };
          assert.equal((await fetch(base + "/api/status", { headers })).status, 200); checks++;
          const payload = '<img src=x onerror=alert(1)>&"\'';
          const response = await fetch(base + "/oauth/google/callback?error=" + encodeURIComponent(payload), { headers });
          const text = await response.text();
          assert(!text.includes(payload));
          assert(text.includes("&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;"));
          assert.equal(response.headers.get("cache-control"), "no-store"); checks += 3;
          if (layout === "frozen") {
            for (const script of ["uitest.ts", "contrast-check.ts"]) {
              const uiRun = Bun.spawn([bun, join(root, "scripts", script)], {
                env: { HOME: home, PATH: bin, UI_PORT: String(port), PAGE_TOKEN: token, FROZEN_PAGE: "1" },
                stdout: "inherit", stderr: "inherit",
              });
              assert.equal(await uiRun.exited, 0, `frozen regression: ${script}`); checks++;
            }
          }
        }
        assert(!(await Bun.file(marker).exists()), "no test may invoke a real or stub mutation CLI"); checks++;
        console.log(`PASS ${layout}: token ${token === undefined ? "unset" : token === "" ? "empty" : "set"}`);
      } finally {
        proc.kill();
        await proc.exited;
      }
    }
  }
  console.log(`PASS: ${checks} isolated security assertions`);
} finally {
  assert(temp.startsWith("/tmp/opencode/api-connectors-security-"));
  await rm(temp, { recursive: true, force: true });
}
