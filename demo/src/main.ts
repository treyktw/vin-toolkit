import "./style.css";
import {
  MemoryVehicleDataCache,
  NhtsaVpicProvider,
  VehicleDataError,
  createVehicleDataService,
  extractVinCandidates,
  repairVinCandidate,
  validateVin,
  type RepairedVinCandidate,
  type VehicleDecodeResult,
} from "vin-core";
import { startWebVinScanner, type WebVinScannerController } from "vin-scanner/web";

const vinInput = document.querySelector<HTMLInputElement>("#vin-input")!;
const analysisPanel = document.querySelector<HTMLDivElement>("#analysis")!;
const decodePanel = document.querySelector<HTMLDivElement>("#decode")!;
const cameraVideo = document.querySelector<HTMLVideoElement>("#camera")!;
const scanStatus = document.querySelector<HTMLDivElement>("#scan-status")!;
const scanStartButton = document.querySelector<HTMLButtonElement>("#scan-start")!;
const scanStopButton = document.querySelector<HTMLButtonElement>("#scan-stop")!;
const engineLabel = document.querySelector<HTMLSpanElement>("#engine")!;

// One service for the page: repeat decodes of the same VIN are cache hits, and
// a scan result landing while a typed decode is in flight is coalesced.
const vehicleDataService = createVehicleDataService({
  providers: [new NhtsaVpicProvider()],
  cache: new MemoryVehicleDataCache(100),
});

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

/** "letter O" / "digit 0": a repair label must not rely on the font to tell O from 0. */
function describeCharacter(character: string): string {
  const kind = /[0-9]/.test(character) ? "digit" : "letter";
  return `${kind} <code>${escapeHtml(character)}</code>`;
}

function renderVin(vin: string, repaired: RepairedVinCandidate | null, badCheckDigit: boolean): string {
  const fixedIndexes = new Set(repaired?.replacements.map((change) => change.index) ?? []);
  return [...vin]
    .map((character, index) => {
      const classes = [
        fixedIndexes.has(index) ? "fix" : "",
        index === 8 ? (badCheckDigit ? "bad" : "check") : "",
      ].filter(Boolean);
      return classes.length
        ? `<span class="${classes.join(" ")}">${escapeHtml(character)}</span>`
        : escapeHtml(character);
    })
    .join("");
}

/** Shows what validation and constrained repair make of the typed text; returns the VIN to decode. */
function analyze(raw: string): string | null {
  if (!raw.trim()) {
    analysisPanel.innerHTML = "";
    return null;
  }
  const validation = validateVin(raw);
  if (validation.valid) {
    analysisPanel.innerHTML = `
      <div class="vin">${renderVin(validation.vin, null, false)}</div>
      <p><span class="badge ok">valid</span><span class="badge ${validation.checkDigitStatus === "valid" ? "ok" : "warn"}">check digit ${validation.checkDigitStatus.replace("_", " ")}</span></p>
      ${structureList(validation)}`;
    return validation.vin;
  }

  const repaired = repairVinCandidate(raw);
  if (repaired) {
    const changes = repaired.replacements.length
      ? repaired.replacements
          .map((change) => `position ${change.index + 1}: ${describeCharacter(change.from)} → ${describeCharacter(change.to)}`)
          .join(", ")
      : "extracted from surrounding text";
    analysisPanel.innerHTML = `
      <div class="vin">${renderVin(repaired.vin, repaired, false)}</div>
      <p><span class="badge warn">repaired</span>${changes}</p>
      <p class="muted">I, L, O and Q are illegal in a VIN but common OCR misreads. The repair was accepted because exactly one substitution produces a VIN that passes the check digit.</p>
      ${structureList(validateVin(repaired.vin))}`;
    return repaired.vin;
  }

  const reasons: string[] = [];
  // Each 17-character window repaired on its own: more than one distinct result
  // means the text is ambiguous, which is exactly when repair must refuse.
  const possibleVins = new Set(
    extractVinCandidates(raw).flatMap((candidate) => repairVinCandidate(candidate)?.vin ?? []),
  );
  if (possibleVins.size > 1)
    reasons.push(`${possibleVins.size} different valid VINs are possible (${[...possibleVins].join(", ")}); refusing to pick one`);
  else if (validation.errors.includes("length")) reasons.push(`${validation.vin.length} characters (need 17)`);
  if (validation.errors.includes("characters")) reasons.push("contains characters a VIN cannot hold");
  if (validation.errors.includes("check_digit"))
    reasons.push(`check digit is ${validation.suppliedCheckDigit}, expected ${validation.expectedCheckDigit}`);
  analysisPanel.innerHTML = `
    ${validation.vin.length === 17 ? `<div class="vin">${renderVin(validation.vin, null, validation.errors.includes("check_digit"))}</div>` : ""}
    <p><span class="badge bad">rejected</span>${escapeHtml(reasons.join("; ") || "no VIN found")}</p>
    <p class="muted">No repair was offered: either no substitution of I/L/O/Q yields a valid VIN, or more than one does and guessing would be unsafe.</p>`;
  return null;
}

function structureList(validation: ReturnType<typeof validateVin>): string {
  const vin = validation.vin;
  return `<dl>
    <dt>WMI</dt><dd>${vin.slice(0, 3)} · ${validation.region.replace("_", " ")}</dd>
    <dt>VDS</dt><dd>${vin.slice(3, 9)}</dd>
    <dt>VIS</dt><dd>${vin.slice(9)}</dd>
    <dt>Model year</dt><dd>${validation.likelyModelYear ?? "?"} <span class="muted">(${validation.modelYearCandidates.join(" / ")})</span></dd>
  </dl>`;
}

