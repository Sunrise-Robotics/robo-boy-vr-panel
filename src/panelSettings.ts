import type { RoboBoyJsonObject, RoboBoyJsonValue } from '@tessel-la/roboboy-panel-sdk';
import {
  DEFAULT_POSE_TELEOP_MOTION_SETTINGS,
  type PoseTeleopMotionSettings,
} from './poseTeleop';

export interface PanelSettings {
  version: 1;
  robotName: string;
  targetPoseTopic: string;
  selectedStreamNames: string[] | null;
  motion: PoseTeleopMotionSettings;
}

export const DEFAULT_ROBOT_NAME = 'robot_small';

export const targetPoseTopicForRobot = (robotName: string): string =>
  `/${robotName}/teleop_target_pose`;

export const flangePoseTopicForRobot = (robotName: string): string =>
  `/${robotName}/flange_pose`;

export const isRobotName = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);

export const isRosTopic = (value: string): boolean =>
  /^\/(?:[^/\s]+\/)*[^/\s]+$/.test(value);

export const DEFAULT_PANEL_SETTINGS: PanelSettings = {
  version: 1,
  robotName: DEFAULT_ROBOT_NAME,
  targetPoseTopic: targetPoseTopicForRobot(DEFAULT_ROBOT_NAME),
  selectedStreamNames: null,
  motion: { ...DEFAULT_POSE_TELEOP_MOTION_SETTINGS },
};

const finiteInRange = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;

const stringArray = (value: unknown): string[] | null => {
  if (value === null) return null;
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))].slice(0, 5);
};

export const parsePanelSettings = (value: RoboBoyJsonValue): PanelSettings => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_PANEL_SETTINGS, motion: { ...DEFAULT_PANEL_SETTINGS.motion } };

  const stored = value as Record<string, unknown>;
  const robotName = typeof stored.robotName === 'string' && isRobotName(stored.robotName)
    ? stored.robotName
    : DEFAULT_ROBOT_NAME;
  const motion = stored.motion && typeof stored.motion === 'object' && !Array.isArray(stored.motion)
    ? stored.motion as Record<string, unknown>
    : {};

  return {
    version: 1,
    robotName,
    targetPoseTopic: typeof stored.targetPoseTopic === 'string' && isRosTopic(stored.targetPoseTopic)
      ? stored.targetPoseTopic
      : targetPoseTopicForRobot(robotName),
    selectedStreamNames: stringArray(stored.selectedStreamNames),
    motion: {
      translationDeadzoneM: finiteInRange(motion.translationDeadzoneM, DEFAULT_POSE_TELEOP_MOTION_SETTINGS.translationDeadzoneM, 0, 0.03),
      rotationDeadzoneRad: finiteInRange(motion.rotationDeadzoneRad, DEFAULT_POSE_TELEOP_MOTION_SETTINGS.rotationDeadzoneRad, 0, Math.PI / 9),
      translationSensitivity: finiteInRange(motion.translationSensitivity, DEFAULT_POSE_TELEOP_MOTION_SETTINGS.translationSensitivity, 0.25, 2),
      rotationSensitivity: finiteInRange(motion.rotationSensitivity, DEFAULT_POSE_TELEOP_MOTION_SETTINGS.rotationSensitivity, 0.25, 2),
      squeezeThreshold: finiteInRange(motion.squeezeThreshold, DEFAULT_POSE_TELEOP_MOTION_SETTINGS.squeezeThreshold, 0.1, 0.9),
    },
  };
};

export const panelSettingsToJson = (settings: PanelSettings): RoboBoyJsonObject => ({
  version: settings.version,
  robotName: settings.robotName,
  targetPoseTopic: settings.targetPoseTopic,
  selectedStreamNames: settings.selectedStreamNames,
  motion: {
    translationDeadzoneM: settings.motion.translationDeadzoneM,
    rotationDeadzoneRad: settings.motion.rotationDeadzoneRad,
    translationSensitivity: settings.motion.translationSensitivity,
    rotationSensitivity: settings.motion.rotationSensitivity,
    squeezeThreshold: settings.motion.squeezeThreshold,
  },
});
