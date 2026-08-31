import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

export type FaceView = "front" | "side";

export interface FaceEncodingResult {
  status: "encoded" | "no_face";
  embedding: Buffer | null;
  dimension: number;
  modelVersion: string;
  detectionScore: number | null;
}

export interface NativeFaceReference {
  view: FaceView;
  embedding: Buffer;
}

export interface FaceVerificationResult {
  status: "matched" | "unknown" | "no_face";
  approved: boolean;
  distance: number | null;
  view: FaceView | null;
  modelVersion: string;
  detectionScore: number | null;
}

export interface FaceModelInfo {
  modelVersion: string;
  embeddingDimension: number;
  defaultL2Threshold: number;
}

/** The addon's face surface. Mirrors lomah-core/artifacts/index.d.ts, except
 *  that the AsyncTask entry points are narrowed: napi generates
 *  `Promise<unknown>` for them, and casting at every call site instead of once
 *  here is how the two drift apart. */
interface LomahCore {
  getFaceModelInfo(): FaceModelInfo;
  faceEmbeddingDistance(candidate: Buffer, reference: Buffer): number;
  warmFaceModels(runtimeDir: string): Promise<void>;
  encodeFace(jpeg: Buffer, runtimeDir: string): Promise<FaceEncodingResult>;
  verifyFace(
    jpeg: Buffer,
    runtimeDir: string,
    references: NativeFaceReference[],
    threshold: number,
  ): Promise<FaceVerificationResult>;
}

/** Thrown when the addon or the ONNX runtime files cannot be found. Kept
 *  distinct from an inference failure: one is a broken install, the other is a
 *  bad photograph, and they need different answers. */
export class FaceEngineUnavailableError extends Error {}

/**
 * Loads the lomah-core native addon and tells it where the ONNX Runtime DLL and
 * the two models live.
 *
 * This replaces the external Python service the backend used to POST frames to.
 * Recognition now runs in-process on whichever machine hosts the backend — the
 * shooter tablet only has to send a JPEG, exactly as before, so no camera or
 * frontend code changes.
 *
 * The addon is Node-API, which is ABI-stable, so the same binary loads under
 * plain `node` in development and under Electron's node (`ELECTRON_RUN_AS_NODE`)
 * in a packaged install.
 */
@Injectable()
export class FaceEngineService implements OnModuleInit {
  private readonly logger = new Logger(FaceEngineService.name);
  private core: LomahCore | null = null;
  private runtimeDir: string | null = null;
  private loadFailure: string | null = null;

  constructor(private readonly config: ConfigService) {}

  /** Loads the models at boot so the first shooter to look at the camera does
   *  not pay the one-time startup cost. A failure here is logged, not thrown:
   *  the rest of the range — lanes, sessions, scoring — must still come up on a
   *  machine with a broken face install. */
  async onModuleInit(): Promise<void> {
    try {
      const core = this.load();
      await core.warmFaceModels(this.requireRuntimeDir());
      this.logger.log(
        `Face models ready (${core.getFaceModelInfo().modelVersion})`,
      );
    } catch (error) {
      this.logger.warn(
        `Face recognition is unavailable: ${(error as Error).message}`,
      );
    }
  }

  get available(): boolean {
    try {
      this.load();
      this.requireRuntimeDir();
      return true;
    } catch {
      return false;
    }
  }

  modelInfo(): FaceModelInfo {
    return this.load().getFaceModelInfo();
  }

  /** The distance at or below which two embeddings are the same person.
   *  Defaults to the model's own calibrated value rather than a number chosen
   *  here, and stays overridable per range: camera, lighting and enrolment
   *  quality all move the right cut-off. */
  matchThreshold(): number {
    const configured = this.config.get<string>("FACE_MATCH_THRESHOLD");
    if (configured !== undefined && configured !== "") {
      const parsed = Number(configured);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
      this.logger.warn(
        `Ignoring FACE_MATCH_THRESHOLD="${configured}": not a positive number`,
      );
    }
    return this.modelInfo().defaultL2Threshold;
  }

  encode(jpeg: Buffer): Promise<FaceEncodingResult> {
    return this.load().encodeFace(jpeg, this.requireRuntimeDir());
  }

  embeddingDistance(candidate: Buffer, reference: Buffer): number {
    return this.load().faceEmbeddingDistance(candidate, reference);
  }

