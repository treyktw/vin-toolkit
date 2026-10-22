const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;
const NORTH_AMERICAN_WMI = /^[1-5]/;
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2] as const;
const TRANSLITERATION: Readonly<Record<string, number>> = {
  A: 1,
  B: 2,
  C: 3,
  D: 4,
  E: 5,
  F: 6,
  G: 7,
  H: 8,
  J: 1,
  K: 2,
  L: 3,
  M: 4,
  N: 5,
  P: 7,
  R: 9,
  S: 2,
  T: 3,
  U: 4,
  V: 5,
  W: 6,
  X: 7,
  Y: 8,
  Z: 9,
  "0": 0,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
};

const YEAR_CODES = "ABCDEFGHJKLMNPRSTVWXY123456789";

export type VinCheckDigitPolicy = "always" | "north_america" | "never";
export type VinCheckDigitStatus = "valid" | "invalid" | "not_required";

export interface VinValidationOptions {
  checkDigit?: VinCheckDigitPolicy;
  currentYear?: number;
}

export interface VinValidationResult {
  valid: boolean;
  vin: string;
  errors: readonly ("length" | "characters" | "check_digit")[];
  checkDigitStatus: VinCheckDigitStatus;
  expectedCheckDigit: string | null;
  suppliedCheckDigit: string | null;
  modelYearCandidates: readonly number[];
  likelyModelYear: number | null;
  region: string;
}

export interface VinStructure {
  vin: string;
  wmi: string;
  vds: string;
  vis: string;
  checkDigit: string;
  modelYearCode: string;
  plantCode: string;
  serialNumber: string;
  region: string;
  modelYearCandidates: readonly number[];
  likelyModelYear: number | null;
}

export interface RepairedVinCandidate {
  vin: string;
  corrected: boolean;
  replacements: readonly { index: number; from: string; to: string }[];
}

export function normalizeVin(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]/g, "");
}

export function vinRegion(vin: string): string {
  const first = vin[0];
  if (!first) return "unknown";
  if (/[1-5]/.test(first)) return "north_america";
  if (/[S-Z]/.test(first)) return "europe";
  if (/[J-R]/.test(first)) return "asia";
  if (/[6-7]/.test(first)) return "oceania";
  if (/[8-9]/.test(first)) return "south_america";
  if (/[A-H]/.test(first)) return "africa";
  return "unknown";
}

export function calculateVinCheckDigit(vin: string): string | null {
  const normalized = normalizeVin(vin);
  if (normalized.length !== 17) return null;
  let sum = 0;
  for (let index = 0; index < 17; index += 1) {
    const character = normalized[index];
    const value = character ? TRANSLITERATION[character] : undefined;
    if (value === undefined) return null;
    sum += value * (WEIGHTS[index] ?? 0);
  }
  const remainder = sum % 11;
  return remainder === 10 ? "X" : String(remainder);
}

export function modelYearCandidates(
  code: string,
  currentYear = new Date().getUTCFullYear(),
): readonly number[] {
  const index = YEAR_CODES.indexOf(code.toUpperCase());
  if (index < 0) return [];
  const first = 1980 + index;
  const candidates: number[] = [];
  for (let year = first; year <= currentYear + 31; year += 30) candidates.push(year);
  return candidates;
}

export function likelyModelYear(
  code: string,
  currentYear = new Date().getUTCFullYear(),
): number | null {
  const candidates = modelYearCandidates(code, currentYear).filter(
    (year) => year <= currentYear + 1,
  );
  return candidates[candidates.length - 1] ?? null;
}

export function validateVin(raw: string, options: VinValidationOptions = {}): VinValidationResult {
  const vin = normalizeVin(raw);
  const errors: Array<"length" | "characters" | "check_digit"> = [];
  if (vin.length !== 17) errors.push("length");
  if (vin.length === 17 && !VIN_PATTERN.test(vin)) errors.push("characters");

  const expectedCheckDigit = calculateVinCheckDigit(vin);
  const suppliedCheckDigit = vin[8] ?? null;
  const policy = options.checkDigit ?? "north_america";
  const required =
    policy === "always" || (policy === "north_america" && NORTH_AMERICAN_WMI.test(vin));
  const checkDigitStatus: VinCheckDigitStatus = required
    ? expectedCheckDigit !== null && suppliedCheckDigit === expectedCheckDigit
      ? "valid"
      : "invalid"
    : "not_required";
  if (required && checkDigitStatus === "invalid" && errors.length === 0) {
    errors.push("check_digit");
  }

  const currentYear = options.currentYear ?? new Date().getUTCFullYear();
  const yearCode = vin[9] ?? "";
  return {
    valid: errors.length === 0,
    vin,
    errors,
    checkDigitStatus,
    expectedCheckDigit,
    suppliedCheckDigit,
    modelYearCandidates: modelYearCandidates(yearCode, currentYear),
    likelyModelYear: likelyModelYear(yearCode, currentYear),
    region: vinRegion(vin),
  };
}

export function parseVinStructure(raw: string): VinStructure | null {
  const validation = validateVin(raw, { checkDigit: "never" });
  if (!validation.valid) return null;
  return {
    vin: validation.vin,
    wmi: validation.vin.slice(0, 3),
    vds: validation.vin.slice(3, 9),
    vis: validation.vin.slice(9),
    checkDigit: validation.vin[8] ?? "",
    modelYearCode: validation.vin[9] ?? "",
    plantCode: validation.vin[10] ?? "",
    serialNumber: validation.vin.slice(11),
    region: validation.region,
    modelYearCandidates: validation.modelYearCandidates,
    likelyModelYear: validation.likelyModelYear,
  };
}

export function extractVinCandidates(raw: string): readonly string[] {
  const tokens = raw.toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  const candidates = new Set<string>();
  for (const token of tokens) {
    for (let index = 0; index <= token.length - 17; index += 1) {
      candidates.add(token.slice(index, index + 17));
    }
  }
  return [...candidates];
}

/**
 * Repairs only characters that are illegal in a VIN but commonly produced by
 * OCR/barcode readers. A repair is accepted only when it is unique and passes
 * the applicable check-digit policy.
 */
export function repairVinCandidate(raw: string): RepairedVinCandidate | null {
  const candidates = extractVinCandidates(raw);
  const repaired: RepairedVinCandidate[] = [];
  const substitutions: Readonly<Record<string, readonly string[]>> = {
    I: ["1"],
    L: ["1"],
    O: ["0"],
    Q: ["0"],
  };

  for (const candidate of candidates) {
    const invalidIndexes = [...candidate].flatMap((character, index) =>
      substitutions[character] ? [index] : [],
    );
    if (invalidIndexes.length > 3) continue;

    const variants: Array<{
      value: string;
      replacements: Array<{ index: number; from: string; to: string }>;
    }> = [{ value: candidate, replacements: [] }];
    for (const index of invalidIndexes) {
      const next = variants.splice(0);
      const from = candidate[index];
      if (!from) continue;
      for (const variant of next) {
        for (const to of substitutions[from] ?? []) {
          variants.push({
            value: `${variant.value.slice(0, index)}${to}${variant.value.slice(index + 1)}`,
            replacements: [...variant.replacements, { index, from, to }],
          });
        }
      }
    }

    for (const variant of variants) {
      const validation = validateVin(variant.value);
      if (validation.valid) {
        repaired.push({
          vin: validation.vin,
          corrected: variant.replacements.length > 0,
          replacements: variant.replacements,
        });
      }
    }
  }

  const unique = [...new Map(repaired.map((item) => [item.vin, item])).values()];
  return unique.length === 1 ? (unique[0] ?? null) : null;
}
