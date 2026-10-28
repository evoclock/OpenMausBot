// Copyright 2026 OpenMausBot contributors. Licensed under Apache-2.0.
// Disabled routines may persist schedule:null; seed a sentinel once-at so load stays total.
import type { Routine, RoutineRun, RoutineScheduleInput } from "./routines.ts";
export const UNSCHEDULED_ONCE_AT = 8_640_000_000_000_000;

export function unscheduledOnceSchedule(): { type: "once"; at: number } {
  return { type: "once", at: UNSCHEDULED_ONCE_AT };
}

export function isUnscheduledOnce(schedule: { type: string; at?: number }): boolean {
  return schedule.type === "once" && schedule.at === UNSCHEDULED_ONCE_AT;
}

export function onceUpdateError(
  routine: Routine,
  patch: { enabled?: boolean; schedule?: RoutineScheduleInput | null },
  runs: readonly RoutineRun[],
  now: number,
): string | null {
  if (isUnscheduledOnce(routine.schedule) && patch.enabled === true && !patch.schedule) return "Choose a schedule before enabling this routine";
  if (patch.schedule === null && patch.enabled !== false) return "Clear the schedule only while disabling the routine";
  if (routine.schedule.type !== "once" || patch.enabled !== false || !routine.enabled ||
    routine.schedule.at <= now || isUnscheduledOnce(routine.schedule) || patch.schedule === null) return null;
  const onceAt = routine.schedule.at;
  const scheduled = runs.some((run) => run.routineId === routine.id && !run.manual && run.scheduledFor === onceAt);
  return scheduled ? null : "This one-time run is still pending. To cancel it, disable with schedule: null in the same update.";
}
