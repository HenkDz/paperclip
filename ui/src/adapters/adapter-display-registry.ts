/**
 * Single source of truth for adapter display metadata.
 *
 * All adapter labels, icons, descriptions, and UI hints live here.
 * Consumers import from this module instead of maintaining their own copies.
 *
 * External (plugin) adapters that aren't registered here get sensible defaults
 * via `getAdapterDisplay()`.
 */
import type { ComponentType } from "react";
import {
  Bot,
  Code,
  Gem,
  MousePointer2,
  Sparkles,
  Terminal,
  Cpu,
} from "lucide-react";
import { OpenCodeLogoIcon } from "@/components/OpenCodeLogoIcon";
import { HermesIcon } from "@/components/HermesIcon";

// ---------------------------------------------------------------------------
// Type suffix parsing
// ---------------------------------------------------------------------------

/** Suffixes extracted from adapter type identifiers. */
const TYPE_SUFFIXES: Record<string, string> = {
  _local: "local",
  _gateway: "gateway",
};

/**
 * Extract the deployment mode suffix from an adapter type string.
 * e.g. "claude_local" → "local", "openclaw_gateway" → "gateway", "cursor" → null
 */
function getTypeSuffix(type: string): string | null {
  for (const [suffix, mode] of Object.entries(TYPE_SUFFIXES)) {
    if (type.endsWith(suffix)) return mode;
  }
  return null;
}

/**
 * Format a label with a deployment mode suffix.
 * e.g. ("Claude Code", "local") → "Claude Code (local)"
 */
function withSuffix(label: string, suffix: string | null): string {
  return suffix ? `${label} (${suffix})` : label;
}

// ---------------------------------------------------------------------------
// Display metadata per adapter type
// ---------------------------------------------------------------------------

export interface AdapterDisplayInfo {
  /** Human-readable label without suffix (e.g. "Claude Code") */
  label: string;
  /** Short description for grid cards */
  description: string;
  /** Icon component for grid cards */
  icon: ComponentType<{ className?: string }>;
  /** Whether to show a "Recommended" badge in grids */
  recommended?: boolean;
  /** Whether the adapter is marked as coming soon (disabled in grids) */
  comingSoon?: boolean;
  /** Label shown when comingSoon and user tries to interact */
  disabledLabel?: string;
}

/**
 * Clean labels (no suffix) — used as the base for both grid cards and dropdowns.
 * Grid cards use these directly; dropdowns append the type suffix via `getAdapterLabel()`.
 */
const labels: Record<string, string> = {
  claude_local: "Claude Code",
  codex_local: "Codex",
  gemini_local: "Gemini CLI",
  opencode_local: "OpenCode",
  pi_local: "Pi",
  cursor: "Cursor",
  hermes_local: "Hermes Agent",
  openclaw_gateway: "OpenClaw Gateway",
  process: "Process",
  http: "HTTP",
};

/**
 * Grid display metadata — used by NewAgentDialog, OnboardingWizard, etc.
 * Only adapters with a `grid` entry appear in the card grids.
 * External adapters not listed here use `getAdapterDisplay()` defaults.
 */
const gridEntries: Record<string, AdapterDisplayInfo> = {
  claude_local: {
    label: "Claude Code",
    description: "Local Claude agent",
    icon: Sparkles,
    recommended: true,
  },
  codex_local: {
    label: "Codex",
    description: "Local Codex agent",
    icon: Code,
    recommended: true,
  },
  gemini_local: {
    label: "Gemini CLI",
    description: "Local Gemini agent",
    icon: Gem,
  },
  opencode_local: {
    label: "OpenCode",
    description: "Local multi-provider agent",
    icon: OpenCodeLogoIcon,
  },
  pi_local: {
    label: "Pi",
    description: "Local Pi agent",
    icon: Terminal,
  },
  cursor: {
    label: "Cursor",
    description: "Local Cursor agent",
    icon: MousePointer2,
  },
  hermes_local: {
    label: "Hermes Agent",
    description: "Local multi-provider agent",
    icon: HermesIcon,
  },
  openclaw_gateway: {
    label: "OpenClaw Gateway",
    description: "Invoke OpenClaw via gateway protocol",
    icon: Bot,
    comingSoon: true,
    disabledLabel: "Configure OpenClaw within the App",
  },
  // System adapters — not selectable for agent creation
  process: {
    label: "Process",
    description: "Internal process adapter",
    icon: Cpu,
    comingSoon: true,
  },
  http: {
    label: "HTTP",
    description: "Internal HTTP adapter",
    icon: Cpu,
    comingSoon: true,
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the human-readable label for an adapter type, with deployment suffix.
 * e.g. "claude_local" → "Claude Code (local)", "openclaw_gateway" → "OpenClaw Gateway (gateway)"
 *
 * Used by dropdowns, property displays, and anywhere the adapter mode matters.
 * For grid cards, use `getAdapterDisplay(type).label` instead (no suffix).
 */
export function getAdapterLabel(type: string): string {
  const base = labels[type] ?? type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return withSuffix(base, getTypeSuffix(type));
}

/**
 * Get a `Record<string, string>` for backward compatibility with code that
 * does `adapterLabels[type] ?? type`.
 */
export function getAdapterLabels(): Record<string, string> {
  const suffixed: Record<string, string> = {};
  for (const [type, label] of Object.entries(labels)) {
    suffixed[type] = withSuffix(label, getTypeSuffix(type));
  }
  return suffixed;
}

/**
 * Get full display info for an adapter type.
 * Returns defaults for unknown/external adapters so they still render in grids.
 * The `label` field is clean (no suffix) — use `getAdapterLabel()` for suffixed.
 */
export function getAdapterDisplay(type: string): AdapterDisplayInfo {
  const known = gridEntries[type];
  if (known) return known;

  // External / plugin adapter — derive from type string
  const base = labels[type] ?? type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const suffix = getTypeSuffix(type);
  return {
    label: base,
    description: suffix ? `External ${suffix} adapter` : "External adapter",
    icon: Cpu,
  };
}

/**
 * Check whether an adapter type has grid metadata registered.
 * External adapters return false.
 */
export function isKnownAdapterType(type: string): boolean {
  return type in gridEntries;
}
