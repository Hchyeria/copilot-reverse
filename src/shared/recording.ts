// Recording is worker-local and never resumes automatically after a restart.
export type RecordingMode = "error" | "full";
export interface RecordingStatus {
  active: boolean;
  mode?: RecordingMode;
  directory?: string;
  requests: number;
  inFlight: number;
  warning?: string;
}
export type RecordingAction = "start" | "end" | "status";
