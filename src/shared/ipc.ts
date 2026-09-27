import type { RecordingAction, RecordingStatus } from "./recording.js";

export type WorkerToSupervisor =
  | { type: "ready"; port: number }
  | { type: "heartbeat"; ts: number }
  | { type: "request-metric"; endpoint: string; model: string; status: number; latencyMs: number; tokensIn?: number; tokensOut?: number; error?: string }
  | { type: "error"; message: string; stack?: string }
  | { type: "recording-reply"; id: string; status?: RecordingStatus; error?: string }
  | { type: "recording-status"; status: RecordingStatus };
export type SupervisorToWorker =
  | { type: "ping" }
  | { type: "shutdown" }
  | { type: "recording-command"; id: string; action: RecordingAction };
