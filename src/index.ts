import type {
  RoboBoyJsonValue,
  RoboBoyPanelContext,
  RoboBoyPanelDefinition,
  RoboBoyPanelInstance,
} from '@tessel-la/roboboy-panel-sdk';
import {
  connectWhep,
  deriveGatewayEndpoints,
  discoverGatewayStreams,
  isWebRtcSupported,
  normalizeWhepEndpoint,
  WEBRTC_UNSUPPORTED_MESSAGE,
  type GatewayStream,
  type WhepConnection,
} from './whep';
import { VrScene } from './vrScene';
import { PoseTeleopController } from './poseTeleop';
import {
  DEFAULT_PANEL_SETTINGS,
  flangePoseTopicForRobot,
  isRosTopic,
  isRobotName,
  panelSettingsToJson,
  parsePanelSettings,
  type PanelSettings,
} from './panelSettings';
import {
  canSelectStream,
  defaultSelectedStreamNames,
  MAX_SELECTED_STREAMS,
} from './cameraSelection';

const PANEL_ID = 'co.sunriserobotics.roboboy.vr';
const FLANGE_POSE_SUFFIX = '/flange_pose';
const POSE_STAMPED_TYPE = 'geometry_msgs/msg/PoseStamped';

const PANEL_MARKUP = `
<div class="rb-vr">
  <style>
    .rb-vr { display: flex; flex-direction: column; gap: .6rem; padding: .75rem; height: 100%; overflow: auto; box-sizing: border-box; font-family: var(--font-family-ui, system-ui, sans-serif); color: var(--text-color, #eee); }
    .rb-vr button { font: inherit; padding: .5rem 1rem; border-radius: .4rem; border: 1px solid var(--border-color, #444); background: var(--primary-color, #2a6fb0); color: var(--button-text-color, #fff); cursor: pointer; }
    .rb-vr button:disabled { opacity: .5; cursor: default; }
    .rb-vr [data-role="actions"] { display: flex; gap: .5rem; flex-wrap: wrap; }
    .rb-vr [data-action="settings"], .rb-vr [data-action="settings-cancel"] { background: var(--secondary-color, transparent); color: var(--text-color, #eee); }
    .rb-vr [data-role="status"] { color: var(--text-secondary, #aaa); font-size: .85rem; white-space: pre-line; }
    .rb-vr [data-role="armed"] { font-weight: 600; }
    .rb-vr [data-role="armed"][data-armed="true"] { color: var(--success-color, #4caf50); }
    .rb-vr [data-role="motion"] { display: flex; align-items: center; gap: .4rem; font-weight: 600; color: var(--error-color, #dd6b6b); }
    .rb-vr [data-role="motion"][data-moving="true"] { color: var(--success-color, #4caf50); }
    .rb-vr [data-role="motion-light"] { width: .7rem; height: .7rem; border-radius: 50%; background: var(--error-color, #b62222); }
    .rb-vr [data-role="motion"][data-moving="true"] [data-role="motion-light"] { background: var(--success-color, #25b84b); }
    .rb-vr [data-role="cameras"] { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .35rem .75rem; }
    .rb-vr [data-role="cameras"] label { display: flex; align-items: center; gap: .4rem; font-size: .9rem; }
    .rb-vr [data-role="previews"] { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .5rem; }
    .rb-vr [data-role="previews"] video { width: 100%; background: #000; border-radius: .25rem; }
    .rb-vr [data-role="settings"] { display: grid; gap: .75rem; padding: .75rem; border: 1px solid var(--card-border, var(--border-color, #444)); border-radius: .5rem; background: var(--card-bg, transparent); }
    .rb-vr [data-role="settings"] fieldset { display: grid; gap: .6rem; min-width: 0; margin: 0; padding: .7rem; border: 1px solid var(--border-color, #444); border-radius: .4rem; }
    .rb-vr [data-role="settings"] legend { padding: 0 .25rem; font-weight: 600; }
    .rb-vr [data-role="settings"] label { display: grid; gap: .25rem; font-size: .85rem; }
    .rb-vr [data-role="settings"] input { min-width: 0; box-sizing: border-box; font: inherit; }
    .rb-vr [data-role="settings"] input[type="text"] { width: 100%; padding: .4rem; }
    .rb-vr [data-role="setting-value"] { color: var(--text-secondary, #aaa); font-size: .8rem; }
    .rb-vr [data-role="settings-error"] { min-height: 1.2rem; color: var(--error-color, #dd6b6b); font-size: .85rem; }
    .rb-vr [data-role="settings-actions"] { display: flex; gap: .5rem; justify-content: flex-end; }
    .rb-vr details { border-top: 1px solid var(--border-color, #444); padding-top: .6rem; font-size: .85rem; }
    .rb-vr details ul { display: grid; gap: .35rem; margin: .5rem 0 0; padding-left: 1.2rem; }
  </style>
  <div data-role="actions"><button data-action="enter" disabled>Enter VR</button><button data-action="settings" aria-expanded="false">Settings</button></div>
  <div data-role="status">Discovering camera streams…</div>
  <form data-role="settings" hidden>
    <fieldset>
      <legend>Robot and ROS</legend>
      <label>Robot namespace<input data-setting="robot-name" type="text" list="rb-vr-robot-names" required pattern="[A-Za-z0-9][A-Za-z0-9_-]*" /></label>
      <datalist id="rb-vr-robot-names"><option value="robot_small"></option><option value="robot_big"></option></datalist>
      <label>Pose target topic<input data-setting="target-topic" type="text" required /></label>
      <span data-role="setting-value">Publishes <code>geometry_msgs/msg/PoseStamped</code>. The source pose remains <code data-role="flange-topic"></code>.</span>
    </fieldset>
    <fieldset>
      <legend>Motion tuning</legend>
      <label>Translation deadzone <span data-role="translation-deadzone-value"></span><input data-setting="translation-deadzone" type="range" min="0" max="0.03" step="0.001" /></label>
      <label>Rotation deadzone <span data-role="rotation-deadzone-value"></span><input data-setting="rotation-deadzone" type="range" min="0" max="10" step="0.5" /></label>
      <label>Translation sensitivity <span data-role="translation-sensitivity-value"></span><input data-setting="translation-sensitivity" type="range" min="0.25" max="2" step="0.05" /></label>
      <label>Rotation sensitivity <span data-role="rotation-sensitivity-value"></span><input data-setting="rotation-sensitivity" type="range" min="0.25" max="2" step="0.05" /></label>
      <label>Clutch threshold <span data-role="squeeze-threshold-value"></span><input data-setting="squeeze-threshold" type="range" min="0.1" max="0.9" step="0.05" /></label>
    </fieldset>
    <div data-role="settings-error" role="alert"></div>
    <div data-role="settings-actions"><button type="button" data-action="settings-cancel">Cancel</button><button type="submit">Save settings</button></div>
  </form>
  <div data-role="cameras" aria-label="Camera streams"></div>
  <div data-role="armed" data-armed="false">Pose control disarmed</div>
  <div data-role="motion" data-moving="false"><span data-role="motion-light"></span><span data-role="motion-text">Motion idle</span></div>
  <details><summary>VR controls</summary><ul><li>Trigger at a camera name toggles that stream.</li><li>Grip either controller to grab and reposition a camera panel.</li><li>Right A arms or disarms pose publishing; it re-anchors when arming.</li><li>Right B re-anchors to the latest flange pose.</li><li>Hold the right squeeze as a clutch to move the pose target; release holds it.</li><li>Trigger at Exit VR leaves the headset session.</li></ul></details>
  <div data-role="previews"></div>
  <div data-role="canvas-host"></div>
</div>
`;

