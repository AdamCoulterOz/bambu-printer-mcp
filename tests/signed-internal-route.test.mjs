import test from 'node:test';
import assert from 'node:assert/strict';
import {ownLocalOf,routeOf,connectionForRoute} from '../dist/counterpart/route.js';
test('counterpart preserves the explicitly configured signed route as local',()=>{
  const selected={mode:'signed_mqtt',type:'cloud'};
  assert.equal(routeOf(selected),'lan');
  assert.deepEqual(ownLocalOf(selected),selected);
  assert.deepEqual(connectionForRoute('lan',selected,false),selected);
});
