import type { UIAdapterModule } from "./types";
import { listUIAdapters } from "./registry";

export interface AdapterOptionMetadata {
  value: string;
  label: string;
  comingSoon: boolean;
}

const ENABLED_ADAPTER_TYPES = new Set([
  "claude_local",
  "codex_local",
  "droid_local",
  "gemini_local",
  "opencode_local",
  "pi_local",
  "cursor",
  "hermes_local",
  "openclaw_gateway",
]);

const KNOWN_BUILT_IN_ADAPTER_TYPES = new Set([
  "process",
  "http",
  "claude_local",
  "codex_local",
  "droid_local",
  "gemini_local",
  "opencode_local",
  "pi_local",
  "cursor",
  "hermes_local",
  "openclaw_gateway",
]);

export function listKnownAdapterTypes(): string[] {
  return listUIAdapters().map((adapter) => adapter.type);
}

export function isEnabledAdapterType(type: string): boolean {
  if (!KNOWN_BUILT_IN_ADAPTER_TYPES.has(type)) {
    return true;
  }
  return ENABLED_ADAPTER_TYPES.has(type);
}

export function listAdapterOptions(
  labelFor: (type: string) => string,
  adapters: UIAdapterModule[] = listUIAdapters(),
): AdapterOptionMetadata[] {
  return adapters.map((adapter) => ({
    value: adapter.type,
    label: labelFor(adapter.type) ?? adapter.label,
    comingSoon: !isEnabledAdapterType(adapter.type),
  }));
}
