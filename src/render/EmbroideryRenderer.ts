/**
 * WebGL2 绣花渲染引擎。
 * 坐标系：DST 单位，y 向上；屏幕 y 向下，由 view 矩阵翻转。
 * 三种模式：
 *  - design：设计视图（针迹静态 + 分区轮廓叠加）
 *  - simulation：走针动画（已绣针段逐针显示，针线沿针迹方向产生各向异性光泽）
 *  - density：起坨热力图
 * 丝线用三角化的细长 quad 渲染，片元着色器按针迹方向与视线的夹角做高光。
 */

import type { DensityWarning, Pt, Stitch } from '../core/types';
import { StitchFlag } from '../core/types';
import { unitToMm } from '../core/units';

export type RenderMode = 'design' | 'simulation' | 'density';

export interface Camera {
  scale: number; // 像素 / DST 单位
  offsetX: number;
  offsetY: number;
}

export interface RenderThread {
  id: string;
  color: string;
  sheen: number;
}

export interface RenderOptions {
  mode: RenderMode;
  /** simulation：已绣到的针索引（含） */
  progress: number;
  playing: boolean;
  showJumps: boolean;
  showColorChanges: boolean;
  showStitchDirection: boolean;
  warnings: DensityWarning[];
  threads: Map<string | null, RenderThread>;
  /** 布面拉伸系数 0~0.05 */
  fabricStretch: number;
  /** 设计视图叠加的分区多边形与选中态 */
  overlays?: Array<{ polygon: Pt[]; selected: boolean; color: string }>;
}

const VERT = `#version 300 es
in vec2 a_pos;
in vec2 a_dir;      // 该针段方向（单位向量，DST 坐标系）
in vec4 a_color;    // 线色 sRGB 0~1
in float a_sheen;
in float a_flag;    // 0 普通 1 跳针 2 换色
uniform vec2 u_viewport;
uniform vec2 u_camScale;
uniform vec2 u_camOffset;
out vec2 v_dir;
out vec4 v_color;
out float v_sheen;
out float v_flag;
void main() {
  vec2 world = a_pos * u_camScale + u_camOffset;
  vec2 clip = vec2(world / u_viewport * 2.0 - 1.0);
  clip.y = -clip.y;
  gl_Position = vec4(clip, 0.0, 1.0);
  v_dir = a_dir;
  v_color = a_color;
  v_sheen = a_sheen;
  v_flag = a_flag;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 v_dir;
in vec4 v_color;
in float v_sheen;
in float v_flag;
uniform float u_showDir;
out vec4 outColor;
void main() {
  if (v_flag > 0.5 && v_flag < 1.5) {
    outColor = vec4(0.92, 0.78, 0.35, 0.55); // 跳针：半透明金黄虚线感
    return;
  }
  if (v_flag > 1.5) {
    outColor = vec4(0.95, 0.45, 0.85, 0.9);  // 换色：品红标记
    return;
  }
  // 丝线基础色 + 沿针迹方向的各向异性高光：
  // 针段方向在屏幕上的角度决定高光强度，模拟丝线反光随方向变化
  float ang = atan(v_dir.y, v_dir.x);
  float anisotropic = 0.5 + 0.5 * sin(ang * 2.0 + gl_FragCoord.x * 0.05);
  vec3 base = v_color.rgb;
  vec3 sheenColor = vec3(1.0, 0.98, 0.92);
  float highlight = anisotropic * v_sheen * 0.45;
  // 针迹方向提示：叠加微弱方向条纹
  float stripe = u_showDir > 0.5 ? 0.08 * sin(gl_FragCoord.x * 0.8 + ang * 6.0) : 0.0;
  vec3 col = base * (0.78 + 0.22 * anisotropic) + sheenColor * highlight + stripe;
  outColor = vec4(clamp(col, 0.0, 1.0), v_color.a);
}`;

