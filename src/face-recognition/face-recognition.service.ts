import {
  BadGatewayException,
  ConflictException,
  HttpException,
  Injectable,
  RequestTimeoutException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export type RecognitionStatus =
  "matched" | "unknown" | "no_face" | "camera_error" | "processing_error";

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

@Injectable()
export class FaceRecognitionService {
  private recognitionInProgress = false;

  constructor(private readonly config: ConfigService) {}

  async recognize(): Promise<FaceRecognitionResult> {
    return this.requestRecognition("/recognize");
  }

  async recognizeFrame(
    jpeg: Uint8Array,
    personName?: string,
  ): Promise<FaceRecognitionResult> {
    const query = personName
      ? `?personName=${encodeURIComponent(personName)}`
      : "";
    return this.requestRecognition(
      `/recognize-frame${query}`,
      Buffer.from(jpeg),
    );
  }

  registrationStatus(personName: string): Promise<FaceRegistrationStatus> {
    return this.requestJson<FaceRegistrationStatus>(
      `/face-registration/${encodeURIComponent(personName)}`,
      { method: "GET" },
      3_000,
    );
  }

  async registerFace(
    personName: string,
    view: FaceRegistrationView,
    jpeg: Uint8Array,
  ): Promise<FaceRegistrationResult> {
    if (this.recognitionInProgress) {
      throw new ConflictException("Face recognition is already running");
    }
    this.recognitionInProgress = true;

    try {
      return await this.requestJson<FaceRegistrationResult>(
        `/register-face/${encodeURIComponent(personName)}/${view}`,
        {
          method: "POST",
          headers: { "Content-Type": "image/jpeg" },
          body: Uint8Array.from(jpeg).buffer,
        },
      );
    } finally {
      this.recognitionInProgress = false;
    }
  }

  private async requestRecognition(
    path: string,
    jpeg?: Buffer,
  ): Promise<FaceRecognitionResult> {
    if (this.recognitionInProgress) {
      throw new ConflictException("Face recognition is already running");
    }
    this.recognitionInProgress = true;

    const frameBody = jpeg ? Uint8Array.from(jpeg).buffer : undefined;

    try {
      const result = await this.requestJson<FaceRecognitionResult>(path, {
        method: "POST",
        ...(frameBody
          ? {
              headers: { "Content-Type": "image/jpeg" },
              body: frameBody,
            }
          : {}),
      });
      return this.interpretResult(result);
    } finally {
      this.recognitionInProgress = false;
    }
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit,
    timeoutMs = 10_000,
  ): Promise<T> {
    const baseUrl = this.config.get<string>(
      "FACE_RECOGNITION_URL",
      "http://127.0.0.1:8000",
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        signal: controller.signal,
      });

      if (!response.ok) {
        let message = `Face service returned HTTP ${response.status}`;
        try {
          const errorBody = (await response.json()) as {
            detail?: unknown;
            message?: unknown;
          };
          const upstreamMessage = errorBody.detail ?? errorBody.message;
          if (typeof upstreamMessage === "string" && upstreamMessage.trim()) {
            message = upstreamMessage;
          }
        } catch {
          // Keep the HTTP fallback when the upstream body is not JSON.
        }
        throw new HttpException(message, response.status);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof HttpException) throw error;

      if (controller.signal.aborted) {
        throw new RequestTimeoutException("Recognition took too long");
      }

      throw new ServiceUnavailableException(
        "Face recognition service is not running",
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async preview(): Promise<Uint8Array | null> {
    const baseUrl = this.config.get<string>(
      "FACE_RECOGNITION_URL",
      "http://127.0.0.1:8000",
    );

    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/preview`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status === 204) return null;
      if (!response.ok) {
        throw new BadGatewayException(
          `Face preview returned HTTP ${response.status}`,
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException(
        "Face recognition preview is unavailable",
      );
    }
  }

  private interpretResult(
    result: FaceRecognitionResult,
  ): FaceRecognitionResult {
    if (result.approved === true) {
      return result;
    }

    switch (result.status) {
      case "unknown":
        return {
          ...result,
          approved: false,
          message: "Wrong person",
        };

      case "no_face":
        return {
          ...result,
          approved: false,
          message: "No face found",
        };

      case "camera_error":
        throw new ServiceUnavailableException(
          "Face service could not access the Iriun camera",
        );

      case "processing_error":
        throw new BadGatewayException("Face encoding or recognition failed");

      case "matched":
      default:
        return {
          ...result,
          approved: false,
          message: "Face was not approved",
        };
    }
  }
}
