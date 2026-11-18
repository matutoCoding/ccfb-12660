/**
 * 领域核心类型定义。
 * 坐标单位：内部全程使用 DST 单位（1 单位 = 0.1 mm），整数为主，
 * 仅多边形建模等中间过程允许浮点，编译成针迹时统一取整。
 */

/** 针迹/移动记录标志位（可组合） */
export enum StitchFlag {
  Normal = 0,
  Jump = 1,
  /** 换色（DST 中为 color change，机台在此停机换线） */
  ColorChange = 2,
  /** DST 结束记录 */
  End = 4
}

/** 展平后的针迹记录，顺序即机台实际绣制顺序 */
export interface Stitch {
  x: number;
  y: number;
  flags: StitchFlag;
  /** 归属分区 id（导入的 DST 无分区时为 null） */
  regionId: string | null;
  /** 归属色号（threadLibrary 中的线 id） */
  threadId: string | null;
}

export type StitchKind = 'running' | 'satin' | 'tatami';

/** 分区针法参数（密度单位：针/10mm，即每 100 个 DST 单位内的针迹行数） */
export interface RegionParams {
  kind: StitchKind;
  /** 针迹方向，弧度制（相对 +X 轴） */
  angle: number;
  /** 密度：行间距，单位 DST（0.1mm），缎纹常用 3~6（0.3~0.6mm） */
  rowSpacing: number;
  /** 拉线补偿（pull compensation）：沿针迹方向的延伸量，DST 单位 */
  pullCompensation: number;
  /** 平针针距，DST 单位 */
  runningStitchLength: number;
  /** 榻榻米针迹长度，DST 单位 */
  tatamiStitchLength: number;
  /** 缎纹单针最大长度，超过则加兜底针，DST 单位 */
  maxStitchLength: number;
  /** 底衬针开关与密度 */
  underlay: boolean;
  underlaySpacing: number;
}

export interface Region {
  id: string;
  name: string;
  /** 轮廓多边形（闭合，点按顺序，y 向上为正） */
  polygon: Pt[];
  /** 孔洞（可选） */
  holes: Pt[][];
  threadId: string;
  params: RegionParams;
  visible: boolean;
}

export interface Pt {
  x: number;
  y: number;
}

/** 绣线条目（参考常见涤纶丝线号段） */
export interface Thread {
  id: string;
  name: string;
  code: string;
  /** sRGB 十六进制，如 #d23b3b */
  color: string;
  /** 光泽强度 0~1，影响高光混合 */
  sheen: number;
}

export interface DesignMetadata {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** 编辑用画布范围（DST 单位） */
  width: number;
  height: number;
}

export interface Design extends DesignMetadata {
  regions: Region[];
  /** 绣制顺序（region id 序列），自动排程后可手动调整 */
  stitchOrder: string[];
  /** 直接导入的原始针迹（无分区编辑态时使用）；自制花版编译后也写入 */
  importedStitches: Stitch[] | null;
  version: number;
}

/** 密度告警（起坨：单位面积针数过高） */
export interface DensityWarning {
  x: number;
  y: number;
  /** 该格子内针数 */
  count: number;
  /** 格子边长，DST 单位 */
  cellSize: number;
  level: 'warn' | 'critical';
}

export interface DesignStats {
  stitchCount: number;
  jumpCount: number;
  colorChangeCount: number;
  /** 总线长（含跳针移动），DST 单位 */
  totalThreadLength: number;
  /** 实际缝制线长（不含跳针），DST 单位 */
  sewingLength: number;
  bbox: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** 预估工时，秒（按机台每分钟针数估算） */
  estimatedSeconds: number;
  warnings: DensityWarning[];
}

export interface VersionSnapshot {
  id: string;
  designId: string;
  label: string;
  createdAt: number;
  /** 快照时的完整 Design 副本 */
  design: Design;
  stats: DesignStats;
}

export interface ProductionSheet {
  id: string;
  name: string;
  createdAt: number;
  items: ProductionItem[];
  sheetWidth: number;
  sheetHeight: number;
}

export interface ProductionItem {
  designId: string;
  designName: string;
  copies: number;
  x: number;
  y: number;
  rotation: number;
}
