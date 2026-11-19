// WebGL2 针迹渲染器。
// 每条针迹渲染为实例化胶囊线段:顶点着色器里按线段方向展开四边形,
// 片元着色器按"线方向 vs 光源方向"算光泽(绣线光泽随针迹方向变化),
// 并采样布面位移纹理模拟拉伸起皱。绘制数量=仿真进度,保证走针顺序与文件一致。

import { Flag, StitchRec } from '../core/types';
import { patternBounds } from '../core/types';

const VERT = `#version 300 es
precision highp float;
// 每实例:起点、终点、颜色、类型(0普通 1跳针)
in vec2 aP0;
in vec2 aP1;
in vec3 aColor;
in float aType;
// 每顶点:quad 角点 (-1..1)
in vec2 aCorner;

uniform vec2 uScale;     // mm → clip
uniform vec2 uOffset;    // 视野中心(mm)
uniform float uWidth;    // 线宽(mm)
uniform sampler2D uDisp; // 位移场
uniform vec4 uDispBounds;// minX,minY,maxX,maxY
uniform float uDispMax;  // 位移场编码最大值
uniform float uDispAmount;

out vec3 vColor;
out vec2 vUV;      // x:沿线 0..1, y:横向 -1..1
out float vAngle;
out float vType;

vec2 displace(vec2 p) {
  vec2 t = (p - uDispBounds.xy) / (uDispBounds.zw - uDispBounds.xy);
  vec2 d = texture(uDisp, t).rg * 2.0 - 1.0;
  return p + d * uDispMax * 2.0 * uDispAmount;
}

void main() {
  vec2 p0 = displace(aP0);
  vec2 p1 = displace(aP1);
  vec2 dir = p1 - p0;
  float len = length(dir);
  vec2 n = len > 1e-6 ? vec2(-dir.y, dir.x) / len : vec2(0.0, 1.0);
  float halfW = uWidth * (aType > 0.5 ? 0.35 : 0.5);
  vec2 pos = mix(p0, p1, aCorner.x) + n * aCorner.y * halfW;
  // 圆头:端点外扩
  pos += (len > 1e-6 ? dir / len : vec2(0.0)) * (aCorner.x * 2.0 - 1.0) * halfW * 0.0;
  gl_Position = vec4((pos - uOffset) * uScale, 0.0, 1.0);
  vColor = aColor;
  vUV = vec2(aCorner.x, aCorner.y);
  vAngle = atan(dir.y, dir.x);
  vType = aType;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 vColor;
in vec2 vUV;
in float vAngle;
in float vType;
uniform float uLightAngle;
uniform float uSheen;
out vec4 outColor;

void main() {
  // 圆角帽:横向衰减
  float edge = 1.0 - abs(vUV.y);
  float alpha = smoothstep(0.0, 0.35, edge);
  if (vType > 0.5) {
    // 跳针:虚线灰线
    if (fract(vUV.x * 8.0) < 0.45) discard;
    outColor = vec4(0.55, 0.58, 0.62, alpha * 0.8);
    return;
  }
  // 绣线光泽:方向与光源夹角决定高光;横向再加一道圆柱高光
  float dirSheen = pow(abs(cos(vAngle - uLightAngle)), 6.0);
  float cyl = sqrt(max(0.0, 1.0 - vUV.y * vUV.y));
  vec3 base = vColor * (0.62 + 0.38 * cyl);
  vec3 col = base + vec3(1.0) * dirSheen * cyl * uSheen * 0.55;
  outColor = vec4(col, alpha);
}`;

const MARKER_VERT = `#version 300 es
precision highp float;
in vec2 aPos;
in vec3 aColor;
in float aSize;
uniform vec2 uScale;
uniform vec2 uOffset;
uniform float uPixelScale;
out vec3 vColor;
void main() {
  gl_Position = vec4((aPos - uOffset) * uScale, 0.0, 1.0);
  gl_PointSize = aSize * uPixelScale;
  vColor = aColor;
}`;

