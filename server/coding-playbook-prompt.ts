import type { RunContractInput } from "./run-contract.ts";

export function codingPlaybookPrompt(contract: RunContractInput, remainingUsd?: number): string {
  const wallTime = contract.limits?.maxWallTimeMs;
  if (!contract.successCriteria.length || contract.successCriteria.some((item) => !item.trim()) ||
    !wallTime || !Number.isFinite(wallTime) || wallTime <= 0 ||
    (contract.limits?.modelAccess !== "subscription" && contract.limits?.modelAccess !== "local" &&
      (remainingUsd === undefined || !Number.isFinite(remainingUsd) || remainingUsd <= 0))) {
    throw new Error("coding playbook requires an approved check and finite positive budget");
  }
  return [
    "/skill:poteto-mode-pi",
    "Use the Autonomous run playbook for one bounded unit. Do not assume a loop command is available.",
    `Goal: ${contract.successCriteria.join("; ")}`,
    `Approved check: ${contract.successCriteria.join("; ")}`,
    `Budget: at most ${wallTime} ms${remainingUsd === undefined ? "" : ` and $${remainingUsd} remaining`}. Stop at the first limit.`,
    "Record the real check and evidence; stop on verification, safety failure, dead end or budget. Preserve uncertain effects for review.",
  ].join("\n");
}
