export const type = "droid_local";
export const label = "Droid (local)";
export const DEFAULT_DROID_LOCAL_AUTONOMY = "medium";

export const models = [
  { id: "gpt-5.1", label: "gpt-5.1" },
  { id: "gpt-5.2", label: "gpt-5.2" },
  { id: "gpt-5.2-codex", label: "gpt-5.2-codex" },
  { id: "gpt-5.3-codex", label: "gpt-5.3-codex" },
  { id: "claude-sonnet-4-5-20250929", label: "claude-sonnet-4-5-20250929" },
  { id: "claude-opus-4-6", label: "claude-opus-4-6" },
  { id: "gemini-3.1-pro-preview", label: "gemini-3.1-pro-preview" },
  { id: "kimi-k2.5", label: "kimi-k2.5" },
];

export const agentConfigurationDoc = `# droid_local agent configuration

Adapter: droid_local

Use when:
- The host machine already has the Factory Droid CLI installed
- You want a local coding agent with session continuation across heartbeats
- You want structured stream-json run logs for transcript rendering

Don't use when:
- The agent should run remotely via webhook or an always-on external service (use http or openclaw_gateway)
- You need Paperclip-managed local skill injection into the runtime today
- Droid CLI is not installed or authenticated on the host

Core fields:
- cwd (string, optional): absolute working directory fallback for the agent process
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the prompt at runtime
- promptTemplate (string, optional): heartbeat prompt template
- bootstrapPromptTemplate (string, optional): only sent when Paperclip starts a fresh session
- model (string, optional): Droid model id
- effort (string, optional): reasoning effort passed as --reasoning-effort
- command (string, optional): defaults to "droid"
- extraArgs (string[], optional): additional CLI args appended before Paperclip's forced --cwd and --output-format flags
- env (object, optional): environment variables; FACTORY_API_KEY is typically required
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Paperclip runs Droid via \
  droid exec --cwd <path> --output-format stream-json
- Prompt content is piped over stdin.
- If extraArgs does not include an autonomy flag, Paperclip adds --auto medium so Droid can make normal development edits during a heartbeat.
- If a saved session id exists for the same cwd, Paperclip resumes it with --session-id.
`;