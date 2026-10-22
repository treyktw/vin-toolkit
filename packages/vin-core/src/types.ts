export type VehicleDataProviderId = "nhtsa_vpic" | (string & {});

export type VehicleDataConfidence = "high" | "medium" | "low";

export interface VehicleFieldProvenance {
  field: string;
  provider: VehicleDataProviderId;
  observedAt: number;
}

export interface VehicleDecodeWarning {
  code: string;
  message: string;
}

/** Stable, vendor-neutral decoded vehicle contract used by every client. */
export interface VehicleDecodeResult {
  vin: string;
  make: string | null;
  model: string | null;
  modelYear: number | null;
  vehicleType: string | null;
  manufacturer: string | null;
  plantCountry: string | null;
  plantCity: string | null;
  plantState: string | null;
  trim: string | null;
  series: string | null;
  engineModel: string | null;
  engineCylinders: number | null;
  engineDisplacement: string | null;
  engineHorsepower: number | null;
  fuelType: string | null;
  secondaryFuelType: string | null;
  electrificationLevel: string | null;
  transmissionStyle: string | null;
  transmissionSpeeds: string | null;
  driveType: string | null;
  bodyClass: string | null;
  doors: number | null;
  seats: number | null;
  cabType: string | null;
  bedType: string | null;
  bedLengthInches: number | null;
  abs: string | null;
  airBagLocations: string | null;
  gvwr: string | null;
  suggestedVIN: string | null;
  errorCode: string | null;
  errorText: string | null;
  possibleValues: string | null;
  provider: VehicleDataProviderId;
  providerVersion: string | null;
  decodedAt: number;
  durationMs: number;
  confidence: VehicleDataConfidence;
  completeness: number;
  warnings: readonly VehicleDecodeWarning[];
  provenance: readonly VehicleFieldProvenance[];
}

export interface VehicleDecodeContext {
  signal?: AbortSignal;
}

export interface PartialVehicleDecode {
  partialVIN: string;
  make: string | null;
  manufacturer: string | null;
  vehicleType: string | null;
  possibleValues: string | null;
  provider: VehicleDataProviderId;
  decodedAt: number;
}

export interface VehicleDataProvider {
  readonly id: VehicleDataProviderId;
  decode(vin: string, context?: VehicleDecodeContext): Promise<VehicleDecodeResult>;
  decodeBatch?(
    vins: readonly string[],
    context?: VehicleDecodeContext,
  ): Promise<readonly VehicleDecodeResult[]>;
}

export type VehicleDataErrorCode =
  | "INVALID_VIN"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_REJECTED"
  | "PROVIDER_UNAVAILABLE"
  | "NO_VEHICLE_DATA";

export class VehicleDataError extends Error {
  readonly code: VehicleDataErrorCode;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(
    code: VehicleDataErrorCode,
    message: string,
    options: { cause?: unknown; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "VehicleDataError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.cause = options.cause;
  }
}
