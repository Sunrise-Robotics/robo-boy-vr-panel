import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { PoseTeleopController, parsePoseStamped } from '../src/poseTeleop.ts';

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
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: false, reanchorPressed: false }, 0);
  assert.equal(published.length, 0);

  controller.setRobotPose(robotPose as any);
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: true, reanchorPressed: false }, 40);
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: false, reanchorPressed: false }, 80);
  assert.equal(published.length, 1);
  assert.equal(published[0].topic, '/robot_a/teleop_target_pose');
  assert.equal(published[0].messageType, 'geometry_msgs/msg/PoseStamped');
  assert.deepEqual(published[0].message.pose.position, { x: 1, y: 2, z: 3 });
});

test('moves only while the squeeze clutch is held and holds its final target on release', () => {
  const published: any[] = [];
  const controller = new PoseTeleopController({ ros: { publish: async (options: unknown) => void published.push(options) } as any });
  controller.setTargetTopic('/robot_a/teleop_target_pose');
  controller.setRobotPose(robotPose as any);
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: true, reanchorPressed: false }, 0);
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: false, reanchorPressed: false }, 40);
  controller.update({ pose: controllerPose(0.02), squeeze: 1, armPressed: false, reanchorPressed: false }, 80);
  controller.update({ pose: controllerPose(0.04), squeeze: 0, armPressed: false, reanchorPressed: false }, 120);

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
  });
  controller.setRobotPose(robotPose as any);
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: true, reanchorPressed: false }, 0);
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: false, reanchorPressed: false }, 40);
  controller.update({ pose: controllerPose(0.002), squeeze: 1, armPressed: false, reanchorPressed: false }, 80);
  controller.update({ pose: controllerPose(0.004), squeeze: 1, armPressed: false, reanchorPressed: false }, 120);

  assert.equal(published.length, 3);
  assert.equal(published[2].message.pose.position.y, 1.998);
});

test('disarming stops pose publications', () => {
  const published: unknown[] = [];
  const controller = new PoseTeleopController({ ros: { publish: async (options: unknown) => void published.push(options) } as any });
  controller.setTargetTopic('/robot_a/teleop_target_pose');
  controller.setRobotPose(robotPose as any);
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: true, reanchorPressed: false }, 0);
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: false, reanchorPressed: false }, 40);
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: true, reanchorPressed: false }, 80);
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: false, reanchorPressed: false }, 120);
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
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: true, reanchorPressed: false }, 0);
  controller.update({ pose: controllerPose(0), squeeze: 1, armPressed: false, reanchorPressed: false }, 40);
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: false, reanchorPressed: false }, 80);
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
  controller.update({ pose: controllerPose(0), squeeze: 0, armPressed: true, reanchorPressed: false }, 0);
  controller.update({ pose: controllerPose(0), squeeze: 1, armPressed: false, reanchorPressed: false }, 40);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((errors[0] as Error).message, 'publish denied');
  assert.deepEqual(armed, [true, false]);
});
