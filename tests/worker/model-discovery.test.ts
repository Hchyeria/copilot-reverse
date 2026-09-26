import { describe, expect, it } from "vitest";
import { discoveryBeforeReady } from "../../src/worker/model-discovery.js";
import { CopilotEndpointContractError } from "../../src/providers/copilot/token.js";

const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

describe("worker model discovery readiness", () => {
  it("waits for discovery before declaring a map-enabled worker ready", async () => {
    const gate = deferred();
    let ready = false;
    const waiting = discoveryBeforeReady(true, () => gate.promise).then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    gate.release();
    await waiting;
    expect(ready).toBe(true);
  });

  it("waits for discovery before readiness even when the map is disabled", async () => {
    const gate = deferred();
    let ready = false;
    const waiting = discoveryBeforeReady(false, () => gate.promise).then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    gate.release();
    await waiting;
    expect(ready).toBe(true);
  });

  it.each([true, false])("blocks readiness on an endpoint contract failure when map enabled=%s", async (enabled) => {
    const error = new CopilotEndpointContractError({ type: "ghecom", host: "acme.ghe.com" });
    await expect(discoveryBeforeReady(enabled, async () => { throw error; })).rejects.toBe(error);
  });

  it("fails open to a ready worker when discovery itself fails", async () => {
    await expect(discoveryBeforeReady(true, async () => { throw new Error("offline"); })).resolves.toBeUndefined();
  });
});
