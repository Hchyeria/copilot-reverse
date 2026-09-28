export interface SlashContext {
  client: {
    status(): Promise<import("../../shared/control-types.js").StatusResponse>;
    restart(): Promise<void>; stop(): Promise<void>; start(): Promise<void>;
    recordStart(mode?: import("../../shared/recording.js").RecordingMode): Promise<import("../../shared/recording.js").RecordingStatus>;
    recordEnd(): Promise<import("../../shared/recording.js").RecordingStatus>;
    doctor(ping?: boolean): Promise<import("../../shared/control-types.js").DoctorCheck[]>;
    requests(): Promise<import("../../shared/control-types.js").MetricSample[]>;
    metrics(): Promise<import("../../shared/control-types.js").MetricsResponse>;
  };
  quit: () => void;
}
export interface SlashCommand {
  name: string;
  describe: string;
  run(args: string[], ctx: SlashContext): Promise<string[]>;
}
export class Registry {
  private cmds = new Map<string, SlashCommand>();
  constructor(private ctx: SlashContext) {}
  add(cmd: SlashCommand): this { this.cmds.set(cmd.name, cmd); return this; }
  list(): SlashCommand[] { return [...this.cmds.values()]; }
  async run(line: string): Promise<string[]> {
    const [name, ...args] = line.trim().split(/\s+/);
    const cmd = this.cmds.get(name);
    if (!cmd) return [`unknown command: ${name} (try /help)`];
    return cmd.run(args, this.ctx);
  }
}
