// WebGL2 针迹渲染器：实例化四边形画每一段针迹，
// 片元着色器按针迹方向算丝线光泽（圆柱明暗 + 方向高光），
// 支持仿真进度裁剪、跳针虚线、布面起皱位移。

import type { StitchPlan } from '../core/types';
import { threadById } from '../core/threadlib';

const VERT = `#version 300 es
layout(location=0) in vec2 a_corner;   // x: -1..1 横向, y: 0..1 沿针迹
layout(location=1) in vec4 i_seg;      // x1,y1,x2,y2 (mm)
layout(location=2) in vec3 i_color;
layout(location=3) in vec2 i_meta;     // x: 记录序号, y: 类型(0针迹 1跳针)

uniform mat3 u_view;
uniform float u_widthMm;
uniform float u_progress;   // 已绣记录数
uniform float u_wrinkle;    // 0..1 起皱强度
uniform float u_time;
uniform float u_hideJumps;

out vec3 v_color;
out vec2 v_uv;
out float v_angle;
out float v_type;
out float v_segLen;

void main() {
  if (i_meta.x >= u_progress || (i_meta.y > 0.5 && u_hideJumps > 0.5)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_color = vec3(0.0); v_uv = vec2(0.0); v_angle = 0.0; v_type = 0.0; v_segLen = 1.0;
    return;
  }
  vec2 p1 = i_seg.xy;
  vec2 p2 = i_seg.zw;
  vec2 d = p2 - p1;
  float segLen = max(length(d), 1e-5);
  vec2 dir = d / segLen;
  vec2 nrm = vec2(-dir.y, dir.x);
  float w = u_widthMm * (i_meta.y > 0.5 ? 0.35 : 1.0);
  vec2 pos = mix(p1, p2, a_corner.y) + nrm * a_corner.x * w * 0.5;
  // 布面拉伸起皱：低频正弦位移，密度大的地方视觉起伏更强
  if (u_wrinkle > 0.001) {
    float amp = u_wrinkle * 0.9;
    pos += amp * vec2(
      sin(pos.y * 1.7 + pos.x * 0.6 + u_time * 0.0),
      cos(pos.x * 1.9 - pos.y * 0.8)
    ) * 0.5;
  }
  vec3 clip = u_view * vec3(pos, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
  v_color = i_color;
  v_uv = a_corner;
  v_angle = atan(dir.y, dir.x);
  v_type = i_meta.y;
  v_segLen = segLen;
}
`;

const FRAG = `#version 300 es
precision mediump float;
in vec3 v_color;
in vec2 v_uv;
in float v_angle;
in float v_type;
in float v_segLen;
uniform float u_lightAngle;
out vec4 o;

void main() {
  if (v_type > 0.5) {
    // 跳针：灰色虚线
    float dash = fract(v_uv.y * v_segLen / 1.2);
    if (dash > 0.5) discard;
    o = vec4(0.55, 0.58, 0.62, 0.8);
    return;
  }
  float across = v_uv.x;                 // -1..1
  float cyl = sqrt(max(0.0, 1.0 - across * across));  // 圆柱截面明暗
  // 丝线光泽：与针迹方向相关的方向高光
  float sheen = 0.55 + 0.45 * pow(abs(cos(v_angle - u_lightAngle)), 2.0);
  vec3 c = v_color * (0.35 + 0.65 * cyl) * sheen;
  c += vec3(0.25) * pow(cyl, 4.0) * sheen;            // 中心高光
  // 边缘轻微压暗，近看能分出一针一针
  float edge = smoothstep(1.0, 0.7, abs(across));
  o = vec4(c, 0.25 + 0.75 * edge);
}
`;

export interface View2D {
  cx: number; // 视野中心 (mm)
  cy: number;
  ppm: number; // 像素/毫米
}

