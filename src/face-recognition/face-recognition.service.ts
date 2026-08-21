import {
  BadGatewayException,
  ConflictException,
  HttpException,
  Injectable,
  RequestTimeoutException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type RecognitionStatus =
  | 'matched'
  | 'unknown'
  | 'no_face'
  | 'camera_error'
  | 'processing_error';

export interface FaceRecognitionResult {
  approved: boolean;
  status: RecognitionStatus;
  person: string | null;
  distance: number | null;
  cameraIndex: number;
  framesScanned: number;
  message: string;
}

@Injectable()
export class FaceRecognitionService {
  private recognitionInProgress = false;

  constructor(private readonly config: ConfigService) {}

  async recognize(): Promise<FaceRecognitionResult> {
    return this.requestRecognition('/recognize');
  }

  async recognizeFrame(jpeg: Uint8Array): Promise<FaceRecognitionResult> {
    return this.requestRecognition('/recognize-frame', Buffer.from(jpeg));
  }

  private async requestRecognition(
    path: '/recognize' | '/recognize-frame',
    jpeg?: Buffer,
  ): Promise<FaceRecognitionResult> {
    if (this.recognitionInProgress) {
      throw new ConflictException('Face recognition is already running');
    }
    this.recognitionInProgress = true;

    const baseUrl = this.config.get<string>(
      'FACE_RECOGNITION_URL',
      'http://127.0.0.1:8000',
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const frameBody = jpeg ? Uint8Array.from(jpeg).buffer : undefined;

    try {
      const response = await fetch(
        `${baseUrl.replace(/\/$/, '')}${path}`,
        {
          method: 'POST',
          signal: controller.signal,
          ...(frameBody
            ? {
                headers: { 'Content-Type': 'image/jpeg' },
                body: frameBody,
              }
            : {}),
        },
      );

      if (!response.ok) {
        throw new BadGatewayException(
          `Face service returned HTTP ${response.status}`,
        );
      }

      const result = (await response.json()) as FaceRecognitionResult;
      return this.interpretResult(result);
    } catch (error) {
      if (error instanceof HttpException) throw error;

      if (controller.signal.aborted) {
        throw new RequestTimeoutException('Recognition took too long');
      }

      throw new ServiceUnavailableException(
        'Face recognition service is not running',
      );
    } finally {
      clearTimeout(timeout);
      this.recognitionInProgress = false;
    }
  }

  async preview(): Promise<Uint8Array | null> {
    const baseUrl = this.config.get<string>(
      'FACE_RECOGNITION_URL',
      'http://127.0.0.1:8000',
    );

    try {
      const response = await fetch(
        `${baseUrl.replace(/\/$/, '')}/preview`,
        { signal: AbortSignal.timeout(2_000) },
      );
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
        'Face recognition preview is unavailable',
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
      case 'unknown':
        return {
          ...result,
          approved: false,
          message: 'Wrong person',
        };

      case 'no_face':
        return {
          ...result,
          approved: false,
          message: 'No face found',
        };

      case 'camera_error':
        throw new ServiceUnavailableException(
          'Face service could not access the Iriun camera',
        );

      case 'processing_error':
        throw new BadGatewayException(
          'Face encoding or recognition failed',
        );

      case 'matched':
      default:
        return {
          ...result,
          approved: false,
          message: 'Face was not approved',
        };
    }
  }
}
