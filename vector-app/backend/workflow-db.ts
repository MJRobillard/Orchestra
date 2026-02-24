import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ArtifactRef, WorkflowSnapshot } from "@/contracts/workflow-contract";

export interface StoredArtifact {
  artifactId: string;
  runId: string;
  phaseId: string;
  attempt: number;
  kind: ArtifactRef["kind"];
  uri: string;
  createdAt: string;
  data: unknown;
}

interface ArtifactDb {
  runs: Record<string, WorkflowSnapshot>;
  artifacts: Record<string, StoredArtifact>;
}

const DB_PATH = join(process.cwd(), ".data", "workflow-db.json");
const DB_LOCK_PATH = `${DB_PATH}.lock`;

function ensureDbFile(): void {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  try {
    readFileSync(DB_PATH, "utf8");
  } catch {
    writeFileSync(DB_PATH, JSON.stringify({ runs: {}, artifacts: {} } as ArtifactDb, null, 2), "utf8");
  }
}

function readDb(): ArtifactDb {
  ensureDbFile();
  const raw = readFileSync(DB_PATH, "utf8");
  const parsed = JSON.parse(raw) as Partial<ArtifactDb>;
  return {
    runs: parsed.runs ?? {},
    artifacts: parsed.artifacts ?? {},
  };
}

function writeDb(db: ArtifactDb): void {
  ensureDbFile();
  const tempPath = `${DB_PATH}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, JSON.stringify(db, null, 2), "utf8");
  renameSync(tempPath, DB_PATH);
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withDbLock<T>(fn: (db: ArtifactDb) => T): T {
  const maxWaitMs = 1500;
  const started = Date.now();

  while (true) {
    try {
      mkdirSync(DB_LOCK_PATH);
      break;
    } catch {
      if (Date.now() - started > maxWaitMs) {
        throw new Error("Timed out acquiring workflow DB lock");
      }
      sleep(10);
    }
  }

  try {
    const db = readDb();
    const result = fn(db);
    writeDb(db);
    return result;
  } finally {
    rmSync(DB_LOCK_PATH, { recursive: true, force: true });
  }
}

export function getRunSnapshot(runId: string): WorkflowSnapshot | null {
  const db = readDb();
  return db.runs[runId] ?? null;
}

export function saveRunSnapshot(snapshot: WorkflowSnapshot): void {
  withDbLock((db) => {
    db.runs[snapshot.runId] = structuredClone(snapshot);
  });
}

export function saveArtifact(params: {
  runId: string;
  phaseId: string;
  attempt: number;
  kind: ArtifactRef["kind"];
  data: unknown;
}): StoredArtifact {
  return withDbLock((db) => {
    const artifactId = `art_${crypto.randomUUID()}`;
    const stored: StoredArtifact = {
      artifactId,
      runId: params.runId,
      phaseId: params.phaseId,
      attempt: params.attempt,
      kind: params.kind,
      uri: `db://artifacts/${artifactId}`,
      createdAt: new Date().toISOString(),
      data: params.data,
    };

    db.artifacts[artifactId] = stored;
    return stored;
  });
}

export function getArtifact(artifactId: string): StoredArtifact | null {
  const db = readDb();
  return db.artifacts[artifactId] ?? null;
}

export function listArtifactsForPhase(runId: string, phaseId: string, attempt?: number): StoredArtifact[] {
  const db = readDb();
  return Object.values(db.artifacts)
    .filter((artifact) => artifact.runId === runId && artifact.phaseId === phaseId)
    .filter((artifact) => (typeof attempt === "number" ? artifact.attempt === attempt : true))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function clearWorkflowDb(): void {
  rmSync(DB_PATH, { force: true });
  rmSync(DB_LOCK_PATH, { recursive: true, force: true });
}

export function deleteRunData(runId: string): void {
  withDbLock((db) => {
    delete db.runs[runId];
    for (const artifact of Object.values(db.artifacts)) {
      if (artifact.runId === runId) {
        delete db.artifacts[artifact.artifactId];
      }
    }
  });
}