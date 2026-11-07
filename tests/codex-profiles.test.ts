import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codexEnv, listCodexProfiles, validCodexHome } from "../src/adapters/codex-profiles.js";
import { codexEndpointProblem } from "../src/adapters/provider-health.js";
import { cleanAgent } from "../src/core/agent-settings.js";
import { validate, type Config } from "../src/core/config.js";

test("Codex profiles are folders with credentials or config, sorted naturally", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-profiles-"));
  try {
    for (const name of ["codex10", "codex2", "empty", "codex1"]) mkdirSync(join(root, name));
    writeFileSync(join(root, "codex1", "auth.json"), "{}");
    writeFileSync(join(root, "codex2", "config.toml"), "");
    writeFileSync(join(root, "codex10", "auth.json"), "{}");
    writeFileSync(join(root, "not-a-dir"), "");
    assert.deepEqual(listCodexProfiles(root).map((profile) => profile.name), ["codex1", "codex2", "codex10"]);
    assert.deepEqual(listCodexProfiles(join(root, "missing")), []);
    assert.equal(codexEnv(join(root, "codex1"))?.CODEX_HOME, join(root, "codex1"));
    assert.equal(codexEnv(undefined), undefined);
    assert.throws(() => codexEnv(join(root, "gone")), /bulunamadı/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("codexHome is accepted only as an absolute path on Codex agents and survives cleaning", () => {
  const home = join(tmpdir(), "codex1");
  const config = (agent: Record<string, unknown>): Config => ({ projectId: "p", repoPath: ".", agents: [agent as never], tasks: [] });
  assert.doesNotThrow(() => validate(config({ id: "c", provider: "codex", transport: "app-server", codexHome: home })));
  assert.throws(() => validate(config({ id: "c", provider: "claude", codexHome: home })), /Geçersiz/);
  assert.throws(() => validate(config({ id: "c", provider: "codex", codexHome: "relative/codex1" })), /Geçersiz/);
  assert.equal(validCodexHome(`${home}\n`), false);
  assert.equal(cleanAgent({ id: "c", provider: "codex", codexHome: home }).codexHome, home);
  assert.equal("codexHome" in cleanAgent({ id: "c", provider: "codex" }), false);
});

test("a loopback openai_base_url is reported only when nothing listens there", async () => {
  const home = mkdtempSync(join(tmpdir(), "mesh-codex-home-"));
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const open = (server.address() as { port: number }).port;
  try {
    assert.equal(await codexEndpointProblem(home), undefined, "no config");
    writeFileSync(join(home, "config.toml"), `model = "x"\nopenai_base_url = "http://127.0.0.1:${open}/v1"\n[projects.'x']\n`);
    assert.equal(await codexEndpointProblem(home), undefined, "bridge running");
    server.close();
    await new Promise((resolve) => server.once("close", resolve));
    assert.match((await codexEndpointProblem(home))!, /çalışan bir şey yok/);
    writeFileSync(join(home, "config.toml"), `[section]\nopenai_base_url = "http://127.0.0.1:${open}/v1"\n`);
    assert.equal(await codexEndpointProblem(home), undefined, "only top-level keys apply");
    writeFileSync(join(home, "config.toml"), `openai_base_url = "https://example.com/v1"\n`);
    assert.equal(await codexEndpointProblem(home), undefined, "remote endpoints are not probed");
  } finally { server.close(); rmSync(home, { recursive: true, force: true }); }
});