export class StitchGL {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  view: View2D = { cx: 0, cy: 0, ppm: 8 };
  progress = Infinity;
  wrinkle = 0;
  showJumps = true;
  lightAngle = 0.9;

  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private segBuffer: WebGLBuffer;
  private metaBuffer: WebGLBuffer;
  private colorBuffer: WebGLBuffer;
  private instanceCount = 0;
  private uView: WebGLUniformLocation;
  private uWidth: WebGLUniformLocation;
  private uProgress: WebGLUniformLocation;
  private uWrinkle: WebGLUniformLocation;
  private uTime: WebGLUniformLocation;
  private uLight: WebGLUniformLocation;
  private uHideJumps: WebGLUniformLocation;
  private dpr = Math.min(window.devicePixelRatio || 1, 2);

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;

    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error('着色器编译失败: ' + gl.getShaderInfoLog(sh));
      }
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(prog));
    }
    this.program = prog;
    this.uView = gl.getUniformLocation(prog, 'u_view')!;
    this.uWidth = gl.getUniformLocation(prog, 'u_widthMm')!;
    this.uProgress = gl.getUniformLocation(prog, 'u_progress')!;
    this.uWrinkle = gl.getUniformLocation(prog, 'u_wrinkle')!;
    this.uTime = gl.getUniformLocation(prog, 'u_time')!;
    this.uLight = gl.getUniformLocation(prog, 'u_lightAngle')!;
    this.uHideJumps = gl.getUniformLocation(prog, 'u_hideJumps')!;

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    // 单位四边形（两个三角形，6 顶点）
    const quad = new Float32Array([
      -1, 0, 1, 0, -1, 1,
      1, 0, 1, 1, -1, 1,
    ]);
    const quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.segBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.segBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);

    this.colorBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(2, 1);

    this.metaBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.metaBuffer);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(3, 1);

    gl.bindVertexArray(null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const pw = Math.round(w * this.dpr);
    const ph = Math.round(h * this.dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
  }

  /** 由针迹计划构建实例数据 */
  setPlan(plan: StitchPlan | null) {
    const gl = this.gl;
    if (!plan || plan.records.length === 0) {
      this.instanceCount = 0;
      return;
    }
    const segs: number[] = [];
    const colors: number[] = [];
    const metas: number[] = [];
    let prev = { x: 0, y: 0 };
    plan.records.forEach((r, i) => {
      const block = plan.blocks[r.block];
      const t = block ? threadById(block.colorId) : threadById('');
      segs.push(prev.x, prev.y, r.x, r.y);
      colors.push(t.rgb[0] / 255, t.rgb[1] / 255, t.rgb[2] / 255);
      metas.push(i, r.flag === 'stitch' ? 0 : 1);
      prev = { x: r.x, y: r.y };
    });
    this.instanceCount = plan.records.length;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.segBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(segs), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colors), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.metaBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(metas), gl.STATIC_DRAW);
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    return {
      x: (sx - w / 2) / this.view.ppm + this.view.cx,
      y: (h / 2 - sy) / this.view.ppm + this.view.cy,
    };
  }

  worldToScreen(p: { x: number; y: number }): { x: number; y: number } {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    return {
      x: (p.x - this.view.cx) * this.view.ppm + w / 2,
      y: h / 2 - (p.y - this.view.cy) * this.view.ppm,
    };
  }

  zoomAt(sx: number, sy: number, factor: number) {
    const before = this.screenToWorld(sx, sy);
    this.view.ppm = Math.max(0.5, Math.min(200, this.view.ppm * factor));
    const after = this.screenToWorld(sx, sy);
    this.view.cx += before.x - after.x;
    this.view.cy += before.y - after.y;
  }

  panBy(dxPx: number, dyPx: number) {
    this.view.cx -= dxPx / this.view.ppm;
    this.view.cy += dyPx / this.view.ppm;
  }

  fitBounds(b: { minX: number; minY: number; maxX: number; maxY: number }, padding = 1.15) {
    const w = this.canvas.clientWidth || 800;
    const h = this.canvas.clientHeight || 600;
    const bw = Math.max(1e-3, b.maxX - b.minX) * padding;
    const bh = Math.max(1e-3, b.maxY - b.minY) * padding;
    this.view.ppm = Math.max(0.5, Math.min(w / bw, h / bh));
    this.view.cx = (b.minX + b.maxX) / 2;
    this.view.cy = (b.minY + b.maxY) / 2;
  }

  render(time = 0) {
    const gl = this.gl;
    this.resize();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.96, 0.95, 0.92, 1); // 布底色
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.instanceCount === 0) return;

    const w = this.canvas.width;
    const h = this.canvas.height;
    const ppm = this.view.ppm * this.dpr;
    const sx = ppm / (w / 2);
    const sy = ppm / (h / 2);
    // 列主序 mat3
    const m = new Float32Array([
      sx, 0, 0,
      0, sy, 0,
      -this.view.cx * sx, -this.view.cy * sy, 1,
    ]);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniformMatrix3fv(this.uView, false, m);
    // 线宽：约 1.6 物理像素对应的 mm，近看针迹更粗更像线
    const widthMm = Math.max(0.12, 1.6 / ppm);
    gl.uniform1f(this.uWidth, widthMm);
    gl.uniform1f(this.uProgress, this.progress === Infinity ? 1e9 : this.progress);
    gl.uniform1f(this.uWrinkle, this.wrinkle);
    gl.uniform1f(this.uTime, time);
    gl.uniform1f(this.uLight, this.lightAngle);
    gl.uniform1f(this.uHideJumps, this.showJumps ? 0 : 1);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.instanceCount);
    gl.bindVertexArray(null);
  }
}
