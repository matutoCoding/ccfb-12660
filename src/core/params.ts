import type { RegionParams, StitchKind } from './types';
import { mmToUnit } from './units';

/** 分区参数默认值（单位均为 DST unit = 0.1mm） */
export function defaultParams(kind: StitchKind): RegionParams {
  return {
    kind,
    angle: 0,
    // 缎纹默认行距 0.4mm；榻榻米 0.5mm；平针不使用行距
    rowSpacing: kind === 'satin' ? mmToUnit(0.4) : mmToUnit(0.5),
    pullCompensation: mmToUnit(0.2),
    runningStitchLength: mmToUnit(2.5),
    tatamiStitchLength: mmToUnit(4),
    maxStitchLength: mmToUnit(12),
    underlay: false,
    underlaySpacing: mmToUnit(2)
  };
}

/** 参数合法性钳制，避免密度设成 0 导致死循环 */
export function clampParams(p: RegionParams): RegionParams {
  return {
    ...p,
    angle: p.angle,
    rowSpacing: Math.max(mmToUnit(0.1), p.rowSpacing),
    pullCompensation: Math.max(0, Math.min(mmToUnit(5), p.pullCompensation)),
    runningStitchLength: Math.max(mmToUnit(0.5), p.runningStitchLength),
    tatamiStitchLength: Math.max(mmToUnit(0.5), p.tatamiStitchLength),
    maxStitchLength: Math.max(mmToUnit(1), p.maxStitchLength),
    underlaySpacing: Math.max(mmToUnit(0.5), p.underlaySpacing)
  };
}
