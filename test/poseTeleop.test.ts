import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { axisMapMatrix, buildHomeGoal, DEFAULT_POSE_TELEOP_MOTION_SETTINGS, PoseTeleopController, parsePoseStamped } from '../src/poseTeleop.ts';

const robotPose = {
  header: { frame_id: 'world' },
  pose: {
    position: { x: 1, y: 2, z: 3 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
  },
};

const controllerPose = (x: number, y = 0, z = 0) => ({
  position: new THREE.Vector3(x, y, z),
  orientation: new THREE.Quaternion(),
});

test('parses a valid PoseStamped and rejects an incomplete one', () => {
  assert.equal(parsePoseStamped(robotPose as any)?.frameId, 'world');
  assert.equal(parsePoseStamped({ pose: { position: { x: 1, y: 2, z: 3 } } } as any), null);
});

test('does not publish until armed from a flange pose', () => {
  const published: any[] = [];
  const controller = new PoseTeleopController({ ros: { publish: async (options: unknown) => void published.push(options) } as any });
  controller.setTargetTopic('/robot_a/teleop_target_pose');
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: false, frameTogglePressed: false }, 0);
  assert.equal(published.length, 0);

  controller.setRobotPose(robotPose as any);
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: true, frameTogglePressed: false }, 40);
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: false, frameTogglePressed: false }, 80);
  assert.equal(published.length, 1);
  assert.equal(published[0].topic, '/robot_a/teleop_target_pose');
  assert.equal(published[0].messageType, 'geometry_msgs/msg/PoseStamped');
  assert.deepEqual(published[0].message.pose.position, { x: 1, y: 2, z: 3 });
  assert.equal(published[0].message.header.frame_id, 'world');

  controller.setTargetFrameId('arm_base');
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: false, frameTogglePressed: false }, 120);
  assert.equal(published[1].message.header.frame_id, 'arm_base');
});

test('moves only while the squeeze clutch is held and holds its final target on release', () => {
  const published: any[] = [];
  const controller = new PoseTeleopController({ ros: { publish: async (options: unknown) => void published.push(options) } as any });
  controller.setTargetTopic('/robot_a/teleop_target_pose');
  controller.setRobotPose(robotPose as any);
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: true, frameTogglePressed: false }, 0);
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: false, frameTogglePressed: false }, 40);
  controller.update({ pose: controllerPose(0.02), squeeze: 1, armPressed: false, frameTogglePressed: false }, 80);
  controller.update({ pose: controllerPose(0.04), squeeze: 0, armPressed: false, frameTogglePressed: false }, 120);

  assert.equal(published.length, 3);
  assert.equal(published[1].message.pose.position.y, 1.98); // WebXR +X (right) maps to robot -Y.
  assert.equal(published[2].message.pose.position.y, 1.98);
});

test('applies configured deadzone and sensitivity to controller translation', () => {
  const published: any[] = [];
  const controller = new PoseTeleopController({ ros: { publish: async (options: unknown) => void published.push(options) } as any });
  controller.setTargetTopic('/robot_a/teleop_target_pose');
  controller.setMotionSettings({
    translationDeadzoneM: 0.003,
    rotationDeadzoneRad: 0,
    translationSensitivity: 0.5,
    rotationSensitivity: 1,
    squeezeThreshold: 0.5,
    axisMap: { forward: '+x', left: '+y', up: '+z' },
  });
  controller.setRobotPose(robotPose as any);
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: true, frameTogglePressed: false }, 0);
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: false, frameTogglePressed: false }, 40);
  controller.update({ pose: controllerPose(0.002), squeeze: 1, armPressed: false, frameTogglePressed: false }, 80);
  controller.update({ pose: controllerPose(0.004), squeeze: 1, armPressed: false, frameTogglePressed: false }, 120);

  assert.equal(published.length, 3);
  assert.equal(published[2].message.pose.position.y, 1.998);
});

test('disarming stops pose publications', () => {
  const published: unknown[] = [];
  const controller = new PoseTeleopController({ ros: { publish: async (options: unknown) => void published.push(options) } as any });
  controller.setTargetTopic('/robot_a/teleop_target_pose');
  controller.setRobotPose(robotPose as any);
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: true, frameTogglePressed: false }, 0);
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: false, frameTogglePressed: false }, 40);
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: true, frameTogglePressed: false }, 80);
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: false, frameTogglePressed: false }, 120);
  assert.equal(published.length, 1);
});

test('reports motion only while armed with the squeeze clutch held', () => {
  const motion: boolean[] = [];
  const controller = new PoseTeleopController({
    ros: { publish: async () => {} } as any,
    onMotionChange: (moving) => motion.push(moving),
  });
  controller.setTargetTopic('/robot_a/teleop_target_pose');
  controller.setRobotPose(robotPose as any);
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: true, frameTogglePressed: false }, 0);
  controller.update({ pose: controllerPose(0), squeeze: 1, armPressed: false, frameTogglePressed: false }, 40);
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: false, frameTogglePressed: false }, 80);
  assert.deepEqual(motion, [true, false]);
});

