import type { EngineAccess, ProviderAdapter } from "./contracts.ts";
import { supportsWorkspaceFiles } from "./workspace.ts";

type Engine = { driverKind: string; capabilities: ProviderAdapter["capabilities"] };

export function codingRecoveryAllowlist(taskTitle: string,
  allowed?: Array<{ instanceId: string; model: string }>): Array<{ instanceId: string; model: string }> | undefined {
  return allowed ?? (/^Coding [a-f0-9]{64}$/.test(taskTitle) ? [] : undefined);
}

export const DEFAULT_CODING_LOCAL_PROVIDERS = ["dsf41"] as const;

export function codingModelChain(instances: readonly {
  instanceId: string; driverKind: string; enabled: boolean; access?: EngineAccess;
  models: { options: readonly { id: string }[] };
}[], localProviders: readonly string[]): Array<{ instanceId: string; model: string; modelAccess: "subscription" | "local" }> {
  const offered = instances.filter((instance) => instance.driverKind === "piAgent" && instance.enabled &&
    instance.access !== "api").flatMap((instance) => instance.models.options.map((option) => ({
      instanceId: instance.instanceId, model: option.id, access: instance.access,
    })));
  const primary = offered.filter((item) => item.model === "openai-codex/gpt-6-luna" && item.access === "custom")
    .map(({ instanceId, model }) => ({ instanceId, model, modelAccess: "subscription" as const }));
  const local = offered.filter((item) => {
    const provider = item.model.split("/", 1)[0];
    return item.access === "custom" && provider !== "merge-gateway" && provider !== "openai-codex" &&
      localProviders.includes(provider!) && item.model.includes("/");
  }).sort((a, b) => Number(b.model === "dsf41/deepseek-v4.1-flash-tf") - Number(a.model === "dsf41/deepseek-v4.1-flash-tf"))
    .map(({ instanceId, model }) => ({ instanceId, model, modelAccess: "local" as const }));
  return [...primary, ...local];
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
