// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  otsuThreshold,
  simplifyDP,
  traceImageData,
  pxPolygonToDst,
  DEFAULT_TRACE
} from '../src/trace/bitmapTrace';
import type { Pt } from '../src/core/types';

function makeImage(width: number, height: number, draw: (x: number, y: number) => [number, number, number]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = draw(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  // jsdom 可能不提供 ImageData 全局类；描边算法只依赖 data/width/height
  return { data, width, height } as unknown as ImageData;
}

describe('Otsu 阈值', () => {
  it('黑白双峰图阈值落在中间', () => {
    const w = 40;
    const h = 40;
    const gray = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        gray[y * w + x] = x < w / 2 ? 20 : 230;
      }
    }
    const t = otsuThreshold(gray, w, h);
    expect(t).toBeGreaterThanOrEqual(20);
    expect(t).toBeLessThan(230);
  });
});

describe('位图描边', () => {
  it('单个实心方块得到 1 个闭合多边形，顶点数 >= 4', () => {
    const img = makeImage(30, 30, (x, y) =>
      x >= 10 && x < 20 && y >= 10 && y < 20 ? [0, 0, 0] : [255, 255, 255]
    );
    const regions = traceImageData(img, { ...DEFAULT_TRACE, minComponentArea: 10 });
    expect(regions.length).toBe(1);
    const poly = regions[0].polygonPx;
    expect(poly.length).toBeGreaterThanOrEqual(4);
    // 轮廓点都在方块边界附近
    for (const p of poly) {
      const onEdgeX = p.x === 10 || p.x === 19;
      const onEdgeY = p.y === 10 || p.y === 19;
      expect(onEdgeX || onEdgeY).toBe(true);
    }
  });

  it('两个分离方块得到 2 个分区', () => {
    const img = makeImage(60, 30, (x, y) => {
      const inA = x >= 5 && x < 15 && y >= 10 && y < 20;
      const inB = x >= 40 && x < 50 && y >= 10 && y < 20;
      return inA || inB ? [0, 0, 0] : [255, 255, 255];
    });
    const regions = traceImageData(img, { ...DEFAULT_TRACE, minComponentArea: 10 });
    expect(regions.length).toBe(2);
  });

  it('小噪点被 minComponentArea 过滤', () => {
    const img = makeImage(40, 40, (x, y) => {
      const big = x >= 10 && x < 30 && y >= 10 && y < 30;
      const noise = x === 2 && y === 2;
      return big || noise ? [0, 0, 0] : [255, 255, 255];
    });
    const regions = traceImageData(img, { ...DEFAULT_TRACE, minComponentArea: 50 });
    expect(regions.length).toBe(1);
  });
});

describe('DP 抽稀', () => {
  it('共线点被抽掉，端点保留', () => {
    const pts: Pt[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
      { x: 4, y: 0 }
    ];
    const out = simplifyDP(pts, 0.5);
    expect(out).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 0 }
    ]);
  });

  it('尖角点在容差内保留', () => {
    const pts: Pt[] = [
      { x: 0, y: 0 },
      { x: 5, y: 5 },
      { x: 10, y: 0 }
    ];
    const out = simplifyDP(pts, 1);
    expect(out.length).toBe(3);
  });
});

describe('像素→DST 坐标映射', () => {
  it('等比缩放且 y 轴翻转、居中', () => {
    const poly: Pt[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 }
    ];
    // 10px 图，目标短边 100 单位 → scale=10
    const out = pxPolygonToDst(poly, 10, 10, 100);
    expect(out[0]).toEqual({ x: -50, y: 50 }); // 左上 → y 向上
    expect(out[2]).toEqual({ x: 50, y: -50 }); // 右下
    for (const p of out) {
      expect(Number.isInteger(p.x)).toBe(true);
      expect(Number.isInteger(p.y)).toBe(true);
    }
  });
});