const createPanelInstance = (context: RoboBoyPanelContext): RoboBoyPanelInstance => {
  const { network, ros, logger } = context;
  if (!network) throw new Error('The VR panel requires the network capability.');
  if (!ros) throw new Error('The VR panel requires the ros capability.');

  const whepBaseUrl = network.endpoints.webrtcWhep ?? '';
  const discoveryEndpoint = network.endpoints.webrtcDiscovery ?? '';
  const browserBaseUrl = typeof location !== 'undefined' ? location.href : 'https://roboboy.invalid/';

  let root: HTMLElement | null = null;
  let active = true;
  let discoveryController: AbortController | null = null;
  let vrScene: VrScene | null = null;
  let discoveredStreams: GatewayStream[] = [];
  let hasInitialSelection = false;
  let settings: PanelSettings = parsePanelSettings(
    context.storage?.get<RoboBoyJsonValue>('settings', panelSettingsToJson(DEFAULT_PANEL_SETTINGS))
      ?? panelSettingsToJson(DEFAULT_PANEL_SETTINGS),
  );
  const selectedStreamNames = new Set<string>();
  const connections = new Map<string, WhepConnection>();
  const connectionControllers = new Map<string, AbortController>();
  const videos = new Map<string, HTMLVideoElement>();
  let flangePoseSubscription: { unsubscribe(): Promise<void> } | null = null;
  let robotSubscriptionGeneration = 0;

  const poseTeleopController = new PoseTeleopController({
    ros,
    onArmedChange: (armed) => {
      const el = root?.querySelector<HTMLElement>('[data-role="armed"]');
      if (!el) return;
      el.dataset.armed = String(armed);
      el.textContent = armed ? 'Pose control armed — hold right squeeze to move' : 'Pose control disarmed';
    },
    onMotionChange: (moving) => {
      const el = root?.querySelector<HTMLElement>('[data-role="motion"]');
      if (el) {
        el.dataset.moving = String(moving);
        const text = el.querySelector<HTMLElement>('[data-role="motion-text"]');
        if (text) text.textContent = moving ? 'Motion enabled' : 'Motion idle';
      }
      vrScene?.setMotionActive(moving);
    },
    onPublishError: (error) => {
      logger.warn('Unable to publish the pose target.', error);
      setStatus(`Pose target publish failed: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
  poseTeleopController.setMotionSettings(settings.motion);

  const setStatus = (text: string) => {
    const el = root?.querySelector<HTMLElement>('[data-role="status"]');
    if (el) el.textContent = text;
  };

  const setEnterEnabled = () => {
    const button = root?.querySelector<HTMLButtonElement>('[data-action="enter"]');
    if (button) button.disabled = connections.size === 0;
  };

  const saveSettings = () => {
    if (!context.storage) return;
    try {
      context.storage.set('settings', panelSettingsToJson(settings));
    } catch (error) {
      logger.warn('Unable to save VR panel settings.', error);
      setStatus('Settings could not be saved, but remain active until this panel closes.');
    }
  };

  const setSettingsFormValues = () => {
    const settingsForm = root?.querySelector<HTMLFormElement>('[data-role="settings"]');
    if (!settingsForm) return;
    const setValue = (selector: string, value: string) => {
      const input = settingsForm.querySelector<HTMLInputElement>(selector);
      if (input) input.value = value;
    };
    setValue('[data-setting="robot-name"]', settings.robotName);
    setValue('[data-setting="target-topic"]', settings.targetPoseTopic);
    setValue('[data-setting="translation-deadzone"]', String(settings.motion.translationDeadzoneM));
    setValue('[data-setting="rotation-deadzone"]', String(settings.motion.rotationDeadzoneRad * 180 / Math.PI));
    setValue('[data-setting="translation-sensitivity"]', String(settings.motion.translationSensitivity));
    setValue('[data-setting="rotation-sensitivity"]', String(settings.motion.rotationSensitivity));
    setValue('[data-setting="squeeze-threshold"]', String(settings.motion.squeezeThreshold));
    const flangeTopic = settingsForm.querySelector<HTMLElement>('[data-role="flange-topic"]');
    if (flangeTopic) flangeTopic.textContent = flangePoseTopicForRobot(settings.robotName);
    const robotNameInput = settingsForm.querySelector<HTMLInputElement>('[data-setting="robot-name"]');
    if (robotNameInput) {
      robotNameInput.oninput = () => {
        if (flangeTopic && isRobotName(robotNameInput.value.trim())) {
          flangeTopic.textContent = flangePoseTopicForRobot(robotNameInput.value.trim());
        }
      };
    }
    const updateValues = () => {
      const values: Array<[string, string, (value: number) => string]> = [
        ['translation-deadzone', 'translation-deadzone-value', (value) => `${(value * 1000).toFixed(0)} mm`],
        ['rotation-deadzone', 'rotation-deadzone-value', (value) => `${value.toFixed(1)}°`],
        ['translation-sensitivity', 'translation-sensitivity-value', (value) => `${value.toFixed(2)}×`],
        ['rotation-sensitivity', 'rotation-sensitivity-value', (value) => `${value.toFixed(2)}×`],
        ['squeeze-threshold', 'squeeze-threshold-value', (value) => `${value.toFixed(2)}`],
      ];
      for (const [inputName, outputRole, format] of values) {
        const input = settingsForm.querySelector<HTMLInputElement>(`[data-setting="${inputName}"]`);
        const output = settingsForm.querySelector<HTMLElement>(`[data-role="${outputRole}"]`);
        if (input && output) output.textContent = format(Number(input.value));
      }
    };
    settingsForm.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach((input) => {
      input.oninput = updateValues;
    });
    updateValues();
  };

  const setSettingsOpen = (open: boolean) => {
    const settingsForm = root?.querySelector<HTMLFormElement>('[data-role="settings"]');
    const settingsButton = root?.querySelector<HTMLButtonElement>('[data-action="settings"]');
    if (!settingsForm || !settingsButton) return;
    if (open) setSettingsFormValues();
    settingsForm.hidden = !open;
    settingsButton.setAttribute('aria-expanded', String(open));
  };

  const configureRobot = async () => {
    const robotName = settings.robotName;

    const generation = ++robotSubscriptionGeneration;
    poseTeleopController.setTargetTopic(settings.targetPoseTopic);
    const previousSubscription = flangePoseSubscription;
    flangePoseSubscription = null;
    if (previousSubscription) await previousSubscription.unsubscribe().catch((error) => logger.warn('Unable to unsubscribe from the previous flange pose.', error));

    try {
      const subscription = await ros.subscribe(
        {
          topic: `/${robotName}${FLANGE_POSE_SUFFIX}`,
          messageType: POSE_STAMPED_TYPE,
          throttleMs: 33,
          queueLength: 1,
        },
        (message) => {
          if (generation === robotSubscriptionGeneration) poseTeleopController.setRobotPose(message);
        }
      );
      if (generation !== robotSubscriptionGeneration) {
        await subscription.unsubscribe();
        return;
      }
      flangePoseSubscription = subscription;
      setStatus(`Using ${robotName}. Waiting for ${flangePoseTopicForRobot(robotName)}.`);
    } catch (error) {
      if (generation === robotSubscriptionGeneration) {
        setStatus(`Unable to subscribe to ${flangePoseTopicForRobot(robotName)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  const cameraByName = (name: string) => discoveredStreams.find((stream) => stream.name === name);

  const renderCameraControls = () => {
    const container = root?.querySelector<HTMLElement>('[data-role="cameras"]');
    if (!container) return;
    container.replaceChildren();
    for (const stream of discoveredStreams) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedStreamNames.has(stream.name);
      checkbox.addEventListener('change', () => toggleStream(stream.name, checkbox.checked));
      label.append(checkbox, document.createTextNode(stream.name));
      container.append(label);
    }
    vrScene?.setCameras(
      discoveredStreams.map((stream) => ({
        id: stream.name,
        label: stream.name,
        enabled: selectedStreamNames.has(stream.name),
      }))
    );
  };

  const removeVideo = (name: string) => {
    const video = videos.get(name);
    videos.delete(name);
    if (!video) return;
    video.pause();
    video.srcObject = null;
    video.remove();
  };

  const disconnectStream = async (name: string) => {
    connectionControllers.get(name)?.abort();
    connectionControllers.delete(name);
    const connection = connections.get(name);
    connections.delete(name);
    vrScene?.removeStream(name);
    removeVideo(name);
    setEnterEnabled();
    if (connection) await connection.close().catch(() => {});
  };

  const connectStream = async (stream: GatewayStream) => {
    if (!selectedStreamNames.has(stream.name) || connections.has(stream.name) || connectionControllers.has(stream.name)) return;

    const controller = new AbortController();
    connectionControllers.set(stream.name, controller);
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    videos.set(stream.name, video);
    root?.querySelector('[data-role="previews"]')?.append(video);

    try {
      const endpoint = normalizeWhepEndpoint(
        deriveGatewayEndpoints(whepBaseUrl, stream.name).whep,
        browserBaseUrl,
      );
      const connection = await connectWhep({
        endpoint,
        fetcher: network.fetch,
        signal: controller.signal,
        onTrack(event) {
          if (!active || !selectedStreamNames.has(stream.name)) return;
          video.srcObject = event.streams[0] ?? new MediaStream([event.track]);
          void video.play().catch(() => {});
          vrScene?.addStream(stream.name, stream.name, video);
        },
        onStateChange(state) {
          if (state === 'failed' || state === 'disconnected') {
            logger.warn(`WebRTC ${state} for stream "${stream.name}".`);
          }
        },
      });
      if (!active || !selectedStreamNames.has(stream.name) || controller.signal.aborted) {
        await connection.close().catch(() => {});
        return;
      }
      connections.set(stream.name, connection);
      setEnterEnabled();
      setStatus(`${connections.size} of ${selectedStreamNames.size} selected stream(s) connected. Put on your headset and enter VR.`);
    } catch (error) {
      if (!controller.signal.aborted) {
        logger.warn(`Unable to connect stream "${stream.name}".`, error);
        setStatus(`Unable to connect ${stream.name}. Toggle it off and on to retry.`);
      }
      if (videos.get(stream.name) === video) removeVideo(stream.name);
    } finally {
      if (connectionControllers.get(stream.name) === controller) connectionControllers.delete(stream.name);
    }
  };

  const connectSelectedStreams = () => {
    for (const stream of discoveredStreams) {
      if (selectedStreamNames.has(stream.name)) void connectStream(stream);
    }
  };

  const toggleStream = (name: string, enabled: boolean) => {
    const stream = cameraByName(name);
    if (!stream) return;
    if (enabled) {
      if (!canSelectStream(selectedStreamNames, name)) {
        setStatus(`At most ${MAX_SELECTED_STREAMS} cameras can be enabled at once.`);
        renderCameraControls();
        return;
      }
      selectedStreamNames.add(name);
      settings.selectedStreamNames = [...selectedStreamNames];
      saveSettings();
      renderCameraControls();
      void connectStream(stream);
      return;
    }
    selectedStreamNames.delete(name);
    settings.selectedStreamNames = [...selectedStreamNames];
    saveSettings();
    renderCameraControls();
    void disconnectStream(name);
  };

  const refreshStreams = async () => {
    if (!isWebRtcSupported()) {
      setStatus(WEBRTC_UNSUPPORTED_MESSAGE);
      return;
    }
    discoveryController?.abort();
    const controller = new AbortController();
    discoveryController = controller;
    try {
      const streams = await discoverGatewayStreams(discoveryEndpoint, controller.signal, network.fetch);
      if (controller.signal.aborted || !active) return;
      discoveredStreams = streams;
      const availableNames = new Set(streams.map((stream) => stream.name));
      for (const name of selectedStreamNames) {
        if (!availableNames.has(name)) selectedStreamNames.delete(name);
      }
      if (!hasInitialSelection && streams.length > 0) {
        hasInitialSelection = true;
        if (settings.selectedStreamNames === null) {
          defaultSelectedStreamNames(streams).forEach((name) => selectedStreamNames.add(name));
          settings.selectedStreamNames = [...selectedStreamNames];
          saveSettings();
        }
      }
      renderCameraControls();
      if (streams.length === 0) {
        setStatus('No camera streams are currently configured.');
        return;
      }
      setStatus(`${selectedStreamNames.size} of ${streams.length} discovered camera stream(s) selected.`);
      connectSelectedStreams();
    } catch (error) {
      if (controller.signal.aborted || !active) return;
      setStatus(`Stream discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (discoveryController === controller) discoveryController = null;
    }
  };

  const teardownStreams = async () => {
    await Promise.all([...new Set([...connections.keys(), ...connectionControllers.keys()])].map((name) => disconnectStream(name)));
  };

  return {
    mount(container) {
      container.innerHTML = PANEL_MARKUP;
      root = container.querySelector<HTMLElement>('.rb-vr');
      if (!root) throw new Error('Unable to create the VR panel root.');

      vrScene = new VrScene({
        onRightControllerFrame: (frame) => poseTeleopController.update(frame),
        onToggle: (name) => toggleStream(name, !selectedStreamNames.has(name)),
        onExit: () => {
          poseTeleopController.stop();
          setStatus('VR session ended.');
        },
      });
      vrScene.mountCanvas(root.querySelector('[data-role="canvas-host"]')!);

      root.addEventListener('click', (event) => {
        const action = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-action]')?.dataset.action : undefined;
        if (action === 'settings') {
          setSettingsOpen(true);
          return;
        }
        if (action === 'settings-cancel') {
          setSettingsOpen(false);
          return;
        }
        if (action === 'enter') {
          void vrScene
            ?.enter()
            .then(() => setStatus('In VR: A arms pose control, B re-anchors, and right squeeze is the clutch.'))
            .catch((error) => setStatus(`Entering VR failed: ${error instanceof Error ? error.message : String(error)}`));
        }
      });

      root.querySelector<HTMLFormElement>('[data-role="settings"]')?.addEventListener('submit', (event) => {
        event.preventDefault();
        const form = event.currentTarget as HTMLFormElement;
        const value = (setting: string) => form.querySelector<HTMLInputElement>(`[data-setting="${setting}"]`)?.value.trim() ?? '';
        const robotName = value('robot-name');
        const targetPoseTopic = value('target-topic');
        const error = form.querySelector<HTMLElement>('[data-role="settings-error"]');
        if (!isRobotName(robotName)) {
          if (error) error.textContent = 'Robot namespace must contain only letters, digits, hyphens, and underscores.';
          return;
        }
        if (!isRosTopic(targetPoseTopic)) {
          if (error) error.textContent = 'Pose target topic must be an absolute ROS topic name.';
          return;
        }
        settings = parsePanelSettings({
          version: 1,
          robotName,
          targetPoseTopic,
          selectedStreamNames: settings.selectedStreamNames,
          motion: {
            translationDeadzoneM: Number(value('translation-deadzone')),
            rotationDeadzoneRad: Number(value('rotation-deadzone')) * Math.PI / 180,
            translationSensitivity: Number(value('translation-sensitivity')),
            rotationSensitivity: Number(value('rotation-sensitivity')),
            squeezeThreshold: Number(value('squeeze-threshold')),
          },
        });
        poseTeleopController.stop();
        poseTeleopController.setMotionSettings(settings.motion);
        saveSettings();
        if (error) error.textContent = '';
        setSettingsOpen(false);
        void configureRobot();
        setStatus(`Settings saved. Using ${settings.targetPoseTopic}; arm again after the flange pose arrives.`);
      });

      selectedStreamNames.clear();
      settings.selectedStreamNames?.forEach((name) => selectedStreamNames.add(name));
      void configureRobot();
      void refreshStreams();
    },
    setActive(isActive) {
      const wasActive = active;
      active = isActive;
      if (!isActive) {
        poseTeleopController.stop();
        void teardownStreams();
      } else if (!wasActive) {
        void refreshStreams();
      }
    },
    async unmount() {
      active = false;
      discoveryController?.abort();
      discoveryController = null;
      poseTeleopController.stop();
      robotSubscriptionGeneration += 1;
      const subscription = flangePoseSubscription;
      flangePoseSubscription = null;
      if (subscription) await subscription.unsubscribe().catch((error) => logger.warn('Unable to unsubscribe from the flange pose.', error));
      await teardownStreams();
      vrScene?.dispose();
      vrScene = null;
      root?.remove();
      root = null;
    },
  };
};

const definition: RoboBoyPanelDefinition = {
  apiVersion: '2.0.0',
  id: PANEL_ID,
  activate: createPanelInstance,
};

export default definition;
