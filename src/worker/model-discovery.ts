import { CopilotEndpointContractError } from "../providers/copilot/token.js";

// Discovery resolves before readiness so a permanent endpoint-contract failure can stop startup instead of
// advertising a worker that cannot serve requests. Other discovery failures still fail open: the worker
// remains useful with its fallback list, just without live capabilities or synthetic aliases.
export async function discoveryBeforeReady(_enabled: boolean, discover: () => Promise<unknown>): Promise<void> {
  try {
    await discover();
  } catch (error) {
    if (error instanceof CopilotEndpointContractError) throw error;
  }
}
