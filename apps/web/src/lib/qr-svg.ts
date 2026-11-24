/**
 * Minimal, zero-dependency ISO/IEC 18004 QR Code (Byte mode, ECC Level L, Versions 1..10)
 * matrix generator for rendering scannable SVG QR codes in WorkspaceRemoteHost.
 */

const CAPACITY_L = [0, 17, 32, 53, 78, 106, 134, 154, 192, 230, 271];
const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const EC_CODEWORDS_PER_BLOCK = [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18];
const NUM_BLOCKS = [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4];
const ALIGNMENT_POS: number[][] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[i]!;
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j] ?? 0) ^ poly[j]!;
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(poly[j]!, root);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data: Uint8Array, ecLen: number): Uint8Array {
  const gen = rsGeneratorPoly(ecLen);
  const rem = new Uint8Array(ecLen);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i]! ^ rem[0]!;
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    for (let j = 0; j < ecLen; j++) {
      rem[j] = (rem[j] ?? 0) ^ gfMul(gen[j + 1]!, factor);
    }
  }
  return rem;
}

export function encodeQrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (version <= 10 && bytes.length > CAPACITY_L[version]!) version++;
  if (version > 10) version = 10;
  const payload = bytes.length > CAPACITY_L[version]! ? bytes.slice(0, CAPACITY_L[version]!) : bytes;

  const totalCodewords = TOTAL_CODEWORDS[version]!;
  const ecPerBlock = EC_CODEWORDS_PER_BLOCK[version]!;
  const blocks = NUM_BLOCKS[version]!;
  const dataCodewords = totalCodewords - ecPerBlock * blocks;

  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  pushBits(0b0100, 4);
  pushBits(payload.length, version <= 9 ? 8 : 16);
  for (const b of payload) pushBits(b, 8);
  const maxBits = dataCodewords * 8;
  pushBits(0, Math.min(4, maxBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const data = new Uint8Array(dataCodewords);
  for (let i = 0; i < bits.length / 8; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i * 8 + b]!;
    data[i] = byte;
  }
  let padIdx = 0;
  for (let i = bits.length / 8; i < dataCodewords; i++) {
    data[i] = padIdx % 2 === 0 ? 0xec : 0x11;
    padIdx++;
  }

  const blockData: Uint8Array[] = [];
  const blockEc: Uint8Array[] = [];
  const baseBlockSize = Math.floor(dataCodewords / blocks);
  const extraBlocks = dataCodewords % blocks;
  let offset = 0;
  for (let b = 0; b < blocks; b++) {
    const len = baseBlockSize + (b >= blocks - extraBlocks ? 1 : 0);
    const slice = data.slice(offset, offset + len);
    offset += len;
    blockData.push(slice);
    blockEc.push(rsEncode(slice, ecPerBlock));
  }

  const finalBytes: number[] = [];
  const maxDataLen = baseBlockSize + (extraBlocks > 0 ? 1 : 0);
  for (let i = 0; i < maxDataLen; i++) {
    for (let b = 0; b < blocks; b++) {
      if (i < blockData[b]!.length) finalBytes.push(blockData[b]![i]!);
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (let b = 0; b < blocks; b++) {
      finalBytes.push(blockEc[b]![i]!);
    }
  }

  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const reserved: boolean[][] = Array.from({ length: size }, () => Array<boolean>(size).fill(false));

  const setModule = (r: number, c: number, dark: boolean) => {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      modules[r]![c] = dark;
      reserved[r]![c] = true;
    }
  };

  const placeFinder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inOuter = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const onBorder = r === 0 || r === 6 || c === 0 || c === 6;
        const inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setModule(row + r, col + c, inOuter && (onBorder || inInner));
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    if (!reserved[6]![i]) setModule(6, i, i % 2 === 0);
    if (!reserved[i]![6]) setModule(i, 6, i % 2 === 0);
  }

  const align = ALIGNMENT_POS[version]!;
  for (const r of align) {
    for (const c of align) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setModule(r + dr, c + dc, dark);
        }
      }
    }
  }

  setModule(size - 8, 8, true);
  for (let i = 0; i < 9; i++) {
    if (!reserved[8]![i]) reserved[8]![i] = true;
    if (!reserved[i]![8]) reserved[i]![8] = true;
  }
  for (let i = 0; i < 8; i++) {
    if (!reserved[8]![size - 1 - i]) reserved[8]![size - 1 - i] = true;
    if (!reserved[size - 1 - i]![8]) reserved[size - 1 - i]![8] = true;
  }

  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const vInfo = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((vInfo >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setModule(b, a, bit);
      setModule(a, b, bit);
    }
  }

  let bitIdx = 0;
  const totalBits = finalBytes.length * 8;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      const r = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (!reserved[r]![c]) {
          let dark = false;
          if (bitIdx < totalBits) {
            dark = ((finalBytes[bitIdx >>> 3]! >>> (7 - (bitIdx & 7))) & 1) === 1;
            bitIdx++;
          }
          if ((r + c) % 2 === 0) dark = !dark;
          modules[r]![c] = dark;
        }
      }
    }
    upward = !upward;
  }

  // Format info for ECC L (01) and Mask 0 (000) -> data = 01000, BCH masked = 0x77c4 (30660)
  const formatBits = 0x77c4;
  for (let i = 0; i < 6; i++) modules[8]![i] = ((formatBits >>> i) & 1) === 1;
  modules[8]![7] = ((formatBits >>> 6) & 1) === 1;
  modules[8]![8] = ((formatBits >>> 7) & 1) === 1;
  modules[7]![8] = ((formatBits >>> 8) & 1) === 1;
  for (let i = 9; i < 15; i++) modules[14 - i]![8] = ((formatBits >>> i) & 1) === 1;
  for (let i = 0; i < 8; i++) modules[size - 1 - i]![8] = ((formatBits >>> i) & 1) === 1;
  for (let i = 8; i < 15; i++) modules[8]![size - 15 + i] = ((formatBits >>> i) & 1) === 1;

  return modules;
}

export function buildQrSvgPath(matrix: boolean[][]): { size: number; path: string } {
  const n = matrix.length;
  const quiet = 2;
  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix[r]![c]) {
        path += `M${c + quiet},${r + quiet}h1v1h-1z`;
      }
    }
  }
  return { size: n + quiet * 2, path };
}
