import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess, ExecFileException } from "node:child_process";
import {
  GH_INSTALL_MESSAGE,
  createGhAuth,
  type GhProcessFunctions,
} from "../../src/cli/gh-auth.js";

function processHarness(options: {
  stdout?: string;
  execError?: ExecFileException | null;
  spawnError?: NodeJS.ErrnoException;
  exitCode?: number;
} = {}) {
  const execFile = vi.fn((
    _file: string,
    _args: readonly string[],
    _options: object,
    callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
  ) => {
    queueMicrotask(() => callback(options.execError ?? null, options.stdout ?? "", ""));
    return {} as ChildProcess;
  });
  const spawn = vi.fn(() => {
    const child = new EventEmitter();
    queueMicrotask(() => {
      if (options.spawnError) child.emit("error", options.spawnError);
      else child.emit("exit", options.exitCode ?? 0, null);
    });
    return child as ChildProcess;
  });
  return {
    processes: { execFile, spawn } as unknown as GhProcessFunctions,
    execFile,
    spawn,
  };
}

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
}

describe("production GitHub CLI adapter", () => {
  it("runs interactive login with exact argv, no shell, and inherited stdio", async () => {
    const harness = processHarness();
    const gh = createGhAuth(harness.processes);

    await gh.login("acme.ghe.com");

    expect(harness.spawn).toHaveBeenCalledWith(
      "gh",
      ["auth", "login", "--hostname", "acme.ghe.com"],
      { shell: false, stdio: "inherit" },
    );
  });

  it("captures and trims token output with exact argv and no shell", async () => {
    const harness = processHarness({ stdout: `enterprise-secret-token${String.fromCharCode(13)}${String.fromCharCode(10)}` });
    const gh = createGhAuth(harness.processes);

    await expect(gh.token("acme.ghe.com")).resolves.toBe("enterprise-secret-token");
    expect(harness.execFile).toHaveBeenCalledWith(
      "gh",
      ["auth", "token", "--hostname", "acme.ghe.com"],
      { shell: false, encoding: "utf8" },
      expect.any(Function),
    );
  });

  it("checks availability through gh --version", async () => {
    const harness = processHarness({ stdout: `gh version 2.80.0${String.fromCharCode(10)}` });
    const gh = createGhAuth(harness.processes);

    await expect(gh.isAvailable()).resolves.toBe(true);
    expect(harness.execFile).toHaveBeenCalledWith(
      "gh",
      ["--version"],
      { shell: false, encoding: "utf8" },
      expect.any(Function),
    );
  });

  it("returns unavailable for an ENOENT version check", async () => {
    const harness = processHarness({ execError: enoent() as ExecFileException });
    await expect(createGhAuth(harness.processes).isAvailable()).resolves.toBe(false);
  });

  it.each(["login", "token"] as const)("maps ENOENT from %s to the install message", async (operation) => {
    const harness = operation === "login"
      ? processHarness({ spawnError: enoent() })
      : processHarness({ execError: enoent() as ExecFileException });
    const gh = createGhAuth(harness.processes);

    const result = operation === "login" ? gh.login("acme.ghe.com") : gh.token("acme.ghe.com");
    await expect(result).rejects.toThrow(GH_INSTALL_MESSAGE);
  });
});
