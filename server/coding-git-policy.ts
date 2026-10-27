import type { ToolScope } from "../shared/tool-scope.ts";
import type { CodingGitCredential, CodingGitDestination, CodingGitGroup, CodingRunConfig } from "./coding-run-config.ts";
import type { RunContractStore } from "./run-contract.ts";

export type GitAction = "push" | "pr-open" | "pr-update" | "pr-ready" | "pr-merge" |
  "force-push" | "tag" | "release" | "publish";
type ResolvedCredential = Exclude<CodingGitCredential, { kind: "fine-grained-group" }>;

export interface RepositoryFacts {
  nameWithOwner: string;
  visibility: "public" | "private";
  defaultBranch: string;
  protectedBranches: readonly string[];
  remoteUrls: readonly string[];
  viewerPermission: "READ" | "TRIAGE" | "WRITE" | "MAINTAIN" | "ADMIN";
  pullRequest?: { number: number; base: string; head: string; draft: boolean; checksGreen?: boolean };
}

export interface CodingGitCredentialProvider {
  /** Checks a named reference at action time; credential material is never returned. */
  canWrite(credential: ResolvedCredential, repository: string): Promise<boolean>;
}

export interface CodingGitPort {
  origin(workspace: string): Promise<string>;
  branch(workspace: string): Promise<string>;
  createBranch(workspace: string, branch: string, base: string): Promise<void>;
  head(workspace: string): Promise<string>;
  outgoingAuthors(workspace: string, remoteUrl: string, branch: string, base: string): Promise<Array<{ name: string; email: string }>>;
  push(workspace: string, remoteUrl: string, revision: string, destination: string,
    credential: ResolvedCredential, repository: string, options?: { setUpstream?: boolean }): Promise<void>;
  pullRequest(action: "pr-open" | "pr-update" | "pr-ready", repository: string, base: string, head: string,
    credential: ResolvedCredential, options: { draft: true; prNumber?: number }): Promise<void>;
  /** A bot cannot execute the merge; the run receipt records only owner eligibility. */
  recordOwnerMerge(runId: string, repository: string, reason: string, method: "merge" | "rebase"): Promise<void>;
}

export interface CodingGitHost {
  inspect(repository: string, request?: CodingGitRequest): Promise<RepositoryFacts>;
  credentials: CodingGitCredentialProvider;
  port: Omit<CodingGitPort, "recordOwnerMerge">;
}

export function createCodingGitRunPolicy(config: CodingRunConfig, store: Pick<RunContractStore, "recordOwnerMerge">,
  host: CodingGitHost) {
  return createCodingGitPolicy({ destinations: config.gitDestinations ?? {}, groups: config.gitCredentialGroups,
    inspect: (repository, request) => host.inspect(repository, request), credentials: host.credentials,
    port: { ...host.port, async recordOwnerMerge(id, repository, reason, method) {
      store.recordOwnerMerge(id, repository, reason, method);
    } },
  });
}

export interface CodingGitRequest {
  botId: string;
  repository: string;
  workspace: string;
  branch: string;
  action: GitAction;
  base?: string;
  draft?: boolean;
  prNumber?: number;
  runId?: string;
  unblockReason?: string;
  mergeMethod?: "merge" | "rebase" | "squash";
}

const REPOSITORY = /^evoclock\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BRANCH = /^[a-z0-9][a-z0-9._/-]*$/;
const SHA = /^[a-f0-9]{40}$/;

function branchName(value: string | undefined): value is string {
  return typeof value === "string" && value.length <= 160 && BRANCH.test(value) &&
    !value.includes("..") && !value.includes("//") && !value.endsWith("/") &&
    !value.endsWith(".lock") && !value.startsWith("refs/") && !value.startsWith("-");
}

function refuse(message: string): never { throw new Error(`Git destination refused: ${message}`); }

/** Coding bots cannot reach a shell or MCP executor outside the checked host Git port. */
export function codingGitToolScope(_existing: ToolScope | undefined): ToolScope {
  return { allow: ["native:read", "native:write", "native:edit", "native:coding_command"] };
}

