"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

/**
 * The hero background: a slowly turning 3D dependency network.
 * Moving the pointer "drops a change" into the graph, and a ripple of light
 * travels outward along the edges, node to node, the way Hades traces impact.
 */
export function RippleField({ className = "" }: { className?: string }) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x06070a, 0.055);
    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
    camera.position.set(0, 0.6, 13);

    // ---------- Build a layered task graph (stages left to right) ----------
    const rng = mulberry32(7);
    const LAYERS = 9;
    const PER = 16;
    const positions: THREE.Vector3[] = [];
    const layerOf: number[] = [];
    for (let l = 0; l < LAYERS; l++) {
      for (let i = 0; i < PER; i++) {
        const x = (l - (LAYERS - 1) / 2) * 2.1 + (rng() - 0.5) * 0.9;
        const r = 2.2 + rng() * 3.4;
        const a = rng() * Math.PI * 2;
        positions.push(new THREE.Vector3(x, Math.sin(a) * r * 0.62, Math.cos(a) * r - 1.5));
        layerOf.push(l);
      }
    }
    const N = positions.length;
    const edges: [number, number][] = [];
    const adj: number[][] = Array.from({ length: N }, () => []);
    for (let i = 0; i < N; i++) {
      if (layerOf[i] === LAYERS - 1) continue;
      const nextLayer = positions
        .map((p, j) => ({ j, d: p.distanceTo(positions[i]) }))
        .filter(({ j }) => layerOf[j] === layerOf[i] + 1)
        .sort((a, b) => a.d - b.d);
      const k = 1 + Math.floor(rng() * 2.4);
      for (let e = 0; e < k && e < nextLayer.length; e++) {
        const j = nextLayer[e].j;
        edges.push([i, j]);
        adj[i].push(j);
        adj[j].push(i);
      }
    }

    // ---------- Nodes ----------
    const nodeGeo = new THREE.BufferGeometry();
    const nodePos = new Float32Array(N * 3);
    const nodeGlow = new Float32Array(N);
    const nodeSeed = new Float32Array(N);
    positions.forEach((p, i) => {
      nodePos.set([p.x, p.y, p.z], i * 3);
      nodeSeed[i] = rng();
    });
    nodeGeo.setAttribute("position", new THREE.BufferAttribute(nodePos, 3));
    nodeGeo.setAttribute("aGlow", new THREE.BufferAttribute(nodeGlow, 1));
    nodeGeo.setAttribute("aSeed", new THREE.BufferAttribute(nodeSeed, 1));
    const nodeMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uPixel: { value: renderer.getPixelRatio() } },
      vertexShader: /* glsl */ `
        attribute float aGlow; attribute float aSeed;
        uniform float uTime; uniform float uPixel;
        varying float vGlow; varying float vSeed;
        void main() {
          vGlow = aGlow; vSeed = aSeed;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float breathe = 0.85 + 0.15 * sin(uTime * 1.3 + aSeed * 40.0);
          gl_PointSize = (5.0 + aGlow * 16.0) * breathe * uPixel * (10.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying float vGlow; varying float vSeed;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float core = smoothstep(0.5, 0.0, d);
          float halo = smoothstep(0.5, 0.15, d) * 0.6;
          vec3 cold = vec3(0.36, 0.42, 0.55);
          vec3 styx = vec3(0.43, 0.66, 1.0);
          vec3 ember = vec3(1.0, 0.48, 0.27);
          vec3 hot = mix(styx, ember, smoothstep(0.75, 1.0, vGlow));
          vec3 col = mix(cold, hot, clamp(vGlow * 1.4, 0.0, 1.0));
          float a = (core * 0.85 + halo * vGlow) * (0.35 + vGlow * 0.9);
          gl_FragColor = vec4(col, a);
        }`,
    });
    const points = new THREE.Points(nodeGeo, nodeMat);

    // ---------- Edges (glow follows the wave) ----------
    const edgePos = new Float32Array(edges.length * 6);
    const edgeGlow = new Float32Array(edges.length * 2);
    edges.forEach(([a, b], e) => {
      edgePos.set([positions[a].x, positions[a].y, positions[a].z, positions[b].x, positions[b].y, positions[b].z], e * 6);
    });
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute("position", new THREE.BufferAttribute(edgePos, 3));
    edgeGeo.setAttribute("aGlow", new THREE.BufferAttribute(edgeGlow, 1));
    const edgeMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute float aGlow; varying float vGlow;
        void main() { vGlow = aGlow; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        varying float vGlow;
        void main() {
          vec3 base = vec3(0.55, 0.62, 0.78);
          vec3 styx = vec3(0.43, 0.66, 1.0);
          gl_FragColor = vec4(mix(base, styx, vGlow), 0.06 + vGlow * 0.55);
        }`,
    });
    const lines = new THREE.LineSegments(edgeGeo, edgeMat);

    const group = new THREE.Group();
    group.add(lines, points);
    group.rotation.x = -0.12;
    scene.add(group);

    // ---------- Ripples ----------
    type Ripple = { dist: Int16Array; t0: number };
    const ripples: Ripple[] = [];
    const bfs = (src: number) => {
      const dist = new Int16Array(N).fill(-1);
      dist[src] = 0;
      const q = [src];
      while (q.length) {
        const u = q.shift()!;
        for (const v of adj[u]) if (dist[v] < 0) {
          dist[v] = dist[u] + 1;
          q.push(v);
        }
      }
      return dist;
    };
    const fire = (src: number, t: number) => {
      ripples.push({ dist: bfs(src), t0: t });
      if (ripples.length > 4) ripples.shift();
    };

    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 0.45 };
    const pointer = new THREE.Vector2(10, 10);
    let lastFire = 0;
    let lastNode = -1;
    let targetRotY = 0;
    let targetRotX = -0.12;

    const onMove = (e: PointerEvent) => {
      const rect = mount.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      targetRotY = pointer.x * 0.25;
      targetRotX = -0.12 + pointer.y * 0.08;
    };
    window.addEventListener("pointermove", onMove, { passive: true });

    const resize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.position.z = w < 700 ? 17 : 13;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();

    const clock = new THREE.Clock();
    let raf = 0;
    let visible = true;
    const io = new IntersectionObserver(([en]) => (visible = en.isIntersecting));
    io.observe(mount);

    // An ambient ripple every few seconds so the scene is alive at rest.
    let nextAmbient = 0.4;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!visible) return;
      const t = clock.getElapsedTime();
      nodeMat.uniforms.uTime.value = t;

      if (!reduced) {
        group.rotation.y += (targetRotY + t * 0.03 - group.rotation.y) * 0.04;
        group.rotation.x += (targetRotX - group.rotation.x) * 0.04;
      }

      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(points)[0];
      if (hit?.index != null && hit.index !== lastNode && t - lastFire > 0.35) {
        lastNode = hit.index;
        lastFire = t;
        fire(hit.index, t);
      }
      if (t > nextAmbient) {
        fire(Math.floor(rng() * PER), t); // start in the first stage
        nextAmbient = t + 3.2 + rng() * 2;
      }

      // Wave front: each hop lights up 0.12 s after the previous one, then decays.
      nodeGlow.fill(0);
      for (const r of ripples) {
        const age = t - r.t0;
        for (let i = 0; i < N; i++) {
          const d = r.dist[i];
          if (d < 0) continue;
          const local = age - d * 0.12;
          if (local < 0) continue;
          const g = Math.exp(-local * 2.2) * (1 - Math.min(1, d / 14));
          if (g > nodeGlow[i]) nodeGlow[i] = g;
        }
      }
      for (let e = 0; e < edges.length; e++) {
        const [a, b] = edges[e];
        edgeGlow[e * 2] = nodeGlow[a] * 0.9;
        edgeGlow[e * 2 + 1] = nodeGlow[b] * 0.9;
      }
      nodeGeo.attributes.aGlow.needsUpdate = true;
      edgeGeo.attributes.aGlow.needsUpdate = true;
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      ro.disconnect();
      io.disconnect();
      nodeGeo.dispose();
      edgeGeo.dispose();
      nodeMat.dispose();
      edgeMat.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div ref={mountRef} className={className} aria-hidden="true" />;
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