let latestDecodeRequest = 0;

async function decode(vin: string): Promise<void> {
  const requestNumber = ++latestDecodeRequest;
  decodePanel.innerHTML = `<p class="muted">Decoding ${vin}…</p>`;
  try {
    const { data, cache, attemptedProviders } = await vehicleDataService.decode(vin);
    if (requestNumber !== latestDecodeRequest) return;
    decodePanel.innerHTML = renderDecode(data, cache, attemptedProviders);
  } catch (error) {
    if (requestNumber !== latestDecodeRequest) return;
    const message =
      error instanceof VehicleDataError ? `${error.code}: ${error.message}` : String(error);
    decodePanel.innerHTML = `<p><span class="badge bad">failed</span>${escapeHtml(message)}</p>`;
  }
}

function renderDecode(data: VehicleDecodeResult, cache: string, attemptedProviders: readonly string[]): string {
  const rows: Array<[string, string | number | null]> = [
    ["Make", data.make],
    ["Model", data.model],
    ["Year", data.modelYear],
    ["Trim", data.trim],
    ["Series", data.series],
    ["Body", data.bodyClass],
    ["Vehicle type", data.vehicleType],
    ["Doors", data.doors],
    ["Engine", [data.engineCylinders && `${data.engineCylinders} cyl`, data.engineDisplacement && `${Number(data.engineDisplacement).toFixed(1)} L`, data.engineHorsepower && `${data.engineHorsepower} hp`].filter(Boolean).join(" · ") || null],
    ["Fuel", data.fuelType],
    ["Transmission", [data.transmissionStyle, data.transmissionSpeeds && `${data.transmissionSpeeds}-speed`].filter(Boolean).join(", ") || null],
    ["Drive", data.driveType],
    ["Manufacturer", data.manufacturer],
    ["Plant", [data.plantCity, data.plantState, data.plantCountry].filter(Boolean).join(", ") || null],
    ["GVWR", data.gvwr],
  ];
  const confidenceClass = data.confidence === "high" ? "ok" : data.confidence === "medium" ? "warn" : "bad";
  return `
    <p>
      <span class="badge ${confidenceClass}">${data.confidence} confidence · ${data.completeness}%</span>
      <span class="badge ${cache === "miss" ? "warn" : "ok"}">cache ${cache}</span>
      <span class="muted">${attemptedProviders.length ? `${attemptedProviders.join(" → ")} in ${data.durationMs} ms` : "served from cache"}</span>
    </p>
    ${data.warnings.map((warning) => `<p><span class="badge warn">${escapeHtml(warning.code)}</span>${escapeHtml(warning.message)}</p>`).join("")}
    <dl>${rows.map(([label, value]) => `<dt>${label}</dt><dd>${value === null || value === "" ? "—" : escapeHtml(String(value))}</dd>`).join("")}</dl>
    <details>
      <summary>Field provenance (${data.provenance.length} fields from ${data.provider})</summary>
      <p class="muted">${data.provenance.map((item) => escapeHtml(item.field)).join(", ")}</p>
    </details>`;
}

let typingTimer: ReturnType<typeof setTimeout> | undefined;
vinInput.addEventListener("input", () => {
  const vin = analyze(vinInput.value);
  clearTimeout(typingTimer);
  if (vin) typingTimer = setTimeout(() => void decode(vin), 300);
});

document.querySelectorAll<HTMLButtonElement>("[data-sample]").forEach((button) => {
  button.addEventListener("click", () => {
    vinInput.value = button.dataset.sample ?? "";
    vinInput.dispatchEvent(new Event("input"));
  });
});

let scanner: WebVinScannerController | null = null;

scanStartButton.addEventListener("click", async () => {
  scanStartButton.disabled = true;
  scanStatus.textContent = "Starting camera…";
  try {
    scanner = await startWebVinScanner({
      video: cameraVideo,
      onProgress(progress) {
        scanStatus.textContent = progress.rejected
          ? `Frame rejected: ${progress.reason?.replace("_", " ")}`
          : `${progress.candidate} · ${progress.matches}/${progress.requiredMatches} frames`;
      },
      onResult(result) {
        scanStatus.textContent = `Accepted ${result.vin} · ${Math.round(result.confidence * 100)}% · ${result.matches} frames in ${result.durationMs} ms`;
        vinInput.value = result.vin;
        analyze(result.vin);
        void decode(result.vin);
        scanner = null;
        scanStartButton.disabled = false;
        scanStopButton.disabled = true;
      },
      onError(error) {
        scanStatus.textContent = `Camera error: ${error.message}`;
      },
    });
    engineLabel.textContent = `engine: ${scanner.engine === "barcode_detector" ? "native BarcodeDetector" : "ZXing (fallback)"}`;
    scanStatus.textContent = "Looking for a VIN barcode…";
    scanStopButton.disabled = false;
  } catch {
    scanStartButton.disabled = false;
  }
});

scanStopButton.addEventListener("click", () => {
  scanner?.stop();
  scanner = null;
  scanStatus.textContent = "Camera off";
  scanStartButton.disabled = false;
  scanStopButton.disabled = true;
});
