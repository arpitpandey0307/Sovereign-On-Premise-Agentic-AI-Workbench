import { Suspense, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Icosahedron, Line, Points, PointMaterial } from "@react-three/drei";
import { useReducedMotion } from "framer-motion";
import * as THREE from "three";

/**
 * The sovereignty boundary, in three dimensions.
 *
 * A shell with the plant's work held inside it: a lit core, a lattice around
 * it, and a field of particles that stay *within* the shell. Nothing leaves.
 * That is the whole product in one object, which is the only reason this is
 * here — a spinning shape that meant nothing would be exactly the "futuristic
 * for the sake of appearance" the brief warns against.
 *
 * It is deliberately confined to the marketing page. Behind the login the
 * product is an instrument panel and stays one.
 *
 * Three constraints it has to meet:
 *
 * - It never blocks the page. The whole canvas is lazily mounted and wrapped in
 *   Suspense, and the hero reads correctly with nothing rendered at all.
 * - `prefers-reduced-motion` stops the animation rather than the render, so
 *   the object is still there, just still.
 * - No external assets. Every geometry and material is generated here, because
 *   an air-gapped box has nowhere to fetch a texture from.
 */

/** The lattice: an icosahedron's own edges, so the shell and cage agree. */
function useEdges(radius: number, detail: number) {
  return useMemo(() => {
    const geometry = new THREE.IcosahedronGeometry(radius, detail);
    const edges = new THREE.EdgesGeometry(geometry);
    const positions = edges.attributes.position.array as Float32Array;
    const segments: Array<[THREE.Vector3, THREE.Vector3]> = [];
    for (let i = 0; i < positions.length; i += 6) {
      segments.push([
        new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]),
        new THREE.Vector3(positions[i + 3], positions[i + 4], positions[i + 5]),
      ]);
    }
    geometry.dispose();
    edges.dispose();
    return segments;
  }, [radius, detail]);
}

/** Work happening inside, held by the boundary. Never crosses it. */
function ContainedField({ still }: { still: boolean }) {
  const points = useRef<THREE.Points>(null);

  const positions = useMemo(() => {
    const count = 420;
    const array = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      // Rejection-free spherical sampling, kept inside the shell's radius.
      const u = Math.random();
      const v = Math.random();
      const theta = 2 * Math.PI * u;
      const phi = Math.acos(2 * v - 1);
      const r = 1.55 * Math.cbrt(Math.random());
      array[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      array[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      array[i * 3 + 2] = r * Math.cos(phi);
    }
    return array;
  }, []);

  useFrame((_, delta) => {
    if (still || !points.current) return;
    points.current.rotation.y += delta * 0.06;
    points.current.rotation.x += delta * 0.02;
  });

  return (
    <Points ref={points} positions={positions} stride={3} frustumCulled={false}>
      <PointMaterial
        transparent
        color="#60a5fa"
        size={0.028}
        sizeAttenuation
        depthWrite={false}
        opacity={0.85}
      />
    </Points>
  );
}

function Core({ still }: { still: boolean }) {
  const cage = useRef<THREE.Group>(null);
  const shell = useRef<THREE.Mesh>(null);
  const segments = useEdges(2, 1);

  useFrame((state, delta) => {
    if (still) return;
    if (cage.current) {
      cage.current.rotation.y += delta * 0.12;
      cage.current.rotation.x += delta * 0.04;
    }
    if (shell.current) {
      // A slow breath, so the boundary reads as live rather than as a prop.
      const t = state.clock.elapsedTime;
      const s = 1 + Math.sin(t * 0.6) * 0.015;
      shell.current.scale.setScalar(s);
    }
  });

  return (
    <group>
      {/* The lit core: the model doing the work. */}
      <Icosahedron args={[0.62, 2]}>
        <meshStandardMaterial
          color="#2563eb"
          emissive="#3b82f6"
          emissiveIntensity={0.75}
          roughness={0.32}
          metalness={0.55}
        />
      </Icosahedron>

      <ContainedField still={still} />

      {/* The boundary itself. */}
      <mesh ref={shell}>
        <icosahedronGeometry args={[2, 2]} />
        <meshBasicMaterial
          color="#3b82f6"
          transparent
          opacity={0.05}
          side={THREE.BackSide}
        />
      </mesh>

      <group ref={cage}>
        {segments.map((segment, index) => (
          <Line
            key={index}
            points={segment}
            color="#3b82f6"
            lineWidth={1}
            transparent
            opacity={0.34}
          />
        ))}
      </group>
    </group>
  );
}

export default function SovereignCore() {
  const reduced = useReducedMotion();

  return (
    <div className="sovereign-core" aria-hidden>
      <Canvas
        camera={{ position: [0, 0, 6.2], fov: 45 }}
        dpr={[1, 1.75]}
        // The page behind must show through; the canvas paints no ground.
        gl={{ antialias: true, alpha: true }}
        // A still scene does not need a render loop burning a laptop battery
        // through an entire pitch.
        frameloop={reduced ? "demand" : "always"}
      >
        <ambientLight intensity={0.55} />
        <pointLight position={[4, 4, 5]} intensity={55} color="#60a5fa" />
        <pointLight position={[-5, -3, -4]} intensity={26} color="#2563eb" />
        <Suspense fallback={null}>
          <Core still={Boolean(reduced)} />
        </Suspense>
      </Canvas>
    </div>
  );
}
