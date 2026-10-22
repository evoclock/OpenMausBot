import type { ProviderAdapter } from "./contracts.ts";
import { supportsWorkspaceFiles } from "./workspace.ts";

type Engine = { driverKind: string; capabilities: ProviderAdapter["capabilities"] };

export function codingRecoveryAllowlist(taskTitle: string,
  allowed?: Array<{ instanceId: string; model: string }>): Array<{ instanceId: string; model: string }> | undefined {
  return allowed ?? (/^Coding [a-f0-9]{64}$/.test(taskTitle) ? [] : undefined);
}

export function allowedCodingRecovery(selection: { instanceId: string; model: string },
  allowed?: readonly { instanceId: string; model: string }[]): boolean {
  return allowed === undefined || allowed.some((item) =>
    item.instanceId === selection.instanceId && item.model === selection.model);
}

/** An automatic switch must not strand the task without its tools or move its filesystem to another machine. */
export function recoveryCapabilityError(from: Engine, to: Engine): string | undefined {
  if (supportsWorkspaceFiles(from.driverKind) !== supportsWorkspaceFiles(to.driverKind)) {
    return "The backup cannot use the same workspace.";
  }
  const tools = ["agentsMcp", "computerMcp", "composioMcp", "dataMcp", "highlevelMcp",
    "phoneMcp", "browserMcp", "localComputerMcp", "customMcp", "images"] as const;
  if (tools.some(key => from.capabilities[key] === true && to.capabilities[key] !== true)) {
    return "The backup does not support all of this engine's tools and attachments.";
  }
}
