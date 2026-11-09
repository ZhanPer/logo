/* Вращающийся знак $ — холодный туман, шершавый камень, светящиеся швы.
   Зависимость: three.js r149 (классический build/three.min.js). */
(function () {
  'use strict';

  var THREE = window.THREE;
  var byId = function (id) { return document.getElementById(id); };
  var stage = byId('stage');
  var loader = byId('loader');
  var loaderText = byId('loader-text');
  var hudSpin = byId('hud-spin');
  var hudState = byId('hud-state');

  /* ---------- ASCII-загрузчик ---------- */
  var loaderTimer = setInterval(function () {
    var n = 10, p = Math.floor(performance.now() / 80) % n, s = '';
    for (var i = 0; i < n; i++) {
      var d = Math.abs(i - p);
      s += d === 0 ? '+' : (d === 1 ? '=' : '-');
    }
    loaderText.textContent = s;
  }, 80);

  function fail(message) {
    clearInterval(loaderTimer);
    loader.classList.add('done');
    var box = byId('nogl');
    box.textContent = message;
    box.hidden = false;
  }

  if (!THREE) { fail('Не удалось загрузить three.js. Для работы страницы нужен интернет.'); return; }

  /* ---------- рендерер ---------- */
  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
  } catch (e) {
    fail('Не удалось запустить WebGL в этом браузере.');
    return;
  }

  var DPR = Math.min(window.devicePixelRatio || 1, 1.75);
  renderer.setPixelRatio(DPR);
  renderer.setSize(window.innerWidth, window.innerHeight);
  stage.appendChild(renderer.domElement);

  var gl = renderer.getContext();
  var canFloat = renderer.capabilities.isWebGL2 && !!gl.getExtension('EXT_color_buffer_float');
  var RT_TYPE = canFloat ? THREE.HalfFloatType : THREE.UnsignedByteType;
  var BLOOM_THRESHOLD = canFloat ? 1.0 : 0.82;

  /* ---------- общие uniform-ы и куски GLSL ---------- */
  var shared = {
    uTime: { value: 0 },
    uRes: { value: new THREE.Vector2(2, 2) },
    uGlow: { value: 1 },
    uScale: { value: 1000 }
  };

  var GLSL_SKY = [
    'vec3 skyCol(float y) {',
    '  vec3 hor = vec3(0.413, 0.445, 0.514);',
    '  vec3 top = vec3(0.262, 0.287, 0.352);',
    '  return mix(hor, top, smoothstep(0.5, 1.0, y));',
    '}'
  ].join('\n');

  /* радуга: оттенок h (дробная часть) -> цвет */
  var GLSL_RAINBOW = [
    'vec3 rainbow(float h) {',
    '  vec3 p = abs(fract(vec3(h) + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);',
    '  return mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), 0.88);',
    '}'
  ].join('\n');

  /* ---------- сцена и камера ---------- */
  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(32, window.innerWidth / window.innerHeight, 0.1, 220);
  var camDist = 8.5;

  /* фон: градиент неба, совпадающий с цветом тумана */
  var bg = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      uniforms: { uRes: shared.uRes },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 1.0, 1.0); }',
      fragmentShader: [
        'varying vec2 vUv;',
        GLSL_SKY,
        'void main() { gl_FragColor = vec4(skyCol(vUv.y), 1.0); }'
      ].join('\n'),
      depthTest: false,
      depthWrite: false
    })
  );
  bg.frustumCulled = false;
  bg.renderOrder = -1000;
  scene.add(bg);

  /* ---------- рельеф: снежные холмы вокруг ---------- */
  function hash2(ix, iy) {
    var h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function vnoise(x, y) {
    var ix = Math.floor(x), iy = Math.floor(y);
    var fx = x - ix, fy = y - iy;
    var ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    var a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  }
  function smooth(a, b, x) {
    var t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }
  function terrainHeight(x, z) {
    var r = Math.sqrt(x * x + z * z);
    var basin = smooth(8, 28, r);
    var h = 0, amp = 1, freq = 0.045, sum = 0;
    for (var i = 0; i < 5; i++) {
      h += amp * vnoise(x * freq + 11.3, z * freq + 7.1);
      sum += amp; amp *= 0.5; freq *= 2.05;
    }
    h /= sum;
    var ridge = 1 - Math.abs(2 * vnoise(x * 0.03 + 3.0, z * 0.03 + 9.0) - 1);
    var big = (h * 7.0 + ridge * 5.5 * basin - 2.5) * basin;
    var fine = vnoise(x * 0.6, z * 0.6) * 0.14;
    return big + fine;
  }

  var TERRAIN_Z = -15;
  var terrainGeo = new THREE.PlaneGeometry(130, 130, 210, 210);
  terrainGeo.rotateX(-Math.PI / 2);
  (function () {
    var pos = terrainGeo.attributes.position;
    for (var i = 0; i < pos.count; i++) {
      pos.setY(i, terrainHeight(pos.getX(i), pos.getZ(i) + TERRAIN_Z));
    }
    terrainGeo.computeVertexNormals();
  })();

  var terrainMat = new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime, uRes: shared.uRes, uGlow: shared.uGlow },
    vertexShader: [
      'varying vec3 vW; varying vec3 vN;',
      'void main() {',
      '  vec4 w = modelMatrix * vec4(position, 1.0);',
      '  vW = w.xyz;',
      '  vN = normalize(mat3(modelMatrix) * normal);',
      '  gl_Position = projectionMatrix * viewMatrix * w;',
      '}'
    ].join('\n'),
    fragmentShader: [
      'uniform float uTime; uniform vec2 uRes; uniform float uGlow;',
      'varying vec3 vW; varying vec3 vN;',
      GLSL_SKY,
      GLSL_RAINBOW,
      'float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
      'float n2(vec2 p) {',
      '  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
      '  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);',
      '}',
      'float fbm2(vec2 p) {',
      '  float a = 0.5, s = 0.0;',
      '  for (int i = 0; i < 4; i++) { s += a * n2(p); p = p * 2.03 + vec2(5.2, 1.3); a *= 0.5; }',
      '  return s;',
      '}',
      'void main() {',
      '  vec3 Ng = normalize(vN);',
      '  float dist = length(cameraPosition - vW);',
      '  vec2 p = vW.xz;',
      '  float e = 0.06;',
      '  float f0 = fbm2(p * 2.4);',
      '  float fx = fbm2((p + vec2(e, 0.0)) * 2.4);',
      '  float fz = fbm2((p + vec2(0.0, e)) * 2.4);',
      '  vec3 bump = vec3(f0 - fx, 0.0, f0 - fz) / e;',
      '  float bumpAmt = 0.24 * exp(-dist * 0.040);',
      '  vec3 N = normalize(Ng + bump * bumpAmt);',
      '  vec3 L = normalize(vec3(-0.45, 0.75, 0.5));',
      '  float diff = max(dot(N, L), 0.0);',
      '  float hemi = mix(0.34, 0.66, N.y * 0.5 + 0.5);',
      '  float slope = 1.0 - Ng.y;',
      '  float rockMix = smoothstep(0.34, 0.56, slope + (f0 - 0.5) * 0.28);',
      '  vec3 snow = vec3(0.70, 0.74, 0.82);',
      '  vec3 rock = vec3(0.23, 0.24, 0.28);',
      '  vec3 albedo = mix(snow, rock, rockMix) * (0.80 + 0.40 * f0);',
      '  vec3 col = albedo * (hemi * 0.55 + diff * 0.50);',
      '  vec2 pe = vec2(p.x * 0.45, p.y);',
      '  float pool = exp(-dot(pe, pe) * 0.10);',
      '  col += rainbow(uTime * 0.12 + (p.x + 3.07) * 0.16) * pool * uGlow * 0.34;',
      '  vec2 sp = vec2(p.x * 0.40, p.y + 0.3);',
      '  col *= 1.0 - 0.30 * exp(-dot(sp, sp) * 0.45);',
      '  float fog = 1.0 - exp(-pow(dist * 0.026, 2.0));',
      '  fog = max(fog, 0.30 * exp(-max(vW.y + 2.15, 0.0) * 0.30));',
      '  vec3 fogC = skyCol(gl_FragCoord.y / uRes.y);',
      '  col = mix(col, fogC, clamp(fog, 0.0, 1.0));',
      '  gl_FragColor = vec4(col, 1.0);',
      '}'
    ].join('\n')
  });
  var terrain = new THREE.Mesh(terrainGeo, terrainMat);
  terrain.position.set(0, -2.15, TERRAIN_Z);
  scene.add(terrain);

  /* ---------- логотип ITtop: буквы строятся из геометрии, шрифты не нужны ---------- */
  var STROKE = 0.26;   // толщина штриха
  var CAP = 1.5;       // высота заглавных
  var XH = 1.12;       // высота строчных
  var ASC_T = 1.36;    // высота буквы t
  var DESC = 0.55;     // выносной элемент буквы p
  var GAP = 0.30;      // просвет между буквами
  var DEPTH = 0.42;
  var BEVEL = { bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.05, bevelOffset: 0, bevelSegments: 2, steps: 1, curveSegments: 1 };

  function pt(x, y) { return new THREE.Vector2(x, y); }

  /* точки дуги эллипса от угла a0 до a1 (рад) за n шагов */
  function arc(cx, cy, rx, ry, a0, a1, n) {
    var out = [];
    for (var i = 0; i <= n; i++) {
      var a = a0 + (a1 - a0) * i / n;
      out.push(pt(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry));
    }
    return out;
  }

  /* замкнутый эллипс без повторной последней точки */
  function ellipse(cx, cy, rx, ry, n) {
    return arc(cx, cy, rx, ry, 0, Math.PI * 2, n).slice(0, -1);
  }

  function glyphI() {
    return { shape: new THREE.Shape([pt(0, 0), pt(STROKE, 0), pt(STROKE, CAP), pt(0, CAP)]), x0: 0, x1: STROKE };
  }

  function glyphT() {
    var w = 1.2, m = w / 2, h = STROKE / 2;
    return {
      shape: new THREE.Shape([
        pt(0, CAP), pt(w, CAP), pt(w, CAP - STROKE), pt(m + h, CAP - STROKE),
        pt(m + h, 0), pt(m - h, 0), pt(m - h, CAP - STROKE), pt(0, CAP - STROKE)
      ]),
      x0: 0, x1: w
    };
  }

  /* строчная t: ствол, перекладина и загнутая «ножка» одним контуром */
  function glyphLowerT() {
    var s = STROKE, ro = 0.55, ri = ro - s, leftExt = 0.20, rightExt = 0.36;
    var end = THREE.MathUtils.degToRad(320);
    var pts = [pt(0, ASC_T), pt(0, XH), pt(-leftExt, XH), pt(-leftExt, XH - s), pt(0, XH - s)];
    pts = pts.concat(arc(ro, ro, ro, ro, Math.PI, end, 28));   /* внешняя дуга, начинается в (0, ro) */
    pts = pts.concat(arc(ro, ro, ri, ri, end, Math.PI, 28));   /* внутренняя дуга, заканчивается в (s, ro) */
    pts.push(pt(s, XH - s), pt(s + rightExt, XH - s), pt(s + rightExt, XH), pt(s, XH), pt(s, ASC_T));
    return { shape: new THREE.Shape(pts), x0: -leftExt, x1: ro + ro * Math.cos(end) };
  }

  function glyphO() {
    var rx = 0.58, ry = XH / 2;
    var shape = new THREE.Shape(ellipse(rx, ry, rx, ry, 64));
    shape.holes.push(new THREE.Path(ellipse(rx, ry, rx - STROKE, ry - STROKE, 64)));
    return { shape: shape, x0: 0, x1: rx * 2 };
  }

  /* строчная p: ствол с выносным элементом и чашей с отверстием */
  function glyphP() {
    var s = STROKE, rx = 0.58, ry = XH / 2;
    var pts = [pt(0, -DESC), pt(0, XH)];
    pts = pts.concat(arc(rx, ry, rx, ry, Math.PI / 2, -Math.PI / 2, 40));   /* от (rx, XH) до (rx, 0) */
    pts.push(pt(s, 0), pt(s, -DESC));
    var shape = new THREE.Shape(pts);
    shape.holes.push(new THREE.Path(ellipse(rx, ry, rx - s, ry - s, 64)));
    return { shape: shape, x0: 0, x1: rx * 2 };
  }

  function extrude(shape, depth) {
    var geo = new THREE.ExtrudeGeometry(shape, Object.assign({ depth: depth }, BEVEL));
    geo.translate(0, 0, -depth / 2);
    return geo;
  }

  /* ---------- пыль: буквы из тысяч частиц, которые разлетаются от курсора ---------- */
  var sign = new THREE.Group();
  var glyphGeos = [];
  var cursor = 0;
  [glyphI(), glyphT(), glyphLowerT(), glyphO(), glyphP()].forEach(function (g) {
    var geo = extrude(g.shape, DEPTH);
    geo.translate(cursor - g.x0, 0, 0);
    glyphGeos.push(geo);
    cursor += (g.x1 - g.x0) + GAP;
  });
  var SIGN_WIDTH = cursor - GAP;
  var OFFSET_X = -SIGN_WIDTH / 2, OFFSET_Y = -(CAP - DESC) / 2;

  /* треугольники всех букв с накопленной площадью: по ней равномерно сэмплируем поверхность */
  var triData = [], triArea = [], totalArea = 0;
  glyphGeos.forEach(function (geo) {
    var pos = geo.attributes.position, nor = geo.attributes.normal;
    for (var i = 0; i + 2 < pos.count; i += 3) {
      var ax = pos.getX(i), ay = pos.getY(i), az = pos.getZ(i);
      var bx = pos.getX(i + 1), by = pos.getY(i + 1), bz = pos.getZ(i + 1);
      var cx = pos.getX(i + 2), cy = pos.getY(i + 2), cz = pos.getZ(i + 2);
      var ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      var qx = uy * vz - uz * vy, qy = uz * vx - ux * vz, qz = ux * vy - uy * vx;
      var area = 0.5 * Math.sqrt(qx * qx + qy * qy + qz * qz);
      if (area < 1e-9) continue;
      triData.push(ax, ay, az, bx, by, bz, cx, cy, cz, nor.getX(i), nor.getY(i), nor.getZ(i));
      totalArea += area;
      triArea.push(totalArea);
    }
    geo.dispose();
  });

  var DUST_COUNT = window.innerWidth < 700 ? 26000 : 45000;
  var dustHome = new Float32Array(DUST_COUNT * 3);
  var dustNormal = new Float32Array(DUST_COUNT * 3);
  var dustRnd = new Float32Array(DUST_COUNT * 2);   /* x: случайность, y: «шов» (фаска) */
  var dustPhase = new Int32Array(DUST_COUNT);       /* фаза «дрожания» оторвавшейся частицы */
  var dustDir = new Float32Array(DUST_COUNT * 3);   /* у каждой частицы своё направление разлёта */
  (function () {
    for (var i = 0; i < DUST_COUNT; i++) {
      var target = Math.random() * totalArea;
      var lo = 0, hi = triArea.length - 1;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (triArea[mid] < target) lo = mid + 1; else hi = mid;
      }
      var o = lo * 12;
      var r1 = Math.sqrt(Math.random()), r2 = Math.random();
      var wa = 1 - r1, wb = r1 * (1 - r2), wc = r1 * r2;
      var nx = triData[o + 9], ny = triData[o + 10], nz = triData[o + 11];
      var inset = Math.random() * Math.random() * 0.035;   /* частицы чуть «внутри», получается пушистый край */
      dustHome[i * 3] = triData[o] * wa + triData[o + 3] * wb + triData[o + 6] * wc - nx * inset + OFFSET_X;
      dustHome[i * 3 + 1] = triData[o + 1] * wa + triData[o + 4] * wb + triData[o + 7] * wc - ny * inset + OFFSET_Y;
      dustHome[i * 3 + 2] = triData[o + 2] * wa + triData[o + 5] * wb + triData[o + 8] * wc - nz * inset;
      dustNormal[i * 3] = nx; dustNormal[i * 3 + 1] = ny; dustNormal[i * 3 + 2] = nz;
      var anz = Math.abs(nz);
      dustPhase[i] = (Math.random() * 1024) | 0;
      var du = Math.random() * 2 - 1, da = Math.random() * Math.PI * 2, dr = Math.sqrt(1 - du * du);
      dustDir[i * 3] = dr * Math.cos(da); dustDir[i * 3 + 1] = dr * Math.sin(da); dustDir[i * 3 + 2] = du;
      dustRnd[i * 2] = Math.random();
      dustRnd[i * 2 + 1] = smooth(0.10, 0.28, anz) * (1 - smooth(0.92, 0.99, anz));
    }
  })();
  var dustPos = new Float32Array(dustHome);
  var dustVel = new Float32Array(DUST_COUNT * 3);
  var dustResting = true;

  var dustGeo = new THREE.BufferGeometry();
  var dustPosAttr = new THREE.BufferAttribute(dustPos, 3);
  dustPosAttr.setUsage(THREE.DynamicDrawUsage);
  dustGeo.setAttribute('position', dustPosAttr);
  dustGeo.setAttribute('aHome', new THREE.BufferAttribute(dustHome, 3));
  dustGeo.setAttribute('aNormal', new THREE.BufferAttribute(dustNormal, 3));
  dustGeo.setAttribute('aRnd', new THREE.BufferAttribute(dustRnd, 2));

  var dustMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: shared.uTime, uRes: shared.uRes, uGlow: shared.uGlow, uScale: shared.uScale,
      uRot: { value: new THREE.Matrix3() }
    },
    vertexShader: [
      'attribute vec3 aHome; attribute vec3 aNormal; attribute vec2 aRnd;',
      'uniform float uTime; uniform float uScale; uniform mat3 uRot;',
      'varying vec3 vN; varying vec3 vWorld; varying vec3 vLocal;',
      'varying float vSeam; varying float vRnd; varying float vDisp;',
      'void main() {',
      '  vec3 p = position;',
      '  vDisp = length(p - aHome);',
      '  p += aNormal * 0.004 * sin(uTime * 1.3 + aRnd.x * 40.0);',
      '  vec4 w = modelMatrix * vec4(p, 1.0);',
      '  vWorld = w.xyz; vLocal = p; vN = uRot * aNormal; vSeam = aRnd.y; vRnd = aRnd.x;',
      '  vec4 mv = viewMatrix * w;',
      '  gl_Position = projectionMatrix * mv;',
      '  gl_PointSize = (0.016 + aRnd.x * 0.013) * uScale / -mv.z;',
      '}'
    ].join('\n'),
    fragmentShader: [
      'uniform float uTime; uniform vec2 uRes; uniform float uGlow;',
      'varying vec3 vN; varying vec3 vWorld; varying vec3 vLocal;',
      'varying float vSeam; varying float vRnd; varying float vDisp;',
      GLSL_SKY,
      GLSL_RAINBOW,
      'void main() {',
      '  vec2 c = gl_PointCoord * 2.0 - 1.0;',
      '  float r2 = dot(c, c);',
      '  if (r2 > 1.0) discard;',
      '  float alpha = 1.0 - smoothstep(0.6, 1.0, r2);',
      /* нормаль «шарика»-спрайта из пространства вида в мировое */
      '  vec3 Ns = vec3(c.x, -c.y, sqrt(1.0 - r2)) * mat3(viewMatrix);',
      '  vec3 N = normalize(normalize(vN) * 0.8 + Ns * 0.6);',
      '  vec3 V = normalize(cameraPosition - vWorld);',
      '  vec3 L1 = normalize(vec3(-0.55, 0.65, 0.60));',
      '  vec3 L2 = normalize(vec3(0.70, 0.20, -0.50));',
      '  float nl = dot(N, L1);',
      '  float d1 = max(nl, 0.0) * 0.72 + (nl * 0.5 + 0.5) * 0.28;',
      '  float d2 = max(dot(N, L2), 0.0);',
      '  vec3 hemi = mix(vec3(0.20, 0.22, 0.27), vec3(0.62, 0.68, 0.80), N.y * 0.5 + 0.5);',
      '  vec3 albedo = mix(vec3(0.17, 0.19, 0.24), vec3(0.40, 0.42, 0.49), vRnd);',
      '  vec3 col = albedo * (hemi * 0.85 + vec3(1.0, 0.97, 0.95) * d1 + vec3(0.5, 0.65, 1.0) * d2 * 0.6);',
      '  vec3 H = normalize(L1 + V);',
      '  col += vec3(1.0) * pow(max(dot(N, H), 0.0), 40.0) * 0.30;',
      '  float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);',
      '  col += vec3(0.55, 0.60, 0.70) * (0.04 + 0.45 * fres);',
      /* швы (частицы фаски) всегда светятся радугой, потревоженные частицы вспыхивают тем же цветом */
      '  vec3 glowCol = rainbow(uTime * 0.12 + vLocal.x * 0.16 + vLocal.y * 0.10);',
      '  float stir = smoothstep(0.03, 0.45, vDisp);',
      '  col += glowCol * (vSeam * 2.1 + stir * 1.4) * uGlow;',
      '  float dist = length(cameraPosition - vWorld);',
      '  float fog = 1.0 - exp(-pow(dist * 0.035, 2.0));',
      '  col = mix(col, skyCol(gl_FragCoord.y / uRes.y), fog * 0.6);',
      '  gl_FragColor = vec4(col, alpha);',
      '}'
    ].join('\n'),
    alphaToCoverage: true
  });
  var dust = new THREE.Points(dustGeo, dustMat);
  dust.frustumCulled = false;
  sign.add(dust);
  scene.add(sign);

  /* физика: слабая пружина к «домашней» точке (частицы долго возвращаются), отталкивание от лучей курсора
     и увлечение движением мыши. Всё считается в локальных координатах знака. */
  var DUST_K = 2.0, DUST_DAMP = 2.6, DUST_ALONG = 0.4, DUST_DRAG = 5, DUST_SCATTER = 0.6, DUST_FLUTTER = 1.8, DUST_MAXV = 5.5;
  var SIN = new Float32Array(1024);
  for (var si = 0; si < 1024; si++) SIN[si] = Math.sin(si / 1024 * Math.PI * 2);

  function updateDust(dt, t, active, nSamples, sampO, sampD, radius, push, mvx, mvy, mvz) {
    var beeOn = beeL.on;
    if (!active && !beeOn && dustResting) return;
    var n = DUST_COUNT, pos = dustPos, vel = dustVel, home = dustHome, phase = dustPhase;
    var R2 = radius * radius, invR = 1 / radius, energy = 0;
    var beeX = beeL.x, beeY = beeL.y, beeZ = beeL.z, beeVx = beeL.vx, beeVy = beeL.vy, beeVz = beeL.vz;
    var beeR2 = beeL.r * beeL.r, beeInvR = 1 / beeL.r, beePush = beeL.push, beeDrag = beeL.drag;
    var ti = (t * 520) | 0, maxV2 = DUST_MAXV * DUST_MAXV;
    for (var i = 0, j = 0; i < n; i++, j += 3) {
      var px = pos[j], py = pos[j + 1], pz = pos[j + 2];
      var vx = vel[j], vy = vel[j + 1], vz = vel[j + 2];
      var ex = home[j] - px, ey = home[j + 1] - py, ez = home[j + 2] - pz;
      var ax = ex * DUST_K - vx * DUST_DAMP;
      var ay = ey * DUST_K - vy * DUST_DAMP;
      var az = ez * DUST_K - vz * DUST_DAMP;

      /* оторвавшиеся частицы слегка «дрожат» в воздухе, как пыль */
      var disp2 = ex * ex + ey * ey + ez * ez;
      if (disp2 > 0.0004) {
        var amp = Math.min(1, Math.max(0, Math.sqrt(disp2) - 0.12) * 2.5) * DUST_FLUTTER;
        var ph = phase[i];
        ax += SIN[(ti + ph) & 1023] * amp;
        ay += SIN[((ti * 3 >> 1) + ph * 7) & 1023] * amp;
        az += SIN[((ti * 5 >> 2) + ph * 13) & 1023] * amp;
      }

      if (active) {
        /* берём самый сильный из лучей на пути курсора */
        var bestF = 0, bx = 0, by = 0, bz = 0, bdx = 0, bdy = 0, bdz = 0;
        for (var s = 0, so = 0; s < nSamples; s++, so += 3) {
          var rx = px - sampO[so], ry = py - sampO[so + 1], rz = pz - sampO[so + 2];
          var dx = sampD[so], dy = sampD[so + 1], dz = sampD[so + 2];
          var tt = rx * dx + ry * dy + rz * dz;
          var cx = rx - dx * tt, cy = ry - dy * tt, cz = rz - dz * tt;
          var d2 = cx * cx + cy * cy + cz * cz;
          if (d2 < R2) {
            var dd = Math.sqrt(d2) + 1e-4;
            var f = 1 - dd * invR;
            if (f > bestF) {
              bestF = f;
              bx = cx / dd; by = cy / dd; bz = cz / dd;
              bdx = dx; bdy = dy; bdz = dz;
            }
          }
        }
        if (bestF > 0) {
          var ff = bestF * bestF;
          var pf = ff * push;
          var drag = ff * DUST_DRAG, kick = pf * DUST_SCATTER;
          ax += bx * pf + bdx * pf * DUST_ALONG + mvx * drag + dustDir[j] * kick;
          ay += by * pf + bdy * pf * DUST_ALONG + mvy * drag + dustDir[j + 1] * kick;
          az += bz * pf + bdz * pf * DUST_ALONG + mvz * drag + dustDir[j + 2] * kick;
        }
      }

      /* пчела действует на пыль как курсор: отталкивает от своей точки, увлекает движением и разбрасывает */
      if (beeOn) {
        var qx = px - beeX, qy = py - beeY, qz = pz - beeZ;
        var q2 = qx * qx + qy * qy + qz * qz;
        if (q2 < beeR2) {
          var qd = Math.sqrt(q2) + 1e-4;
          var qf = 1 - qd * beeInvR;
          qf *= qf;
          var qp = qf * beePush;
          var qk = qp / qd, qs = qp * DUST_SCATTER;
          ax += qx * qk + beeVx * qf * beeDrag + dustDir[j] * qs;
          ay += qy * qk + beeVy * qf * beeDrag + dustDir[j + 1] * qs;
          az += qz * qk + beeVz * qf * beeDrag + dustDir[j + 2] * qs;
        }
      }

      vx += ax * dt; vy += ay * dt; vz += az * dt;
      var sp2 = vx * vx + vy * vy + vz * vz;
      if (sp2 > maxV2) {
        var sc = DUST_MAXV / Math.sqrt(sp2);
        vx *= sc; vy *= sc; vz *= sc;
      }
      pos[j] = px + vx * dt; pos[j + 1] = py + vy * dt; pos[j + 2] = pz + vz * dt;
      vel[j] = vx; vel[j + 1] = vy; vel[j + 2] = vz;
      /* «энергию» для засыпания считаем по каждой четвёртой частице: этого достаточно и дешевле */
      if ((i & 3) === 0) energy += Math.abs(ex) + Math.abs(ey) + Math.abs(ez) + Math.abs(vx) + Math.abs(vy) + Math.abs(vz);
    }
    dustPosAttr.needsUpdate = true;
    if (!active && !beeOn && energy < (n >> 2) * 4e-4) {
      pos.set(home);
      vel.fill(0);
      dustResting = true;
    } else {
      dustResting = false;
    }
  }

  /* ---------- снег ---------- */
  var FLAKES = 1100;
  var flakePos = new Float32Array(FLAKES * 3);
  var flakeSeed = new Float32Array(FLAKES);
  for (var fi = 0; fi < FLAKES; fi++) {
    flakePos[fi * 3] = (Math.random() - 0.5) * 30;
    flakePos[fi * 3 + 1] = Math.random() * 12 - 3;
    flakePos[fi * 3 + 2] = Math.random() * 34 - 24;
    flakeSeed[fi] = Math.random();
  }
  var flakeGeo = new THREE.BufferGeometry();
  flakeGeo.setAttribute('position', new THREE.BufferAttribute(flakePos, 3));
  flakeGeo.setAttribute('aSeed', new THREE.BufferAttribute(flakeSeed, 1));
  var snowMat = new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime, uScale: shared.uScale },
    vertexShader: [
      'attribute float aSeed; uniform float uTime; uniform float uScale;',
      'varying float vFade;',
      'void main() {',
      '  vec3 p = position;',
      '  p.y = mod(p.y - uTime * (0.30 + aSeed * 0.55) + 3.0, 12.0) - 3.0;',
      '  p.x += sin(uTime * 0.40 + aSeed * 40.0) * 0.6;',
      '  p.z += cos(uTime * 0.30 + aSeed * 20.0) * 0.6;',
      '  vec4 mv = viewMatrix * modelMatrix * vec4(p, 1.0);',
      '  gl_Position = projectionMatrix * mv;',
      '  gl_PointSize = (0.022 + aSeed * 0.05) * uScale / -mv.z;',
      '  float edge = smoothstep(-3.0, -2.0, p.y) * (1.0 - smoothstep(8.0, 9.0, p.y));',
      '  vFade = edge * exp(-length(mv.xyz) * 0.045);',
      '}'
    ].join('\n'),
    fragmentShader: [
      'varying float vFade;',
      'void main() {',
      '  float d = length(gl_PointCoord - 0.5);',
      '  float a = smoothstep(0.5, 0.0, d);',
      '  gl_FragColor = vec4(vec3(1.0), a * a * vFade * 0.8);',
      '}'
    ].join('\n'),
    transparent: true,
    depthWrite: false
  });
  var snow = new THREE.Points(flakeGeo, snowMat);
  snow.frustumCulled = false;
  scene.add(snow);

  /* ---------- пост-обработка: bloom, хроматика, зерно ---------- */
  function makeRT(type, samples, depth) {
    return new THREE.WebGLRenderTarget(2, 2, {
      type: type,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: !!depth,
      samples: samples || 0
    });
  }
  var rtScene = makeRT(RT_TYPE, 4, true);
  var rtB1a = makeRT(RT_TYPE), rtB1b = makeRT(RT_TYPE);
  var rtB2a = makeRT(RT_TYPE), rtB2b = makeRT(RT_TYPE);

  var fsScene = new THREE.Scene();
  var fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  var fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
  fsQuad.frustumCulled = false;
  fsScene.add(fsQuad);

  var FS_VERT = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
  function makePass(frag, uniforms) {
    return new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: frag, uniforms: uniforms, depthTest: false, depthWrite: false });
  }
  function runPass(mat, target) {
    fsQuad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(fsScene, fsCam);
  }

  var brightPass = makePass([
    'uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThreshold; varying vec2 vUv;',
    'vec3 s(vec2 o) { return texture2D(tSrc, vUv + o * uTexel).rgb; }',
    'void main() {',
    '  vec3 c = (s(vec2(-1.0, -1.0)) + s(vec2(1.0, -1.0)) + s(vec2(-1.0, 1.0)) + s(vec2(1.0, 1.0))) * 0.25;',
    '  float l = max(max(c.r, c.g), c.b);',
    '  float k = smoothstep(uThreshold, uThreshold + 0.5, l);',
    '  gl_FragColor = vec4(c * k, 1.0);',
    '}'
  ].join('\n'), {
    tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: BLOOM_THRESHOLD }
  });

  var blurPass = makePass([
    'uniform sampler2D tSrc; uniform vec2 uDir; varying vec2 vUv;',
    'void main() {',
    '  vec3 c = texture2D(tSrc, vUv).rgb * 0.2270270270;',
    '  c += (texture2D(tSrc, vUv + uDir * 1.3846153846).rgb + texture2D(tSrc, vUv - uDir * 1.3846153846).rgb) * 0.3162162162;',
    '  c += (texture2D(tSrc, vUv + uDir * 3.2307692308).rgb + texture2D(tSrc, vUv - uDir * 3.2307692308).rgb) * 0.0702702703;',
    '  gl_FragColor = vec4(c, 1.0);',
    '}'
  ].join('\n'), { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });

  var finalPass = makePass([
    'uniform sampler2D tScene; uniform sampler2D tB1; uniform sampler2D tB2;',
    'uniform vec2 uRes; uniform float uTime; uniform float uCA; uniform float uBloom;',
    'varying vec2 vUv;',
    'float hh(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }',
    'void main() {',
    '  vec2 uv = vUv;',
    '  vec2 c = uv - 0.5;',
    '  float r2 = dot(c, c);',
    '  vec2 dir = normalize(c + vec2(1e-5));',
    /* горизонтальные «сбои» полос при сильном ускорении */
    '  float row = floor(uv.y * 42.0);',
    '  float tick = floor(uTime * 9.0);',
    '  float hit = step(0.93, hh(vec2(row, tick))) * smoothstep(0.15, 0.9, uCA);',
    '  uv.x += hit * (hh(vec2(row, tick + 3.0)) - 0.5) * 0.05 * uCA;',
    '  float amt = 0.0010 + r2 * 0.0065 + uCA * 0.020;',
    '  vec3 acc = vec3(0.0); vec3 wsum = vec3(0.0);',
    '  for (int i = 0; i < 9; i++) {',
    '    float t = float(i) / 8.0;',
    '    vec3 w = vec3(max(1.0 - t * 2.0, 0.0), 1.0 - abs(t * 2.0 - 1.0), max(t * 2.0 - 1.0, 0.0));',
    '    acc += texture2D(tScene, uv + dir * amt * (t - 0.5) * 2.0).rgb * w;',
    '    wsum += w;',
    '  }',
    '  vec3 col = acc / wsum;',
    '  col += (texture2D(tB1, vUv).rgb * 0.70 + texture2D(tB2, vUv).rgb * 1.10) * uBloom;',
    '  col *= 1.0 - 0.30 * smoothstep(0.18, 0.95, r2 * 2.0);',
    '  col += (hh(vUv * uRes + fract(uTime) * 91.7) - 0.5) * 0.035;',
    '  col = max(col, vec3(0.0));',
    '  vec3 hi = max(col - 0.75, vec3(0.0));',
    '  col = min(col, vec3(0.75)) + 0.25 * (1.0 - exp(-hi / 0.25));',
    '  col = pow(col, vec3(1.0 / 2.2));',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n'), {
    tScene: { value: rtScene.texture }, tB1: { value: rtB1a.texture }, tB2: { value: rtB2b.texture },
    uRes: shared.uRes, uTime: shared.uTime, uCA: { value: 0 }, uBloom: { value: 0.30 }
  });

  /* ---------- размеры ---------- */
  function resize() {
    var w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h);
    var bw = Math.max(2, Math.floor(w * DPR)), bh = Math.max(2, Math.floor(h * DPR));
    rtScene.setSize(bw, bh);
    var w1 = Math.max(2, bw >> 2), h1 = Math.max(2, bh >> 2);
    var w2 = Math.max(2, bw >> 3), h2 = Math.max(2, bh >> 3);
    rtB1a.setSize(w1, h1); rtB1b.setSize(w1, h1);
    rtB2a.setSize(w2, h2); rtB2b.setSize(w2, h2);
    shared.uRes.value.set(bw, bh);
    brightPass.uniforms.uTexel.value.set(1 / bw, 1 / bh);
    camera.aspect = w / h;
    var halfTan = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    camDist = Math.max(8.5, SIGN_WIDTH * 1.1 / (2 * halfTan * camera.aspect));
    camera.updateProjectionMatrix();
    shared.uScale.value = bh /(2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  }
  window.addEventListener('resize', resize);
  resize();

  /* ---------- управление ---------- */
  var BASE_SPEED = 0.7;
  var paused = false;
  var angle = 0.55, vel = BASE_SPEED;
  var dragging = false, dragAccum = 0, lastX = 0;
  var pointer = { x: 0, y: 0, active: false }, camPos = new THREE.Vector3(0, 0.5, camDist);
  var glitch = 0;

  /* луч курсора в локальных координатах знака для расчёта частиц */
  var raycaster = new THREE.Raycaster();
  var ndc = new THREE.Vector2();
  var invSign = new THREE.Matrix4();
  var rayO = new THREE.Vector3(), rayD = new THREE.Vector3(0, 0, -1);

  var canvas = renderer.domElement;
  function trackPointer(e) {
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
    pointer.active = true;
  }
  canvas.addEventListener('pointerdown', function (e) {
    dragging = true;
    lastX = e.clientX;
    trackPointer(e);
    document.body.classList.add('dragging');
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* не критично */ }
  });
  canvas.addEventListener('pointermove', function (e) {
    trackPointer(e);
    if (dragging) {
      dragAccum += (e.clientX - lastX) * 0.012;
      lastX = e.clientX;
    }
  });
  function endDrag(e) {
    dragging = false;
    document.body.classList.remove('dragging');
    if (e && e.pointerType === 'touch') pointer.active = false;
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', function () { pointer.active = false; });
  window.addEventListener('blur', function () { pointer.active = false; });
  window.addEventListener('wheel', function (e) {
    vel = Math.max(-16, Math.min(16, vel + e.deltaY * 0.008));
  }, { passive: true });
  window.addEventListener('keydown', function (e) {
    if (e.code === 'Space') {
      e.preventDefault();
      paused = !paused;
      hudState.textContent = paused ? '[ пробел ] продолжить' : '[ пробел ] пауза';
    }
  });

  /* ---------- пчела: медленно летает по экрану и сдувает пыль так же, как курсор ---------- */
  var BEE_SPEED = 1.15;
  var beeL = { on: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r: 0.6, push: 50, drag: 6 };   /* пчела в координатах знака */

  function beeBodyMaterial(kind) {
    return new THREE.ShaderMaterial({
      defines: { KIND: kind },
      uniforms: { uRes: shared.uRes },
      vertexShader: [
        'varying vec3 vObj; varying vec3 vNw; varying vec3 vWorld;',
        'void main() {',
        '  vObj = position;',
        '  vNw = normalize(mat3(modelMatrix) * normal);',
        '  vec4 w = modelMatrix * vec4(position, 1.0);',
        '  vWorld = w.xyz;',
        '  gl_Position = projectionMatrix * viewMatrix * w;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec2 uRes;',
        'varying vec3 vObj; varying vec3 vNw; varying vec3 vWorld;',
        GLSL_SKY,
        'void main() {',
        '  vec3 base;',
        '#if KIND == 0',
        '  base = mix(vec3(0.025, 0.022, 0.03), vec3(0.95, 0.52, 0.02), smoothstep(-0.25, 0.25, sin(vObj.x * 62.0)));',
        '#elif KIND == 1',
        '  base = vec3(0.50, 0.26, 0.02);',
        '#else',
        '  base = vec3(0.035, 0.03, 0.03);',
        '#endif',
        '  vec3 N = normalize(vNw);',
        '  vec3 V = normalize(cameraPosition - vWorld);',
        '  vec3 L1 = normalize(vec3(-0.55, 0.65, 0.60));',
        '  float nl = dot(N, L1);',
        '  float diff = max(nl, 0.0) * 0.7 + (nl * 0.5 + 0.5) * 0.3;',
        '  vec3 hemi = mix(vec3(0.20, 0.22, 0.27), vec3(0.65, 0.70, 0.82), N.y * 0.5 + 0.5);',
        '  vec3 col = base * (hemi * 0.9 + vec3(1.0, 0.97, 0.95) * diff * 1.1);',
        '  vec3 H = normalize(L1 + V);',
        '  col += vec3(1.0) * pow(max(dot(N, H), 0.0), 36.0) * 0.45;',
        '  col += vec3(0.5, 0.6, 0.75) * pow(1.0 - max(dot(N, V), 0.0), 3.0) * 0.18;',
        '  float fog = 1.0 - exp(-pow(length(cameraPosition - vWorld) * 0.035, 2.0));',
        '  col = mix(col, skyCol(gl_FragCoord.y / uRes.y), fog * 0.6);',
        '  gl_FragColor = vec4(col, 1.0);',
        '}'
      ].join('\n')
    });
  }

  var beeWingMat = new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime },
    vertexShader: [
      'varying vec3 vObj; varying vec3 vNw; varying vec3 vWorld;',
      'void main() {',
      '  vObj = position;',
      '  vNw = normalize(mat3(modelMatrix) * normal);',
      '  vec4 w = modelMatrix * vec4(position, 1.0);',
      '  vWorld = w.xyz;',
      '  gl_Position = projectionMatrix * viewMatrix * w;',
      '}'
    ].join('\n'),
    fragmentShader: [
      'uniform float uTime;',
      'varying vec3 vObj; varying vec3 vNw; varying vec3 vWorld;',
      GLSL_RAINBOW,
      'void main() {',
      '  vec3 N = normalize(vNw);',
      '  vec3 V = normalize(cameraPosition - vWorld);',
      '  float f = pow(1.0 - abs(dot(N, V)), 2.0);',
      '  vec3 col = vec3(0.92, 0.96, 1.0) + rainbow(vObj.z * 6.0 + vObj.x * 8.0 + uTime * 0.4) * 0.25;',
      '  gl_FragColor = vec4(col, 0.30 + 0.35 * f);',
      '}'
    ].join('\n'),
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide
  });

  var beeGroup = new THREE.Group();   /* положение и курс в мире */
  var beeBody = new THREE.Group();    /* наклон корпуса и крылья */
  beeGroup.add(beeBody);
  (function buildBee() {
    function add(geo, kind) { beeBody.add(new THREE.Mesh(geo, beeBodyMaterial(kind))); }
    var abdomen = new THREE.SphereGeometry(0.07, 24, 16); abdomen.scale(1.55, 1, 1); abdomen.translate(-0.09, 0, 0);
    add(abdomen, 0);
    var thorax = new THREE.SphereGeometry(0.055, 20, 14); thorax.translate(0.035, 0.005, 0);
    add(thorax, 1);
    var head = new THREE.SphereGeometry(0.04, 18, 12); head.translate(0.105, -0.005, 0);
    add(head, 2);
    var sting = new THREE.ConeGeometry(0.014, 0.05, 10); sting.rotateZ(Math.PI / 2); sting.translate(-0.215, 0, 0);
    add(sting, 2);
    [-1, 1].forEach(function (side) {
      var antenna = new THREE.CylinderGeometry(0.003, 0.003, 0.07, 6);
      antenna.translate(0, 0.035, 0); antenna.rotateX(side * 0.35); antenna.rotateZ(-1.1); antenna.translate(0.125, 0.0, side * 0.015);
      add(antenna, 2);
    });
  })();

  var beeWingA, beeWingB;   /* оси крыльев: вращение вокруг продольной оси тела */
  (function buildWings() {
    var shape = new THREE.Shape();
    shape.absellipse(0, 0.095, 0.045, 0.095, 0, Math.PI * 2, false, 0);
    var geoA = new THREE.ShapeGeometry(shape, 16); geoA.rotateX(-Math.PI / 2);
    var geoB = geoA.clone(); geoB.scale(1, 1, -1);
    beeWingA = new THREE.Group(); beeWingA.position.set(0.03, 0.05, -0.012); beeWingA.add(new THREE.Mesh(geoA, beeWingMat));
    beeWingB = new THREE.Group(); beeWingB.position.set(0.03, 0.05, 0.012); beeWingB.add(new THREE.Mesh(geoB, beeWingMat));
    beeBody.add(beeWingA, beeWingB);
  })();
  scene.add(beeGroup);

  var beePos = new THREE.Vector3(-4.2, 0.9, 0.4), beeVel = new THREE.Vector3(0.7, 0.1, 0);
  var beeHeading = new THREE.Vector3(1, 0, 0), beeTarget = new THREE.Vector3();
  var beeWant = new THREE.Vector3(), beeTmp = new THREE.Vector3(), beeLocal = new THREE.Vector3(), beeVelLocal = new THREE.Vector3();
  var beeAxX = new THREE.Vector3(), beeAxY = new THREE.Vector3(), beeAxZ = new THREE.Vector3(), beeUp = new THREE.Vector3(0, 1, 0);
  var beeBasis = new THREE.Matrix4();
  var beeNextPick = 0, beePhase = Math.random() * 10;

  /* новая цель: чаще рядом с надписью, иначе в случайном месте экрана */
  function pickBeeTarget(t) {
    if (Math.random() < 0.55) {
      beeTarget.set((Math.random() * 2 - 1) * 3.0, -0.2 + Math.random() * 1.7, (Math.random() * 2 - 1) * 0.9);
    } else {
      ndc.set(Math.random() * 1.7 - 0.85, Math.random() * 1.3 - 0.55);
      raycaster.setFromCamera(ndc, camera);
      var ray = raycaster.ray, z = (Math.random() * 2 - 1) * 1.6;
      var k = (z - ray.origin.z) / ray.direction.z;
      beeTarget.copy(ray.direction).multiplyScalar(k).add(ray.origin);
    }
    beeTarget.y = Math.max(beeTarget.y, -1.45);
    beeNextPick = t + 2.5 + Math.random() * 3.5;
  }

  function updateBee(dt, t) {
    if (t > beeNextPick || beePos.distanceTo(beeTarget) < 0.3) pickBeeTarget(t);
    beeWant.subVectors(beeTarget, beePos);
    var dist = beeWant.length();
    beeWant.multiplyScalar(BEE_SPEED * Math.min(1, dist / 1.4 + 0.3) / Math.max(dist, 1e-4));
    /* лёгкая «пчелиная» петляющая добавка к курсу */
    beeWant.x += Math.sin(t * 2.1 + beePhase) * 0.45;
    beeWant.y += Math.cos(t * 2.9 + beePhase * 1.7) * 0.35;
    beeWant.z += Math.sin(t * 1.7 + beePhase * 0.6) * 0.25;
    beeVel.lerp(beeWant, 1 - Math.exp(-dt * 1.6));
    if (beeVel.length() > 1.8) beeVel.setLength(1.8);
    beePos.addScaledVector(beeVel, dt);
    if (beePos.y < -1.5) { beePos.y = -1.5; if (beeVel.y < 0) beeVel.y = 0; }

    var speed = beeVel.length();
    if (speed > 0.05) {
      beeHeading.lerp(beeTmp.copy(beeVel).divideScalar(speed), 1 - Math.exp(-dt * 3.5));
      if (beeHeading.lengthSq() < 1e-4) beeHeading.copy(beeVel).normalize();
      beeHeading.normalize();
    }
    beeAxX.copy(beeHeading);
    beeAxZ.crossVectors(beeAxX, beeUp);
    if (beeAxZ.lengthSq() < 1e-4) beeAxZ.set(0, 0, 1);
    beeAxZ.normalize();
    beeAxY.crossVectors(beeAxZ, beeAxX);
    beeBasis.makeBasis(beeAxX, beeAxY, beeAxZ);
    beeGroup.quaternion.setFromRotationMatrix(beeBasis);
    beeGroup.position.copy(beePos);
    beeGroup.position.y += Math.sin(t * 11 + beePhase) * 0.012;
    beeBody.rotation.z = 0.30 + Math.sin(t * 5.0) * 0.04;   /* нос чуть вверх */
    var flap = 0.35 + Math.sin(t * 58 + beePhase) * 0.8;
    beeWingA.rotation.x = flap;
    beeWingB.rotation.x = -flap;
  }

  /* курсор -> лучи в координатах знака + скорость мыши: чем быстрее движение, тем больше радиус и сила */
  var prevNdcX = 0, prevNdcY = 0, prevValid = false;
  var mouseVel = new THREE.Vector3(), rawVel = new THREE.Vector3(), localVel = new THREE.Vector3();
  var rotInv = new THREE.Matrix3();
  var signCenter = new THREE.Vector3(), pA = new THREE.Vector3(), pB = new THREE.Vector3();
  var MAX_SAMPLES = 6;
  var sampO = new Float32Array(MAX_SAMPLES * 3), sampD = new Float32Array(MAX_SAMPLES * 3);

  /* точка под курсором в плоскости, проходящей через центр знака (перпендикулярно взгляду камеры) */
  function cursorPlanePoint(nx, ny, out) {
    ndc.set(nx, ny);
    raycaster.setFromCamera(ndc, camera);
    var ray = raycaster.ray;
    out.copy(signCenter).sub(ray.origin);
    var along = out.dot(ray.direction);
    out.copy(ray.direction).multiplyScalar(along).add(ray.origin);
  }

  function stirDust(dt, t) {
    var active = pointer.active;
    var curX = pointer.x, curY = -pointer.y;
    var samples = 1, pathLen = 0;

    /* пчела в координатах знака; считаем только когда она рядом с буквами */
    invSign.copy(sign.matrixWorld).invert();
    rotInv.setFromMatrix4(invSign);
    beeLocal.copy(beePos).applyMatrix4(invSign);
    beeL.on = Math.abs(beeLocal.x) < 3.9 && Math.abs(beeLocal.y) < 1.9 && Math.abs(beeLocal.z) < 1.1;
    if (beeL.on) {
      beeVelLocal.copy(beeVel).applyMatrix3(rotInv);
      beeL.x = beeLocal.x; beeL.y = beeLocal.y; beeL.z = beeLocal.z;
      beeL.vx = beeVelLocal.x; beeL.vy = beeVelLocal.y; beeL.vz = beeVelLocal.z;
    }

    if (active) {
      if (!prevValid) { prevNdcX = curX; prevNdcY = curY; prevValid = true; }
      signCenter.setFromMatrixPosition(sign.matrixWorld);
      cursorPlanePoint(prevNdcX, prevNdcY, pA);
      cursorPlanePoint(curX, curY, pB);
      pathLen = pA.distanceTo(pB);
      rawVel.subVectors(pB, pA).multiplyScalar(dt > 1e-4 ? 1 / dt : 0);
    } else {
      prevValid = false;
      rawVel.set(0, 0, 0);
    }
    mouseVel.lerp(rawVel, 1 - Math.exp(-dt * 14));
    var speed = mouseVel.length();
    if (speed > 40) { mouseVel.multiplyScalar(40 / speed); speed = 40; }

    var sp = Math.min(speed, 16);
    var radius = (0.5 + sp * 0.07) * Math.max(1, camPos.z / 8.5);
    var push = 50 + sp * 6;

    if (active) {
      /* при быстром движении расставляем лучи вдоль всего пути курсора, чтобы мышь не «перепрыгивала» частицы */
      samples = Math.max(1, Math.min(MAX_SAMPLES, 1 + Math.floor(pathLen / (0.45 * radius))));
      for (var s = 0; s < samples; s++) {
        var f = (s + 1) / samples;
        ndc.set(prevNdcX + (curX - prevNdcX) * f, prevNdcY + (curY - prevNdcY) * f);
        raycaster.setFromCamera(ndc, camera);
        rayO.copy(raycaster.ray.origin).applyMatrix4(invSign);
        rayD.copy(raycaster.ray.direction).transformDirection(invSign);
        sampO[s * 3] = rayO.x; sampO[s * 3 + 1] = rayO.y; sampO[s * 3 + 2] = rayO.z;
        sampD[s * 3] = rayD.x; sampD[s * 3 + 1] = rayD.y; sampD[s * 3 + 2] = rayD.z;
      }
      prevNdcX = curX; prevNdcY = curY;
      localVel.copy(mouseVel).applyMatrix3(rotInv);
    } else {
      localVel.set(0, 0, 0);
    }
    updateDust(dt, t, active, samples, sampO, sampD, radius, push, localVel.x, localVel.y, localVel.z);
  }

  /* ---------- главный цикл ---------- */
  var t0 = performance.now(), last = t0, hudAt = 0, shown = false, readyAt = t0 + 900;
  var lookAt = new THREE.Vector3(0, 0.1, 0);

  function frame(now) {
    requestAnimationFrame(frame);
    var t = (now - t0) / 1000;
    var rawDt = (now - last) / 1000;
    var dt = Math.min(rawDt, 0.05);
    last = now;
    shared.uTime.value = t;

    var target = paused ? 0 : BASE_SPEED;
    if (dragging) {
      var step = dragAccum; dragAccum = 0;
      angle += step;
      var inst = dt > 0 ? step / dt : 0;
      vel += (inst - vel) * Math.min(1, dt * 14);
    } else {
      vel += (target - vel) * (1 - Math.exp(-dt * 0.8));
      angle += vel * dt;
    }

    var excess = dragging ? Math.abs(vel) * 0.5 : Math.abs(vel - target);
    var gTarget = Math.min(excess * 0.09, 1.5);
    glitch += (gTarget - glitch) * (1 - Math.exp(-dt * 6));
    var intro = Math.max(0, 1 - t / 2.4);
    finalPass.uniforms.uCA.value = glitch + intro * intro * 1.3;

    sign.rotation.y = angle;
    sign.rotation.x = Math.sin(t * 0.55) * 0.07;
    sign.position.y = Math.sin(t * 0.9) * 0.08;
    sign.updateMatrixWorld(true);
    dustMat.uniforms.uRot.value.setFromMatrix4(sign.matrixWorld);

    camPos.x += (pointer.x * 0.55 - camPos.x) * Math.min(1, dt * 2.5);
    camPos.y += (0.5 - pointer.y * 0.25 - camPos.y) * Math.min(1, dt * 2.5);
    camPos.z += (camDist - camPos.z) * Math.min(1, dt * 4);
    camera.position.copy(camPos);
    camera.lookAt(lookAt);
    camera.updateMatrixWorld();

    updateBee(Math.min(rawDt, 0.1), t);
    stirDust(Math.min(rawDt, 0.1), t);   /* физике пыли разрешён шаг покрупнее: при редких кадрах возврат не растягивается */

    /* сцена -> bloom -> финальный проход на экран */
    renderer.setRenderTarget(rtScene);
    renderer.render(scene, camera);

    brightPass.uniforms.tSrc.value = rtScene.texture;
    runPass(brightPass, rtB1a);
    blurPass.uniforms.tSrc.value = rtB1a.texture;
    blurPass.uniforms.uDir.value.set(1.6 / rtB1a.width, 0);
    runPass(blurPass, rtB1b);
    blurPass.uniforms.tSrc.value = rtB1b.texture;
    blurPass.uniforms.uDir.value.set(0, 1.6 / rtB1b.height);
    runPass(blurPass, rtB1a);

    blurPass.uniforms.tSrc.value = rtB1a.texture;
    blurPass.uniforms.uDir.value.set(1.8 / rtB1a.width, 0);
    runPass(blurPass, rtB2a);
    blurPass.uniforms.tSrc.value = rtB2a.texture;
    blurPass.uniforms.uDir.value.set(0, 1.8 / rtB2a.height);
    runPass(blurPass, rtB2b);

    finalPass.uniforms.tScene.value = rtScene.texture;
    runPass(finalPass, null);

    if (now - hudAt > 100) {
      hudAt = now;
      hudSpin.textContent = 'Скорость: ' + vel.toFixed(2) + ' рад/с';
    }
    if (!shown && now > readyAt) {
      shown = true;
      clearInterval(loaderTimer);
      loader.classList.add('done');
    }
  }
  requestAnimationFrame(frame);
})();
