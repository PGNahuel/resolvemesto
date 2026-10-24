import mysql from 'mysql2/promise';
import { AsyncLocalStorage } from 'node:async_hooks';

const schema=[
  `CREATE TABLE IF NOT EXISTS users (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL,
    email VARCHAR(254) NOT NULL UNIQUE, password_hash VARCHAR(255) NOT NULL,
    profile_photo MEDIUMTEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS businesses (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120) NOT NULL,
    logo MEDIUMTEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS employees (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, business_id INT UNSIGNED NOT NULL,
    user_id INT UNSIGNED NOT NULL, role ENUM('admin','employee') NOT NULL,
    UNIQUE KEY employees_business_user (business_id,user_id),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS catalog (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, business_id INT UNSIGNED NOT NULL,
    type ENUM('service','product') NOT NULL, name VARCHAR(120) NOT NULL,
    price INT UNSIGNED NOT NULL, active TINYINT NOT NULL DEFAULT 1, photo MEDIUMTEXT,
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS customers (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, business_id INT UNSIGNED NOT NULL,
    full_name VARCHAR(120) NOT NULL, phone VARCHAR(40) NOT NULL,
    email VARCHAR(254) NOT NULL, profile_photo MEDIUMTEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY customers_business_email (business_id,email),
    KEY customers_business_name (business_id,full_name),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS sales (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, business_id INT UNSIGNED NOT NULL,
    employee_id INT UNSIGNED NOT NULL, customer VARCHAR(120),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    customer_id INT UNSIGNED, created_by_employee_id INT UNSIGNED,
    payment_method VARCHAR(20) NOT NULL DEFAULT 'cash', discount INT UNSIGNED NOT NULL DEFAULT 0,
    notes VARCHAR(500), status VARCHAR(20) NOT NULL DEFAULT 'completed',
    void_reason VARCHAR(300), voided_at DATETIME,
    KEY sales_business_date (business_id,created_at),
    KEY sales_customer_date (customer_id,created_at),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
    FOREIGN KEY (employee_id) REFERENCES employees(id),
    FOREIGN KEY (customer_id) REFERENCES customers(id),
    FOREIGN KEY (created_by_employee_id) REFERENCES employees(id)
  )`,
  `CREATE TABLE IF NOT EXISTS sale_items (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, sale_id INT UNSIGNED NOT NULL,
    catalog_id INT UNSIGNED NOT NULL, item_name VARCHAR(120) NOT NULL,
    item_type VARCHAR(20) NOT NULL, quantity INT UNSIGNED NOT NULL,
    unit_price INT UNSIGNED NOT NULL, KEY items_sale (sale_id),
    FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
    FOREIGN KEY (catalog_id) REFERENCES catalog(id)
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token VARCHAR(128) PRIMARY KEY, user_id INT UNSIGNED NOT NULL,
    expires_at BIGINT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, business_id INT UNSIGNED NOT NULL,
    actor_user_id INT UNSIGNED, actor_employee_id INT UNSIGNED,
    action VARCHAR(40) NOT NULL, entity_type VARCHAR(40) NOT NULL,
    entity_id INT UNSIGNED, before_json LONGTEXT, after_json LONGTEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY audit_business_date (business_id,created_at),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
    FOREIGN KEY (actor_user_id) REFERENCES users(id),
    FOREIGN KEY (actor_employee_id) REFERENCES employees(id)
  )`
];

export function createDatabase(config={}) {
  const pool=mysql.createPool({
    host:process.env.DB_HOST||'127.0.0.1', port:Number(process.env.DB_PORT||3306),
    user:process.env.DB_USER||'resolvemesto', password:process.env.DB_PASSWORD||'',
    database:process.env.DB_NAME||'resolvemesto',
    ...(process.env.DB_SOCKET?{socketPath:process.env.DB_SOCKET}:{}),
    waitForConnections:true, connectionLimit:10, dateStrings:true, decimalNumbers:true,
    timezone:'Z', ...config
  });
  const transactions=new AsyncLocalStorage();
  const configured=new WeakSet();
  async function configure(connection) {
    if(!configured.has(connection)) {
      await connection.query("SET time_zone = '+00:00'");
      configured.add(connection);
    }
  }
  async function execute(sql,params) {
    const active=transactions.getStore();
    if(active)return active.execute(sql,params);
    const connection=await pool.getConnection();
    try {
      await configure(connection);
      return await connection.execute(sql,params);
    } finally { connection.release(); }
  }
  return {
    async initialize() {
      for(const statement of schema)await pool.query(statement);
    },
    prepare(sql) {
      return {
        async get(...params) { const [rows]=await execute(sql,params); return rows[0]||null; },
        async all(...params) { const [rows]=await execute(sql,params); return rows; },
        async run(...params) { const [result]=await execute(sql,params); return {lastInsertRowid:result.insertId}; }
      };
    },
    async transaction(work) {
      const connection=await pool.getConnection();
      try {
        await configure(connection);
        await connection.beginTransaction();
        const result=await transactions.run(connection,work);
        await connection.commit();
        return result;
      } catch(error) {
        await connection.rollback();
        throw error;
      } finally { connection.release(); }
    },
    close() { return pool.end(); }
  };
}