const MARKER_FRAG = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d);
  if (r > 0.5) discard;
  float ring = smoothstep(0.5, 0.42, r) * (0.35 + 0.65 * smoothstep(0.28, 0.34, r));
  outColor = vec4(vColor, ring);
}`;

export interface ViewState {
  centerX: number;
  centerY: number;
  /** 像素/mm */
  ppm: number;
}

export interface Marker {
  x: number;
  y: number;
  color: [number, number, number];
  size: number;
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

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

export class StitchRenderer {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private markerProg: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private markerVao: WebGLVertexArrayObject;
  private instanceBuf: WebGLBuffer;
  private markerBuf: WebGLBuffer;
  private dispTex: WebGLTexture;
  private uni: Record<string, WebGLUniformLocation | null> = {};
  private markerUni: Record<string, WebGLUniformLocation | null> = {};
  private segmentCount = 0;
  private markerCount = 0;
  /** 每条针迹记录对应的实例下标(颜色记录无实例,为 -1) */
  recordToInstance: Int32Array = new Int32Array(0);
  /** 实例下标 → 记录下标 */
  instanceToRecord: number[] = [];
  bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: true });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    this.prog = link(gl, VERT, FRAG);
    this.markerProg = link(gl, MARKER_VERT, MARKER_FRAG);
    for (const n of ['uScale', 'uOffset', 'uWidth', 'uDisp', 'uDispBounds', 'uDispMax', 'uDispAmount', 'uLightAngle', 'uSheen']) {
      this.uni[n] = gl.getUniformLocation(this.prog, n);
    }
    for (const n of ['uScale', 'uOffset', 'uPixelScale']) {
      this.markerUni[n] = gl.getUniformLocation(this.markerProg, n);
    }

    // 线段实例 VAO:单位 quad(2 三角形)+ 实例属性
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const quad = new Float32Array([
      0, -1, 1, -1, 0, 1,
      0, 1, 1, -1, 1, 1,
    ]);
    const quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    const cornerLoc = gl.getAttribLocation(this.prog, 'aCorner');
    gl.enableVertexAttribArray(cornerLoc);
    gl.vertexAttribPointer(cornerLoc, 2, gl.FLOAT, false, 0, 0);

    this.instanceBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    const stride = 8 * 4;
    const attrs: Array<[string, number, number]> = [
      ['aP0', 2, 0], ['aP1', 2, 2], ['aColor', 3, 4], ['aType', 1, 7],
    ];
    for (const [name, size, off] of attrs) {
      const loc = gl.getAttribLocation(this.prog, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off * 4);
      gl.vertexAttribDivisor(loc, 1);
    }

    // 标记 VAO
    this.markerVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.markerVao);
    this.markerBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.markerBuf);
    const mStride = 6 * 4;
    const mAttrs: Array<[string, number, number]> = [['aPos', 2, 0], ['aColor', 3, 2], ['aSize', 1, 5]];
    for (const [name, size, off] of mAttrs) {
      const loc = gl.getAttribLocation(this.markerProg, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, mStride, off * 4);
    }
    gl.bindVertexArray(null);

    // 位移纹理(初始 1×1 零位移)
    this.dispTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.dispTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  /**
   * 上传针迹数据。colorOf(recordIndex) 返回 [r,g,b](0..1)。
   * 实例顺序与记录顺序一致:绘制前 N 个实例即"绣到第 N 步"。
   */
  setStitches(stitches: StitchRec[], colorOf: (recIndex: number) => [number, number, number]): void {
    const gl = this.gl;
    const data: number[] = [];
    this.recordToInstance = new Int32Array(stitches.length).fill(-1);
    this.instanceToRecord = [];
    let px = 0, py = 0, first = true;
    let instanceIdx = 0;
    stitches.forEach((s, i) => {
      if (s.flag === Flag.End || s.flag === Flag.Color) {
        if (s.flag !== Flag.Color) { px = s.x; py = s.y; }
        return;
      }
      if (first) { px = s.x; py = s.y; first = false; }
      const type = s.flag === Flag.Jump ? 1 : 0;
      const [r, g, b] = colorOf(i);
      data.push(px, py, s.x, s.y, r, g, b, type);
      this.recordToInstance[i] = instanceIdx++;
      this.instanceToRecord.push(i);
      px = s.x; py = s.y;
    });
    this.segmentCount = instanceIdx;
    this.bounds = patternBounds(stitches);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  setMarkers(markers: Marker[]): void {
    const gl = this.gl;
    const data: number[] = [];
    for (const m of markers) data.push(m.x, m.y, m.color[0], m.color[1], m.color[2], m.size);
    this.markerCount = markers.length;
    gl.bindVertexArray(this.markerVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.markerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  setDisplacement(field: { data: Uint8Array; size: number; bounds: { minX: number; minY: number; maxX: number; maxY: number }; maxDisp: number } | null): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.dispTex);
    if (field) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, field.size, field.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, field.data);
      this.dispBounds = [field.bounds.minX, field.bounds.minY, field.bounds.maxX, field.bounds.maxY];
      this.dispMax = field.maxDisp;
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 0, 255]));
      this.dispMax = 0;
    }
  }

  private dispBounds = [0, 0, 1, 1];
  private dispMax = 0;

  /** 适配视野:返回初始 ViewState */
  fitView(): ViewState {
    const b = this.bounds;
    const w = Math.max(1e-6, b.maxX - b.minX);
    const h = Math.max(1e-6, b.maxY - b.minY);
    const cw = this.canvas.clientWidth || 1;
    const ch = this.canvas.clientHeight || 1;
    const ppm = Math.min(cw / w, ch / h) * 0.85;
    return { centerX: (b.minX + b.maxX) / 2, centerY: (b.minY + b.maxY) / 2, ppm };
  }

  render(opts: {
    view: ViewState;
    progress: number;       // 显示的实例数(仿真进度)
    stitchWidthMm: number;
    sheen: number;          // 光泽强度 0..1
    lightAngleDeg: number;
    dispAmount: number;     // 布面拉伸强度 0..1
    bgColor?: [number, number, number, number];
  }): void {
    const gl = this.gl;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    const bg = opts.bgColor ?? [0.94, 0.93, 0.90, 1];
    gl.clearColor(bg[0], bg[1], bg[2], bg[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const aspect = w / Math.max(1, h);
    const scale: [number, number] = [
      (2 * opts.view.ppm * dpr) / w,
      (2 * opts.view.ppm * dpr) / h,
    ];
    void aspect;

    gl.useProgram(this.prog);
    gl.uniform2f(this.uni.uScale, scale[0], scale[1]);
    gl.uniform2f(this.uni.uOffset, opts.view.centerX, opts.view.centerY);
    gl.uniform1f(this.uni.uWidth, opts.stitchWidthMm);
    gl.uniform1f(this.uni.uSheen, opts.sheen);
    gl.uniform1f(this.uni.uLightAngle, (opts.lightAngleDeg * Math.PI) / 180);
    gl.uniform4fv(this.uni.uDispBounds, this.dispBounds);
    gl.uniform1f(this.uni.uDispMax, this.dispMax);
    gl.uniform1f(this.uni.uDispAmount, opts.dispAmount);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.dispTex);
    gl.uniform1i(this.uni.uDisp, 0);

    gl.bindVertexArray(this.vao);
    const count = Math.min(opts.progress, this.segmentCount);
    if (count > 0) gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);

    if (this.markerCount > 0) {
      gl.useProgram(this.markerProg);
      gl.uniform2f(this.markerUni.uScale, scale[0], scale[1]);
      gl.uniform2f(this.markerUni.uOffset, opts.view.centerX, opts.view.centerY);
      gl.uniform1f(this.markerUni.uPixelScale, dpr);
      gl.bindVertexArray(this.markerVao);
      gl.drawArrays(gl.POINTS, 0, this.markerCount);
    }
    gl.bindVertexArray(null);
  }

  get totalInstances(): number {
    return this.segmentCount;
  }
}
