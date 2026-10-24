import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const root=new URL('..',import.meta.url).pathname;
const currentDatabase=join(root,'resolvemesto.sqlite');
const previousDatabase=join(root,'barberia.sqlite');

export function createDatabase(path=process.env.DB_PATH||(existsSync(currentDatabase)||!existsSync(previousDatabase)?currentDatabase:previousDatabase)) {
  const db=new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON;
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, profile_photo TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS businesses(id INTEGER PRIMARY KEY, name TEXT NOT NULL, logo TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS employees(id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('admin','employee')), UNIQUE(business_id,user_id));
CREATE TABLE IF NOT EXISTS catalog(id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE, type TEXT NOT NULL CHECK(type IN ('service','product')), name TEXT NOT NULL, price INTEGER NOT NULL CHECK(price>=0), active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE, full_name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT NOT NULL, profile_photo TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(business_id,email));
CREATE TABLE IF NOT EXISTS sales(id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE, employee_id INTEGER NOT NULL REFERENCES employees(id), customer TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sale_items(id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE, catalog_id INTEGER NOT NULL REFERENCES catalog(id), item_name TEXT NOT NULL, item_type TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity>0), unit_price INTEGER NOT NULL CHECK(unit_price>=0));
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit_logs(id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE, actor_user_id INTEGER REFERENCES users(id), actor_employee_id INTEGER REFERENCES employees(id), action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id INTEGER, before_json TEXT, after_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS sales_business_date ON sales(business_id,created_at);
CREATE INDEX IF NOT EXISTS items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS audit_business_date ON audit_logs(business_id,created_at);`);

  addColumn(db,'sales','customer_id','INTEGER REFERENCES customers(id)');
  addColumn(db,'sales','created_by_employee_id','INTEGER REFERENCES employees(id)');
  addColumn(db,'users','profile_photo','TEXT');
  addColumn(db,'customers','profile_photo','TEXT');
  addColumn(db,'catalog','photo','TEXT');
  addColumn(db,'sales','payment_method',"TEXT NOT NULL DEFAULT 'cash'");
  addColumn(db,'sales','discount','INTEGER NOT NULL DEFAULT 0');
  addColumn(db,'sales','notes','TEXT');
  addColumn(db,'sales','status',"TEXT NOT NULL DEFAULT 'completed'");
  addColumn(db,'sales','void_reason','TEXT');
  addColumn(db,'sales','voided_at','TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS customers_business_name ON customers(business_id,full_name); CREATE INDEX IF NOT EXISTS sales_customer_date ON sales(customer_id,created_at);');
  return db;
}

function addColumn(db,table,column,definition) {
  if(!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`).get(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
