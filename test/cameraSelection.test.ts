import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canSelectStream,
  defaultSelectedStreamNames,
  INITIAL_SELECTED_STREAMS,
  MAX_SELECTED_STREAMS,
} from '../src/cameraSelection.ts';

test('selects the first two already-sorted discovered streams by default', () => {
  const streams = [
    { name: 'cam01', tracks: ['H264'] },
    { name: 'cam02', tracks: ['H264'] },
    { name: 'inhand', tracks: [] },
  ];

  assert.equal(INITIAL_SELECTED_STREAMS, 2);
  assert.deepEqual([...defaultSelectedStreamNames(streams)], ['cam01', 'cam02']);
});

test('permits deselected streams only while fewer than five are selected', () => {
  const selected = new Set(['cam01', 'cam02', 'cam03', 'inhand', 'zed2']);

  assert.equal(MAX_SELECTED_STREAMS, 5);
  assert.equal(canSelectStream(selected, 'cam01'), true);
  assert.equal(canSelectStream(selected, 'zed4'), false);
});
