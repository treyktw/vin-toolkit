import { describe, expect, it } from "vitest";
import { calculateVinCheckDigit, parseVinStructure, repairVinCandidate, validateVin } from "./vin";

describe("VIN primitives", () => {
  it("normalizes and validates a North American check digit", () => {
    const result = validateVin(" 1hgbh41jxmn109186 ");
    expect(result).toMatchObject({
      valid: true,
      vin: "1HGBH41JXMN109186",
      checkDigitStatus: "valid",
      likelyModelYear: 2021,
      region: "north_america",
    });
    expect(result.modelYearCandidates).toContain(1991);
    expect(result.modelYearCandidates).toContain(2021);
    expect(calculateVinCheckDigit(result.vin)).toBe("X");
  });

  it("rejects an invalid North American check digit", () => {
    expect(validateVin("1HGBH41JXMN109187")).toMatchObject({
      valid: false,
      errors: ["check_digit"],
    });
  });

  it("parses stable WMI, VDS, and VIS segments", () => {
    expect(parseVinStructure("1HGBH41JXMN109186")).toMatchObject({
      wmi: "1HG",
      vds: "BH41JX",
      vis: "MN109186",
      plantCode: "N",
      serialNumber: "109186",
    });
  });

  it("extracts a VIN from label text and uniquely repairs OCR characters", () => {
    expect(repairVinCandidate("VIN: 1HGBH41JXMN109186")?.vin).toBe("1HGBH41JXMN109186");
    expect(repairVinCandidate("VIN: 1HGBH4IJXMN109186")).toMatchObject({
      vin: "1HGBH41JXMN109186",
      corrected: true,
    });
  });
});

// Every VIN below is either the widely published sample 1HGBH41JXMN109186 or a
// synthetic all-"Z" VIN with a computed check digit; none belongs to a vehicle.
describe("constrained OCR repair", () => {
  it("repairs O and Q to 0 and L to 1 only when the result validates", () => {
    expect(repairVinCandidate("1ZZZZOQZ8NZ00000L")).toMatchObject({
      vin: "1ZZZZ00Z8NZ000001",
      corrected: true,
      replacements: [
        { index: 5, from: "O", to: "0" },
        { index: 6, from: "Q", to: "0" },
        { index: 16, from: "L", to: "1" },
      ],
    });
  });

  it("refuses a repair that still fails the North American check digit", () => {
    expect(repairVinCandidate("1HGBH4IJXMN109187")).toBeNull();
  });

  it("refuses to guess when more than one valid VIN remains", () => {
    expect(repairVinCandidate("1ZZZZ00Z8NZ000001 / 1ZZZZ00Z6PZ000002")).toBeNull();
  });

  it("gives up on candidates with more than three illegal characters", () => {
    expect(repairVinCandidate("1ZZZZOOZ8NZOOOOO1")).toBeNull();
  });

  it("does not require a check digit outside North America", () => {
    expect(validateVin("WZZZZ00Z0ZZ000006")).toMatchObject({
      valid: true,
      checkDigitStatus: "not_required",
      region: "europe",
    });
    expect(validateVin("WZZZZ00Z0ZZ000006", { checkDigit: "always" }).valid).toBe(false);
  });
});
