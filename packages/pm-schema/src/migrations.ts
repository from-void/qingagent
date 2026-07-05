import { PM_SCHEMA_VERSION, type PmSchemaVersion } from "./schemaVersion";
import { normalizePmDoc } from "./validators";
import type { PmDoc } from "./types";

export const PM_MIGRATION_VERSIONS = [PM_SCHEMA_VERSION] as const;

export function migratePmDoc(value: unknown, from: PmSchemaVersion, to: PmSchemaVersion = PM_SCHEMA_VERSION): PmDoc {
  if (from !== PM_SCHEMA_VERSION || to !== PM_SCHEMA_VERSION) {
    throw new Error(`Unsupported PM schema migration: ${from} -> ${to}`);
  }
  return normalizePmDoc(value);
}

export function assertPmMigrationRegistryContinuous(): void {
  for (let i = 0; i < PM_MIGRATION_VERSIONS.length; i += 1) {
    if (PM_MIGRATION_VERSIONS[i] !== i + 1) {
      throw new Error(`PM migration registry is not continuous at index ${i}`);
    }
  }
}
