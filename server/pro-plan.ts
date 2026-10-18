// The desktop app hands this server only the plan answer (OMB_PRO_PLAN, then its private parent port), never the account.
import { liveCallsAllowed, proPlanFromEnvironment, proPlanFromMessage } from "../electron/pro-plan.mjs";

export class ProPlan {
  private known: boolean;
  private readonly cloudHome: boolean;
  private readonly log: (line: string) => void;

  constructor({ cloudHome, env = process.env, log = (line) => console.log(line) }: {
    cloudHome: boolean;
    env?: NodeJS.ProcessEnv;
    log?: (line: string) => void;
  }) {
    this.cloudHome = cloudHome;
    this.known = proPlanFromEnvironment(env);
    this.log = log;
  }

  receive(message: unknown): boolean {
    const pro = proPlanFromMessage(message);
    if (pro === null) return false;
    if (pro !== this.known) this.log(`[pro-plan] the desktop app says ${pro ? "Pro" : "not Pro"}`);
    this.known = pro;
    return true;
  }

  /** Asked when a call starts, never during one: a plan change never cuts off a running call. */
  liveCallsAllowed(): boolean {
    return liveCallsAllowed({ cloudHome: this.cloudHome, lastKnown: this.known });
  }
}
