// Real worker process + real supervisor monitor/control routes. No live Copilot:
// only count_tokens and malformed JSON, and boot-time fetch is disabled by preload.
import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import request from "supertest";
import { WorkerMonitor } from "../../src/supervisor/monitor.js";
import { createControlApp } from "../../src/supervisor/api.js";
import { defaultConfig } from "../../src/shared/config.js";
import { openDb } from "../../src/supervisor/db.js";

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r())); return port;
}
async function until(test: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await test()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error("worker recording condition timed out");
}

it("controls real worker recording over IPC and HTTP without touching the user's daemon", async () => {
  const home = await mkdtemp(join(tmpdir(), "recording-e2e-"));
  const db = openDb(":memory:");
  const old = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, NODE_OPTIONS: process.env.NODE_OPTIONS };
  let monitor: WorkerMonitor | undefined;
  try {
    const data = join(home, ".copilot-reverse"); await mkdir(data);
    await writeFile(join(data, "creds.json"), JSON.stringify({ ghToken: "dummy-no-network" }));
    const entry = join(home, "offline-worker.mjs");
    await writeFile(entry, `globalThis.fetch = async () => { throw new Error('offline test'); };\nconst { register } = await import(${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href)});\nregister();\nawait import(${JSON.stringify(pathToFileURL(resolve("src/worker/index.ts")).href)});\n`);
    process.env.HOME = process.env.USERPROFILE = home;
    const workerPort = await freePort();
    monitor = new WorkerMonitor({ ...defaultConfig(), workerPort }, entry, {
      onStateChange: () => {}, onCrash: () => {}, onWorkerMessage: () => {},
    });
    monitor.start(); await until(() => monitor!.currentState() === "ready");
    const app = createControlApp({
      db, getState: () => monitor!.currentState(), start: () => monitor!.start(), stop: () => monitor!.stop(), restart: () => monitor!.restartManually(),
      doctor: async () => [], github: () => undefined, models: async () => [], subscribe: () => () => {},
      clients: () => ({ claude: { user: false, project: false }, codex: { user: false, project: false }, pi: { user: false, project: false } }),
      recording: (action) => monitor!.recording(action), recordingStatus: () => monitor!.recordingStatus(),
    });
    expect((await request(app).get("/api/status")).body.recording.active).toBe(false);
    const session = (await request(app).post("/api/recording/start").expect(200)).body;
    expect(session.active).toBe(true);
    const base = `http://127.0.0.1:${workerPort}`;
    const body = '{ "model":"gpt-test", "messages":[{"role":"user","content":"你好"}] }';
    expect((await fetch(base + "/anthropic/v1/messages/count_tokens", { method: "POST", headers: { "content-type": "application/json" }, body })).status).toBe(200);
    expect((await fetch(base + "/openai/responses", { method: "POST", headers: { "content-type": "application/json" }, body: "{bad" })).status).toBe(400);
    await until(() => monitor!.recordingStatus().requests === 2 && monitor!.recordingStatus().inFlight === 0);
    const dirs = (await readdir(session.directory, { withFileTypes: true })).filter((d) => d.isDirectory());
    expect(dirs).toHaveLength(2);
    const bodies = await Promise.all(dirs.map((d) => readFile(join(session.directory, d.name, "inbound.json"), "utf8")));
    expect(bodies).toContain(body); expect(bodies).toContain("{bad");
    expect((await request(app).post("/api/recording/end").expect(200)).body.active).toBe(false);
    await request(app).post("/api/recording/start").expect(200);
    monitor.restartManually(); await until(() => monitor!.currentState() === "ready");
    expect(monitor.recordingStatus().active).toBe(false);
  } finally {
    monitor?.stop();
    await new Promise((r) => setTimeout(r, 150));
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    db.close(); await rm(home, { recursive: true, force: true });
  }
}, 10000);
