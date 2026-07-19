/* <shader-glow> — soft animated 3D-style mesh gradient (WebGL), shadergradient-inspired.
   Attributes: paused="true|false" (animation eases to a stop / resumes smoothly). */
(function () {
  if (customElements.get('shader-glow')) return;

  const VERT = `
attribute vec2 a_pos;
void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }`;

  const FRAG = `
precision mediump float;
uniform vec2 u_res;
uniform float u_time;

vec3 c1 = vec3(0.420, 0.702, 0.957); /* brighter #6bb3f4 */
vec3 c2 = vec3(0.216, 0.459, 0.808); /* lifted #3775ce */
vec3 c3 = vec3(0.298, 0.580, 0.910); /* lifted #4c94e8 */
vec3 c4 = vec3(0.639, 0.867, 1.0);   /* bright cyan #a3ddff */

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  float t = u_time * 0.55;

  /* slow flowing warp for a soft 3D-silk feel */
  vec2 p = uv;
  p.x += 0.18 * sin(p.y * 5.0 + t);
  p.y += 0.18 * sin(p.x * 4.0 - t * 0.8);

  vec2 b1 = vec2(0.25 + 0.42 * sin(t * 0.7), 0.45 + 0.42 * cos(t * 0.55));
  vec2 b2 = vec2(0.75 + 0.40 * cos(t * 0.6), 0.55 + 0.40 * sin(t * 0.75));
  vec2 b3 = vec2(0.50 + 0.46 * sin(t * 0.45 + 2.0), 0.35 + 0.38 * cos(t * 0.65 + 1.0));
  vec2 b4 = vec2(0.40 + 0.44 * cos(t * 0.5 + 4.0), 0.70 + 0.34 * sin(t * 0.6 + 3.0));

  float w1 = exp(-7.0 * dot(p - b1, p - b1));
  float w2 = exp(-7.0 * dot(p - b2, p - b2));
  float w3 = exp(-7.0 * dot(p - b3, p - b3));
  float w4 = exp(-8.0 * dot(p - b4, p - b4));
  float base = 0.22;
  float sum = w1 + w2 + w3 + w4 + base;

  vec3 col = (c4 * w1 + c2 * w2 + c3 * w3 + c1 * w4 + c2 * base) / sum;

  /* gentle top-light sheen for depth */
  col += 0.08 * (1.0 - uv.y);

  gl_FragColor = vec4(col, 1.0);
}`;

  customElements.define('shader-glow', class extends HTMLElement {
    static get observedAttributes() { return ['paused']; }

    connectedCallback() {
      if (this._init) return;
      this._init = true;
      this.style.display = 'block';
      const cv = document.createElement('canvas');
      cv.style.cssText = 'width:100%;height:100%;display:block';
      this.appendChild(cv);
      this._cv = cv;

      const gl = cv.getContext('webgl', { antialias: true, alpha: false });
      this._gl = gl;
      if (!gl) { this.style.background = 'linear-gradient(165deg,#5ba3e9,#2b5fae)'; return; }

      const mk = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        return s;
      };
      const prog = gl.createProgram();
      gl.attachShader(prog, mk(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog); gl.useProgram(prog);

      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'a_pos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      this._uRes = gl.getUniformLocation(prog, 'u_res');
      this._uTime = gl.getUniformLocation(prog, 'u_time');

      this._t = Math.random() * 100;   // shader time (advances only when playing)
      this._speed = this.getAttribute('paused') === 'true' ? 0 : 1;
      this._target = this._speed;
      this._last = performance.now();

      const loop = (now) => {
        this._raf = requestAnimationFrame(loop);
        const dt = Math.min(0.05, (now - this._last) / 1000);
        this._last = now;
        // ease speed toward target for smooth start/stop
        this._speed += (this._target - this._speed) * Math.min(1, dt * 5);
        if (this._target === 0 && this._speed < 0.01) { this._speed = 0; }
        this._t += dt * this._speed;
        this._draw();
      };
      this._raf = requestAnimationFrame(loop);
    }

    _draw() {
      const gl = this._gl, cv = this._cv;
      if (!gl) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(cv.clientWidth * dpr));
      const h = Math.max(1, Math.round(cv.clientHeight * dpr));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; gl.viewport(0, 0, w, h); }
      gl.uniform2f(this._uRes, w, h);
      gl.uniform1f(this._uTime, this._t);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    attributeChangedCallback(name, _old, val) {
      if (name === 'paused') this._target = val === 'true' ? 0 : 1;
    }

    disconnectedCallback() {
      cancelAnimationFrame(this._raf);
      this._init = false;
      if (this._cv) this._cv.remove();
    }
  });
})();
