// 全局数据模型。坐标统一为毫米(mm)，Y 轴向上（绣品正面视角）。

export interface Vec2 {
  x: number;
  y: number;
}

export type StitchType = 'run' | 'satin' | 'tatami';

export const STITCH_TYPE_NAMES: Record<StitchType, string> = {
  run: '平针',
  satin: '缎纹',
  tatami: '榻榻米',
};

export interface Region {
  id: string;
  name: string;
  /** 轮廓多边形（mm，逆时针）。dst 来源的分区用 points 直接保存针迹 */
  polygon: Vec2[];
  source: 'drawn' | 'traced' | 'dst';
  /** source === 'dst' 时：文件里的原始针点（顺序与文件一致，不参与参数重算） */
  points?: Vec2[];
  stitchType: StitchType;
  /** 针迹方向（度）。缎纹=列方向，榻榻米=行方向 */
  angle: number;
  /** 行距/列距（mm），越小越密 */
  spacing: number;
  /** 针迹长度（mm），平针/榻榻米用 */
  stitchLength: number;
  /** 拉线补偿（mm），轮廓外扩量 */
  pullComp: number;
  /** 绣线颜色 id（threadlib） */
  colorId: string;
}

export interface VersionSnapshot {
  id: string;
  time: number;
  label: string;
  regions: Region[];
}

export interface Pattern {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  regions: Region[];
  versions: VersionSnapshot[];
}

/** 仿真/DST 记录：一条记录 = 一次针迹移动（绝对坐标） */
export type RecordFlag = 'stitch' | 'jump' | 'color';

export interface SimRecord {
  x: number;
  y: number;
  flag: RecordFlag;
  /** 所属分区块下标（StitchPlan.blocks） */
  block: number;
}

export interface StitchBlock {
  regionId: string;
  colorId: string;
  points: Vec2[];
}

export interface ColorStat {
  colorId: string;
  stitches: number;
  lengthMm: number;
}

export interface PlanStats {
  stitches: number;
  jumps: number;
  colorChanges: number;
  lengthMm: number;
  estSeconds: number;
  perColor: ColorStat[];
}

export interface StitchPlan {
  blocks: StitchBlock[];
  records: SimRecord[];
  stats: PlanStats;
  /** 起坨警告点（mm） */
  hotspots: Vec2[];
}

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
