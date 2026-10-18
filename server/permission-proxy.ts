// MCP stdio server the claude CLI spawns for --permission-prompt-tool; forwards each ask to the server's broker over a unix socket.
// stdout is the MCP channel: never console.log here.
import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { parseAskQuestions, questionAnswersByQuestion, type AskQuestion } from "../shared/ask-question.ts";
import { allowsTool, parseToolScope } from "../shared/tool-scope.ts";

const selection = parseToolScope(process.env.OMB_PERMISSION_TOOL_SCOPE === undefined
  ? undefined : (() => { try { return JSON.parse(process.env.OMB_PERMISSION_TOOL_SCOPE); } catch { return null; } })());
if (!selection.ok) throw new Error(selection.error);
const allowQuestion = allowsTool(selection.scope, { kind: "mcp", server: "ogb", name: "ask_user" });

const socketPath = process.argv[2] ?? "";

const waiting = new Map<string, (msg: any) => void>();
const conn = connect(socketPath);
// JSON lines can span reads; a stream decoder keeps a split character whole.
conn.setEncoding("utf8");

interface AllowPermissionResult {
  behavior: "allow";
  updatedInput: object;
  updatedPermissions?: object[];
}
const dead = () => {
  for (const resolve of waiting.values()) {
    resolve({ behavior: "deny", message: "OpenMausBot: permission broker unavailable — skip this action" });
  }
  waiting.clear();
};
conn.on("error", dead);
conn.on("close", dead);

let connBuf = "";
conn.on("data", (chunk) => {
  connBuf += chunk;
  let nl;
  while ((nl = connBuf.indexOf("\n")) !== -1) {
    const line = connBuf.slice(0, nl);
    connBuf = connBuf.slice(nl + 1);
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.t === "answer") {
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  }
});

const send = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");

function askBroker(ask: Record<string, unknown>): Promise<any> {
  return new Promise((resolve) => {
    waiting.set(String(ask.id), resolve);
    if (conn.destroyed) return dead();
    try {
      conn.write(JSON.stringify(ask) + "\n");
    } catch {
      dead();
    }
  });
}

function multiSelectQuestion(args: Record<string, unknown>): AskQuestion[] | null {
  if (args.multiSelect !== true) return null;
  const options = Array.isArray(args.choices) ? args.choices : [];
  return parseAskQuestions({ questions: [{ question: args.question, multiSelect: true, options }] });
}

const ASK_USER_QUESTION = "AskUserQuestion";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** A bare allow makes the headless CLI run AskUserQuestion with no dialog ("The user did not answer the questions."),
 * so answers go in the tool's own `answers` field: keyed by question text, one comma-joined string each. */
async function answerNativeQuestions(input: unknown): Promise<string> {
  const questions = parseAskQuestions(input);
  if (!questions?.length) {
    return JSON.stringify({
      behavior: "deny",
      message:
        "OpenMausBot: this AskUserQuestion call had no answerable question (each one needs question text), so nobody was shown it. Ask again with a well-formed call, or continue without it.",
    });
  }
  const answer = await askBroker({
    t: "ask",
    id: randomUUID(),
    kind: "question",
    tool: ASK_USER_QUESTION,
    input: { questions },
  });
  if (answer.behavior === "deny") {
    return JSON.stringify({ behavior: "deny", message: answer.message || "Denied from OpenMausBot" });
  }
  // Only the person's own answer fills `answers`: the broker's notes (a timeout's sentence) would read as their choice.
  const answers =
    answer.source === "user" && typeof answer.message === "string"
      ? questionAnswersByQuestion(answer.message, questions)
      : {};
  return JSON.stringify({ behavior: "allow", updatedInput: { ...asRecord(input), answers } });
}

const TOOLS = [
  {
    name: "approve",
    description: "Ask the OpenMausBot user whether a tool use is allowed",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: { type: "string" },
        input: { type: "object" },
        tool_use_id: { type: "string" },
      },
      required: ["tool_name", "input"],
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the human who owns this bot a question and wait for their answer. Use whenever you need a decision, a preference, missing information, or sign-off before doing something consequential — do not guess on things the owner would want to decide. Returns their answer as text.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, with enough context to answer at a glance" },
        choices: {
          type: "array",
          items: { type: "string" },
          description: "Optional 2-5 suggested answers, shown as one-tap buttons",
        },
        multiSelect: {
          type: "boolean",
          description: "Set true when the person may pick more than one of the choices. Their picks come back joined with commas.",
        },
      },
      required: ["question"],
    },
  },
];

async function handle(msg: any) {
  if (msg.method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "openmausbot-permissions", version: "1" },
      },
    });
  }
  // approve is the CLI's private permission callback, not an execution grant.
  if (msg.method === "tools/list") return send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS.filter((tool) => tool.name === "approve" || allowQuestion) } });
  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    const reply = (text: string) => send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } });
    if (name === "ask_user" && !allowQuestion) return reply("OpenMausBot: this question tool is excluded by the bot's tool selection.");
    if (name === "approve" && args.tool_name === ASK_USER_QUESTION) {
      return reply(await answerNativeQuestions(args.input));
    }
    const askId = randomUUID();
    const isQuestion = name === "ask_user";
    const picksSeveral = isQuestion ? multiSelectQuestion(args) : null;
    // Hand the CLI's own suggested rules back as updatedPermissions, so claude stops asking at its own layer.
    const suggestions = Array.isArray(args.permission_suggestions)
      ? args.permission_suggestions
      : Array.isArray(args.suggestions)
        ? args.suggestions
        : null;
    const answer: any = await askBroker(
      isQuestion
        ? { t: "ask", id: askId, kind: "question", tool: "ask_user", input: { question: args.question, choices: args.choices, ...(picksSeveral ? { questions: picksSeveral } : {}) } }
        : { t: "ask", id: askId, tool: args.tool_name, input: args.input },
    );
    let text = answer.message || "No answer was given — use your best judgment.";
    if (picksSeveral && answer.source === "user" && typeof answer.message === "string") {
      text = questionAnswersByQuestion(answer.message, picksSeveral)[picksSeveral[0]!.question] ?? text;
    }
    if (!isQuestion) {
      if (answer.behavior === "allow") {
        const result: AllowPermissionResult = { behavior: "allow", updatedInput: args.input ?? {} };
        if (answer.always && suggestions) result.updatedPermissions = suggestions;
        text = JSON.stringify(result);
      } else {
        text = JSON.stringify({ behavior: "deny", message: answer.message || "Denied from OpenMausBot" });
      }
    }
    return reply(text);
  }
  if (String(msg.method ?? "").startsWith("notifications/")) return;
  if (msg.id != null) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
}

let inBuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inBuf += chunk;
  let nl;
  while ((nl = inBuf.indexOf("\n")) !== -1) {
    const line = inBuf.slice(0, nl);
    inBuf = inBuf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      void handle(JSON.parse(line));
    } catch {
    }
  }
});
process.stdin.on("end", () => process.exit(0));
