import { repairVinCandidate, validateVin, type RepairedVinCandidate } from "vin-core/vin";

export type VinScanSource = "barcode_detector" | "zxing" | "expo" | "manual";
export type VinBarcodeFormat = "code39" | "code128" | "data_matrix" | "qr" | "unknown";

export interface VinScanObservation {
  rawValue: string;
  source: VinScanSource;
  format?: string;
  observedAt?: number;
}

export interface VinScanProgress {
  candidate: string | null;
  matches: number;
  requiredMatches: number;
  rejected: boolean;
  reason?: "no_candidate" | "invalid_vin" | "duplicate_frame";
}

export interface VinScanResult {
  vin: string;
  confidence: number;
  matches: number;
  durationMs: number;
  source: VinScanSource;
  format: VinBarcodeFormat;
  checkDigit: "valid" | "not_required";
  corrected: boolean;
  corrections: RepairedVinCandidate["replacements"];
}

export interface VinScanConsensusOptions {
  minimumMatches?: number;
  internationalMinimumMatches?: number;
  observationWindowMs?: number;
  minimumFrameSpacingMs?: number;
}

interface CandidateState {
  firstSeenAt: number;
  lastSeenAt: number;
  matches: number;
  repaired: RepairedVinCandidate;
  source: VinScanSource;
  format: VinBarcodeFormat;
}

export function normalizeBarcodeFormat(format?: string): VinBarcodeFormat {
  const normalized = format?.toLowerCase().replace(/[-_\s]/g, "") ?? "";
  if (normalized === "code39") return "code39";
  if (normalized === "code128") return "code128";
  if (normalized === "datamatrix") return "data_matrix";
  if (normalized === "qr" || normalized === "qrcode") return "qr";
  return "unknown";
}

/** Extracts and safely repairs one unambiguous VIN from scanner or OCR text. */
export function extractVin(raw: string): string | null {
  return repairVinCandidate(raw)?.vin ?? null;
}

/** Requires repeated matching frames instead of trusting a single camera read. */
export class VinScanConsensus {
  readonly #minimumMatches: number;
  readonly #internationalMinimumMatches: number;
  readonly #observationWindowMs: number;
  readonly #minimumFrameSpacingMs: number;
  readonly #candidates = new Map<string, CandidateState>();

  constructor(options: VinScanConsensusOptions = {}) {
    this.#minimumMatches = Math.max(1, options.minimumMatches ?? 2);
    this.#internationalMinimumMatches = Math.max(
      this.#minimumMatches,
      options.internationalMinimumMatches ?? 3,
    );
    this.#observationWindowMs = Math.max(250, options.observationWindowMs ?? 2_000);
    this.#minimumFrameSpacingMs = Math.max(0, options.minimumFrameSpacingMs ?? 75);
  }

  reset(): void {
    this.#candidates.clear();
  }

  observe(observation: VinScanObservation): {
    progress: VinScanProgress;
    result: VinScanResult | null;
  } {
    const now = observation.observedAt ?? Date.now();
    for (const [vin, state] of this.#candidates) {
      if (now - state.lastSeenAt > this.#observationWindowMs) {
        this.#candidates.delete(vin);
      }
    }

    if (!observation.rawValue || observation.rawValue.length > 2_048) {
      return {
        progress: {
          candidate: null,
          matches: 0,
          requiredMatches: this.#minimumMatches,
          rejected: true,
          reason: "no_candidate",
        },
        result: null,
      };
    }

    const repaired = repairVinCandidate(observation.rawValue);
    if (!repaired) {
      return {
        progress: {
          candidate: null,
          matches: 0,
          requiredMatches: this.#minimumMatches,
          rejected: true,
          reason: "invalid_vin",
        },
        result: null,
      };
    }

    const validation = validateVin(repaired.vin);
    const requiredMatches =
      validation.checkDigitStatus === "valid"
        ? this.#minimumMatches
        : this.#internationalMinimumMatches;
    const previous = this.#candidates.get(repaired.vin);
    if (previous && now - previous.lastSeenAt < this.#minimumFrameSpacingMs) {
      return {
        progress: {
          candidate: repaired.vin,
          matches: previous.matches,
          requiredMatches,
          rejected: true,
          reason: "duplicate_frame",
        },
        result: null,
      };
    }

    const state: CandidateState = previous
      ? { ...previous, lastSeenAt: now, matches: previous.matches + 1 }
      : {
          firstSeenAt: now,
          lastSeenAt: now,
          matches: 1,
          repaired,
          source: observation.source,
          format: normalizeBarcodeFormat(observation.format),
        };
    this.#candidates.set(repaired.vin, state);
    const progress: VinScanProgress = {
      candidate: repaired.vin,
      matches: state.matches,
      requiredMatches,
      rejected: false,
    };
    if (state.matches < requiredMatches) return { progress, result: null };

    const checksumBonus = validation.checkDigitStatus === "valid" ? 0.25 : 0.1;
    const formatBonus = state.format === "unknown" ? 0 : 0.05;
    const repeatBonus = Math.min(0.2, (state.matches - 1) * 0.1);
    return {
      progress,
      result: {
        vin: repaired.vin,
        confidence: Math.min(1, 0.5 + checksumBonus + formatBonus + repeatBonus),
        matches: state.matches,
        durationMs: now - state.firstSeenAt,
        source: state.source,
        format: state.format,
        checkDigit: validation.checkDigitStatus === "valid" ? "valid" : "not_required",
        corrected: repaired.corrected,
        corrections: repaired.replacements,
      },
    };
  }
}
