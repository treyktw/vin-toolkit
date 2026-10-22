import type {
  VehicleDataProvider,
  VehicleDecodeContext,
  VehicleDecodeResult,
  VehicleDataConfidence,
  VehicleFieldProvenance,
  PartialVehicleDecode,
} from "./types";
import { VehicleDataError } from "./types";
import { validateVin } from "./vin";

const DEFAULT_BASE_URL = "https://vpic.nhtsa.dot.gov/api/vehicles";
const PROVIDER_ID = "nhtsa_vpic" as const;

type VpicValue = string | null | undefined;
type VpicRow = Record<string, VpicValue>;

interface VpicResponse {
  Count?: number;
  Message?: string;
  Results?: VpicRow[];
  SearchCriteria?: string;
}

function text(value: VpicValue): string | null {
  const normalized = value?.trim();
  return !normalized || normalized === "Not Applicable" ? null : normalized;
}

function number(value: VpicValue): number | null {
  const normalized = text(value);
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function completeness(
  result: Pick<
    VehicleDecodeResult,
    | "make"
    | "model"
    | "modelYear"
    | "bodyClass"
    | "engineModel"
    | "fuelType"
    | "transmissionStyle"
    | "driveType"
  >,
): number {
  const values = Object.values(result);
  return Math.round((values.filter((value) => value !== null).length / values.length) * 100);
}

function confidenceFor(score: number, errorCode: string | null): VehicleDataConfidence {
  if (errorCode && errorCode !== "0") return score >= 70 ? "medium" : "low";
  if (score >= 70) return "high";
  return score >= 40 ? "medium" : "low";
}

export interface NhtsaVpicProviderOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export class NhtsaVpicProvider implements VehicleDataProvider {
  readonly id = PROVIDER_ID;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: NhtsaVpicProviderOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    // Browsers throw "Illegal invocation" when window.fetch is called with a
    // receiver other than window, which `this.#fetch(...)` would do.
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async decode(rawVin: string, context: VehicleDecodeContext = {}): Promise<VehicleDecodeResult> {
    const validation = validateVin(rawVin);
    if (!validation.valid) {
      throw new VehicleDataError("INVALID_VIN", "VIN validation failed");
    }

    const startedAt = Date.now();
    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#baseUrl}/DecodeVinValuesExtended/${encodeURIComponent(validation.vin)}?format=json`,
        {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: context.signal,
        },
      );
    } catch (error) {
      if (context.signal?.aborted) {
        throw new VehicleDataError("PROVIDER_TIMEOUT", "Vehicle decoder timed out", {
          cause: error,
          retryable: true,
        });
      }
      throw new VehicleDataError("PROVIDER_UNAVAILABLE", "Vehicle decoder is unavailable", {
        cause: error,
        retryable: true,
      });
    }

    if (!response.ok) {
      throw new VehicleDataError(
        "PROVIDER_REJECTED",
        `Vehicle decoder returned HTTP ${response.status}`,
        { retryable: response.status >= 500 || response.status === 429 },
      );
    }

    const payload = (await response.json()) as VpicResponse;
    const row = payload.Results?.[0];
    if (!row) {
      throw new VehicleDataError("NO_VEHICLE_DATA", "Vehicle decoder returned no result");
    }

    const observedAt = Date.now();
    const errorCode = text(row.ErrorCode);
    const warnings =
      errorCode && errorCode !== "0"
        ? [
            {
              code: `NHTSA_${errorCode}`,
              message: text(row.ErrorText) ?? "NHTSA returned a decode warning",
            },
          ]
        : [];
    const base = {
      make: text(row.Make),
      model: text(row.Model),
      modelYear: number(row.ModelYear),
      bodyClass: text(row.BodyClass),
      engineModel: text(row.EngineModel),
      fuelType: text(row.FuelTypePrimary),
      transmissionStyle: text(row.TransmissionStyle),
      driveType: text(row.DriveType),
    };
    const score = completeness(base);
    const provenance: VehicleFieldProvenance[] = Object.entries(row)
      .filter(([, value]) => text(value) !== null)
      .map(([field]) => ({ field, provider: PROVIDER_ID, observedAt }));

    return {
      vin: validation.vin,
      ...base,
      vehicleType: text(row.VehicleType),
      manufacturer: text(row.Manufacturer),
      plantCountry: text(row.PlantCountry),
      plantCity: text(row.PlantCity),
      plantState: text(row.PlantState),
      trim: text(row.Trim),
      series: text(row.Series),
      engineCylinders: number(row.EngineCylinders),
      engineDisplacement: text(row.DisplacementL),
      engineHorsepower: number(row.EngineHP),
      secondaryFuelType: text(row.FuelTypeSecondary),
      electrificationLevel: text(row.ElectrificationLevel),
      transmissionSpeeds: text(row.TransmissionSpeeds),
      doors: number(row.Doors),
      seats: number(row.Seats),
      cabType: text(row.CabType),
      bedType: text(row.BedType),
      bedLengthInches: number(row.BedLengthIN),
      abs: text(row.ABS),
      airBagLocations: text(row.AirBagLocCurtain),
      gvwr: text(row.GVWR),
      suggestedVIN: text(row.SuggestedVIN),
      errorCode,
      errorText: text(row.ErrorText),
      possibleValues: text(row.PossibleValues),
      provider: PROVIDER_ID,
      // vPIC does not expose a provider-version field in this response.
      providerVersion: null,
      decodedAt: observedAt,
      durationMs: observedAt - startedAt,
      confidence: confidenceFor(score, errorCode),
      completeness: score,
      warnings,
      provenance,
    };
  }

  async decodePartial(
    rawPartialVin: string,
    context: VehicleDecodeContext = {},
  ): Promise<PartialVehicleDecode> {
    const partialVIN = rawPartialVin.trim().toUpperCase().replace(/[\s-]/g, "");
    if (!/^[A-HJ-NPR-Z0-9]{3,16}$/.test(partialVIN)) {
      throw new VehicleDataError(
        "INVALID_VIN",
        "Partial VIN must contain 3 to 16 valid VIN characters",
      );
    }
    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#baseUrl}/DecodeVinValues/${encodeURIComponent(partialVIN)}?format=json`,
        { headers: { Accept: "application/json" }, signal: context.signal },
      );
    } catch (error) {
      throw new VehicleDataError(
        context.signal?.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE",
        context.signal?.aborted ? "Vehicle decoder timed out" : "Vehicle decoder is unavailable",
        { cause: error, retryable: true },
      );
    }
    if (!response.ok) {
      throw new VehicleDataError(
        "PROVIDER_REJECTED",
        `Vehicle decoder returned HTTP ${response.status}`,
        { retryable: response.status >= 500 || response.status === 429 },
      );
    }
    const payload = (await response.json()) as VpicResponse;
    const row = payload.Results?.[0];
    if (!row) {
      throw new VehicleDataError("NO_VEHICLE_DATA", "Vehicle decoder returned no result");
    }
    return {
      partialVIN,
      make: text(row.Make),
      manufacturer: text(row.Manufacturer),
      vehicleType: text(row.VehicleType),
      possibleValues: text(row.PossibleValues),
      provider: PROVIDER_ID,
      decodedAt: Date.now(),
    };
  }
}
