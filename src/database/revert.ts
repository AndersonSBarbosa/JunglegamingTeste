import { dataSource } from './data-source';

/** Abre a conexão, reverte a última migration e encerra a conexão. */
async function revert(): Promise<void> {
  await dataSource.initialize();
  try {
    await dataSource.undoLastMigration({ transaction: 'all' });
  } finally {
    await dataSource.destroy();
  }
}

revert().catch((error: unknown) => {
  console.error('Migration rollback failed', error);
  process.exitCode = 1;
});
