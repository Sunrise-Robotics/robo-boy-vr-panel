import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultPanelSettings,
  isRosTopic,
  parsePanelSettings,
  panelSettingsToJson,
  targetPoseTopicForRobot,
} from '../src/panelSettings.ts';

test('defaults each controller to its own robot', () => {
  const settings = defaultPanelSettings();
  assert.equal(settings.arms.left.robotName, 'robot_small');
  assert.equal(settings.arms.right.robotName, 'robot_big');
  assert.equal(settings.arms.right.targetPoseTopic, '/robot_big/teleop_command');
  assert.deepEqual(settings.arms.left.motion.axisMap, { forward: '+x', left: '+y', up: '+z' });
  assert.deepEqual(parsePanelSettings(panelSettingsToJson(settings)), settings);
});

test('migrates v1 settings to the right controller', () => {
  const settings = parsePanelSettings({
    version: 1,
    robotName: 'robot_big',
    targetPoseTopic: '/cartesian_controller/target_pose',
    targetFrameId: '',
    selectedStreamNames: ['wrist'],
    motion: { translationSensitivity: 1.5 },
  });

  assert.equal(settings.arms.right.robotName, 'robot_big');
  assert.equal(settings.arms.right.targetPoseTopic, '/cartesian_controller/target_pose');
  assert.equal(settings.arms.right.targetFrameId, '');
  assert.equal(settings.arms.right.motion.translationSensitivity, 1.5);
  assert.equal(settings.arms.left.robotName, 'robot_small');
  assert.deepEqual(settings.selectedStreamNames, ['wrist']);
});

test('replaces the unconsumed v1 default topic and invalid stored values', () => {
  const settings = parsePanelSettings({
    version: 2,
    arms: {
      left: { robotName: 'robot_big', targetPoseTopic: '/robot_big/teleop_target_pose' },
      right: { robotName: 'robot_small', targetPoseTopic: 'not-absolute', motion: { axisMap: { forward: '+x', left: '-x', up: '+z' } } },
    },
    selectedStreamNames: null,
  });

  assert.equal(settings.arms.left.targetPoseTopic, targetPoseTopicForRobot('robot_big'));
  assert.equal(settings.arms.right.targetPoseTopic, targetPoseTopicForRobot('robot_small'));
  assert.equal(settings.arms.right.motion.translationSensitivity, 1);
  assert.deepEqual(settings.arms.right.motion.axisMap, { forward: '+x', left: '+y', up: '+z' });
  assert.equal(parsePanelSettings({ version: 2, arms: { left: { robotName: 'robot_other' } } }).arms.left.robotName, 'robot_small');
});

test('accepts ordinary absolute ROS topic paths only', () => {
  assert.equal(isRosTopic('/teleop_target_pose'), true);
  assert.equal(isRosTopic('/cartesian_controller/target_pose'), true);
  assert.equal(isRosTopic('teleop_target_pose'), false);
  assert.equal(isRosTopic('/bad//topic'), false);
});
