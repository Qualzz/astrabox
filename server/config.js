const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);

// Project-local settings only; never rewrite the user's global Codex config.
export function generationConfig(env = process.env) {
  const model = env.ASTRABOX_MODEL?.trim() || 'gpt-6-astra';
  const effort = env.ASTRABOX_EFFORT?.trim() || 'high';
  if (!EFFORTS.has(effort)) throw new Error('ASTRABOX_EFFORT: use minimal, low, medium, high or xhigh.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model)) throw new Error('Invalid ASTRABOX_MODEL identifier.');
  return Object.freeze({ model, effort, serviceTier: 'priority' });
}
