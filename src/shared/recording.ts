// Recording is worker-local and never resumes automatically after a restart.
export interface RecordingStatus {
  active: boolean;
  directory?: string;
  requests: number;
  inFlight: number;
  warning?: string;
}
export type RecordingAction = "start" | "end" | "status";
