import type { Object3DNode, BufferGeometryNode, MaterialNode } from '@react-three/fiber'
import type * as THREE from 'three'

declare global {
  namespace JSX {
    interface IntrinsicElements {
      mesh: Object3DNode<THREE.Mesh, typeof THREE.Mesh>
      group: Object3DNode<THREE.Group, typeof THREE.Group>
      ambientLight: Object3DNode<THREE.AmbientLight, typeof THREE.AmbientLight>
      pointLight: Object3DNode<THREE.PointLight, typeof THREE.PointLight>
      directionalLight: Object3DNode<THREE.DirectionalLight, typeof THREE.DirectionalLight>
      sphereGeometry: BufferGeometryNode<THREE.SphereGeometry, typeof THREE.SphereGeometry>
      boxGeometry: BufferGeometryNode<THREE.BoxGeometry, typeof THREE.BoxGeometry>
      cylinderGeometry: BufferGeometryNode<THREE.CylinderGeometry, typeof THREE.CylinderGeometry>
      bufferGeometry: BufferGeometryNode<THREE.BufferGeometry, typeof THREE.BufferGeometry>
      meshStandardMaterial: MaterialNode<THREE.MeshStandardMaterial, typeof THREE.MeshStandardMaterial>
      meshBasicMaterial: MaterialNode<THREE.MeshBasicMaterial, typeof THREE.MeshBasicMaterial>
      lineBasicMaterial: MaterialNode<THREE.LineBasicMaterial, typeof THREE.LineBasicMaterial>
      // 'line' conflicts with SVG; R3F uses lowercase 'line' for THREE.Line
      // We alias it to avoid conflicts:
      primitive: { object: unknown; [key: string]: unknown }
    }
  }
}
