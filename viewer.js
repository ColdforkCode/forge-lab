// Inline WebGL 1 viewer for Wingoria.ProceduralAssets meshes.
//
// The payload is MeshPayload.Packed serialized camelCase by Blazor JS interop:
// base64 Float32 positions/normals/baseColors/controlColors, base64 Uint16
// indices and shellIndices, plus center/radius. Same renderer as the
// acceptance report's page, reduced to a single reloadable model per canvas.
window.forgeViewer = (function () {
  var states = {};

  function decodeFloat(text) {
    var binary = atob(text), bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  }
  function decodeIndex(text) {
    var binary = atob(text), bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Uint16Array(bytes.buffer);
  }

  var VERTEX = [
    'precision mediump float;',
    'attribute vec3 aPosition; attribute vec3 aNormal; attribute vec3 aColor; attribute vec2 aUv;',
    'uniform float uYaw; uniform float uPitch; uniform float uScale; uniform float uAspect;',
    'uniform vec3 uCenter;',
    'varying vec3 vColor; varying float vLight; varying vec2 vUv;',
    'vec3 turn(vec3 p) {',
    '  float cy = cos(uYaw), sy = sin(uYaw), cp = cos(uPitch), sp = sin(uPitch);',
    '  vec3 a = vec3(cy * p.x - sy * p.z, p.y, sy * p.x + cy * p.z);',
    '  return vec3(a.x, cp * a.y - sp * a.z, sp * a.y + cp * a.z);',
    '}',
    'void main() {',
    '  vec3 p = turn(aPosition - uCenter);',
    '  vec3 n = normalize(turn(aNormal));',
    '  float key = max(dot(n, normalize(vec3(-0.35, 0.78, 0.52))), 0.0);',
    '  float fill = max(dot(n, normalize(vec3(0.72, 0.24, -0.44))), 0.0);',
    '  vLight = 0.60 + 0.46 * key + 0.20 * fill;',
    '  vColor = aColor;',
    '  vUv = aUv;',
    '  gl_Position = vec4(p.x / (uScale * uAspect), p.y / uScale, p.z / (uScale * 6.0), 1.0);',
    '}'
  ].join('\n');

  var FRAGMENT = [
    'precision mediump float;',
    'varying vec3 vColor; varying float vLight; varying vec2 vUv;',
    'uniform float uFlat; uniform float uTextured; uniform sampler2D uAtlas;',
    'void main() {',
    '  if (uTextured > 0.5 && vUv.x >= 0.0) {',
    '    vec3 surface = texture2D(uAtlas, vUv).rgb * (0.80 + 0.30 * clamp(vLight - 0.6, 0.0, 0.7));',
    '    gl_FragColor = vec4(surface, 1.0);',
    '    return;',
    '  }',
    '  vec3 c = mix(pow(max(vColor * vLight, vec3(0.0)), vec3(0.72)) * 1.16, vColor, uFlat);',
    '  gl_FragColor = vec4(c, 1.0);',
    '}'
  ].join('\n');

  function compile(gl, type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) || 'shader');
    }
    return shader;
  }

  function buffer(gl, target, data) {
    var handle = gl.createBuffer();
    gl.bindBuffer(target, handle);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    return handle;
  }

  function setup(canvasId) {
    var canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    var gl = canvas.getContext('webgl', { antialias: true, alpha: false });
    if (!gl) return null;

    var program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    gl.useProgram(program);

    var state = {
      gl: gl, canvas: canvas, program: program,
      yaw: -0.86, pitch: 0.36, zoom: 1.0, flat: 0.0, shell: false,
      textured: 0.0, texture: null, uv: null,
      center: [0, 0, 0], radius: 1,
      position: null, normal: null, material: null, control: null, colorBuffer: null,
      full: null, fullCount: 0, shellBuffer: null, shellCount: 0
    };
    states[canvasId] = state;

    var dragging = false, lastX = 0, lastY = 0;
    canvas.addEventListener('pointerdown', function (event) {
      dragging = true; lastX = event.clientX; lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', function (event) {
      if (!dragging) return;
      state.yaw += (event.clientX - lastX) * 0.009;
      state.pitch = Math.max(-1.35, Math.min(1.35, state.pitch + (event.clientY - lastY) * 0.007));
      lastX = event.clientX; lastY = event.clientY;
      draw(state);
    });
    ['pointerup', 'pointercancel'].forEach(function (name) {
      canvas.addEventListener(name, function () { dragging = false; });
    });
    canvas.addEventListener('wheel', function (event) {
      event.preventDefault();
      state.zoom = Math.max(0.35, Math.min(2.4, state.zoom * Math.exp(event.deltaY * 0.0012)));
      draw(state);
    }, { passive: false });

    if (window.ResizeObserver) new ResizeObserver(function () { draw(state); }).observe(canvas);
    return state;
  }

  function bind(state, name, handle, size) {
    var gl = state.gl;
    var location = gl.getAttribLocation(state.program, name);
    if (location < 0 || !handle) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, handle);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size || 3, gl.FLOAT, false, 0, 0);
  }

  function draw(state) {
    if (!state || !state.position) return;
    var gl = state.gl;
    var ratio = Math.min(window.devicePixelRatio || 1, 2);
    var width = Math.max(1, Math.round(state.canvas.clientWidth * ratio));
    var height = Math.max(1, Math.round(state.canvas.clientHeight * ratio));
    if (state.canvas.width !== width || state.canvas.height !== height) {
      state.canvas.width = width;
      state.canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.clearColor(0.043, 0.051, 0.071, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(state.program);

    bind(state, 'aPosition', state.position);
    bind(state, 'aNormal', state.normal);
    bind(state, 'aColor', state.colorBuffer);
    bind(state, 'aUv', state.uv, 2);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, state.shell ? state.shellBuffer : state.full);

    gl.uniform1f(gl.getUniformLocation(state.program, 'uYaw'), state.yaw);
    gl.uniform1f(gl.getUniformLocation(state.program, 'uPitch'), state.pitch);
    gl.uniform1f(gl.getUniformLocation(state.program, 'uScale'), state.radius * state.zoom);
    gl.uniform1f(gl.getUniformLocation(state.program, 'uAspect'), width / height);
    gl.uniform1f(gl.getUniformLocation(state.program, 'uFlat'), state.flat);
    gl.uniform3fv(gl.getUniformLocation(state.program, 'uCenter'), state.center);
    gl.uniform1f(gl.getUniformLocation(state.program, 'uTextured'), state.textured);
    if (state.texture) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, state.texture);
      gl.uniform1i(gl.getUniformLocation(state.program, 'uAtlas'), 0);
    }

    gl.drawElements(gl.TRIANGLES, state.shell ? state.shellCount : state.fullCount, gl.UNSIGNED_SHORT, 0);
  }

  return {
    load: function (canvasId, payload) {
      var state = states[canvasId] || setup(canvasId);
      if (!state) return;
      var gl = state.gl;
      var full = decodeIndex(payload.indices);
      var shell = decodeIndex(payload.shellIndices);
      state.position = buffer(gl, gl.ARRAY_BUFFER, decodeFloat(payload.positions));
      state.normal = buffer(gl, gl.ARRAY_BUFFER, decodeFloat(payload.normals));
      state.material = buffer(gl, gl.ARRAY_BUFFER, decodeFloat(payload.baseColors));
      state.control = buffer(gl, gl.ARRAY_BUFFER, decodeFloat(payload.controlColors));
      state.colorBuffer = state.flat > 0.5 ? state.control : state.material;
      state.full = buffer(gl, gl.ELEMENT_ARRAY_BUFFER, full);
      state.fullCount = full.length;
      state.shellBuffer = buffer(gl, gl.ELEMENT_ARRAY_BUFFER, shell);
      state.shellCount = shell.length;
      state.uv = buffer(gl, gl.ARRAY_BUFFER, decodeFloat(payload.atlasUv));
      state.center = payload.center;
      state.radius = payload.radius;
      draw(state);
    },
    loadTexture: function (canvasId, dataUri) {
      var state = states[canvasId] || setup(canvasId);
      if (!state) return;
      var gl = state.gl;
      var image = new Image();
      image.onload = function () {
        state.texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, state.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        state.textured = 1.0;
        draw(state);
      };
      image.src = dataUri;
    },
    setTextured: function (canvasId, on) {
      var state = states[canvasId];
      if (!state) return;
      state.textured = on && state.texture ? 1.0 : 0.0;
      draw(state);
    },
    // Decodes any image source (File or fetched Blob) to raw RGB for the engine.
    _bitmapToPayload: function (bitmap, name) {
      var canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      var context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      var pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      var rgb = new Uint8Array(bitmap.width * bitmap.height * 3);
      for (var i = 0, o = 0; i < pixels.length; i += 4) {
        rgb[o++] = pixels[i]; rgb[o++] = pixels[i + 1]; rgb[o++] = pixels[i + 2];
      }
      var binary = '';
      for (var k = 0; k < rgb.length; k += 8192) {
        binary += String.fromCharCode.apply(null, rgb.subarray(k, k + 8192));
      }
      return { width: bitmap.width, height: bitmap.height, rgbBase64: btoa(binary), name: name };
    },
    hasFile: function (inputId) {
      var input = document.getElementById(inputId);
      return !!(input && input.files && input.files[0]);
    },
    readImageFile: function (inputId) {
      var self = this;
      return new Promise(function (resolve, reject) {
        var input = document.getElementById(inputId);
        if (!input || !input.files || !input.files[0]) { reject(new Error('nessun-file')); return; }
        var file = input.files[0];
        createImageBitmap(file).then(function (bitmap) {
          resolve(self._bitmapToPayload(bitmap, file.name));
        }).catch(reject);
      });
    },
    readImageUrl: function (url) {
      var self = this;
      return fetch(url)
        .then(function (response) {
          if (!response.ok) throw new Error('atlas ' + response.status);
          return response.blob();
        })
        .then(function (blob) { return createImageBitmap(blob); })
        .then(function (bitmap) { return self._bitmapToPayload(bitmap, url); });
    },
    setMode: function (canvasId, mode) {
      var state = states[canvasId];
      if (!state) return;
      state.flat = mode === 'control' ? 1.0 : 0.0;
      state.colorBuffer = mode === 'control' ? state.control : state.material;
      draw(state);
    },
    setShell: function (canvasId, on) {
      var state = states[canvasId];
      if (!state) return;
      state.shell = !!on;
      draw(state);
    },
    resetView: function (canvasId) {
      var state = states[canvasId];
      if (!state) return;
      state.yaw = -0.86; state.pitch = 0.36; state.zoom = 1.0;
      draw(state);
    },
    saveDataUri: function (filename, dataUri) {
      var anchor = document.createElement('a');
      anchor.href = dataUri;
      anchor.download = filename;
      anchor.click();
    },
    saveText: function (filename, text) {
      var blob = new Blob([text], { type: 'text/plain' });
      var anchor = document.createElement('a');
      anchor.href = URL.createObjectURL(blob);
      anchor.download = filename;
      anchor.click();
      setTimeout(function () { URL.revokeObjectURL(anchor.href); }, 3000);
    }
  };
})();
