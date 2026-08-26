import {
  ConflictException,
  Injectable,
  Logger,
  NotImplementedException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";

import { PrismaService } from "@/common/prisma/prisma.service";
import {
  FaceEngineService,
  FaceEngineUnavailableError,
  NativeFaceReference,
} from "./face-engine.service";

export type RecognitionStatus =
  | "matched"
  | "unknown"
  | "no_face"
  | "camera_error"
  | "processing_error";

export interface FaceRecognitionResult {
  approved: boolean;
  status: RecognitionStatus;
  person: string | null;
  distance: number | null;
  cameraIndex: number;
  framesScanned: number;
  message: string;
}

export type FaceRegistrationView = "front" | "side";

export interface FaceRegistrationStatus {
  person: string;
  registered: boolean;
  capturedViews: FaceRegistrationView[];
  referenceCount: number;
}

export interface FaceRegistrationResult {
  person: string;
  view: FaceRegistrationView;
  storedAs: string;
  capturedViews: FaceRegistrationView[];
  complete: boolean;
  message: string;
}

/** Both views are required before a shooter counts as registered: a front-only
 *  enrolment rejects the same person the moment they turn their head, which on
 *  a firing point reads as the system being broken. */
const REQUIRED_VIEWS: FaceRegistrationView[] = ["front", "side"];

/** The camera moved to the shooter's tablet, so the backend has no camera of
 *  its own to open. Kept as a named constant because the response shape is the
 *  one the tablet already parses and must not change. */
const NO_SERVER_CAMERA = -1;

/**
 * Face registration and verification, running offline in this process.
 *
 * Previously this class POSTed frames to a Python service on port 8000. That
 * service is gone: the JPEG now goes straight to the bundled ONNX models
 * through the lomah-core addon, and the resulting embedding is stored in this
 * database. A range with no network, and a machine with no Python, both work.
 *
 * The HTTP contract is unchanged, so the shooter tablet needs no new code — it
 * still captures a frame in the browser and POSTs it.
 */
@Injectable()
export class FaceRecognitionService {
  private readonly logger = new Logger(FaceRecognitionService.name);

  /** One inference at a time. The models are held behind a single mutex in the
   *  addon anyway; refusing here turns a queue of tablets into an immediate,
   *  explainable answer rather than a pile of slow requests. */
  private recognitionInProgress = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: FaceEngineService,
  ) {}

  /** The old server-camera endpoint. There is no camera on the backend now, and
   *  answering with a fabricated "no face" would look like a failed scan
   *  instead of a call that no longer applies. */
  recognize(): Promise<FaceRecognitionResult> {
    return Promise.reject(
      new NotImplementedException(
        "The backend has no camera; POST a JPEG frame to check-frame instead",
      ),
    );
  }

  async recognizeFrame(
    jpeg: Uint8Array,
    personName?: string,
  ): Promise<FaceRecognitionResult> {
    if (!personName?.trim()) {
      throw new NotImplementedException(
        "Identifying an unknown face is not supported; check a frame against a named shooter",
      );
    }
    const person = personName.trim();

    return this.exclusively(async () => {
      const references = await this.usableReferences(person);
      if (references.length === 0) {
        return this.result({
          status: "unknown",
          approved: false,
          person: null,
          distance: null,
          message: `${person} has no registered face reference`,
        });
      }

      const verification = await this.engine.verify(
        Buffer.from(jpeg),
        references,
        this.engine.matchThreshold(),
      );

      if (verification.status === "no_face") {
        return this.result({
          status: "no_face",
          approved: false,
          person: null,
          distance: null,
          message: "No face found",
        });
      }

      return this.result({
        status: verification.approved ? "matched" : "unknown",
        approved: verification.approved,
        // Only name the person on a match. Returning the queried name either
        // way would let the tablet's own name comparison pass on a rejection.
        person: verification.approved ? person : null,
        distance: verification.distance,
        message: verification.approved ? "Face approved" : "Wrong person",
      });
    });
  }

  async registrationStatus(personName: string): Promise<FaceRegistrationStatus> {
    const person = personName.trim();
    const capturedViews = await this.capturedViews(person);

    return {
      person,
      registered: this.isComplete(capturedViews),
      capturedViews,
      referenceCount: capturedViews.length,
    };
  }

  async registerFace(
    personName: string,
    view: FaceRegistrationView,
    jpeg: Uint8Array,
  ): Promise<FaceRegistrationResult> {
    const person = personName.trim();
    if (!person) {
      throw new UnprocessableEntityException(
        "A person name is required to register a face",
      );
    }

    return this.exclusively(async () => {
      const encoded = await this.encode(Buffer.from(jpeg));

      // 422 rather than 400: the request was well formed, the photograph just
      // was not usable. The tablet retries a 422 with a fresh frame, which is
      // exactly right for someone who blinked or looked away.
      if (encoded.status === "no_face" || !encoded.embedding) {
        throw new UnprocessableEntityException(
          "No face was found in the photo. Look at the camera and try again.",
        );
      }

      // Prisma types a Bytes column as Uint8Array<ArrayBuffer>, which Node's
      // Buffer (ArrayBufferLike) does not satisfy. Copy rather than cast.
      const embedding = new Uint8Array(encoded.embedding);

      await this.prisma.faceReference.upsert({
        where: { personName_view: { personName: person, view } },
        create: {
          personName: person,
          view,
          embedding,
          dimension: encoded.dimension,
          modelVersion: encoded.modelVersion,
          detectionScore: encoded.detectionScore,
        },
        update: {
          embedding,
          dimension: encoded.dimension,
          modelVersion: encoded.modelVersion,
          detectionScore: encoded.detectionScore,
        },
      });

      const capturedViews = await this.capturedViews(person);
      const complete = this.isComplete(capturedViews);

      return {
        person,
        view,
        storedAs: `${person}/${view}`,
        capturedViews,
        complete,
        message: complete
          ? "Face registration complete"
          : `Saved the ${view} view`,
      };
    });
  }

  /** The Python service exposed its own camera preview. Nothing on the backend
   *  produces frames now, and the tablet already renders its own camera, so
   *  there is deliberately never a frame to hand back. */
  preview(): Promise<Uint8Array | null> {
    return Promise.resolve(null);
  }

  private async encode(jpeg: Buffer) {
    try {
      return await this.engine.encode(jpeg);
    } catch (error) {
      throw this.translateEngineError(error);
    }
  }

  /** Stored embeddings are only comparable to a candidate from the SAME model.
   *  A model upgrade changes what the numbers mean, and silently comparing
   *  across versions produces confident, wrong answers — so mismatched rows are
   *  dropped and the shooter is asked to register again. */
  private async usableReferences(
    person: string,
  ): Promise<NativeFaceReference[]> {
    const stored = await this.prisma.faceReference.findMany({
      where: { personName: person },
      orderBy: { view: "asc" },
    });
    if (stored.length === 0) return [];

    const { modelVersion, embeddingDimension } = this.engine.modelInfo();
    const usable = stored.filter(
      (reference) =>
        reference.modelVersion === modelVersion &&
        reference.dimension === embeddingDimension &&
        reference.embedding.length === embeddingDimension * 4,
    );

    if (usable.length !== stored.length) {
      this.logger.warn(
        `Ignoring ${stored.length - usable.length} face reference(s) for ${person}: ` +
          `they were made by a different model than ${modelVersion}`,
      );
    }

    return usable.map((reference) => ({
      view: reference.view as FaceRegistrationView,
      embedding: Buffer.from(reference.embedding),
    }));
  }

  private async capturedViews(
    person: string,
  ): Promise<FaceRegistrationView[]> {
    const stored = await this.prisma.faceReference.findMany({
      where: { personName: person },
      select: { view: true },
    });
    const captured = new Set(stored.map((reference) => reference.view));
    return REQUIRED_VIEWS.filter((view) => captured.has(view));
  }

  private isComplete(capturedViews: FaceRegistrationView[]): boolean {
    return REQUIRED_VIEWS.every((view) => capturedViews.includes(view));
  }

  private async exclusively<T>(work: () => Promise<T>): Promise<T> {
    if (this.recognitionInProgress) {
      throw new ConflictException("Face recognition is already running");
    }
    this.recognitionInProgress = true;
    try {
      return await work();
    } catch (error) {
      throw this.translateEngineError(error);
    } finally {
      this.recognitionInProgress = false;
    }
  }

  /** A missing addon or missing model file is an install problem the operator
   *  can fix; anything else out of the engine is a genuine processing failure.
   *  Collapsing both into one message is what makes "it just says error" bugs. */
  private translateEngineError(error: unknown): unknown {
    if (error instanceof FaceEngineUnavailableError) {
      return new ServiceUnavailableException(
        `Face recognition is not installed on this machine: ${error.message}`,
      );
    }
    return error;
  }

  private result(
    partial: Omit<FaceRecognitionResult, "cameraIndex" | "framesScanned">,
  ): FaceRecognitionResult {
    return {
      ...partial,
      cameraIndex: NO_SERVER_CAMERA,
      framesScanned: 1,
    };
  }
}
