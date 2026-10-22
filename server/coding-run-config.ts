import { z } from "zod";
import { codingRunLimitsSchema } from "./run-contract.ts";

export const codingRunConfigSchema = z.object({
  repositoryRoot: z.string().min(1),
  /** Explicit per-origin-bot run budgets; a missing bot entry refuses unattended work. */
  bots: z.record(z.string().min(1), codingRunLimitsSchema.extend({
    maxIterations: z.number().int().positive().optional(),
  })).optional(),
  registrations: z.array(z.object({
    routineId: z.string().min(1), workerBotId: z.string().min(1), reviewerBotId: z.string().min(1),
    developmentRole: z.string().min(1), reviewRole: z.string().min(1),
    repository: z.string().min(1), ref: z.string().min(1),
    successCriteria: z.array(z.string().min(1)).min(1),
  }).strict()).min(1).max(20),
}).strict();

export type CodingRunConfig = z.output<typeof codingRunConfigSchema>;