/** Only an exact configured destination and fresh metadata may authorize an outward Git effect. */
export function createCodingGitPolicy(options: {
  destinations: Readonly<Record<string, readonly CodingGitDestination[]>>;
  groups?: Readonly<Record<string, CodingGitGroup>>;
  inspect(repository: string, request?: CodingGitRequest): Promise<RepositoryFacts>;
  credentials: CodingGitCredentialProvider;
  port: CodingGitPort;
}) {
  return async (request: CodingGitRequest): Promise<"applied" | "owner-eligible"> => {
    if (!["push", "pr-open", "pr-update", "pr-ready", "pr-merge"].includes(request.action)) {
      refuse("force pushes, tags, releases and publication are not permitted");
    }
    if (!REPOSITORY.test(request.repository) || !branchName(request.branch)) refuse("repository or branch is not canonical");
    const grants = Object.hasOwn(options.destinations, request.botId) ? options.destinations[request.botId] : undefined;
    const matches = Array.isArray(grants) ? grants.filter((entry) => entry.repository === request.repository &&
      request.branch.startsWith(entry.branchPrefix)) : undefined;
    if (matches?.length !== 1) refuse("this bot has no unambiguous destination grant");
    const grant = matches[0]!;
    const facts = await options.inspect(request.repository, request);
    if (facts.nameWithOwner !== request.repository || !["public", "private"].includes(facts.visibility) ||
      (grant.visibility && facts.visibility !== grant.visibility) ||
      !["WRITE", "MAINTAIN", "ADMIN"].includes(facts.viewerPermission) ||
      !branchName(facts.defaultBranch) || !Array.isArray(facts.protectedBranches) ||
      !facts.protectedBranches.every(branchName) || !Array.isArray(facts.remoteUrls) || !facts.remoteUrls.length) {
      refuse("repository visibility, identity, permission or branch protection is unverified");
    }
    let credential: ResolvedCredential;
    if (grant.credential.kind === "fine-grained-group") {
      const group = options.groups && Object.hasOwn(options.groups, grant.credential.group)
        ? options.groups[grant.credential.group] : undefined;
      if (!group?.reference || group.visibility !== facts.visibility || !group.repositories.includes(request.repository)) {
        refuse("the credential group is missing or outside its repository and visibility scope");
      }
      credential = { kind: "fine-grained-token", reference: group.reference };
    } else {
      if (!grant.credential.reference) refuse("a named repository credential is required");
      credential = grant.credential;
    }
    if (!(await options.credentials.canWrite(credential, request.repository))) refuse("the named repository credential has no write grant");
    const remote = await options.port.origin(request.workspace);
    if (!facts.remoteUrls.includes(remote)) refuse("the configured Git remote does not match the verified repository");
    if ((await options.port.branch(request.workspace)) !== request.branch) refuse("the workspace branch differs from its grant");
    const protectedNames = ["main", facts.defaultBranch, ...facts.protectedBranches].map((name) => name.toLowerCase());
    if (protectedNames.includes(request.branch.toLowerCase())) refuse("pushing to main, default or protected branches is forbidden");
    const revision = await options.port.head(request.workspace);
    if (!SHA.test(revision)) refuse("the local revision is not verified");
    const base = request.base ?? facts.defaultBranch;
    if (!facts.protectedBranches.includes(base)) refuse("the outgoing base is not a verified protected branch");
    const authors = await options.port.outgoingAuthors(request.workspace, remote, request.branch, base);
    if (!authors.length || authors.some((author) => author.name !== "evoclock" ||
      author.email !== "52983349+evoclock@users.noreply.github.com")) {
      refuse("every outgoing commit must use Julen's verified Git author");
    }
    if (request.action === "push") {
      await options.port.push(request.workspace, remote, revision, `refs/heads/${request.branch}`, credential, request.repository);
      return "applied";
    }
    if (!branchName(request.base) || !facts.protectedBranches.includes(request.base)) {
      refuse("the pull request base is not a verified protected branch");
    }
    if (request.action === "pr-open" && request.draft !== true) refuse("new pull requests must be drafts");
    const linkedPr = facts.pullRequest;
    if (request.action !== "pr-open" && (!Number.isSafeInteger(request.prNumber) || request.prNumber! <= 0 ||
      !linkedPr || linkedPr.number !== request.prNumber || linkedPr.base !== request.base ||
      linkedPr.head !== request.branch)) refuse("the pull request identity or revision is unverified");
    if (request.action === "pr-ready" && facts.pullRequest?.draft !== true) refuse("the pull request is not a draft");
    if (request.action === "pr-merge") {
      if (facts.visibility !== "private") refuse("public pull request merges are forbidden");
      if (facts.pullRequest?.checksGreen !== true) refuse("every pull request check must pass before a private merge");
      if (!request.runId || !request.unblockReason || !/\bunblock(?:s|ed|ing)?\b/i.test(request.unblockReason) ||
        request.unblockReason.trim().length < 16) refuse("a stated development-unblock reason and run ID are required");
      if (request.mergeMethod !== "merge" && request.mergeMethod !== "rebase") refuse("squash merges are forbidden");
      await options.port.recordOwnerMerge(request.runId, request.repository, request.unblockReason, request.mergeMethod);
      return "owner-eligible";
    }
    if (request.action !== "pr-open" && request.action !== "pr-update" && request.action !== "pr-ready") {
      refuse("this pull request action is not permitted");
    }
    await options.port.pullRequest(request.action, request.repository, request.base, request.branch, credential,
      { draft: true, ...(request.prNumber ? { prNumber: request.prNumber } : {}) });
    return "applied";
  };
}
