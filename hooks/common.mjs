import { loadConfig, DEFAULTS } from '../lib/config.mjs';

export async function readInput() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return JSON.parse(data || '{}');
}

// Config quebrada não pode desligar a proteção: cai nos padrões.
export function safeConfig() {
  try {
    return loadConfig();
  } catch {
    return { ...DEFAULTS };
  }
}

export const reply = (obj) => process.stdout.write(JSON.stringify(obj));

export const preToolDecision = (decision, reason, extra = {}) =>
  reply({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason, ...extra } });
