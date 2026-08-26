-- Face references for offline recognition.
--
-- Replaces the external Python face service: embeddings now come from the
-- bundled ONNX models via the lomah-core native addon and live in this
-- database, so a range with no network still verifies shooters.
--
-- Only the embedding is stored, never the photograph. `personName` mirrors
-- `sessions.shooterName`, which is what the lane session carries.
CREATE TABLE "face_references" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personName" TEXT NOT NULL,
    "view" TEXT NOT NULL,
    "embedding" BLOB NOT NULL,
    "dimension" INTEGER NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "detectionScore" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- One reference per view per person: re-registering a view replaces it.
CREATE UNIQUE INDEX "face_references_personName_view_key" ON "face_references"("personName", "view");
CREATE INDEX "face_references_personName_idx" ON "face_references"("personName");
