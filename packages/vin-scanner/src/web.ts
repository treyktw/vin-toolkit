import { VinScanConsensus, type VinScanProgress, type VinScanResult } from "./core";

type NativeBarcodeFormat = "code_39" | "code_128" | "data_matrix" | "qr_code";

interface NativeDetectedBarcode {
  rawValue: string;
  format: string;
}

interface NativeBarcodeDetector {
  detect(source: CanvasImageSource): Promise<NativeDetectedBarcode[]>;
}

interface NativeBarcodeDetectorConstructor {
  new (options?: { formats?: NativeBarcodeFormat[] }): NativeBarcodeDetector;
  getSupportedFormats(): Promise<string[]>;
}

export interface WebVinScannerOptions {
  video: HTMLVideoElement;
  onResult: (result: VinScanResult) => void;
  onProgress?: (progress: VinScanProgress) => void;
  onError?: (error: Error) => void;
  constraints?: MediaStreamConstraints;
  consensus?: VinScanConsensus;
}

export interface WebVinScannerController {
  engine: "barcode_detector" | "zxing";
  stop(): void;
}

function nativeDetector(): NativeBarcodeDetectorConstructor | null {
  return (
    (
      globalThis as typeof globalThis & {
        BarcodeDetector?: NativeBarcodeDetectorConstructor;
      }
    ).BarcodeDetector ?? null
  );
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

async function startNativeScanner(
  options: WebVinScannerOptions,
  Detector: NativeBarcodeDetectorConstructor,
): Promise<WebVinScannerController | null> {
  const desired: NativeBarcodeFormat[] = ["code_39", "code_128", "data_matrix", "qr_code"];
  const supported = await Detector.getSupportedFormats();
  const formats = desired.filter((format) => supported.includes(format));
  if (formats.length === 0) return null;

  const consensus = options.consensus ?? new VinScanConsensus();
  const stream = await navigator.mediaDevices.getUserMedia(
    options.constraints ?? {
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1_920 },
        height: { ideal: 1_080 },
      },
      audio: false,
    },
  );
  options.video.srcObject = stream;
  options.video.playsInline = true;
  options.video.muted = true;
  await options.video.play();

  const detector = new Detector({ formats });
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const controller: WebVinScannerController = {
    engine: "barcode_detector",
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      stopStream(stream);
      options.video.srcObject = null;
    },
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const detections = await detector.detect(options.video);
      for (const detection of detections) {
        const observed = consensus.observe({
          rawValue: detection.rawValue,
          format: detection.format,
          source: "barcode_detector",
        });
        options.onProgress?.(observed.progress);
        if (observed.result) {
          options.onResult(observed.result);
          controller.stop();
          return;
        }
      }
    } catch {
      // Individual frames frequently fail while the camera is moving.
    }
    timer = setTimeout(() => void tick(), 80);
  };
  void tick();
  return controller;
}

async function startZxingScanner(options: WebVinScannerOptions): Promise<WebVinScannerController> {
  const [{ BrowserMultiFormatReader }, { BarcodeFormat }] = await Promise.all([
    import("@zxing/browser"),
    import("@zxing/library"),
  ]);
  const consensus = options.consensus ?? new VinScanConsensus();
  const reader = new BrowserMultiFormatReader();
  let stopped = false;
  let controls: { stop(): void } | null = null;
  controls = await reader.decodeFromConstraints(
    options.constraints ?? {
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1_920 },
        height: { ideal: 1_080 },
      },
      audio: false,
    },
    options.video,
    (result) => {
      if (stopped || !result) return;
      const observed = consensus.observe({
        rawValue: result.getText(),
        // getBarcodeFormat() is a numeric enum; map it to its name ("CODE_39")
        // so normalizeBarcodeFormat recognises it.
        format: BarcodeFormat[result.getBarcodeFormat()],
        source: "zxing",
      });
      options.onProgress?.(observed.progress);
      if (observed.result) {
        options.onResult(observed.result);
        stopped = true;
        controls?.stop();
      }
    },
  );

  return {
    engine: "zxing",
    stop() {
      stopped = true;
      controls?.stop();
      stopStream(options.video.srcObject as MediaStream | null);
      options.video.srcObject = null;
    },
  };
}

/** Uses the native detector when available and lazy-loads ZXing otherwise. */
export async function startWebVinScanner(
  options: WebVinScannerOptions,
): Promise<WebVinScannerController> {
  try {
    const Detector = nativeDetector();
    if (Detector) {
      const native = await startNativeScanner(options, Detector);
      if (native) return native;
    }
    return await startZxingScanner(options);
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error("Could not start VIN scanner");
    options.onError?.(normalized);
    throw normalized;
  }
}
