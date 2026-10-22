import type { VinScanObservation } from "./core";

export const EXPO_VIN_BARCODE_TYPES = ["code39", "code128", "datamatrix", "qr"] as const;

export interface ExpoBarcodeResult {
  data: string;
  type?: string;
}

export function vinObservationFromExpo(
  result: ExpoBarcodeResult,
  observedAt = Date.now(),
): VinScanObservation {
  return {
    rawValue: result.data,
    format: result.type,
    source: "expo",
    observedAt,
  };
}
