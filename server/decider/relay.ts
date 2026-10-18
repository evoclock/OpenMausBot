// Anything the relay does not accept never goes through the included token: only with the person's own key.
import { jevRequestBody } from "./jev.ts";
import { ROOM_ROUTING_INSTRUCTIONS, ROOM_ROUTING_STATE_KEYS } from "./room-routing.ts";
import type { DeciderQuestion, DeciderSeam } from "./types.ts";

export const KEY_CHECK_STATE = { purpose: "OpenMausBot is checking that a decision-model key works." };
export const KEY_CHECK_QUESTION = "Is this a connection check?";

/** Measured in UTF-8 bytes. */
export const RELAY_MAX_BODY_BYTES = 64 * 1024;
export const RELAY_MAX_STATE_BYTES = 24_000;

/** A job added later stays out until the relay accepts it. */
const RELAY_SEAMS: ReadonlySet<DeciderSeam> = new Set<DeciderSeam>(["roomRouting", "keyCheck"]);
const ROOM_STATE_KEYS: ReadonlySet<string> = new Set(ROOM_ROUTING_STATE_KEYS);
const ROOM_STATE_REQUIRED = ROOM_ROUTING_STATE_KEYS.filter((key) => key !== "recent_messages");

export function relaySeam(seam: DeciderSeam): boolean {
  return RELAY_SEAMS.has(seam);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function shapeFits(seam: DeciderSeam, state: unknown, questions: Record<string, DeciderQuestion>): boolean {
  const ids = Object.keys(questions);
  const question = questions.answer;
  if (ids.length !== 1 || !question) return false;
  if (seam === "keyCheck") {
    return question.type === "yesno" && question.instructions === KEY_CHECK_QUESTION && !question.criteria &&
      JSON.stringify(state) === JSON.stringify(KEY_CHECK_STATE);
  }
  if (seam === "roomRouting") {
    return question.type === "choice" && question.instructions === ROOM_ROUTING_INSTRUCTIONS && isRecord(state) &&
      Object.keys(state).every((key) => ROOM_STATE_KEYS.has(key)) && ROOM_STATE_REQUIRED.every((key) => key in state);
  }
  return false;
}

export function relayAccepts(seam: DeciderSeam, state: unknown, questions: Record<string, DeciderQuestion>): boolean {
  try {
    if (!shapeFits(seam, state, questions)) return false;
    return Buffer.byteLength(JSON.stringify(state)) <= RELAY_MAX_STATE_BYTES &&
      Buffer.byteLength(JSON.stringify(jevRequestBody(state, questions))) <= RELAY_MAX_BODY_BYTES;
  } catch {
    return false;
  }
}
