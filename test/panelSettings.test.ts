import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PANEL_SETTINGS,
  isRosTopic,
  parsePanelSettings,
  targetPoseTopicForRobot,
} from '../src/panelSettings.ts';

test('keeps a user-selected PoseStamped target topic', () => {
  const settings = parsePanelSettings({
    version: 1,
    robotName: 'robot_big',
    targetPoseTopic: '/cartesian_controller/target_pose',
    selectedStreamNames: ['wrist'],
    motion: DEFAULT_PANEL_SETTINGS.motion,
  });

  assert.equal(settings.targetPoseTopic, '/cartesian_controller/target_pose');
  assert.equal(settings.robotName, 'robot_big');
  assert.deepEqual(settings.selectedStreamNames, ['wrist']);
});

test('falls back to the selected robot default for an invalid stored target topic', () => {
  const settings = parsePanelSettings({
    version: 1,
    robotName: 'robot_big',
    targetPoseTopic: 'not-an-absolute-topic',
    selectedStreamNames: null,
    motion: {},
  });

  assert.equal(settings.targetPoseTopic, targetPoseTopicForRobot('robot_big'));
  assert.equal(settings.motion.translationSensitivity, 1);
});

test('accepts ordinary absolute ROS topic paths only', () => {
  assert.equal(isRosTopic('/teleop_target_pose'), true);
  assert.equal(isRosTopic('/cartesian_controller/target_pose'), true);
  assert.equal(isRosTopic('teleop_target_pose'), false);
  assert.equal(isRosTopic('/bad//topic'), false);
});
