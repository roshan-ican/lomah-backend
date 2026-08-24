import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  RequestTimeoutException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type FaceRegistrationResult,
  type FaceRegistrationStatus,
  FaceRecognitionService,
  type FaceRecognitionResult,
} from "./face-recognition.service";
import { FaceRecognitionController } from "./face-recognition.controller";

const matched: FaceRecognitionResult = {
  approved: true,
  status: "matched",
  person: "roshan",
  distance: 0.317,
  cameraIndex: 0,
  framesScanned: 2,
  message: "roshan recognized",
};

function makeService(): FaceRecognitionService {
  return new FaceRecognitionService({
    get: vi.fn().mockReturnValue("http://127.0.0.1:8000"),
  } as never);
}

function response(body: unknown, status = 200): Response {
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

describe("FaceRecognitionService", () => {
  it("approves only an explicitly approved result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(matched)));

    await expect(makeService().recognize()).resolves.toEqual(matched);
  });

  it("forwards an in-memory JPEG frame to the face service", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(matched));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      makeService().recognizeFrame(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])),
    ).resolves.toEqual(matched);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/recognize-frame",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "image/jpeg" },
        body: expect.any(ArrayBuffer),
      }),
    );
  });

  it("forwards the session shooter name when checking a frame", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(matched));
    vi.stubGlobal("fetch", fetchMock);

    await makeService().recognizeFrame(
      Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
      "Ahmed Ali",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/recognize-frame?personName=Ahmed%20Ali",
      expect.any(Object),
    );
  });

  it("reads registration state from the face service", async () => {
    const status: FaceRegistrationStatus = {
      person: "Ahmed Ali",
      registered: false,
      capturedViews: ["front"],
      referenceCount: 1,
    };
    const fetchMock = vi.fn().mockResolvedValue(response(status));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      makeService().registrationStatus("Ahmed Ali"),
    ).resolves.toEqual(status);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/face-registration/Ahmed%20Ali",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("forwards a labelled registration frame", async () => {
    const saved: FaceRegistrationResult = {
      person: "Ahmed",
      view: "front",
      storedAs: "front-123.jpg",
      capturedViews: ["front"],
      complete: false,
      message: "Stored front view",
    };
    const fetchMock = vi.fn().mockResolvedValue(response(saved));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      makeService().registerFace(
        "Ahmed",
        "front",
        Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
      ),
    ).resolves.toEqual(saved);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/register-face/Ahmed/front",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "image/jpeg" },
        body: expect.any(ArrayBuffer),
      }),
    );
  });

  it("preserves registration validation details from the face service", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          response({ detail: "No face was detected in the image" }, 422),
        ),
    );

    await expect(
      makeService().registerFace(
        "Ahmed",
        "front",
        Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
      ),
    ).rejects.toMatchObject({
      status: 422,
      response: "No face was detected in the image",
    });
  });

  it.each([
    ["unknown", "Wrong person"],
    ["no_face", "No face found"],
  ] as const)("returns %s as a rejection", async (status, message) => {
    vi.stubGlobal(
      "fetch",
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

  it("reports camera access failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          response({ ...matched, approved: false, status: "camera_error" }),
        ),
    );

    await expect(makeService().recognize()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("reports recognition processing failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          response({ ...matched, approved: false, status: "processing_error" }),
        ),
    );

    await expect(makeService().recognize()).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it("reports when the local face service is not running", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("refused")));

    await expect(makeService().recognize()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("times out a recognition request after ten seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      ),
    );

    const pending = expect(makeService().recognize()).rejects.toBeInstanceOf(
      RequestTimeoutException,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
  });

  it("allows only one camera request at a time", async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
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

  it("returns no preview before the camera has produced a frame", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 204 }),
    );

    await expect(makeService().preview()).resolves.toBeNull();
  });

  it("proxies the latest preview frame as bytes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: vi
          .fn()
          .mockResolvedValue(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]).buffer),
      }),
    );

    await expect(makeService().preview()).resolves.toEqual(
      Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
    );
  });
});

describe("FaceRecognitionController device binding", () => {
  const registrationStatus: FaceRegistrationStatus = {
    person: "Ahmed",
    registered: true,
    capturedViews: ["front", "side"],
    referenceCount: 2,
  };

  function makeController(deviceLaneId: number | null) {
    const faceRecognition = {
      registrationStatus: vi.fn().mockResolvedValue(registrationStatus),
    };
    const controller = new FaceRecognitionController(
      faceRecognition as never,
      {
        list: vi
          .fn()
          .mockReturnValue([{ deviceId: "tablet-1", laneId: deviceLaneId }]),
      } as never,
      {
        findActiveByLane: vi.fn().mockResolvedValue({ shooterName: "Ahmed" }),
      } as never,
    );
    return { controller, faceRecognition };
  }

  it("derives the face name from the assigned lane session", async () => {
    const { controller, faceRecognition } = makeController(2);

    await expect(controller.registration("2", "tablet-1")).resolves.toEqual(
      registrationStatus,
    );
    expect(faceRecognition.registrationStatus).toHaveBeenCalledWith("Ahmed");
  });

  it("rejects a shooter device assigned to another lane", async () => {
    const { controller } = makeController(3);

    await expect(
      controller.registration("2", "tablet-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
