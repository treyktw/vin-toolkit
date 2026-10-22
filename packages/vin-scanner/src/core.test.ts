import { describe, expect, it } from "vitest";
import { VinScanConsensus } from "./core";

describe("VIN scan consensus", () => {
  it("requires matching observations from separate frames", () => {
    const consensus = new VinScanConsensus();
    const first = consensus.observe({
      rawValue: "VIN: 1HGBH41JXMN109186",
      source: "barcode_detector",
      format: "code_39",
      observedAt: 1_000,
    });
    expect(first.result).toBeNull();
    expect(first.progress.matches).toBe(1);

    const duplicate = consensus.observe({
      rawValue: "1HGBH41JXMN109186",
      source: "barcode_detector",
      format: "code_39",
      observedAt: 1_010,
    });
    expect(duplicate.progress.reason).toBe("duplicate_frame");

    const accepted = consensus.observe({
      rawValue: "1HGBH41JXMN109186",
      source: "barcode_detector",
      format: "code_39",
      observedAt: 1_100,
    });
    expect(accepted.result).toMatchObject({
      vin: "1HGBH41JXMN109186",
      matches: 2,
      checkDigit: "valid",
    });
    expect(accepted.result?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("rejects oversized or invalid barcode payloads", () => {
    const consensus = new VinScanConsensus();
    expect(consensus.observe({ rawValue: "x".repeat(2_049), source: "expo" }).progress.reason).toBe(
      "no_candidate",
    );
    expect(consensus.observe({ rawValue: "INVALID", source: "expo" }).progress.reason).toBe(
      "invalid_vin",
    );
  });
});

describe("VIN scan consensus thresholds", () => {
  it("needs three frames when the VIN has no check digit to confirm it", () => {
    const consensus = new VinScanConsensus();
    const observe = (observedAt: number) =>
      consensus.observe({ rawValue: "WZZZZ00Z0ZZ000006", source: "zxing", observedAt });
    expect(observe(0).result).toBeNull();
    expect(observe(100).progress).toMatchObject({ matches: 2, requiredMatches: 3 });
    const accepted = observe(200).result;
    expect(accepted).toMatchObject({ matches: 3, checkDigit: "not_required" });
  });

  it("forgets candidates that fall outside the observation window", () => {
    const consensus = new VinScanConsensus({ observationWindowMs: 500 });
    const raw = "1ZZZZ00Z8NZ000001";
    consensus.observe({ rawValue: raw, source: "zxing", observedAt: 0 });
    const late = consensus.observe({ rawValue: raw, source: "zxing", observedAt: 1_000 });
    expect(late.result).toBeNull();
    expect(late.progress.matches).toBe(1);
  });

  it("reports OCR corrections on the accepted result", () => {
    const consensus = new VinScanConsensus();
    consensus.observe({ rawValue: "1ZZZZOOZ8NZ000001", source: "manual", observedAt: 0 });
    const accepted = consensus.observe({
      rawValue: "1ZZZZOOZ8NZ000001",
      source: "manual",
      observedAt: 100,
    });
    expect(accepted.result).toMatchObject({ vin: "1ZZZZ00Z8NZ000001", corrected: true });
    expect(accepted.result?.corrections).toHaveLength(2);
  });
});
