import { describe, expect, it, vi } from "vitest";
import { NhtsaVpicProvider } from "./nhtsa";

describe("NHTSA vPIC provider", () => {
  it("maps provider data into the stable vehicle contract", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            Results: [
              {
                VIN: "1HGBH41JXMN109186",
                Make: "HONDA",
                Model: "Accord",
                ModelYear: "1991",
                BodyClass: "Sedan/Saloon",
                Doors: "4",
                FuelTypePrimary: "Gasoline",
                ErrorCode: "0",
                ErrorText: "0 - VIN decoded clean. Check Digit (9th position) is correct",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const provider = new NhtsaVpicProvider({ fetch });

    await expect(provider.decode("1HGBH41JXMN109186")).resolves.toMatchObject({
      vin: "1HGBH41JXMN109186",
      make: "HONDA",
      model: "Accord",
      modelYear: 1991,
      doors: 4,
      provider: "nhtsa_vpic",
      providerVersion: null,
      confidence: "medium",
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/DecodeVinValuesExtended/1HGBH41JXMN109186"),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects a bad VIN before making a provider request", async () => {
    const fetch = vi.fn();
    const provider = new NhtsaVpicProvider({ fetch });
    await expect(provider.decode("INVALID")).rejects.toMatchObject({
      code: "INVALID_VIN",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("NHTSA vPIC provider errors", () => {
  const vin = "1ZZZZ00Z8NZ000001";

  it("marks 5xx and 429 retryable and 4xx permanent", async () => {
    for (const [status, retryable] of [
      [503, true],
      [429, true],
      [400, false],
    ] as const) {
      const provider = new NhtsaVpicProvider({
        fetch: vi.fn(async () => new Response("", { status })),
      });
      await expect(provider.decode(vin)).rejects.toMatchObject({
        code: "PROVIDER_REJECTED",
        retryable,
      });
    }
  });

  it("reports an aborted request as a timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new NhtsaVpicProvider({
      fetch: vi.fn(async () => {
        throw new DOMException("aborted", "AbortError");
      }),
    });
    await expect(provider.decode(vin, { signal: controller.signal })).rejects.toMatchObject({
      code: "PROVIDER_TIMEOUT",
      retryable: true,
    });
  });

  it("surfaces vPIC decode warnings and lowers confidence", async () => {
    const provider = new NhtsaVpicProvider({
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              Results: [{ Make: "", ErrorCode: "8", ErrorText: "8 - No detailed data available" }],
            }),
          ),
      ),
    });
    const result = await provider.decode(vin);
    expect(result.confidence).toBe("low");
    expect(result.warnings).toEqual([{ code: "NHTSA_8", message: "8 - No detailed data available" }]);
    expect(result.provenance.map((item) => item.field)).toEqual(["ErrorCode", "ErrorText"]);
  });

  it("validates partial VINs before calling vPIC", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ Results: [{ Make: "HONDA" }] })),
    );
    const provider = new NhtsaVpicProvider({ fetch });
    await expect(provider.decodePartial("1H")).rejects.toMatchObject({ code: "INVALID_VIN" });
    await expect(provider.decodePartial("1hg-bh")).resolves.toMatchObject({
      partialVIN: "1HGBH",
      make: "HONDA",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("NHTSA vPIC provider default fetch", () => {
  it("calls the global fetch with globalThis as its receiver", async () => {
    const original = globalThis.fetch;
    let receiver: unknown;
    globalThis.fetch = function (this: unknown) {
      receiver = this;
      return Promise.resolve(new Response(JSON.stringify({ Results: [{ Make: "HONDA" }] })));
    } as typeof fetch;
    try {
      await new NhtsaVpicProvider().decode("1HGBH41JXMN109186");
      expect(receiver).toBe(globalThis);
    } finally {
      globalThis.fetch = original;
    }
  });
});
