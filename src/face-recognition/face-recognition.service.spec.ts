import {
  BadGatewayException,
  ConflictException,
  RequestTimeoutException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FaceRecognitionService,
  type FaceRecognitionResult,
} from './face-recognition.service';

const matched: FaceRecognitionResult = {
  approved: true,
  status: 'matched',
  person: 'roshan',
  distance: 0.317,
  cameraIndex: 0,
  framesScanned: 2,
  message: 'roshan recognized',
};

function makeService(): FaceRecognitionService {
  return new FaceRecognitionService({
    get: vi.fn().mockReturnValue('http://127.0.0.1:8000'),
  } as never);
}

function response(body: FaceRecognitionResult, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('FaceRecognitionService', () => {
  it('approves only an explicitly approved result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(matched)));

    await expect(makeService().recognize()).resolves.toEqual(matched);
  });

  it('forwards an in-memory JPEG frame to the face service', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(matched));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      makeService().recognizeFrame(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])),
    ).resolves.toEqual(matched);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/recognize-frame',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg' },
        body: expect.any(ArrayBuffer),
      }),
    );
  });

  it.each([
    ['unknown', 'Wrong person'],
    ['no_face', 'No face found'],
  ] as const)('returns %s as a rejection', async (status, message) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response({
          ...matched,
          approved: false,
          status,
          person: null,
        }),
      ),
    );

    await expect(makeService().recognize()).resolves.toMatchObject({
      approved: false,
      status,
      message,
    });
  });

  it('reports camera access failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response({ ...matched, approved: false, status: 'camera_error' }),
      ),
    );

    await expect(makeService().recognize()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('reports recognition processing failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response({ ...matched, approved: false, status: 'processing_error' }),
      ),
    );

    await expect(makeService().recognize()).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('reports when the local face service is not running', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('refused')));

    await expect(makeService().recognize()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('times out a recognition request after ten seconds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      ),
    );

    const pending = expect(makeService().recognize()).rejects.toBeInstanceOf(
      RequestTimeoutException,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
  });

  it('allows only one camera request at a time', async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    const service = makeService();

    const first = service.recognize();
    await expect(service.recognize()).rejects.toBeInstanceOf(ConflictException);
    resolveFetch?.(response(matched));
    await expect(first).resolves.toEqual(matched);
  });

  it('returns no preview before the camera has produced a frame', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 204 }),
    );

    await expect(makeService().preview()).resolves.toBeNull();
  });

  it('proxies the latest preview frame as bytes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: vi.fn().mockResolvedValue(
          Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]).buffer,
        ),
      }),
    );

    await expect(makeService().preview()).resolves.toEqual(
      Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
    );
  });
});
