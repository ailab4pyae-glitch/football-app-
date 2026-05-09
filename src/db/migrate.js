require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required to run migrations');
  process.exit(1);
}

const schemaPath = path.resolve(__dirname, 'schema.sql');
const schemaSql = fs.readFileSync(schemaPath, 'utf8');

const pool = new Pool({ connectionString: databaseUrl });

const runMigration = async () => {
  try {
    await pool.query(schemaSql);
    console.log('Database schema applied successfully.');
  } catch (err) {
    console.error('Failed to apply database schema:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
};

runMigration();
