import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harnessDimensions } from '../src/stats/config.js';

test('Codex dimensions use the active hook model and leave undocumented effort unknown', () => {
  assert.deepEqual(harnessDimensions('codex', { model: 'gpt-active', model_reasoning_effort: 'high' }), {
    provider: 'unknown', model: 'gpt-active', reasoningEffort: 'unknown',
  });
  assert.deepEqual(harnessDimensions('codex', {}), {
    provider: 'unknown', model: 'unknown', reasoningEffort: 'unknown',
  });
});

test('Claude Code dimensions use documented effort.level, and Cursor uses model_params', () => {
  assert.deepEqual(harnessDimensions('claude-code', { model: 'claude-active', effort: { level: 'xhigh' } }), {
    provider: 'unknown', model: 'claude-active', reasoningEffort: 'xhigh',
  });
  assert.deepEqual(harnessDimensions('cursor', {
    model: 'legacy-slug', model_id: 'selected-model',
    model_params: [{ id: 'thinking', value: 'true' }, { id: 'effort', value: 'max' }],
  }), { provider: 'unknown', model: 'selected-model', reasoningEffort: 'max' });
  assert.deepEqual(harnessDimensions('cursor', { model: 'legacy-slug' }), {
    provider: 'unknown', model: 'unknown', reasoningEffort: 'unknown',
  });
  assert.deepEqual(harnessDimensions('other', { model: 'unverified', effort: 'high' }), {
    provider: 'unknown', model: 'unknown', reasoningEffort: 'unknown',
  });
});
