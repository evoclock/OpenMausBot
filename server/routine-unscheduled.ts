// Copyright 2026 OpenMausBot contributors. Licensed under Apache-2.0.
// Disabled routines may persist schedule:null; seed a sentinel once-at so load stays total.
export const UNSCHEDULED_ONCE_AT = 8_640_000_000_000_000;

export function unscheduledOnceSchedule(): { type: "once"; at: number } {
  return { type: "once", at: UNSCHEDULED_ONCE_AT };
}

export function isUnscheduledOnce(schedule: { type: string; at?: number }): boolean {
  return schedule.type === "once" && schedule.at === UNSCHEDULED_ONCE_AT;
}
