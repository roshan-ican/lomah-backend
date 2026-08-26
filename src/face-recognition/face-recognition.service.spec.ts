import {
  ConflictException,
  ForbiddenException,
  NotImplementedException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FaceEngineUnavailableError } from "./face-engine.service";
import {
  type FaceRegistrationStatus,
  FaceRecognitionService,
} from "./face-recognition.service";
import { FaceRecognitionController } from "./face-recognition.controller";

const MODEL_VERSION = "yunet-2023mar+sface-int8-2021dec";
const DIMENSION = 128;

/** A stored embedding is `dimension` little-endian f32s. The values do not
 *  matter here — the comparison itself is the native crate's job and is tested
 *  in Rust; what matters is that the right BYTES reach it. */
function embedding(fill = 0.1): Uint8Array {
  const floats = new Float32Array(DIMENSION).fill(fill);
  return new Uint8Array(floats.buffer.slice(0));
}

interface StoredReference {
  personName: string;
  view: string;
  embedding: Uint8Array;
  dimension: number;
  modelVersion: string;
  detectionScore: number | null;
}

/** An in-memory stand-in for the single table this service touches, including
 *  the composite-key upsert, so re-registering a view is genuinely exercised
 *  rather than mocked away. */
function makePrisma(rows: StoredReference[] = []) {
  return {
    rows,
    faceReference: {
      findMany: vi.fn(({ where }: { where: { personName: string } }) =>
        Promise.resolve(rows.filter((row) => row.personName === where.personName)),
      ),
      upsert: vi.fn(
        ({
          where,
          create,
          update,
        }: {
          where: { personName_view: { personName: string; view: string } };
          create: StoredReference;
          update: Partial<StoredReference>;
        }) => {
          const key = where.personName_view;
          const existing = rows.find(
            (row) => row.personName === key.personName && row.view === key.view,
          );
          if (existing) {
            Object.assign(existing, update);
          } else {
            rows.push({ ...create });
          }
          return Promise.resolve();
        },
      ),
    },
  };
}

function makeEngine(overrides: Record<string, unknown> = {}) {
  return {
    modelInfo: vi.fn().mockReturnValue({
      modelVersion: MODEL_VERSION,
      embeddingDimension: DIMENSION,
      defaultL2Threshold: 1.128,
    }),
    matchThreshold: vi.fn().mockReturnValue(1.128),
    encode: vi.fn().mockResolvedValue({
      status: "encoded",
      embedding: Buffer.from(embedding()),
      dimension: DIMENSION,
      modelVersion: MODEL_VERSION,
      detectionScore: 0.98,
    }),
    verify: vi.fn().mockResolvedValue({
      status: "matched",
      approved: true,
      distance: 0.42,
      view: "front",
      modelVersion: MODEL_VERSION,
      detectionScore: 0.97,
    }),
    ...overrides,
  };
}

function makeService(
  rows: StoredReference[] = [],
  engineOverrides: Record<string, unknown> = {},
) {
  const prisma = makePrisma(rows);
  const engine = makeEngine(engineOverrides);
  const service = new FaceRecognitionService(
    prisma as never,
    engine as never,
  );
  return { service, prisma, engine };
}

function reference(view: string, overrides: Partial<StoredReference> = {}) {
  return {
    personName: "Ahmed",
    view,
    embedding: embedding(),
    dimension: DIMENSION,
    modelVersion: MODEL_VERSION,
    detectionScore: 0.9,
    ...overrides,
  };
}

