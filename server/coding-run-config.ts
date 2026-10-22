import { z } from "zod";

export const codingRunConfigSchema = z.object({
  repositoryRoot: z.string().min(1),
  registrations: z.array(z.object({
    routineId: z.string().min(1), workerBotId: z.string().min(1), reviewerBotId: z.string().min(1),
    developmentRole: z.string().min(1), reviewRole: z.string().min(1),
    repository: z.string().min(1), ref: z.string().min(1),
    successCriteria: z.array(z.string().min(1)).min(1),
  }).strict()).min(1).max(20),
}).strict();

export type CodingRunConfig = z.output<typeof codingRunConfigSchema>;
