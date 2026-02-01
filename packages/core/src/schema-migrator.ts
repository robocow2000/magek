import {
  MagekConfig,
  CommandEnvelope,
  EventEnvelope,
  SchemaMigrationMetadata,
  CommandInterface,
  EntityInterface,
  EventInterface,
  InvalidVersionError,
  EntitySnapshotEnvelope,
  TraceActionTypes,
  getLogger,
} from '@magek/common'
import { trace } from './instrumentation'

type SchemaMigrableEnvelope = CommandEnvelope | EventEnvelope | EntitySnapshotEnvelope
type SchemaMigrableValue = CommandInterface | EventInterface | EntityInterface

export class SchemaMigrator {
  public constructor(private config: MagekConfig) {}

  @trace(TraceActionTypes.SCHEMA_MIGRATOR_MIGRATE)
  public async migrate<TMigrableEnvelope extends SchemaMigrableEnvelope>(
    conceptEnvelope: TMigrableEnvelope
  ): Promise<TMigrableEnvelope> {
    this.checkVersionRange(conceptEnvelope)
    if (this.needsMigration(conceptEnvelope)) {
      return await this.applyAllMigrations(conceptEnvelope)
    }

    return conceptEnvelope // The current version is exactly the same as the version of the concept
  }

  private getEnvelopeSchemaVersion(conceptEnvelope: SchemaMigrableEnvelope): number {
    // Prefer the explicit "schemaVersion" field if present; fall back to legacy "version" for compatibility
    return (conceptEnvelope as any).schemaVersion ?? (conceptEnvelope as any).version
  }

  private checkVersionRange(conceptEnvelope: SchemaMigrableEnvelope): void {
    const envelopeVersion = this.getEnvelopeSchemaVersion(conceptEnvelope)

    if (envelopeVersion < 1) {
      throw new InvalidVersionError(
        `Received an invalid schema version value, ${envelopeVersion}, for ${conceptEnvelope.typeName}. ` +
          'Versions must be greater than 0'
      )
    }

    const currentVersion = this.config.currentVersionFor(conceptEnvelope.typeName)
    if (currentVersion < envelopeVersion) {
      throw new InvalidVersionError(
        `Can not migrate schema an unknown version: The current schema version of ${conceptEnvelope.typeName} is ${currentVersion}, which is ` +
          `lower than the received version ${envelopeVersion}`
      )
    }
  }

  private needsMigration(conceptEnvelope: SchemaMigrableEnvelope): boolean {
    const currentVersion = this.config.currentVersionFor(conceptEnvelope.typeName)
    const envelopeVersion = this.getEnvelopeSchemaVersion(conceptEnvelope)
    return currentVersion > envelopeVersion
  }

  private async applyAllMigrations<TMigrableEnvelope extends SchemaMigrableEnvelope>(
    oldConceptEnvelope: TMigrableEnvelope
  ): Promise<TMigrableEnvelope> {
    const logger = getLogger(this.config, 'SchemaMigrator#applyAllMigrations')
    const currentVersion = this.config.currentVersionFor(oldConceptEnvelope.typeName)
    const oldVersion = this.getEnvelopeSchemaVersion(oldConceptEnvelope)
    logger.info(
      `Migrating schema ${oldConceptEnvelope.typeName} from version ${oldVersion} to version ${currentVersion}`
    )
    logger.debug('Envelope before schema migration:\n', oldConceptEnvelope)

    const migrations = this.config.schemaMigrations[oldConceptEnvelope.typeName]
    let migratedConceptValue = oldConceptEnvelope.value as SchemaMigrableValue
    for (let toVersion = oldVersion + 1; toVersion <= currentVersion; toVersion++) {
      migratedConceptValue = await this.applyMigration(migratedConceptValue, migrations.get(toVersion))
    }

    const newConceptEnvelope = {
      ...oldConceptEnvelope,
      value: migratedConceptValue,
      // keep backward compatible "version" field and also set the new "schemaVersion"
      version: currentVersion,
      schemaVersion: currentVersion,
    }
    logger.debug('Envelope after migration:\n', newConceptEnvelope)
    return newConceptEnvelope
  }

  private async applyMigration<TMigrableValue extends SchemaMigrableValue>(
    oldValue: TMigrableValue,
    migration: SchemaMigrationMetadata | undefined
  ): Promise<TMigrableValue> {
    const logger = getLogger(this.config, 'SchemaMigrator#applyMigration')
    if (!migration) {
      throw new InvalidVersionError(
        'Received an undefined schema migration value. Are there "gaps" between the versions of the schema migrations?'
      )
    }
    const oldConcept = Object.assign(new migration.fromSchema(), oldValue)
    const migrationMethod = new migration.migrationClass()[migration.methodName]
    const newConcept = await migrationMethod(oldConcept)
    logger.debug(`Partial migration finished. Migrated from oldValue=${oldConcept} to newValue=${newConcept}`)
    return newConcept
  }
}
