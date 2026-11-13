import { dataSource } from './data-source';

/** Abre a conexão, aplica migrations pendentes e encerra a conexão. */
async function migrate(): Promise<void> {
  await dataSource.initialize();
  try {
    await dataSource.runMigrations({ transaction: 'all' });
  } finally {
    await dataSource.destroy();
  }
}

migrate().catch((error: unknown) => {
  console.error('Migration failed', error);
  process.exitCode = 1;
});
