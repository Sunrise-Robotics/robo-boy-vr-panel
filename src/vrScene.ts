// Ported from ~/sunrise/whep-test/public/vr-scene.js (a working proof of concept already tested
// in a Quest headset): video-texture-on-a-plane per camera stream, controller ray for grab/drop,
// exit button. Camera-toggle buttons are dropped -- this panel connects every discovered stream
// automatically rather than offering a manual per-camera picker.
import * as THREE from 'three';

const PANEL_POSITIONS: Array<[number, number, number]> = [
  [-1.8, 1.7, -2.8],
  [0, 1.7, -2.8],
  [1.8, 1.7, -2.8],
  [-0.9, 0.5, -2.4],
  [0.9, 0.5, -2.4],
];

function labelTexture(text: string, color = '#222'): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 96;
  const context = canvas.getContext('2d')!;
  context.fillStyle = color;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#fff';
  context.font = 'bold 38px system-ui';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, 256, 48);
  return new THREE.CanvasTexture(canvas);
}

interface PanelEntry {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  home: [number, number, number];
  drag: { scale: number; distance: number } | null;
}

export interface VrSceneOptions {
  onGamepad(gamepad: Gamepad | null): void;
  onExit(): void;
}

export class VrScene {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly panels = new Map<string, PanelEntry>();
  private readonly controllers: THREE.XRTargetRaySpace[];
  private readonly raycaster = new THREE.Raycaster();
  private readonly tempMatrix = new THREE.Matrix4();
  private readonly viewerPosition = new THREE.Vector3();
  private readonly controllerPosition = new THREE.Vector3();
  private readonly targetPosition = new THREE.Vector3();
  private readonly exitButton: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly onGamepad: VrSceneOptions['onGamepad'];
  private readonly onExitCallback: VrSceneOptions['onExit'];
  private session: XRSession | null = null;
  private grabbedBy = new Map<THREE.XRTargetRaySpace, THREE.Mesh>();

  constructor(options: VrSceneOptions) {
    this.onGamepad = options.onGamepad;
    this.onExitCallback = options.onExit;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.xr.enabled = true;
    // Hidden on the flat panel: this canvas only ever needs to be seen inside the headset, once
    // an immersive session takes it over.
    Object.assign(this.renderer.domElement.style, {
      position: 'fixed',
      width: '1px',
      height: '1px',
      opacity: '0',
      pointerEvents: 'none',
    });

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#101820');
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 100);
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#334455', 2));

    this.controllers = [this.renderer.xr.getController(0), this.renderer.xr.getController(1)];
    this.controllers.forEach((controller) => {
      controller.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -5)]),
          new THREE.LineBasicMaterial({ color: '#66ccff' })
        )
      );
      controller.addEventListener('selectstart', () => this.select(controller));
      controller.addEventListener('selectend', () => this.drop(controller));
      this.scene.add(controller);
    });

    this.exitButton = new THREE.Mesh(
      new THREE.PlaneGeometry(1.1, 0.26),
      new THREE.MeshBasicMaterial({ map: labelTexture('Exit VR', '#7a3535') })
    );
    this.exitButton.position.set(1.25, 2.25, -2.5);
    this.scene.add(this.exitButton);

    this.renderer.setAnimationLoop(() => this.render());
  }

  mountCanvas(container: HTMLElement): void {
    container.append(this.renderer.domElement);
  }

  addStream(id: string, label: string, video: HTMLVideoElement): void {
    if (this.panels.has(id)) return;
    const texture = new THREE.VideoTexture(video);
    texture.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1.6, 0.9),
      new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide })
    );
    const home = PANEL_POSITIONS[this.panels.size % PANEL_POSITIONS.length];
    mesh.position.set(...home);
    this.panels.set(id, { mesh, home, drag: null });
    this.scene.add(mesh);
    void label; // reserved for a future name label, matching the camera-toggle button whep-test drew
  }

  removeStream(id: string): void {
    const entry = this.panels.get(id);
    if (!entry) return;
    entry.mesh.material.map?.dispose();
    entry.mesh.material.dispose();
    entry.mesh.geometry.dispose();
    this.scene.remove(entry.mesh);
    this.panels.delete(id);
  }

  async enter(): Promise<void> {
    this.panels.forEach((entry) => entry.mesh.position.set(...entry.home));
    const session = await navigator.xr!.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
    this.session = session;
    session.addEventListener('end', () => {
      this.session = null;
      this.onExitCallback();
    });
    this.renderer.xr.setReferenceSpaceType('local');
    await this.renderer.xr.setSession(session);
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    void this.session?.end().catch(() => {});
    [...this.panels.keys()].forEach((id) => this.removeStream(id));
    this.exitButton.material.map?.dispose();
    this.exitButton.material.dispose();
    this.exitButton.geometry.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private hits(controller: THREE.XRTargetRaySpace, items: THREE.Object3D[]): THREE.Object3D | undefined {
    this.tempMatrix.identity().extractRotation(controller.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tempMatrix);
    return this.raycaster.intersectObjects(items)[0]?.object;
  }

  private select(controller: THREE.XRTargetRaySpace): void {
    if (this.hits(controller, [this.exitButton])) {
      void this.session?.end();
      return;
    }
    this.grab(controller);
  }

  private grab(controller: THREE.XRTargetRaySpace): void {
    const target = this.hits(
      controller,
      [...this.panels.values()].map((entry) => entry.mesh)
    ) as THREE.Mesh | undefined;
    const entry = target && [...this.panels.values()].find((candidate) => candidate.mesh === target);
    if (!entry || entry.drag) return;
    this.viewerPosition.setFromMatrixPosition(this.renderer.xr.getCamera().matrixWorld);
    controller.getWorldPosition(this.controllerPosition);
    entry.drag = {
      scale: entry.mesh.scale.x,
      distance: Math.max(0.1, this.controllerPosition.distanceTo(this.viewerPosition)),
    };
    controller.attach(entry.mesh);
    this.grabbedBy.set(controller, entry.mesh);
  }

  private drop(controller: THREE.XRTargetRaySpace): void {
    const mesh = this.grabbedBy.get(controller);
    if (!mesh) return;
    this.scene.attach(mesh);
    const entry = [...this.panels.values()].find((candidate) => candidate.mesh === mesh);
    if (entry) {
      entry.drag = null;
      this.faceViewer(entry.mesh);
    }
    this.grabbedBy.delete(controller);
  }

  private faceViewer(mesh: THREE.Mesh): void {
    this.targetPosition.copy(this.viewerPosition);
    this.targetPosition.y = mesh.position.y;
    mesh.lookAt(this.targetPosition);
  }

  private render(): void {
    if (this.session) {
      const right = [...this.session.inputSources].find((source) => source.handedness === 'right')?.gamepad;
      this.onGamepad(right ?? null);
      this.viewerPosition.setFromMatrixPosition(this.renderer.xr.getCamera().matrixWorld);
      this.panels.forEach((entry) => {
        if (entry.drag) {
          entry.mesh.parent?.getWorldPosition(this.controllerPosition);
          const scale =
            (entry.drag.scale * entry.drag.distance) / Math.max(0.1, this.controllerPosition.distanceTo(this.viewerPosition));
          entry.mesh.scale.setScalar(THREE.MathUtils.clamp(scale, 0.25, 4));
        } else {
          this.faceViewer(entry.mesh);
        }
      });
    }
    this.renderer.render(this.scene, this.camera);
  }
}
