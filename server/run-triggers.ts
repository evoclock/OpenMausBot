import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { runContractSchema, type RunContract, type RunContractInput, type RunSnapshot } from "./run-contract.ts";

const eventSchema = z.object({
  action: z.string().optional(),
  repository: z.object({ full_name: z.string() }),
}).passthrough();

export interface RunStartPort {
  start(contract: RunContract): Promise<unknown>;
  get(id: string): RunSnapshot | undefined;
}

export type TriggerTemplate = Omit<RunContractInput, "id">;

function triggerId(source: string): string {
  const hex = createHash("sha256").update(source).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function agentTemplate(template: TriggerTemplate): TriggerTemplate {
  if (template.repositoryClass !== "agent-private" || (template.authorisedExternalWrites ?? []).length > 0) {
    throw new Error("unattended trigger requires a private agent repository with no external write authorisation");
  }
  runContractSchema.parse({ ...template, id: triggerId("template") });
  return template;
}

async function startOnce(port: RunStartPort, source: string, template: TriggerTemplate) {
  const contract = runContractSchema.parse({ ...agentTemplate(template), id: triggerId(source) });
  if (port.get(contract.id)) return { status: "existing" as const, id: contract.id };
  try {
    await port.start(contract);
  } catch (error) {
    if (!port.get(contract.id)) throw error;
    return { status: "existing" as const, id: contract.id };
  }
  return { status: "accepted" as const, id: contract.id };
}

export function startScheduledCodingRun(port: RunStartPort, routine: {
  id: string; routineId: string; botId: string; scheduledFor: number; triggerSource?: string; status: string;
}, template: TriggerTemplate) {
  if (routine.triggerSource !== "schedule" || routine.status !== "running" || routine.botId !== template.botId) {
    return Promise.resolve({ status: "ignored" as const });
  }
  return startOnce(port, `routine:${routine.routineId}:${routine.id}:${routine.scheduledFor}`, template);
}

export async function startGithubCodingRun(port: RunStartPort, input: {
  raw: Buffer;
  signature: string;
  secret: string;
  deliveryId: string;
  event: string;
}, template: TriggerTemplate) {
  if (!input.secret || input.raw.length > 256 * 1024 || !/^sha256=[a-f0-9]{64}$/.test(input.signature) ||
    !/^[a-f0-9-]{36}$/i.test(input.deliveryId)) {
    throw new Error("invalid GitHub webhook authentication");
  }
  const expected = createHmac("sha256", input.secret).update(input.raw).digest();
  const provided = Buffer.from(input.signature.slice(7), "hex");
  if (!timingSafeEqual(expected, provided)) throw new Error("invalid GitHub webhook authentication");
  const payload = eventSchema.parse(JSON.parse(input.raw.toString("utf8")));
  const actions: Record<string, readonly string[]> = {
    pull_request: ["opened", "reopened", "synchronize", "ready_for_review"],
    check_run: ["completed"], workflow_run: ["completed"],
  };
  if (payload.repository.full_name !== template.repository ||
    !Object.hasOwn(actions, input.event) || !actions[input.event]!.includes(payload.action ?? "")) {
    return { status: "ignored" as const };
  }
  return startOnce(port, `github:${input.deliveryId}`, template);
}
