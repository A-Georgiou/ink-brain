// Repairs for common slips in a built scene.
import * as THREE from "three";

// The local axis a round shape turns about; spheres fit any.
const ROUND = { cylinder: "y", cone: "y", lathe: "y", spring: "y", torus: "z", gear: "z", sphere: null };
const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

// Radial copies with no parent go round an axis through the world's origin; when they sit on a wheel or hub turning the same way whose axle is elsewhere, they go round that axle instead.
export function recentreRings(items) {
    const solids = [...items.values()].filter((item) => !item.def.copy && item.def.type !== "wire");
    const boxOf = (obj) => new THREE.Box3().setFromObject(obj);
    for (const item of solids) {
        const { def, obj } = item;
        const copies = obj.userData.copies;
        if (!(def.radial > 1) || !copies || def.parent != null || def.on != null || Array.isArray(def.pivot)) continue;
        const axis = AXES[def.axis] ?? AXES.y;
        const first = boxOf(copies[0]).getCenter(new THREE.Vector3());
        let best = null;
        for (const hub of solids) {
            if (hub === item || !(hub.def.type in ROUND)) continue;
            const body = hub.obj.userData.body ?? hub.obj;
            const turn = ROUND[hub.def.type] ? AXES[ROUND[hub.def.type]].clone().transformDirection(body.matrixWorld) : axis;
            if (Math.abs(turn.dot(axis)) < 0.97) continue;
            const centre = body.getWorldPosition(new THREE.Vector3()).projectOnPlane(axis);
            const off = first.clone().projectOnPlane(axis).distanceTo(centre);
            const radius = boxOf(body).getBoundingSphere(new THREE.Sphere()).radius;
            if (off <= radius * 1.1 && centre.length() > radius && (!best || off < best.off)) best = { centre, off };
        }
        if (!best) continue;
        obj.position.copy(best.centre);
        for (const copy of copies) copy.position.sub(best.centre);
        obj.updateMatrixWorld(true);
        item.home.position.copy(obj.position);
        copies.forEach((copy, n) => items.get(`${def.id}#${n + 1}`)?.home.position.copy(copy.position));
    }
}
