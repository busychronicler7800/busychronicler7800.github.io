// =========================================================
// TORUS KNOT SURFACE-GRID ASCII SCULPTURE ENGINE
// =========================================================
const ASCII_CHARS = [".", ":", "-", "=", "+", "*", "#", "%", "@"];

let autoRotate = true;
let flowEnabled = false;
let flowPhase = 0;

let scene, camera, renderer, modelPivot;
let glyphPointsMesh = null;
let occlusionGroup = null;
let raycaster = new THREE.Raycaster();

let dragMode = "none";
let prevMouse = { x: 0, y: 0 };
let prevPinchDist = null;
let targetCamZ = 6.9;
let targetPan = new THREE.Vector2(0, 0.02);

function buildAsciiAtlas() {
  const cols = 9;
  const rows = 1;
  const cellSize = 128;
  const canvas = document.createElement("canvas");
  canvas.width = cols * cellSize;
  canvas.height = rows * cellSize;

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 ${Math.floor(cellSize * 0.78)}px "SFMono-Regular", Menlo, Consolas, "Courier New", monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ASCII_CHARS.forEach((ch, idx) => {
    ctx.fillText(ch, idx * cellSize + cellSize / 2, cellSize / 2 + 2);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;

  return { texture, cols, rows };
}

const ATLAS = buildAsciiAtlas();

function addCurvedPatch(rings, closedLoop, stepRow, stepChar, outPoints, occlusionGroup, insetDepth = 0.020) {
  const M = rings.length;
  const N = rings[0].length;
  if (M < 2 || N < 3) return;

  const ringCenters = rings.map(ring => {
    let cx = 0, cy = 0, cz = 0;
    for (let j = 0; j < N; j++) {
      cx += ring[j][0]; cy += ring[j][1]; cz += ring[j][2];
    }
    return new THREE.Vector3(cx / N, cy / N, cz / N);
  });

  const normals = Array.from({ length: M }, () => Array.from({ length: N }, () => new THREE.Vector3()));
  const p0 = new THREE.Vector3(), pU1 = new THREE.Vector3(), pU2 = new THREE.Vector3();
  const pV1 = new THREE.Vector3(), pV2 = new THREE.Vector3();
  const dU = new THREE.Vector3(), dV = new THREE.Vector3();
  let outwardScore = 0;

  for (let i = 0; i < M; i++) {
    const iPrev = Math.max(0, i - 1);
    const iNext = Math.min(M - 1, i + 1);
    for (let j = 0; j < N; j++) {
      const jPrev = closedLoop ? (j - 1 + N) % N : Math.max(0, j - 1);
      const jNext = closedLoop ? (j + 1) % N : Math.min(N - 1, j + 1);

      pU1.set(...rings[i][jPrev]);
      pU2.set(...rings[i][jNext]);
      pV1.set(...rings[iPrev][j]);
      pV2.set(...rings[iNext][j]);

      dU.subVectors(pU2, pU1);
      dV.subVectors(pV2, pV1);
      const n = new THREE.Vector3().crossVectors(dU, dV);
      p0.set(...rings[i][j]);

      if (n.lengthSq() < 1e-12) {
        n.subVectors(p0, ringCenters[i]).normalize();
      } else {
        n.normalize();
      }

      if (closedLoop) {
        const radial = p0.clone().sub(ringCenters[i]);
        outwardScore += n.dot(radial);
      }
      normals[i][j] = n;
    }
  }

  if (closedLoop && outwardScore < 0) {
    for (let i = 0; i < M; i++) {
      for (let j = 0; j < N; j++) normals[i][j].negate();
    }
  }

  const occPositions = [];
  const insetRings = Array.from({ length: M }, (_, i) =>
    Array.from({ length: N }, (_, j) => {
      const pt = rings[i][j];
      const nm = normals[i][j];
      return [pt[0] - nm.x * insetDepth, pt[1] - nm.y * insetDepth, pt[2] - nm.z * insetDepth];
    })
  );

  const jLimit = closedLoop ? N : N - 1;
  for (let i = 0; i < M - 1; i++) {
    for (let j = 0; j < jLimit; j++) {
      const jNext = (j + 1) % N;
      const a = insetRings[i][j], b = insetRings[i + 1][j];
      const c = insetRings[i + 1][jNext], d = insetRings[i][jNext];
      occPositions.push(...a, ...b, ...d, ...b, ...c, ...d);
    }
  }

  const occGeom = new THREE.BufferGeometry();
  occGeom.setAttribute("position", new THREE.Float32BufferAttribute(occPositions, 3));
  occlusionGroup.add(new THREE.Mesh(occGeom));

  const vArc = new Float64Array(M);
  vArc[0] = 0;
  for (let i = 1; i < M; i++) {
    let sumDist = 0;
    for (let j = 0; j < N; j++) {
      const a = rings[i - 1][j], b = rings[i][j];
      sumDist += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    }
    vArc[i] = vArc[i - 1] + sumDist / N;
  }

  const totalVLen = vArc[M - 1];
  if (totalVLen < 1e-5) return;

  const numRows = Math.max(2, Math.round(totalVLen / stepRow));
  let curI = 0;

  for (let r = 0; r <= numRows; r++) {
    const targetArc = (r / numRows) * totalVLen;
    while (curI < M - 2 && vArc[curI + 1] < targetArc) curI++;
    const segArc = vArc[curI + 1] - vArc[curI];
    const alphaV = segArc > 1e-7 ? (targetArc - vArc[curI]) / segArc : 0;
    const vNorm = (curI + alphaV) / (M - 1);

    const rowPts = [];
    const rowNms = [];
    const loopCount = closedLoop ? N + 1 : N;

    for (let j = 0; j < loopCount; j++) {
      const jj = j % N;
      const pA = rings[curI][jj], pB = rings[curI + 1][jj];
      const nA = normals[curI][jj], nB = normals[curI + 1][jj];

      rowPts.push([
        pA[0] + (pB[0] - pA[0]) * alphaV,
        pA[1] + (pB[1] - pA[1]) * alphaV,
        pA[2] + (pB[2] - pA[2]) * alphaV
      ]);
      const nx = nA.x + (nB.x - nA.x) * alphaV;
      const ny = nA.y + (nB.y - nA.y) * alphaV;
      const nz = nA.z + (nB.z - nA.z) * alphaV;
      const nl = Math.hypot(nx, ny, nz) || 1;
      rowNms.push([nx / nl, ny / nl, nz / nl]);
    }

    const uArc = new Float64Array(loopCount);
    uArc[0] = 0;
    for (let j = 1; j < loopCount; j++) {
      const a = rowPts[j - 1], b = rowPts[j];
      uArc[j] = uArc[j - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    }

    const totalULen = uArc[loopCount - 1];
    if (totalULen < stepChar * 0.4) continue;

    const numChars = closedLoop
      ? Math.max(4, Math.floor(totalULen / stepChar))
      : Math.max(2, Math.round(totalULen / stepChar) + 1);

    let curJ = 0;
    for (let c = 0; c < numChars; c++) {
      const targetU = closedLoop
        ? (c / numChars) * totalULen
        : (c / Math.max(1, numChars - 1)) * totalULen;

      while (curJ < loopCount - 2 && uArc[curJ + 1] < targetU) curJ++;
      const segU = uArc[curJ + 1] - uArc[curJ];
      const alphaU = segU > 1e-7 ? (targetU - uArc[curJ]) / segU : 0;

      const p0 = rowPts[curJ], p1 = rowPts[curJ + 1];
      const n0 = rowNms[curJ], n1 = rowNms[curJ + 1];

      const px = p0[0] + (p1[0] - p0[0]) * alphaU;
      const py = p0[1] + (p1[1] - p0[1]) * alphaU;
      const pz = p0[2] + (p1[2] - p0[2]) * alphaU;

      let nx = n0[0] + (n1[0] - n0[0]) * alphaU;
      let ny = n0[1] + (n1[1] - n0[1]) * alphaU;
      let nz = n0[2] + (n1[2] - n0[2]) * alphaU;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;

      outPoints.push({ x: px, y: py, z: pz, nx, ny, nz, uPhase: vNorm });
    }
  }
}

function buildTorusKnotData(outPoints, occGroup) {
  const segsU = 240;
  const segsV = 36;
  const p = 2, q = 3;
  const scale = 0.66;
  const tubeRadius = 0.36;

  const centers = [];
  for (let i = 0; i <= segsU; i++) {
    const t = (i / segsU) * Math.PI * 2;
    const r = Math.cos(q * t) + 2.0;
    const x = r * Math.cos(p * t) * scale;
    const y = -Math.sin(q * t) * scale * 1.15;
    const z = r * Math.sin(p * t) * scale;
    centers.push(new THREE.Vector3(x, y, z));
  }

  const tangents = [];
  for (let i = 0; i <= segsU; i++) {
    const prev = centers[(i - 1 + segsU) % segsU];
    const next = centers[(i + 1) % segsU];
    tangents.push(new THREE.Vector3().subVectors(next, prev).normalize());
  }

  let normal = new THREE.Vector3(0, 1, 0);
  if (Math.abs(tangents[0].dot(normal)) > 0.9) normal.set(1, 0, 0);
  normal.sub(tangents[0].clone().multiplyScalar(tangents[0].dot(normal))).normalize();

  const rings = [];
  for (let i = 0; i <= segsU; i++) {
    if (i > 0) {
      const rotAxis = new THREE.Vector3().crossVectors(tangents[i - 1], tangents[i]);
      if (rotAxis.lengthSq() > 1e-10) {
        rotAxis.normalize();
        const angle = Math.acos(Math.max(-1, Math.min(1, tangents[i - 1].dot(tangents[i]))));
        normal.applyAxisAngle(rotAxis, angle).normalize();
      }
    }
    const binormal = new THREE.Vector3().crossVectors(tangents[i], normal).normalize();
    const ring = [];
    for (let j = 0; j < segsV; j++) {
      const theta = (j / segsV) * Math.PI * 2;
      const cosT = Math.cos(theta), sinT = Math.sin(theta);
      const pt = centers[i].clone()
        .addScaledVector(normal, cosT * tubeRadius)
        .addScaledVector(binormal, sinT * tubeRadius);
      ring.push([pt.x, pt.y, pt.z]);
    }
    rings.push(ring);
  }

  addCurvedPatch(rings, true, 0.017, 0.015, outPoints, occGroup, 0.020);
}

function buildModelPointGeometry(points) {
  const count = points.length;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uPhases = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const p = points[i];
    positions[i * 3]     = p.x;
    positions[i * 3 + 1] = p.y;
    positions[i * 3 + 2] = p.z;
    normals[i * 3]       = p.nx;
    normals[i * 3 + 1]   = p.ny;
    normals[i * 3 + 2]   = p.nz;
    uPhases[i] = p.uPhase;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geom.setAttribute("aUPhase", new THREE.BufferAttribute(uPhases, 1));
  return geom;
}

function createAsciiPointMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uAtlas: { value: ATLAS.texture },
      uAtlasCols: { value: ATLAS.cols },
      uWorldSize: { value: 0.017 },
      uProjectionScale: { value: 600.0 },
      uFlow: { value: 0.0 },
      uFlowPhase: { value: 0.0 }
    },
    vertexShader: `
      attribute float aUPhase;
      uniform float uWorldSize;
      uniform float uProjectionScale;
      uniform float uFlow;
      uniform float uFlowPhase;

      varying float vCharIdx;
      varying float vLum;
      varying float vFacing;

      void main() {
        vec3 n = normalize(normalMatrix * normal);
        vFacing = n.z;

        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;

        float dist = max(0.65, -mvPosition.z);
        float ptSize = clamp((uWorldSize * uProjectionScale) / dist, 2.0, 44.0);
        gl_PointSize = vFacing < -0.18 ? 0.0 : ptSize;

        vec3 keyDir = normalize(vec3(0.42, 0.65, 0.85));
        vec3 fillDir = normalize(vec3(-0.75, -0.15, 0.65));

        float halfLambert = dot(n, keyDir) * 0.5 + 0.5;
        float keyShading = pow(clamp(halfLambert, 0.0, 1.0), 1.35) * 0.68;
        float fillShading = max(dot(n, fillDir), 0.0) * 0.28;
        float fresnelRim = pow(1.0 - clamp(max(n.z, 0.0), 0.0, 1.0), 2.0) * 0.38;

        float rawLum = 0.15 + keyShading + fillShading + fresnelRim;
        if (uFlow > 0.5) {
          rawLum += sin(aUPhase * 37.6991 - uFlowPhase) * 0.16;
        }

        float lum = clamp(rawLum, 0.12, 1.0);
        vLum = lum;
        vCharIdx = clamp(floor(lum * 8.99), 0.0, 8.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uAtlas;
      uniform float uAtlasCols;
      varying float vCharIdx;
      varying float vLum;
      varying float vFacing;

      void main() {
        float edgeFade = smoothstep(-0.16, 0.18, vFacing);
        if (edgeFade <= 0.01) discard;

        vec2 localCoord = mix(vec2(0.04), vec2(0.96), gl_PointCoord);
        vec2 uv = vec2(
          (vCharIdx + localCoord.x) / uAtlasCols,
          localCoord.y
        );

        vec4 texColor = texture2D(uAtlas, uv);
        float alpha = texColor.a * edgeFade;
        if (alpha < 0.12) discard;

        float brightness = mix(0.36, 1.0, vLum);
        gl_FragColor = vec4(vec3(brightness), alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true
  });
}

function initAnatomyEngine() {
  const stage = document.getElementById("anatomy-stage");
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  camera = new THREE.PerspectiveCamera(38, stage.clientWidth / stage.clientHeight, 0.1, 100);
  camera.position.set(0, 0.02, targetCamZ);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(stage.clientWidth, stage.clientHeight);
  stage.appendChild(renderer.domElement);

  modelPivot = new THREE.Group();
  modelPivot.rotation.order = "YXZ";
  scene.add(modelPivot);

  occlusionGroup = new THREE.Group();
  const points = [];
  buildTorusKnotData(points, occlusionGroup);

  const occlusionMat = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    side: THREE.DoubleSide
  });
  occlusionGroup.traverse(obj => {
    if (obj.isMesh) {
      obj.material = occlusionMat;
      obj.renderOrder = 1;
    }
  });
  modelPivot.add(occlusionGroup);

  const ptGeom = buildModelPointGeometry(points);
  const mat = createAsciiPointMaterial();
  if (stage.clientHeight > 0) {
    const fovRad = (camera.fov * Math.PI) / 180;
    mat.uniforms.uProjectionScale.value = stage.clientHeight / (2 * Math.tan(fovRad / 2));
  }

  glyphPointsMesh = new THREE.Points(ptGeom, mat);
  glyphPointsMesh.renderOrder = 2;
  modelPivot.add(glyphPointsMesh);

  stage.addEventListener("mousedown", e => {
    dragMode = (e.button === 2 || e.shiftKey) ? "pan" : "rotate";
    prevMouse = { x: e.clientX, y: e.clientY };
  });

  window.addEventListener("mouseup", () => { dragMode = "none"; });

  window.addEventListener("mousemove", e => {
    if (dragMode === "none" || !modelPivot) return;
    const dx = e.clientX - prevMouse.x;
    const dy = e.clientY - prevMouse.y;

    if (dragMode === "rotate") {
      modelPivot.rotation.y += dx * 0.009;
      modelPivot.rotation.x = Math.max(-0.75, Math.min(0.75, modelPivot.rotation.x + dy * 0.006));
    } else if (dragMode === "pan") {
      const panSpeed = targetCamZ * 0.0014;
      targetPan.x = Math.max(-1.6, Math.min(1.6, targetPan.x - dx * panSpeed));
      targetPan.y = Math.max(-2.3, Math.min(2.3, targetPan.y + dy * panSpeed));
    }
    prevMouse = { x: e.clientX, y: e.clientY };
  });

  stage.addEventListener("touchstart", e => {
    if (e.touches.length === 1) {
      dragMode = "rotate";
      prevMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (e.touches.length === 2) {
      dragMode = "pinch";
      prevPinchDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
    }
  }, { passive: true });

  stage.addEventListener("touchmove", e => {
    if (!modelPivot) return;
    if (dragMode === "rotate" && e.touches.length === 1) {
      const dx = e.touches[0].clientX - prevMouse.x;
      const dy = e.touches[0].clientY - prevMouse.y;
      modelPivot.rotation.y += dx * 0.011;
      modelPivot.rotation.x = Math.max(-0.75, Math.min(0.75, modelPivot.rotation.x + dy * 0.008));
      prevMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (dragMode === "pinch" && e.touches.length === 2 && prevPinchDist) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const ratio = prevPinchDist / Math.max(10, dist);
      targetCamZ = Math.min(10.5, Math.max(1.15, targetCamZ * ratio));
      prevPinchDist = dist;
    }
  }, { passive: true });

  stage.addEventListener("touchend", () => {
    dragMode = "none";
    prevPinchDist = null;
  });

  stage.addEventListener("wheel", e => {
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    const oldZ = targetCamZ;
    const zoomFactor = 1 + e.deltaY * 0.0012;
    const newZ = Math.min(10.5, Math.max(1.15, oldZ * zoomFactor));
    const ratio = newZ / oldZ;

    let focusDepth = oldZ;
    if (occlusionGroup) {
      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
      const hits = raycaster.intersectObjects(occlusionGroup.children, false);
      if (hits.length > 0) focusDepth = hits[0].distance;
    }

    const tanHalfFov = Math.tan((camera.fov * Math.PI) / 360);
    const worldX = targetPan.x + ndcX * camera.aspect * tanHalfFov * focusDepth;
    const worldY = targetPan.y + ndcY * tanHalfFov * focusDepth;

    if (e.deltaY < 0) {
      targetPan.x = worldX - ndcX * camera.aspect * tanHalfFov * (focusDepth * ratio);
      targetPan.y = worldY - ndcY * tanHalfFov * (focusDepth * ratio);
    } else {
      targetPan.x += (0 - targetPan.x) * 0.18;
      targetPan.y += (0.02 - targetPan.y) * 0.18;
    }

    targetPan.x = Math.max(-1.6, Math.min(1.6, targetPan.x));
    targetPan.y = Math.max(-2.3, Math.min(2.3, targetPan.y));
    targetCamZ = newZ;
  }, { passive: false });

  window.addEventListener("resize", resizeAnatomyViewport);
  resizeAnatomyViewport();
  requestAnimationFrame(animateAnatomyScene);
}

function resizeAnatomyViewport() {
  const stage = document.getElementById("anatomy-stage");
  if (!stage || !renderer || stage.clientWidth === 0) return;
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);

  if (glyphPointsMesh && glyphPointsMesh.material.uniforms) {
    const fovRad = (camera.fov * Math.PI) / 180;
    glyphPointsMesh.material.uniforms.uProjectionScale.value = h / (2 * Math.tan(fovRad / 2));
  }
}

function toggleAutoRotate() {
  autoRotate = !autoRotate;
  document.getElementById("btn-autorotate").classList.toggle("active", autoRotate);
  document.getElementById("btn-autorotate").innerText = `ROTATE : ${autoRotate ? "ON" : "OFF"}`;
}

function toggleFlow() {
  flowEnabled = !flowEnabled;
  document.getElementById("btn-flow").classList.toggle("active", flowEnabled);
  document.getElementById("btn-flow").innerText = `FLOW : ${flowEnabled ? "ON" : "OFF"}`;
  if (glyphPointsMesh) {
    glyphPointsMesh.material.uniforms.uFlow.value = flowEnabled ? 1.0 : 0.0;
  }
}

function resetAnatomyView() {
  targetCamZ = 6.9;
  targetPan.set(0, 0.02);
  if (modelPivot) modelPivot.rotation.set(0, 0, 0);
}

function animateAnatomyScene() {
  requestAnimationFrame(animateAnatomyScene);
  if (!document.getElementById("sec-anatomy").classList.contains("active")) return;

  camera.position.z += (targetCamZ - camera.position.z) * 0.16;
  camera.position.x += (targetPan.x - camera.position.x) * 0.16;
  camera.position.y += (targetPan.y - camera.position.y) * 0.16;

  if (autoRotate && dragMode === "none" && modelPivot) {
    modelPivot.rotation.y += 0.007;
  }

  if (flowEnabled && glyphPointsMesh) {
    flowPhase += 0.08;
    glyphPointsMesh.material.uniforms.uFlowPhase.value = flowPhase;
  }

  renderer.render(scene, camera);
}
