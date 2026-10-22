// pnpm vin <VIN>  — validate, repair OCR confusions, and decode through NHTSA vPIC.
// pnpm vin --offline <VIN>  — validation and repair only, no network.
import {
  NhtsaVpicProvider,
  VehicleDataError,
  createVehicleDataService,
  parseVinStructure,
  repairVinCandidate,
  validateVin,
} from "vin-core";

const args = process.argv.slice(2);
const offline = args.includes("--offline");
const input = args.filter((arg) => arg !== "--offline").join(" ");

if (!input) {
  console.error("usage: pnpm vin [--offline] <VIN or label text>");
  process.exit(2);
}

const validation = validateVin(input);
let vin = validation.vin;
console.log(`input        ${input}`);
if (!validation.valid) {
  const repaired = repairVinCandidate(input);
  if (!repaired) {
    console.error(
      `invalid      ${validation.errors.join(", ")}` +
        (validation.expectedCheckDigit
          ? ` (check digit: supplied ${validation.suppliedCheckDigit}, expected ${validation.expectedCheckDigit})`
          : ""),
    );
    console.error("repair       no unique valid VIN could be recovered");
    process.exit(1);
  }
  vin = repaired.vin;
  const changes = repaired.replacements
    .map((change) => `pos ${change.index + 1}: ${change.from}->${change.to}`)
    .join(", ");
  console.log(`repaired     ${vin}${changes ? `  (${changes})` : "  (extracted from text)"}`);
}

const structure = parseVinStructure(vin);
const checked = validateVin(vin);
console.log(`vin          ${vin}`);
console.log(`check digit  ${checked.checkDigitStatus}`);
console.log(`region       ${checked.region}`);
console.log(`model year   ${checked.likelyModelYear ?? "?"} (candidates ${checked.modelYearCandidates.join(", ")})`);
console.log(`wmi/vds/vis  ${structure?.wmi} / ${structure?.vds} / ${structure?.vis}`);

if (offline) process.exit(0);

const service = createVehicleDataService({ providers: [new NhtsaVpicProvider()] });
try {
  const { data, cache, attemptedProviders } = await service.decode(vin);
  const fields: Array<[string, unknown]> = [
    ["make", data.make],
    ["model", data.model],
    ["year", data.modelYear],
    ["trim", data.trim],
    ["body", data.bodyClass],
    ["engine", [data.engineCylinders && `${data.engineCylinders} cyl`, data.engineDisplacement && `${Number(data.engineDisplacement).toFixed(1)} L`].filter(Boolean).join(", ") || null],
    ["fuel", data.fuelType],
    ["drive", data.driveType],
    ["plant", [data.plantCity, data.plantState, data.plantCountry].filter(Boolean).join(", ") || null],
  ];
  console.log(`\nvPIC         ${attemptedProviders.join(" -> ")} (cache ${cache}, ${data.durationMs} ms)`);
  for (const [label, value] of fields) console.log(`${label.padEnd(13)}${value ?? "—"}`);
  console.log(`confidence   ${data.confidence} (${data.completeness}% of core fields)`);
  for (const warning of data.warnings) console.log(`warning      ${warning.code}: ${warning.message}`);
} catch (error) {
  if (error instanceof VehicleDataError) {
    console.error(`decode failed ${error.code}: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
