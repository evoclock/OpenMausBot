import { t } from "@/lib/i18n";
import type { ServerFrame } from "../../shared/wire";

export type ComputerStart = Pick<Extract<ServerFrame, { kind: "computer" }>, "state" | "place">;

export function computerStartLine(start: ComputerStart | undefined, name: string): string | null {
  if (!start) return null;
  if (start.place !== "cloud") return t("chat.provisioning");
  return t(start.state === "waking" ? "chat.computerWaking" : "chat.computerStarting", { name });
}
