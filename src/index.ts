import type {
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
import { DriveController } from './drive';
import {
  canSelectStream,
  defaultSelectedStreamNames,
  MAX_SELECTED_STREAMS,
} from './cameraSelection';

const PANEL_ID = 'co.sunriserobotics.roboboy.vr';
const DRIVE_TOPIC = '/cmd_vel';

const PANEL_MARKUP = `
<div class="rb-vr">
  <style>
    .rb-vr { display: flex; flex-direction: column; gap: .5rem; padding: .75rem; height: 100%; box-sizing: border-box; font-family: var(--font-family-ui, system-ui, sans-serif); color: var(--text-color, #eee); }
    .rb-vr button { font: inherit; padding: .5rem 1rem; border-radius: .4rem; border: 1px solid var(--border-color, #444); background: var(--primary-color, #2a6fb0); color: var(--button-text-color, #fff); cursor: pointer; }
    .rb-vr button:disabled { opacity: .5; cursor: default; }
    .rb-vr [data-role="status"] { color: var(--text-secondary, #aaa); font-size: .85rem; white-space: pre-line; }
    .rb-vr [data-role="armed"] { font-weight: 600; }
    .rb-vr [data-role="armed"][data-armed="true"] { color: var(--success-color, #4caf50); }
    .rb-vr [data-role="cameras"] { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .35rem .75rem; }
    .rb-vr [data-role="cameras"] label { display: flex; align-items: center; gap: .4rem; font-size: .9rem; }
    .rb-vr [data-role="previews"] { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .5rem; }
    .rb-vr [data-role="previews"] video { width: 100%; background: #000; border-radius: .25rem; }
  </style>
  <button data-action="enter" disabled>Enter VR</button>
  <div data-role="status">Discovering camera streams…</div>
  <div data-role="cameras" aria-label="Camera streams"></div>
  <div data-role="armed" data-armed="false">Drive disarmed</div>
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
  const selectedStreamNames = new Set<string>();
  const connections = new Map<string, WhepConnection>();
  const connectionControllers = new Map<string, AbortController>();
  const videos = new Map<string, HTMLVideoElement>();

  const driveController = new DriveController({
    ros,
    topic: DRIVE_TOPIC,
    onArmedChange: (armed) => {
      const el = root?.querySelector<HTMLElement>('[data-role="armed"]');
      if (!el) return;
      el.dataset.armed = String(armed);
      el.textContent = armed ? 'Drive armed — holding grip' : 'Drive disarmed';
    },
  });

  const setStatus = (text: string) => {
    const el = root?.querySelector<HTMLElement>('[data-role="status"]');
    if (el) el.textContent = text;
  };

  const setEnterEnabled = () => {
    const button = root?.querySelector<HTMLButtonElement>('[data-action="enter"]');
    if (button) button.disabled = connections.size === 0;
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
      renderCameraControls();
      void connectStream(stream);
      return;
    }
    selectedStreamNames.delete(name);
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
        defaultSelectedStreamNames(streams).forEach((name) => selectedStreamNames.add(name));
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
        onGamepad: (gamepad) => driveController.update(gamepad),
        onToggle: (name) => toggleStream(name, !selectedStreamNames.has(name)),
        onExit: () => {
          driveController.stop();
          setStatus('VR session ended.');
        },
      });
      vrScene.mountCanvas(root.querySelector('[data-role="canvas-host"]')!);

      root.addEventListener('click', (event) => {
        const action = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-action]')?.dataset.action : undefined;
        if (action !== 'enter') return;
        void vrScene
          ?.enter()
          .then(() => setStatus('In VR: trigger a camera name to toggle it, grip a screen to move it, or point at "Exit VR" and trigger. Hold right grip to drive.'))
          .catch((error) => setStatus(`Entering VR failed: ${error instanceof Error ? error.message : String(error)}`));
      });

      void refreshStreams();
    },
    setActive(isActive) {
      const wasActive = active;
      active = isActive;
      if (!isActive) {
        driveController.stop();
        void teardownStreams();
      } else if (!wasActive) {
        void refreshStreams();
      }
    },
    async unmount() {
      active = false;
      discoveryController?.abort();
      discoveryController = null;
      driveController.stop();
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
