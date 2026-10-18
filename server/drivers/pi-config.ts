export interface PiConfig {
  cli: string;
  /** Full-auto: never ask before an action. Host control is unavailable in this mode. */
  fullAuto: boolean;
  agentDir?: string;
}

export function decodePiConfig(raw: unknown): PiConfig {
  if (raw === null || raw === undefined) return { cli: "pi", fullAuto: false };
  if (typeof raw !== "object") throw new Error("pi config must be an object");
  const obj = raw as { cli?: unknown; fullAuto?: unknown; agentDir?: unknown };
  if (obj.cli !== undefined && typeof obj.cli !== "string") throw new Error("pi config `cli` must be a string");
  if (obj.fullAuto !== undefined && typeof obj.fullAuto !== "boolean") throw new Error("pi config `fullAuto` must be a boolean");
  if (obj.agentDir !== undefined && (typeof obj.agentDir !== "string" || !obj.agentDir.trim() || !obj.agentDir.startsWith("/"))) throw new Error("pi config `agentDir` must be an absolute directory");
  return {
    cli: obj.cli && obj.cli.trim() ? obj.cli.trim() : "pi",
    fullAuto: obj.fullAuto === true,
    ...(obj.agentDir ? { agentDir: obj.agentDir as string } : {}),
  };
}