const frame = new Uint8Array([0xff, 0xd8, 0xff]);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FaceRecognitionService registration", () => {
  it("stores an embedding and reports the view as captured", async () => {
    const { service, prisma } = makeService();

    const result = await service.registerFace("Ahmed", "front", frame);

    expect(result.capturedViews).toEqual(["front"]);
    expect(result.complete).toBe(false);
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0].modelVersion).toBe(MODEL_VERSION);
    expect(prisma.rows[0].embedding).toHaveLength(DIMENSION * 4);
  });

  it("is complete only once both views exist", async () => {
    const { service } = makeService([reference("front")]);

    const result = await service.registerFace("Ahmed", "side", frame);

    expect(result.capturedViews).toEqual(["front", "side"]);
    expect(result.complete).toBe(true);
  });

  it("replaces a view rather than accumulating stale photos", async () => {
    const { service, prisma } = makeService([reference("front")]);

    await service.registerFace("Ahmed", "front", frame);

    expect(prisma.rows).toHaveLength(1);
  });

  // 422 specifically: the tablet retries a 422 with a fresh frame, which is the
  // right answer for someone who blinked. A 400 would abort registration.
  it("asks for another photo when no face is found", async () => {
    const { service } = makeService([], {
      encode: vi.fn().mockResolvedValue({
        status: "no_face",
        embedding: null,
        dimension: DIMENSION,
        modelVersion: MODEL_VERSION,
        detectionScore: null,
      }),
    });

    await expect(
      service.registerFace("Ahmed", "front", frame),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("reports registration state from the stored views", async () => {
    const { service } = makeService([reference("front"), reference("side")]);

    await expect(service.registrationStatus("Ahmed")).resolves.toEqual({
      person: "Ahmed",
      registered: true,
      capturedViews: ["front", "side"],
      referenceCount: 2,
    });
  });

  it("is not registered on a front view alone", async () => {
    const { service } = makeService([reference("front")]);

    const status = await service.registrationStatus("Ahmed");

    expect(status.registered).toBe(false);
  });
});

describe("FaceRecognitionService verification", () => {
  it("approves a match and names the person", async () => {
    const { service, engine } = makeService([reference("front")]);

    const result = await service.recognizeFrame(frame, "Ahmed");

    expect(result.approved).toBe(true);
    expect(result.status).toBe("matched");
    expect(result.person).toBe("Ahmed");
    expect(result.distance).toBe(0.42);
    expect(engine.verify).toHaveBeenCalledWith(
      expect.anything(),
      [expect.objectContaining({ view: "front" })],
      1.128,
    );
  });

  // The tablet compares the returned name against the expected shooter. Naming
  // the person on a rejection would let that comparison pass on a face the
  // engine just refused.
  it("does not name the person when the face is rejected", async () => {
    const { service } = makeService([reference("front")], {
      verify: vi.fn().mockResolvedValue({
        status: "unknown",
        approved: false,
        distance: 1.4,
        view: "front",
        modelVersion: MODEL_VERSION,
        detectionScore: 0.95,
      }),
    });

    const result = await service.recognizeFrame(frame, "Ahmed");

    expect(result.approved).toBe(false);
    expect(result.person).toBeNull();
  });

  it("passes an empty frame through as no_face rather than an error", async () => {
    const { service } = makeService([reference("front")], {
      verify: vi.fn().mockResolvedValue({
        status: "no_face",
        approved: false,
        distance: null,
        view: null,
        modelVersion: MODEL_VERSION,
        detectionScore: null,
      }),
    });

    const result = await service.recognizeFrame(frame, "Ahmed");

    expect(result.status).toBe("no_face");
    expect(result.approved).toBe(false);
  });

  it("says so when the shooter has never registered", async () => {
    const { service, engine } = makeService([]);

    const result = await service.recognizeFrame(frame, "Ahmed");

    expect(result.status).toBe("unknown");
    expect(result.message).toMatch(/no registered face reference/i);
    expect(engine.verify).not.toHaveBeenCalled();
  });

  // Embeddings from two different models are not comparable. Using them anyway
  // produces a confident answer from meaningless arithmetic.
  it("ignores references made by a different model", async () => {
    const { service, engine } = makeService([
      reference("front", { modelVersion: "some-older-model" }),
    ]);

    const result = await service.recognizeFrame(frame, "Ahmed");

    expect(engine.verify).not.toHaveBeenCalled();
    expect(result.status).toBe("unknown");
  });

  it("ignores a reference whose byte length does not match the dimension", async () => {
    const { service, engine } = makeService([
      reference("front", { embedding: new Uint8Array(8) }),
    ]);

    await service.recognizeFrame(frame, "Ahmed");

    expect(engine.verify).not.toHaveBeenCalled();
  });

  it("refuses to identify an unnamed face", async () => {
    const { service } = makeService([reference("front")]);

    await expect(service.recognizeFrame(frame)).rejects.toBeInstanceOf(
      NotImplementedException,
    );
  });

  it("has no server camera to scan", async () => {
    const { service } = makeService();

    await expect(service.recognize()).rejects.toBeInstanceOf(
      NotImplementedException,
    );
  });
});

describe("FaceRecognitionService failure handling", () => {
  it("allows only one inference at a time", async () => {
    let release: (value: unknown) => void = () => {};
    const { service } = makeService([], {
      encode: vi.fn().mockReturnValue(new Promise((resolve) => {
        release = resolve;
      })),
    });

    const first = service.registerFace("Ahmed", "front", frame);
    const second = service.registerFace("Ahmed", "side", frame);

    await expect(second).rejects.toBeInstanceOf(ConflictException);

    release({
      status: "encoded",
      embedding: Buffer.from(embedding()),
      dimension: DIMENSION,
      modelVersion: MODEL_VERSION,
      detectionScore: 0.9,
    });
    await first;
  });

  // A broken install and a bad photograph need different answers: one is fixed
  // by the operator, the other by looking at the camera again.
  it("reports a missing addon as a service problem", async () => {
    const { service } = makeService([], {
      encode: vi
        .fn()
        .mockRejectedValue(new FaceEngineUnavailableError("addon not found")),
    });

    await expect(
      service.registerFace("Ahmed", "front", frame),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("never offers a preview frame, because nothing on the backend produces one", async () => {
    const { service } = makeService();

    await expect(service.preview()).resolves.toBeNull();
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
