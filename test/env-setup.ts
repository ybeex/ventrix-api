// Loaded with `node --import` BEFORE any app module, so env.ts sees test configuration.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL ??= 'postgres://storekeeper:storekeeper@localhost:5432/storekeeper_test';
process.env.REDIS_URL ??= 'redis://localhost:6379/15'; // isolated logical DB, flushed between tests
process.env.MAIL_DRIVER = 'json';
process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_LOCAL_DIR = mkdtempSync(join(tmpdir(), 'sk-storage-'));
process.env.FILE_URL_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.RATE_LIMIT_MAX = '100000';
process.env.AUTH_RATE_LIMIT_MAX = '100000';
process.env.CORS_ORIGINS = 'http://localhost:5173';
process.env.MAX_LOCATIONS_PER_ORG = '1';
process.env.CB_VOLUME_THRESHOLD = '2';
process.env.LOAD_SHEDDING = 'false'; // a busy CI box must not 503 the suite
