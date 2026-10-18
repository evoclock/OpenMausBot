// Dependency-free: Electron main, the server and the renderer all import it.

export const PRO_PLAN_ENV = "OMB_PRO_PLAN";
export const PRO_PLAN_MESSAGE = "openmausbot:pro-plan";

/** While the plan cannot be checked, the last verified plan decides (`lastPlan`, else `lastKnown`); a Cloud home always may. */
export function liveCallsAllowed({ account, lastKnown = false, cloudHome = false } = {}) {
  if (cloudHome) return true;
  const last = lastKnown === true;
  if (!account || (account.status === "signed-out" && account.message === "restoring")) return last;
  switch (account.status) {
    case "signed-out": return false;
    case "connecting": return last;
    case "connected": {
      const entitlement = account.entitlement;
      if (entitlement?.plan === "pro" && entitlement.status === "active") return true;
      return Boolean(account.purchase);
    }
    case "unavailable":
    case "reauth-required":
      return account.lastPlan ? account.lastPlan.active === true : last;
    default: return false;
  }
}

export function proPlanEnvironment(pro) {
  return { [PRO_PLAN_ENV]: pro === true ? "1" : "0" };
}

export function proPlanFromEnvironment(env) {
  return env?.[PRO_PLAN_ENV]?.trim() === "1";
}

export function proPlanMessage(pro) {
  return { type: PRO_PLAN_MESSAGE, pro: pro === true };
}

/** null for any other message; a malformed one throws rather than being read as an answer. */
export function proPlanFromMessage(message) {
  if (!message || typeof message !== "object" || message.type !== PRO_PLAN_MESSAGE) return null;
  if (typeof message.pro !== "boolean") throw new Error("invalid Pro plan message");
  return message.pro;
}

export function createProPlanRelay() {
  let pro = false;
  return {
    update(account) {
      pro = liveCallsAllowed({ account, lastKnown: pro });
      return pro;
    },
    environment: () => proPlanEnvironment(pro),
    message: () => proPlanMessage(pro),
  };
}
