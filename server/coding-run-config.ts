import { z } from "zod";
import { codingRunLimitsSchema } from "./run-contract.ts";

const reference = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/);
const credentialReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fine-grained-token"), reference }).strict(),
  z.object({ kind: z.literal("fine-grained-group"), group: reference }).strict(),
  z.object({ kind: z.literal("github-app"), reference }).strict(),
]);
export type CodingGitCredential = z.output<typeof credentialReferenceSchema>;

export const codingGitGroupSchema = z.object({
  reference,
  visibility: z.enum(["public", "private"]),
  repositories: z.array(z.string().regex(/^evoclock\/[A-Za-z0-9][A-Za-z0-9._-]*$/)).min(1),
}).strict();
export type CodingGitGroup = z.output<typeof codingGitGroupSchema>;

export const codingGitAppInstallationSchema = z.object({
  appId: z.number().int().positive(),
  installationId: z.number().int().positive(),
  privateKeyPath: z.string().startsWith("/").min(2),
  repositories: z.array(z.string().regex(/^evoclock\/[A-Za-z0-9][A-Za-z0-9._-]*$/)).min(1),
  visibility: z.enum(["public", "private"]).optional(),
}).strict();
export type CodingGitAppInstallation = z.output<typeof codingGitAppInstallationSchema>;

export const codingGitDestinationSchema = z.object({
  repository: z.string().regex(/^evoclock\/[A-Za-z0-9][A-Za-z0-9._-]*$/),
  branchPrefix: z.string().regex(/^[a-z0-9][a-z0-9._/-]*\/$/),
  visibility: z.enum(["public", "private"]).optional(),
  credential: credentialReferenceSchema,
}).strict();
export type CodingGitDestination = z.output<typeof codingGitDestinationSchema>;

export const codingRunConfigSchema = z.object({
  /** Destinations and credential references are operator-owned; missing entries never grant a Git write. */
  gitDestinations: z.record(z.string().min(1), z.array(codingGitDestinationSchema).max(50)).optional(),
  gitCredentialGroups: z.record(reference, codingGitGroupSchema).optional(),
  /** Named installation settings; only an absolute key path, never key material, belongs in config. */
  gitAppInstallations: z.record(reference, codingGitAppInstallationSchema).optional(),
  repositoryRoot: z.string().min(1),
  rolesFilePath: z.string().min(1).optional(),
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
