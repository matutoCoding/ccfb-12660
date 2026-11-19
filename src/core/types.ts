// 核心数据模型。坐标单位统一为毫米(mm)，Y 轴向上，原点在花版中心。

export interface Vec2 {
  x: number;
  y: number;
}

/** 针法类型:平针(轮廓走针) / 缎纹(横向包针) / 榻榻米(来回填针) */
export type StitchType = 'run' | 'satin' | 'tatami';

export const STITCH_TYPE_NAMES: Record<StitchType, string> = {
  run: '平针',
  satin: '缎纹',
  tatami: '榻榻米',
};

/** 一个绣花分区 */
export interface Region {
  id: string;
  name: string;
  /** 外轮廓多边形(mm),逆时针 */
  outline: Vec2[];
  /** 孔洞轮廓 */
  holes: Vec2[][];
  stitchType: StitchType;
  /** 针迹方向(度),榻榻米为行方向,缎纹为横跨方向的垂直方向 */
  angle: number;
  /** 密度:行距/针迹间距(mm),越小越密 */
  density: number;
  /** 针迹长度(mm),平针与榻榻米填充用 */
  stitchLength: number;
  /** 拉线补偿(mm),轮廓外扩量 */
  pullComp: number;
  /** 绣线颜色 id(对应颜色库) */
  colorId: string;
}

/** 针迹记录标志,与 DST 语义一一对应 */
export enum Flag {
  Stitch = 0,
  Jump = 1,
  Color = 2,
  End = 3,
}

/** 一条针迹记录:绝对坐标(mm)。仿真与 DST 导出共用,顺序即绣制顺序。 */
export interface StitchRec {
  x: number;
  y: number;
  flag: Flag;
  /** 该针所属分区(生成时写入;从 DST 导入时为 -1) */
  region: number;
}

export interface Pattern {
  id: string;
  name: string;
  /** 分区列表,数组顺序即绣制顺序 */
  regions: Region[];
  /** 由分区生成的完整针迹序列(含跳针/换色),仿真与导出 DST 都以此为准 */
  stitches: StitchRec[];
  createdAt: number;
  updatedAt: number;
}

export interface PatternVersion {
  id: string;
  savedAt: number;
  note: string;
  name: string;
  regions: Region[];
  stitches: StitchRec[];
}

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function createRegion(partial: Partial<Region> = {}): Region {
  return {
    id: newId(),
    name: '分区',
    outline: [],
    holes: [],
    stitchType: 'tatami',
    angle: 45,
    density: 0.4,
    stitchLength: 3.0,
    pullComp: 0.2,
    colorId: 'T1800',
    ...partial,
  };
}

export function createPattern(name: string): Pattern {
  return {
    id: newId(),
    name,
    regions: [],
    stitches: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** 花版外接框 */
export function patternBounds(stitches: StitchRec[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of stitches) {
    if (s.x < minX) minX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.x > maxX) maxX = s.x;
    if (s.y > maxY) maxY = s.y;
  }
  if (!isFinite(minX)) { minX = minY = maxX = maxY = 0; }
  return { minX, minY, maxX, maxY };
}
