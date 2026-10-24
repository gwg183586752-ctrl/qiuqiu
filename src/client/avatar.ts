import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import { EMOTIONS } from '../shared/protocol.ts';
import type { Segment } from '../shared/protocol.ts';

export class AvatarStage {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.05, 30);
  private vrm?: VRM;
  private disposed = false;
  private frame = 0;
  private last = performance.now();
  private cue?: Segment;
  private cueTime = 0;
  private observer: ResizeObserver;
  private poses = new Map<string, { bone: THREE.Object3D; rotation: THREE.Quaternion }>();
  private volume: () => number;

  constructor(canvas: HTMLCanvasElement, volume: () => number) {
    this.volume = volume;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb5d9cb, 2.2));
    const light = new THREE.DirectionalLight(0xfff4e8, 3.2); light.position.set(1, 3, 3); this.scene.add(light);
    const rim = new THREE.DirectionalLight(0xb3f4df, 1.5); rim.position.set(-2, 2, -1); this.scene.add(rim);
    this.observer = new ResizeObserver(() => {
      const box = canvas.getBoundingClientRect();
      this.renderer.setSize(Math.max(1, box.width), Math.max(1, box.height), false);
      this.camera.aspect = box.width / Math.max(1, box.height); this.camera.updateProjectionMatrix();
    });
    this.observer.observe(canvas);
    this.animate();
  }

  async load(): Promise<string[]> {
    const loader = new GLTFLoader();
    loader.register(parser => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync('/models/VRM1_Constraint_Twist_Sample.vrm');
    if (this.disposed) { VRMUtils.deepDispose(gltf.scene); return []; }
    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) throw new Error('角色资源没有可用的人形骨骼');
    VRMUtils.removeUnnecessaryVertices(gltf.scene); VRMUtils.rotateVRM0(vrm);
    this.vrm = vrm; this.scene.add(vrm.scene);
    const left = vrm.humanoid.getNormalizedBoneNode('leftUpperArm');
    const right = vrm.humanoid.getNormalizedBoneNode('rightUpperArm');
    if (left) left.rotation.z = -1.05;
    if (right) right.rotation.z = 1.05;
    vrm.update(0); vrm.scene.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(vrm.scene);
    const height = bounds.max.y - bounds.min.y;
    this.camera.position.set(0, bounds.min.y + height * 0.74, height * 1.15);
    this.camera.lookAt(0, bounds.min.y + height * 0.74, 0);
    for (const name of ['head', 'neck', 'spine', 'chest', 'upperChest']) {
      const bone = vrm.humanoid.getNormalizedBoneNode(name as VRMHumanBoneName);
      if (bone) this.poses.set(name, { bone, rotation: bone.quaternion.clone() });
    }
    return EMOTIONS.filter(name => !!vrm.expressionManager?.getExpression(name));
  }

  present(cue: Segment) { this.cue = cue; this.cueTime = performance.now(); }
  reset() { this.cue = undefined; }

  private animate = () => {
    if (this.disposed) return;
    const now = performance.now(); const delta = Math.min((now - this.last) / 1000, 0.05); this.last = now;
    const vrm = this.vrm;
    if (vrm) {
      for (const { bone, rotation } of this.poses.values()) bone.quaternion.copy(rotation);
      const head = this.poses.get('head')?.bone;
      const chest = this.poses.get('upperChest')?.bone ?? this.poses.get('chest')?.bone;
      if (head) head.rotation.y += Math.sin(now / 3500) * 0.025;
      if (chest) chest.rotation.x += Math.sin(now / 1900) * 0.007;
      const elapsed = (now - this.cueTime) / 1000;
      const envelope = elapsed < 1.6 ? Math.sin(elapsed / 1.6 * Math.PI) : 0;
      if (head && this.cue?.action === 'nod') head.rotation.x += Math.sin(elapsed * Math.PI * 3) * 0.14 * envelope;
      if (head && this.cue?.action === 'shake') head.rotation.y += Math.sin(elapsed * Math.PI * 4) * 0.22 * envelope;
      if (head && this.cue?.action === 'tilt') head.rotation.z += 0.2 * envelope;
      if (chest && this.cue?.action === 'lean') chest.rotation.x += 0.24 * envelope;
      const manager = vrm.expressionManager;
      if (manager) {
        for (const name of EMOTIONS) manager.setValue(name, this.cue?.emotion === name ? 0.8 : 0);
        manager.setValue('aa', Math.min(1, this.volume() * 6));
        const blinkPhase = (now / 1000) % 4.3;
        manager.setValue('blink', blinkPhase < 0.14 ? Math.sin(blinkPhase / 0.14 * Math.PI) : 0);
      }
      vrm.update(delta);
    }
    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.animate);
  };

  dispose() {
    this.disposed = true; cancelAnimationFrame(this.frame); this.observer.disconnect();
    VRMUtils.deepDispose(this.scene); this.renderer.dispose();
  }
}
