import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { InitialSchema1710000000000 } from './migrations/1710000000000-InitialSchema';

export const dataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL ??
    'postgres://wager:wager@localhost:5432/wagering',
  migrations: [InitialSchema1710000000000],
  migrationsTableName: 'schema_migrations',
  synchronize: false,
  logging: false,
});
