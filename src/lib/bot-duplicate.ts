// A copy's restrictions go in the request that creates it: a later patch that failed would leave it unrestricted.
import { helperModelAllowed } from "../../shared/wire";
import type { Bot } from "@/state/store";

export type RestrictedSource = Pick<Bot, "visibility" | "toolScope" | "helperModel">;

export interface RestrictedCopyRequest {
  visibility?: Bot["visibility"];
  settings?: { toolScope?: Bot["toolScope"]; helperModel?: false };
}

export function restrictedCopyRequest(source: RestrictedSource): RestrictedCopyRequest {
  const settings: NonNullable<RestrictedCopyRequest["settings"]> = {
    ...(Object.hasOwn(source, "toolScope") ? { toolScope: source.toolScope } : {}),
    ...(helperModelAllowed(source) ? {} : { helperModel: false as const }),
  };
  return {
    ...(source.visibility && source.visibility !== "everyone" ? { visibility: source.visibility } : {}),
    ...(Object.keys(settings).length ? { settings } : {}),
  };
}
