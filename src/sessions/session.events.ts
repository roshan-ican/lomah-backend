import { SessionStatus } from "@prisma/client";

interface BaseSessionEvent {
    laneId: number;
    sessionId: string;
}

export interface SessionCreatedEvent extends BaseSessionEvent {
    type: 'session:created';
    // Nullable in the schema — a walk-in session can be created before a
    // shooter is attached, so the event has to allow the same.
    shooterName: string | null;
}

export interface SessionStartedEvent extends BaseSessionEvent {
    type: 'session:started';
    stageId: string;
    stageOrder: number;
    targetId: string;
    startedAt: Date;
}

export interface SessionPausedEvent extends BaseSessionEvent {
    type: 'session:paused';
    pausedAt: Date;
}

export interface SessionResumedEvent extends BaseSessionEvent {
    type: 'session:resumed';
    totalPausedMs: number;
}

export interface SessionAdvancedEvent extends BaseSessionEvent {
    type: 'session:advanced';
    fromStageId: string;
    toStageId?: string;
    toStageOrder?: number;
}

export interface SessionCompletedEvent extends BaseSessionEvent {
    type: 'session:completed';
    status: SessionStatus;
    endedAt: Date;
}

export interface SessionReviewedEvent extends BaseSessionEvent {
    type: 'session:reviewed';
    feedback: string;
}

export interface SessionShotsResetEvent extends BaseSessionEvent {
    type: 'session:shots_reset';
    stageId: string;
}

// type of calibration @roshan-ican
export interface ShotCalibratedEvent extends BaseSessionEvent {
    type: 'shot:calibrated';
    sessionStageId: string;
    shotId: string;
    shotNumber: number;
    x: number;
    y: number;
    score: number;
}

export type SessionEvent =
    | SessionCreatedEvent
    | SessionStartedEvent
    | SessionPausedEvent
    | SessionResumedEvent
    | SessionAdvancedEvent
    | SessionCompletedEvent
    | SessionReviewedEvent
    | SessionShotsResetEvent
    | ShotCalibratedEvent
