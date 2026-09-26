import { execFile, spawn } from "node:child_process";

export const GH_INSTALL_MESSAGE = "GitHub CLI is required for GHE.com. Install it from https://cli.github.com/.";

export interface GhAuth {
  isAvailable(): Promise<boolean>;
  login(host: string): Promise<void>;
  token(host: string): Promise<string>;
}

export interface GhProcessFunctions {
  execFile: typeof execFile;
  spawn: typeof spawn;
}

const productionProcesses: GhProcessFunctions = { execFile, spawn };

function executableMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function capturedGh(args: string[], processes: GhProcessFunctions): Promise<string> {
  return new Promise((resolve, reject) => {
    processes.execFile("gh", args, { shell: false, encoding: "utf8" }, (error, stdout) => {
      if (error) {
        reject(executableMissing(error) ? new Error(GH_INSTALL_MESSAGE) : error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function waitForChild(host: string, args: string[], processes: GhProcessFunctions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = processes.spawn("gh", args, { shell: false, stdio: "inherit" });
    let settled = false;
    child.once("error", (error) => {
      settled = true;
      reject(executableMissing(error) ? new Error(GH_INSTALL_MESSAGE) : error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      if (code === 0) resolve();
      else reject(new Error(`GitHub CLI login failed for ${host} (${signal ?? `exit ${code}`}).`));
    });
  });
}

export function createGhAuth(processes: GhProcessFunctions = productionProcesses): GhAuth {
  return {
    async isAvailable(): Promise<boolean> {
      try {
        await capturedGh(["--version"], processes);
        return true;
      } catch (error) {
        if (error instanceof Error && error.message === GH_INSTALL_MESSAGE) return false;
        throw error;
      }
    },

    login(host: string): Promise<void> {
      return waitForChild(host, ["auth", "login", "--hostname", host], processes);
    },

    token(host: string): Promise<string> {
      return capturedGh(["auth", "token", "--hostname", host], processes);
    },
  };
}

export const ghAuth: GhAuth = createGhAuth();
