import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globalWiringAllowed } from '../src/hosts/global-policy.js';

test('global wiring is enabled unless the external-manager kill switch is truthy', () => {
  assert.equal(globalWiringAllowed({}), true);
  assert.equal(globalWiringAllowed({ GRAFT_NO_GLOBAL_WIRING: '' }), true);
  assert.equal(globalWiringAllowed({ GRAFT_NO_GLOBAL_WIRING: '0' }), true);
  assert.equal(globalWiringAllowed({ GRAFT_NO_GLOBAL_WIRING: 'false' }), true);
  assert.equal(globalWiringAllowed({ GRAFT_NO_GLOBAL_WIRING: '1' }), false);
  assert.equal(globalWiringAllowed({ GRAFT_NO_GLOBAL_WIRING: 'yes' }), false);
});
