import type { UIAdapterModule } from "./types";
import { claudeLocalUIAdapter } from "./claude-local";
import { codexLocalUIAdapter } from "./codex-local";
import { cursorLocalUIAdapter } from "./cursor";
import { droidLocalUIAdapter } from "./droid-local";
import { geminiLocalUIAdapter } from "./gemini-local";
import { hermesLocalUIAdapter } from "./hermes-local";
import { openCodeLocalUIAdapter } from "./opencode-local";
import { piLocalUIAdapter } from "./pi-local";
import { openClawGatewayUIAdapter } from "./openclaw-gateway";
import { processUIAdapter } from "./process";
import { httpUIAdapter } from "./http";

const uiAdapters: UIAdapterModule[] = [];
const adaptersByType = new Map<string, UIAdapterModule>();

function registerBuiltInUIAdapters() {
  for (const adapter of [
    claudeLocalUIAdapter,
    codexLocalUIAdapter,
    droidLocalUIAdapter,
    geminiLocalUIAdapter,
    hermesLocalUIAdapter,
    openCodeLocalUIAdapter,
    piLocalUIAdapter,
    cursorLocalUIAdapter,
    openClawGatewayUIAdapter,
    processUIAdapter,
    httpUIAdapter,
  ]) {
    registerUIAdapter(adapter);
  }
}

export function registerUIAdapter(adapter: UIAdapterModule): void {
  const existingIndex = uiAdapters.findIndex((entry) => entry.type === adapter.type);
  if (existingIndex >= 0) {
    uiAdapters.splice(existingIndex, 1, adapter);
  } else {
    uiAdapters.push(adapter);
  }
  adaptersByType.set(adapter.type, adapter);
}

export function unregisterUIAdapter(type: string): void {
  if (type === processUIAdapter.type || type === httpUIAdapter.type) return;
  const existingIndex = uiAdapters.findIndex((entry) => entry.type === type);
  if (existingIndex >= 0) {
    uiAdapters.splice(existingIndex, 1);
  }
  adaptersByType.delete(type);
}

export function findUIAdapter(type: string): UIAdapterModule | null {
  return adaptersByType.get(type) ?? null;
}

registerBuiltInUIAdapters();

export function getUIAdapter(type: string): UIAdapterModule {
  return adaptersByType.get(type) ?? processUIAdapter;
}

export function listUIAdapters(): UIAdapterModule[] {
  return [...uiAdapters];
}