// 分区轮廓/热力格用的简单着色器
const LINE_VERT = `#version 300 es
in vec2 a_pos;
in vec4 a_color;
uniform vec2 u_viewport;
uniform vec2 u_camScale;
uniform vec2 u_camOffset;
out vec4 v_color;
void main() {
  vec2 world = a_pos * u_camScale + u_camOffset;
  vec2 clip = vec2(world / u_viewport * 2.0 - 1.0);
  clip.y = -clip.y;
  gl_Position = vec4(clip, 0.0, 1.0);
  v_color = a_color;
}`;
const LINE_FRAG = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 outColor;
void main() { outColor = v_color; }`;

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [0.8, 0.8, 0.8];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('着色器编译失败: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('程序链接失败: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

/** 针段宽度（像素），真实 40wt 丝线约 0.2mm，这里视觉上加粗便于近看一针一针 */
const THREAD_WIDTH_PX = 2.6;
const JUMP_WIDTH_PX = 1.2;

export class EmbroideryRenderer {
  private gl: WebGL2RenderingContext;
  private threadProg: WebGLProgram;
  private lineProg: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private posBuf: WebGLBuffer;
  private dirBuf: WebGLBuffer;
  private colorBuf: WebGLBuffer;
  private sheenBuf: WebGLBuffer;
  private flagBuf: WebGLBuffer;
  private lineVao: WebGLVertexArrayObject;
  private linePosBuf: WebGLBuffer;
  private lineColorBuf: WebGLBuffer;
  private vertexCount = 0;
  private lineVertexCount = 0;
  camera: Camera = { scale: 4, offsetX: 0, offsetY: 0 };
  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    this.threadProg = program(gl, VERT, FRAG);
    this.lineProg = program(gl, LINE_VERT, LINE_FRAG);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.posBuf = this.makeAttrib(0, 2);
    this.dirBuf = this.makeAttrib(1, 2);
    this.colorBuf = this.makeAttrib(2, 4);
    this.sheenBuf = this.makeAttrib(3, 1);
    this.flagBuf = this.makeAttrib(4, 1);

    this.lineVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.lineVao);
    this.linePosBuf = this.makeAttrib(0, 2);
    this.lineColorBuf = this.makeAttrib(1, 4);
    gl.bindVertexArray(null);
  }

  private makeAttrib(location: number, size: number): WebGLBuffer {
    const gl = this.gl;
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    return buf;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
  }

  /** 让整个针迹包围盒居中适配 */
  fitTo(stitches: Stitch[], padding = 60) {
    if (!stitches.length) {
      this.camera = { scale: 4, offsetX: this.canvas.width / 2, offsetY: this.canvas.height / 2 };
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of stitches) {
      minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
      minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y);
    }
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const sx = (this.canvas.width - padding * 2) / w;
    const sy = (this.canvas.height - padding * 2) / h;
    this.camera.scale = Math.min(sx, sy);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    this.camera.offsetX = this.canvas.width / 2 - cx * this.camera.scale;
    this.camera.offsetY = this.canvas.height / 2 - cy * this.camera.scale;
  }

  screenToWorld(sx: number, sy: number): Pt {
    return {
      x: (sx - this.camera.offsetX) / this.camera.scale,
      y: -(sy - this.camera.offsetY) / this.camera.scale
    };
  }

  zoom(factor: number, center?: Pt) {
    const c = center ?? { x: this.canvas.width / 2, y: this.canvas.height / 2 };
    const before = this.screenToWorld(c.x, c.y);
    this.camera.scale = Math.max(0.3, Math.min(60, this.camera.scale * factor));
    const after = this.screenToWorld(c.x, c.y);
    this.camera.offsetX += (after.x - before.x) * this.camera.scale;
    this.camera.offsetY -= (after.y - before.y) * this.camera.scale;
  }

  /** 应用布面拉伸：沿每针方向收缩 */
  private applyStretch(stitches: Stitch[], factor: number): Stitch[] {
    if (factor <= 0) return stitches;
    return stitches.map((s, i) => {
      if (i === 0) return s;
      const p = stitches[i - 1];
      return { ...s, x: Math.round(s.x - (s.x - p.x) * factor), y: Math.round(s.y - (s.y - p.y) * factor) };
    });
  }

  /**
   * 把针迹三角化为相机空间 quad。
   * 每针段生成两个三角形（6 顶点），宽度固定像素，不随缩放变化，保证近看针针分明。
   */
  private buildThreadGeometry(stitches: Stitch[], opts: RenderOptions, visibleCount: number) {
    const gl = this.gl;
    const n = Math.min(visibleCount, stitches.length);
    // 每针 6 顶点，每顶点 2(pos)+2(dir)+4(color)+1(sheen)+1(flag) = 10 float
    const data = new Float32Array(Math.max(1, (n - 1) * 6) * 10);
    let vi = 0;
    const cam = this.camera;
    const widthFor = (flag: number) => (flag === 0 ? THREAD_WIDTH_PX : JUMP_WIDTH_PX) / 2;

    for (let i = 1; i < n; i++) {
      const a = stitches[i - 1];
      const b = stitches[i];
      const flag = (b.flags & StitchFlag.ColorChange) ? 2 : (b.flags & StitchFlag.Jump) ? 1 : 0;
      if (flag === 1 && !opts.showJumps) continue;
      if (flag === 2 && !opts.showColorChanges) continue;
      const thread = opts.threads.get(b.threadId) ?? { id: '', color: '#c8c8c8', sheen: 0.6 };
      const [r, g, bl] = hexToRgb(thread.color);
      const halfW = widthFor(flag) / cam.scale; // 转回世界单位宽度
      // 屏幕方向（y 翻转后计算法线）
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const segLen = Math.hypot(dx, dy) || 1;
      const ux = dx / segLen;
      const uy = dy / segLen;
      const nx = -uy * halfW;
      const ny = ux * halfW;
      const corners = [
        { x: a.x + nx, y: a.y + ny },
        { x: a.x - nx, y: a.y - ny },
        { x: b.x + nx, y: b.y + ny },
        { x: b.x - nx, y: b.y - ny }
      ];
      const push = (p: { x: number; y: number }) => {
        const o = vi * 10;
        data[o] = p.x; data[o + 1] = p.y;
        data[o + 2] = ux; data[o + 3] = uy;
        data[o + 4] = r; data[o + 5] = g; data[o + 6] = bl; data[o + 7] = 1;
        data[o + 8] = thread.sheen;
        data[o + 9] = flag;
        vi++;
      };
      push(corners[0]); push(corners[1]); push(corners[2]);
      push(corners[1]); push(corners[3]); push(corners[2]);
    }

    gl.bindVertexArray(this.vao);
    this.streamData(this.posBuf, data, 10, 0, 2);
    this.streamData(this.dirBuf, data, 10, 2, 2);
    this.streamData(this.colorBuf, data, 10, 4, 4);
    this.streamData(this.sheenBuf, data, 10, 8, 1);
    this.streamData(this.flagBuf, data, 10, 9, 1);
    this.vertexCount = vi;
  }

  private streamData(buf: WebGLBuffer, all: Float32Array, stride: number, offset: number, size: number) {
    const gl = this.gl;
    const count = all.length / stride;
    const out = new Float32Array(count * size);
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < size; k++) out[i * size + k] = all[i * stride + offset + k];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, out, gl.DYNAMIC_DRAW);
  }

  /** 分区轮廓 + 密度热力格的线段几何（GL_LINES，位置与颜色两个独立数组） */
  private buildLineGeometry(opts: RenderOptions) {
    const gl = this.gl;
    const positions: number[] = [];
    const colors: number[] = [];
    const push = (a: Pt, b: Pt, c: [number, number, number, number]) => {
      positions.push(a.x, a.y, b.x, b.y);
      colors.push(...c, ...c);
    };
    if (opts.mode === 'density') {
      for (const w of opts.warnings) {
        const half = w.cellSize / 2;
        const c: [number, number, number, number] =
          w.level === 'critical'
            ? [0.9, 0.25, 0.2, 0.6]
            : [0.95, 0.65, 0.25, 0.45];
        const p1 = { x: w.x - half, y: w.y - half };
        const p2 = { x: w.x + half, y: w.y - half };
        const p3 = { x: w.x + half, y: w.y + half };
        const p4 = { x: w.x - half, y: w.y + half };
        push(p1, p2, c);
        push(p2, p3, c);
        push(p3, p4, c);
        push(p4, p1, c);
      }
    }
    if (opts.overlays) {
      for (const ov of opts.overlays) {
        const [r, g, b] = hexToRgb(ov.selected ? '#4f9cf9' : ov.color);
        const c: [number, number, number, number] = [r, g, b, ov.selected ? 1 : 0.65];
        const poly = ov.polygon;
        for (let i = 0; i < poly.length; i++) {
          push(poly[i], poly[(i + 1) % poly.length], c);
        }
      }
    }
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.linePosBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineColorBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colors), gl.DYNAMIC_DRAW);
    this.lineVertexCount = positions.length / 2;
  }

  render(stitchesIn: Stitch[], opts: RenderOptions) {
    const gl = this.gl;
    this.resize();
    const stitches = this.applyStretch(stitchesIn, opts.fabricStretch);
    const visibleCount = opts.mode === 'simulation' ? opts.progress + 1 : stitches.length;

    gl.clearColor(0.06, 0.07, 0.09, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const vp = [this.canvas.width, this.canvas.height];
    const camScale = [this.camera.scale, this.camera.scale];
    const camOffset = [this.camera.offsetX, this.camera.offsetY];

    // 针迹
    this.buildThreadGeometry(stitches, opts, visibleCount);
    gl.useProgram(this.threadProg);
    gl.bindVertexArray(this.vao);
    this.uniform2('u_viewport', vp);
    this.uniform2('u_camScale', camScale);
    this.uniform2('u_camOffset', camOffset);
    const showDirLoc = gl.getUniformLocation(this.threadProg, 'u_showDir');
    gl.uniform1f(showDirLoc, opts.showStitchDirection ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);

    // 轮廓与热力
    this.buildLineGeometry(opts);
    if (this.lineVertexCount > 0) {
      gl.useProgram(this.lineProg);
      gl.bindVertexArray(this.lineVao);
      this.uniform2Line('u_viewport', vp);
      this.uniform2Line('u_camScale', camScale);
      this.uniform2Line('u_camOffset', camOffset);
      gl.drawArrays(gl.LINES, 0, this.lineVertexCount);
    }
    gl.bindVertexArray(null);
  }

  private uniform2(name: string, v: number[]) {
    const gl = this.gl;
    gl.uniform2f(gl.getUniformLocation(this.threadProg, name), v[0], v[1]);
  }
  private uniform2Line(name: string, v: number[]) {
    const gl = this.gl;
    gl.uniform2f(gl.getUniformLocation(this.lineProg, name), v[0], v[1]);
  }

  /** 生产纸样：离屏渲染到指定尺寸 canvas，返回 dataURL */
  renderPatternImage(stitches: Stitch[], opts: RenderOptions, size = 1600): string {
    const prev = [this.canvas.width, this.canvas.height];
    this.canvas.width = size;
    this.canvas.height = size;
    this.fitTo(stitches, 80);
    this.render(stitches, { ...opts, mode: 'design' });
    const url = this.canvas.toDataURL('image/png');
    this.canvas.width = prev[0];
    this.canvas.height = prev[1];
    this.resize();
    return url;
  }

  dispose() {
    const gl = this.gl;
    gl.deleteProgram(this.threadProg);
    gl.deleteProgram(this.lineProg);
    gl.deleteBuffer(this.posBuf);
    gl.deleteBuffer(this.dirBuf);
    gl.deleteBuffer(this.colorBuf);
    gl.deleteBuffer(this.sheenBuf);
    gl.deleteBuffer(this.flagBuf);
    gl.deleteBuffer(this.linePosBuf);
    gl.deleteBuffer(this.lineColorBuf);
    gl.deleteVertexArray(this.vao);
    gl.deleteVertexArray(this.lineVao);
  }
}

export function fmtLength(units: number): string {
  return `${unitToMm(units).toFixed(1)} mm`;
}
