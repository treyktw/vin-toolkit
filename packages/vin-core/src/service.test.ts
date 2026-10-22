import { describe, expect, it, vi } from "vitest";
import { MemoryVehicleDataCache, createVehicleDataService } from "./service";
import { VehicleDataError, type VehicleDataProvider, type VehicleDecodeResult } from "./types";

const decoded: VehicleDecodeResult = {
  vin: "1HGBH41JXMN109186",
  make: "HONDA",
  model: "Accord",
  modelYear: 1991,
  vehicleType: "PASSENGER CAR",
  manufacturer: "Honda",
  plantCountry: "United States",
  plantCity: null,
  plantState: null,
  trim: null,
  series: null,
  engineModel: null,
  engineCylinders: null,
  engineDisplacement: null,
  engineHorsepower: null,
  fuelType: null,
  secondaryFuelType: null,
  electrificationLevel: null,
  transmissionStyle: null,
  transmissionSpeeds: null,
  driveType: null,
  bodyClass: "Sedan",
  doors: 4,
  seats: null,
  cabType: null,
  bedType: null,
  bedLengthInches: null,
  abs: null,
  airBagLocations: null,
  gvwr: null,
  suggestedVIN: null,
  errorCode: "0",
  errorText: null,
  possibleValues: null,
  provider: "test",
  providerVersion: null,
  decodedAt: 1,
  durationMs: 1,
  confidence: "high",
  completeness: 75,
  warnings: [],
  provenance: [],
};

describe("vehicle-data service", () => {
  it("coalesces concurrent work and serves the cache", async () => {
    const decode = vi.fn(async () => decoded);
    const provider: VehicleDataProvider = { id: "test", decode };
    const service = createVehicleDataService({
      providers: [provider],
      cache: new MemoryVehicleDataCache(),
    });

    const [first, second] = await Promise.all([
      service.decode(decoded.vin),
      service.decode(decoded.vin),
    ]);
    expect(first.data.make).toBe("HONDA");
    expect(second.data.make).toBe("HONDA");
    expect(decode).toHaveBeenCalledTimes(1);

    expect((await service.decode(decoded.vin)).cache).toBe("hit");
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid VINs before calling a provider", async () => {
    const decode = vi.fn(async () => decoded);
    const service = createVehicleDataService({
      providers: [{ id: "test", decode }],
    });
    await expect(service.decode("not-a-vin")).rejects.toMatchObject({
      code: "INVALID_VIN",
    });
    expect(decode).not.toHaveBeenCalled();
  });
});

describe("vehicle-data service failure policy", () => {
  it("retries a retryable error, then fails over to the next provider", async () => {
    const flaky = vi.fn(async () => {
      throw new VehicleDataError("PROVIDER_REJECTED", "HTTP 503", { retryable: true });
    });
    const backup = vi.fn(async () => ({ ...decoded, provider: "backup" }));
    const service = createVehicleDataService({
      providers: [
        { id: "flaky", decode: flaky },
        { id: "backup", decode: backup },
      ],
    });
    const result = await service.decode(decoded.vin);
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(backup).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      cache: "miss",
      attemptedProviders: ["flaky", "backup"],
    });
    expect(result.data.provider).toBe("backup");
  });

  it("does not retry a permanent error", async () => {
    const gone = vi.fn(async () => {
      throw new VehicleDataError("NO_VEHICLE_DATA", "none");
    });
    const service = createVehicleDataService({ providers: [{ id: "gone", decode: gone }] });
    await expect(service.decode(decoded.vin)).rejects.toMatchObject({ code: "NO_VEHICLE_DATA" });
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("aborts a slow provider at the timeout", async () => {
    const hang: VehicleDataProvider["decode"] = (_vin, context) =>
      new Promise((_resolve, reject) => {
        context?.signal?.addEventListener("abort", () =>
          reject(new VehicleDataError("PROVIDER_TIMEOUT", "timed out")),
        );
      });
    const service = createVehicleDataService({
      providers: [{ id: "slow", decode: hang }],
      timeoutMs: 20,
      retries: 0,
    });
    await expect(service.decode(decoded.vin)).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
  });

  it("serves a stale entry without calling providers until it expires", async () => {
    const cache = new MemoryVehicleDataCache();
    const now = Date.now();
    cache.set(decoded.vin, { value: decoded, staleAt: now - 1, expiresAt: now + 60_000 });
    const decode = vi.fn(async () => decoded);
    const service = createVehicleDataService({ providers: [{ id: "test", decode }], cache });
    expect((await service.decode(decoded.vin)).cache).toBe("stale");
    expect(decode).not.toHaveBeenCalled();

    cache.set(decoded.vin, { value: decoded, staleAt: now - 2, expiresAt: now - 1 });
    expect((await service.decode(decoded.vin)).cache).toBe("miss");
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it("evicts the least recently used entry past its capacity", () => {
    const cache = new MemoryVehicleDataCache(2);
    const entry = { value: decoded, staleAt: 1, expiresAt: 2 };
    cache.set("A", entry);
    cache.set("B", entry);
    cache.get("A");
    cache.set("C", entry);
    expect(cache.get("B")).toBeNull();
    expect(cache.get("A")).not.toBeNull();
  });
});