  verify(
    jpeg: Buffer,
    references: NativeFaceReference[],
    threshold: number,
  ): Promise<FaceVerificationResult> {
    return this.load().verifyFace(
      jpeg,
      this.requireRuntimeDir(),
      references,
      threshold,
    );
  }

  private load(): LomahCore {
    if (this.core) return this.core;
    if (this.loadFailure) {
      throw new FaceEngineUnavailableError(this.loadFailure);
    }

    const dir = this.resolveFirst(this.nativeDirCandidates(), "index.js");
    if (!dir) {
      this.loadFailure =
        "the lomah-core addon was not found; run `npm run build:native` in frontend/, " +
        "or set LOMAH_NATIVE_DIR to the directory holding index.js";
      throw new FaceEngineUnavailableError(this.loadFailure);
    }

    try {
      // A computed path and createRequire rather than an import: the location
      // depends on whether this is a packaged install, so the bundler must not
      // try to follow it. A .node binary also cannot be loaded out of an asar.
      this.core = createRequire(__filename)(
        path.join(dir, "index.js"),
      ) as LomahCore;
      return this.core;
    } catch (error) {
      this.loadFailure = `the lomah-core addon at ${dir} could not be loaded: ${(error as Error).message}`;
      throw new FaceEngineUnavailableError(this.loadFailure);
    }
  }

  private requireRuntimeDir(): string {
    if (this.runtimeDir) return this.runtimeDir;

    const dir = this.resolveFirst(
      this.runtimeDirCandidates(),
      "onnxruntime.dll",
      "face_detection_yunet.onnx",
      "face_recognition_sface_int8.onnx",
    );
    if (!dir) {
      throw new FaceEngineUnavailableError(
        "the ONNX runtime and face models were not found; run " +
          "`npm run fetch:runtime` in frontend/lomah-core, or set LOMAH_FACE_RUNTIME_DIR",
      );
    }
    this.addToDllSearchPath(dir);
    this.runtimeDir = dir;
    return dir;
  }

  /**
   * Puts the runtime directory on PATH so onnxruntime.dll can find the Visual
   * C++ runtime DLLs shipped beside it.
   *
   * Placing them next to onnxruntime.dll is not by itself enough. ort loads it
   * with `LoadLibraryExW(path, NULL, 0)` — no LOAD_WITH_ALTERED_SEARCH_PATH —
   * and without that flag Windows resolves the DLL's own imports from the
   * EXECUTABLE's directory and the system directories, never from the folder
   * the DLL happens to live in. PATH is the one entry in that search order this
   * process can still influence, and Node's process.env writes reach the real
   * environment block on Windows, so this must happen before the first load.
   *
   * On a machine that already has the redistributable installed this changes
   * nothing: System32 is searched first and wins.
   */
  private addToDllSearchPath(dir: string): void {
    if (process.platform !== "win32") return;

    const current = process.env.PATH ?? "";
    const alreadyPresent = current
      .split(path.delimiter)
      .some((entry) => entry && path.resolve(entry) === dir);
    if (alreadyPresent) return;

    process.env.PATH = current ? `${dir}${path.delimiter}${current}` : dir;
  }

  /** Packaged, electron-builder's extraResources puts the addon beside the
   *  backend; in development it is wherever `npm run build:native` left it. */
  private nativeDirCandidates(): string[] {
    return [
      process.env.LOMAH_NATIVE_DIR,
      path.join(__dirname, "..", "native"),
      path.resolve(process.cwd(), "..", "frontend", "lomah-core", "artifacts"),
    ].filter((candidate): candidate is string => Boolean(candidate));
  }

  /** `<native>/runtime` packaged; `<native>/../runtime` in development, where
   *  the models sit next to artifacts/ rather than inside it. */
  private runtimeDirCandidates(): string[] {
    const native = this.resolveFirst(this.nativeDirCandidates(), "index.js");
    return [
      process.env.LOMAH_FACE_RUNTIME_DIR,
      native ? path.join(native, "runtime") : undefined,
      native ? path.resolve(native, "..", "runtime") : undefined,
      path.resolve(process.cwd(), "..", "frontend", "lomah-core", "runtime"),
    ].filter((candidate): candidate is string => Boolean(candidate));
  }

  private resolveFirst(
    candidates: string[],
    ...requiredFiles: string[]
  ): string | null {
    for (const candidate of candidates) {
      const complete = requiredFiles.every((file) =>
        fs.existsSync(path.join(candidate, file)),
      );
      if (complete) return path.resolve(candidate);
    }
    return null;
  }
}
