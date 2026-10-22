import { VehicleDataError, type VehicleDataProvider, type VehicleDecodeResult } from "./types";
import { validateVin } from "./vin";

export interface VehicleDataCacheEntry {
  value: VehicleDecodeResult;
  expiresAt: number;
  staleAt: number;
}

export interface VehicleDataCache {
  get(vin: string): Promise<VehicleDataCacheEntry | null> | VehicleDataCacheEntry | null;
  set(vin: string, entry: VehicleDataCacheEntry): Promise<void> | void;
}

export interface VehicleDataServiceOptions {
  providers: readonly VehicleDataProvider[];
  cache?: VehicleDataCache;
  timeoutMs?: number;
  retries?: number;
  cacheTtlMs?: number;
  staleAfterMs?: number;
}

export interface VehicleDataServiceResult {
  data: VehicleDecodeResult;
  cache: "hit" | "stale" | "miss";
  attemptedProviders: readonly string[];
}

export class MemoryVehicleDataCache implements VehicleDataCache {
  readonly #entries = new Map<string, VehicleDataCacheEntry>();
  readonly #maximumEntries: number;

  constructor(maximumEntries = 500) {
    this.#maximumEntries = Math.max(1, maximumEntries);
  }

  get(vin: string): VehicleDataCacheEntry | null {
    const entry = this.#entries.get(vin);
    if (!entry) return null;
    this.#entries.delete(vin);
    this.#entries.set(vin, entry);
    return entry;
  }

  set(vin: string, entry: VehicleDataCacheEntry): void {
    this.#entries.delete(vin);
    this.#entries.set(vin, entry);
    while (this.#entries.size > this.#maximumEntries) {
      const oldest = this.#entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.#entries.delete(oldest);
    }
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createVehicleDataService(options: VehicleDataServiceOptions) {
  if (options.providers.length === 0) {
    throw new Error("At least one vehicle-data provider is required");
  }
  const timeoutMs = options.timeoutMs ?? 4_000;
  const retries = Math.max(0, options.retries ?? 1);
  const cacheTtlMs = options.cacheTtlMs ?? 90 * 24 * 60 * 60 * 1_000;
  const staleAfterMs = options.staleAfterMs ?? 30 * 24 * 60 * 60 * 1_000;
  const inFlight = new Map<string, Promise<VehicleDataServiceResult>>();

  async function fromProviders(vin: string): Promise<VehicleDataServiceResult> {
    const attemptedProviders: string[] = [];
    let finalError: unknown;

    for (const provider of options.providers) {
      attemptedProviders.push(provider.id);
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const data = await provider.decode(vin, { signal: controller.signal });
          const now = Date.now();
          await options.cache?.set(vin, {
            value: data,
            staleAt: now + staleAfterMs,
            expiresAt: now + cacheTtlMs,
          });
          return { data, cache: "miss", attemptedProviders };
        } catch (error) {
          finalError = error;
          const retryable = error instanceof VehicleDataError && error.retryable;
          if (!retryable || attempt === retries) break;
          await wait(100 * 2 ** attempt);
        } finally {
          clearTimeout(timer);
        }
      }
    }

    throw finalError instanceof Error
      ? finalError
      : new VehicleDataError("PROVIDER_UNAVAILABLE", "No vehicle-data provider succeeded", {
          cause: finalError,
          retryable: true,
        });
  }

  return {
    async decode(rawVin: string): Promise<VehicleDataServiceResult> {
      const validation = validateVin(rawVin);
      if (!validation.valid) {
        throw new VehicleDataError("INVALID_VIN", "VIN validation failed");
      }
      const now = Date.now();
      const cached = await options.cache?.get(validation.vin);
      if (cached && cached.expiresAt > now) {
        return {
          data: cached.value,
          cache: cached.staleAt > now ? "hit" : "stale",
          attemptedProviders: [],
        };
      }

      const existing = inFlight.get(validation.vin);
      if (existing) return existing;
      const request = fromProviders(validation.vin).finally(() => {
        inFlight.delete(validation.vin);
      });
      inFlight.set(validation.vin, request);
      return request;
    },
  };
}

export type VehicleDataService = ReturnType<typeof createVehicleDataService>;