test('disarms and reports a rejected pose publish', async () => {
  const errors: unknown[] = [];
  const armed: boolean[] = [];
  const controller = new PoseTeleopController({
    ros: { publish: async () => Promise.reject(new Error('publish denied')) } as any,
    onArmedChange: (value) => armed.push(value),
    onPublishError: (error) => errors.push(error),
  });
  controller.setTargetTopic('/robot_a/teleop_target_pose');
  controller.setRobotPose(robotPose as any);
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: true, frameTogglePressed: false }, 0);
  controller.update({ pose: controllerPose(0), squeeze: 1, armPressed: false, frameTogglePressed: false }, 40);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((errors[0] as Error).message, 'publish denied');
  assert.deepEqual(armed, [true, false]);
});

test('B/Y toggles translation into the tool frame, like joy_to_cartesian', () => {
  const published: any[] = [];
  const frames: string[] = [];
  const controller = new PoseTeleopController({
    ros: { publish: async (options: unknown) => void published.push(options) } as any,
    onFrameChange: (frame) => frames.push(frame),
  });
  controller.setTargetTopic('/robot_small/teleop_command');
  // Tool yawed +90° about robot Z: robot -Y (controller right) becomes robot +X in tool axes.
  controller.setRobotPose({ ...robotPose, pose: { ...robotPose.pose, orientation: { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 } } } as any);
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: true, frameTogglePressed: false }, 0);
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: false, frameTogglePressed: true }, 40);
  controller.update({ pose: controllerPose(0.02), squeeze: 1, armPressed: false, frameTogglePressed: true }, 80);

  assert.deepEqual(frames, ['tool']);
  assert.equal(controller.frame, 'tool');
  const { x, y } = published.at(-1).message.pose.position;
  assert.ok(Math.abs(x - 1.02) < 1e-9 && Math.abs(y - 2) < 1e-9, `got ${x}, ${y}`);
});

test('builds a single-arm fabrics joint goal for known arms only', () => {
  const home = [1, 2, 3, 4, 5, 6];
  assert.deepEqual(buildHomeGoal('robot_big', home), {
    frame: 'arm_base',
    big_joint_target: home,
    big_joint_tolerance: 0.01,
    cruise_velocity: 0,
  });
  assert.equal(buildHomeGoal('robot_other', home), null);
});

test('axis map remaps controller left/right onto robot forward/back', () => {
  const published: any[] = [];
  const controller = new PoseTeleopController({ ros: { publish: async (options: unknown) => void published.push(options) } as any });
  controller.setTargetTopic('/robot_big/teleop_command');
  controller.setMotionSettings({ ...DEFAULT_POSE_TELEOP_MOTION_SETTINGS, axisMap: { forward: '+y', left: '+x', up: '+z' } });
  controller.setRobotPose(robotPose as any);
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: true, frameTogglePressed: false }, 0);
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: false, frameTogglePressed: false }, 40);
  controller.update({ pose: controllerPose(0.02), squeeze: 1, armPressed: false, frameTogglePressed: false }, 80);

  const { x, y } = published.at(-1).message.pose.position;
  assert.ok(Math.abs(x - 0.98) < 1e-9 && Math.abs(y - 2) < 1e-9, `got ${x}, ${y}`); // right = -left = robot -X
});

test('rotation follows the axis map, including mirrored maps', () => {
  // Mirrored map (left -> -Y) is a reflection; M R M^T must still be a proper rotation.
  const m = axisMapMatrix({ forward: '+x', left: '-y', up: '+z' });
  assert.ok(Math.abs(m.determinant() + 1) < 1e-9);
  const published: any[] = [];
  const controller = new PoseTeleopController({ ros: { publish: async (options: unknown) => void published.push(options) } as any });
  controller.setTargetTopic('/robot_big/teleop_command');
  controller.setMotionSettings({ ...DEFAULT_POSE_TELEOP_MOTION_SETTINGS, rotationDeadzoneRad: 0, axisMap: { forward: '+x', left: '-y', up: '+z' } });
  controller.setRobotPose(robotPose as any);
  const yawed = (angle: number) => ({ position: new THREE.Vector3(), orientation: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle) });
  controller.update({ pose: yawed(0), squeeze: 0, armPressed: true, frameTogglePressed: false }, 0);
  controller.update({ pose: yawed(0), squeeze: 0, armPressed: false, frameTogglePressed: false }, 40);
  controller.update({ pose: yawed(0.1), squeeze: 1, armPressed: false, frameTogglePressed: false }, 80);
  const q = published.at(-1).message.pose.orientation; // Yaw about up stays about Z, mirrored in sign by the flipped Y.
  assert.ok(Math.abs(q.z + Math.sin(0.05)) < 1e-6 && Math.abs(q.x) < 1e-9 && Math.abs(q.y) < 1e-9, JSON.stringify(q));
});
