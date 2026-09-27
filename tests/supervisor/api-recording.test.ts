import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createControlApp, type ControlDeps } from "../../src/supervisor/api.js";
import { openDb, type Db } from "../../src/supervisor/db.js";
import type { RecordingStatus } from "../../src/shared/recording.js";

const databases: Db[] = [];
afterEach(() => { databases.splice(0).forEach((db) => db.close()); });
function fixture(recording: Partial<ControlDeps> = {}) {
  const db = openDb(":memory:"); databases.push(db);
  return createControlApp({
    db, getState: () => "ready", restart: () => {}, stop: () => {}, start: () => {},
    doctor: async () => [], github: () => undefined, models: async () => [],
    clients: () => ({ claude: { user: false, project: false }, codex: { user: false, project: false }, pi: { user: false, project: false } }),
    subscribe: () => () => {}, ...recording,
  });
}
const active: RecordingStatus = { active: true, directory: "/private/session", requests: 3, inFlight: 2 };

describe("recording control API", () => {
  it("returns worker status directly from start/end and exposes the snapshot via /api/status", async () => {
    let status = active;
    const recording = vi.fn(async (action) => { status = { ...status, active: action === "start" }; return status; });
    const app = fixture({ recording, recordingStatus: () => status });
    expect((await request(app).post("/api/recording/start").expect(200)).body).toEqual(active);
    expect((await request(app).get("/api/status")).body.recording).toEqual(active);
    const end = (await request(app).post("/api/recording/end").expect(200)).body;
    expect(end).toEqual({ ...active, active: false }); // enrollment stopped, still draining
    expect(recording.mock.calls.map(([action]) => action)).toEqual(["start", "end"]);
  });
  it("omits recording for older deps and explicitly rejects unsupported commands", async () => {
    const app = fixture();
    expect((await request(app).get("/api/status")).body.recording).toBeUndefined();
    for (const action of ["start", "end"]) {
      expect((await request(app).post(`/api/recording/${action}`).expect(503)).body.error).toMatch(/unavailable/i);
    }
    await request(app).get("/api/recording/start").expect(404);
  });
  it.each(["worker not ready", "worker restarting", "timed out after 5s", "disk full"])("surfaces %s as a non-success response", async (error) => {
    const app = fixture({ recording: async () => { throw new Error(error); } });
    const res = await request(app).post("/api/recording/start").expect(503);
    expect(res.body).toEqual({ error });
  });
  it("surfaces partial capture warnings without falsely failing a successful end", async () => {
    const status = { ...active, active: false, warning: "incomplete: disk full" };
    const app = fixture({ recording: async () => status, recordingStatus: () => status });
    expect((await request(app).post("/api/recording/end").expect(200)).body).toEqual(status);
    expect((await request(app).get("/api/status")).body.recording).toEqual(status);
  });
});
