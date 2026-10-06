import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const scrypt = promisify(scryptCallback);
const root = new URL('.', import.meta.url).pathname;
const db = new DatabaseSync(join(root, 'barberia.sqlite'));
db.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, profile_photo TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS businesses(id INTEGER PRIMARY KEY, name TEXT NOT NULL, logo TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS employees(id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('admin','employee')), UNIQUE(business_id,user_id));
CREATE TABLE IF NOT EXISTS catalog(id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE, type TEXT NOT NULL CHECK(type IN ('service','product')), name TEXT NOT NULL, price INTEGER NOT NULL CHECK(price>=0), active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE, full_name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT NOT NULL, profile_photo TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(business_id,email));
CREATE TABLE IF NOT EXISTS sales(id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE, employee_id INTEGER NOT NULL REFERENCES employees(id), customer TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sale_items(id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE, catalog_id INTEGER NOT NULL REFERENCES catalog(id), item_name TEXT NOT NULL, item_type TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity>0), unit_price INTEGER NOT NULL CHECK(unit_price>=0));
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sales_business_date ON sales(business_id,created_at);
CREATE INDEX IF NOT EXISTS items_sale ON sale_items(sale_id);`);
if(!db.prepare("SELECT 1 FROM pragma_table_info('sales') WHERE name='customer_id'").get()) db.exec('ALTER TABLE sales ADD COLUMN customer_id INTEGER REFERENCES customers(id)');
if(!db.prepare("SELECT 1 FROM pragma_table_info('sales') WHERE name='created_by_employee_id'").get()) db.exec('ALTER TABLE sales ADD COLUMN created_by_employee_id INTEGER REFERENCES employees(id)');
if(!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name='profile_photo'").get()) db.exec('ALTER TABLE users ADD COLUMN profile_photo TEXT');
if(!db.prepare("SELECT 1 FROM pragma_table_info('customers') WHERE name='profile_photo'").get()) db.exec('ALTER TABLE customers ADD COLUMN profile_photo TEXT');
db.exec('CREATE INDEX IF NOT EXISTS customers_business_name ON customers(business_id,full_name); CREATE INDEX IF NOT EXISTS sales_customer_date ON sales(customer_id,created_at);');

const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml' };
function log(event, details={}) { console.log(JSON.stringify({ time:new Date().toISOString(), event, ...details })); }
const send = (res, status, body) => { res.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }); res.end(JSON.stringify(body)); };
function cookie(req, name) { return (req.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith(`${name}=`))?.slice(name.length+1); }
async function body(req) { let data=''; for await(const chunk of req) { data+=chunk; if(data.length>2_000_000) throw new Error('El archivo es demasiado grande'); } return data ? JSON.parse(data) : {}; }
async function passwordHash(password, salt=randomBytes(16).toString('hex')) { return `${salt}:${(await scrypt(password,salt,64)).toString('hex')}`; }
async function userFor(req) {
  const token=cookie(req,'sid'); if(!token) return null;
  const session=db.prepare('SELECT user_id FROM sessions WHERE token=? AND expires_at>?').get(token,Date.now());
  return session ? db.prepare('SELECT id,name,email,profile_photo FROM users WHERE id=?').get(session.user_id) : null;
}
function validPhoto(value) { return typeof value==='string' && (value==='' || (value.startsWith('data:image/') && value.length<1_500_000)); }
function businessFor(req, user) {
  const id=Number(req.headers['x-business-id']);
  if(!id) return null;
  return db.prepare(`SELECT b.id,b.name,b.logo,e.role,e.id employee_id FROM businesses b JOIN employees e ON e.business_id=b.id WHERE b.id=? AND e.user_id=?`).get(id,user.id) || null;
}
async function route(req,res) {
  const url=new URL(req.url,'http://localhost'); const path=url.pathname; const method=req.method;
  if(method==='GET' && !path.startsWith('/api/')) {
    const file=(path==='/' || path==='/new/admin')?'index.html':path.slice(1);
    if(file.includes('..')) return send(res,404,{error:'No encontrado'});
    try { const data=await readFile(join(root,'public',file)); res.writeHead(200,{'content-type':mime[extname(file)]||'application/octet-stream'}); return res.end(data); } catch { return send(res,404,{error:'No encontrado'}); }
  }
  if(method==='POST' && path==='/api/register') {
    const b=await body(req); const name=String(b.name||'').trim(),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||''),profilePhoto=b.profile_photo;
    if(!name||!email||password.length<8) return send(res,400,{error:'Completá tu nombre y email; la contraseña debe tener al menos 8 caracteres.'});
    if(profilePhoto!==undefined&&!validPhoto(profilePhoto)) return send(res,400,{error:'La foto de perfil no es válida o es demasiado grande.'});
    try { const result=db.prepare('INSERT INTO users(name,email,password_hash,profile_photo) VALUES(?,?,?,?)').run(name,email,await passwordHash(password),profilePhoto||null); return send(res,201,{id:Number(result.lastInsertRowid)}); } catch(error) {
      const duplicateEmail=String(error.message).includes('UNIQUE constraint failed: users.email');
      if(duplicateEmail) {
        log('registration_conflict',{request_id:req.requestId,reason:'email_already_registered',sqlite_code:error.code||null,sqlite_errno:error.errcode||null});
        return send(res,409,{error:'Ese email ya tiene una cuenta. Iniciá sesión o probá con otro email.'});
      }
      throw error;
    }
  }
  if(method==='POST' && path==='/api/admin/register') {
    const b=await body(req); const name=String(b.name||'').trim(),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||''),businessName=String(b.business_name||'').trim(),profilePhoto=b.profile_photo;
    if(!name||!email||password.length<8||!businessName) return send(res,400,{error:'Completá tus datos, el nombre del negocio y una contraseña de al menos 8 caracteres.'});
    if(profilePhoto!==undefined&&!validPhoto(profilePhoto)) return send(res,400,{error:'La foto de perfil no es válida o es demasiado grande.'});
    try {
      db.exec('BEGIN');
      const userId=Number(db.prepare('INSERT INTO users(name,email,password_hash,profile_photo) VALUES(?,?,?,?)').run(name,email,await passwordHash(password),profilePhoto||null).lastInsertRowid);
      const businessId=Number(db.prepare('INSERT INTO businesses(name) VALUES(?)').run(businessName).lastInsertRowid);
      db.prepare("INSERT INTO employees(business_id,user_id,role) VALUES(?,?, 'admin')").run(businessId,userId);
      db.exec('COMMIT'); return send(res,201,{id:userId});
    } catch(error) {
      try { db.exec('ROLLBACK'); } catch {}
      if(String(error.message).includes('UNIQUE constraint failed: users.email')) return send(res,409,{error:'Ese email ya tiene una cuenta. Iniciá sesión o usá otro email.'});
      throw error;
    }
  }
  if(method==='POST' && path==='/api/login') {
    const b=await body(req); const u=db.prepare('SELECT * FROM users WHERE email=?').get(String(b.email||'').trim().toLowerCase());
    if(!u) return send(res,401,{error:'Email o contraseña incorrectos.'});
    const [salt,hash]=u.password_hash.split(':'); const check=await scrypt(String(b.password||''),salt,64);
    if(!timingSafeEqual(check,Buffer.from(hash,'hex'))) return send(res,401,{error:'Email o contraseña incorrectos.'});
    const token=randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token,u.id,Date.now()+30*86400000);
    res.setHeader('set-cookie',`sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
    return send(res,200,{id:u.id,name:u.name,email:u.email});
  }
  if(method==='POST' && path==='/api/logout') { const token=cookie(req,'sid'); if(token) db.prepare('DELETE FROM sessions WHERE token=?').run(token); res.setHeader('set-cookie','sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); return send(res,200,{ok:true}); }
  const user=await userFor(req);
  if(path==='/api/me' && method==='GET') {
    if(!user) return send(res,401,{error:'Iniciá sesión.'});
    const businesses=db.prepare('SELECT b.id,b.name,b.logo,e.role,e.id employee_id FROM businesses b JOIN employees e ON e.business_id=b.id WHERE e.user_id=? ORDER BY b.name').all(user.id);
    return send(res,200,{user,businesses});
  }
  if(!user) return send(res,401,{error:'Iniciá sesión.'});
  if(path==='/api/profile' && method==='PATCH') {
    const b=await body(req);
    if(!validPhoto(b.profile_photo)) return send(res,400,{error:'La foto de perfil no es válida o es demasiado grande.'});
    db.prepare('UPDATE users SET profile_photo=? WHERE id=?').run(b.profile_photo||null,user.id);
    return send(res,200,{ok:true,profile_photo:b.profile_photo||null});
  }
  if(path==='/api/password' && method==='PATCH') {
    const b=await body(req),currentPassword=String(b.current_password||''),password=String(b.password||'');
    if(password.length<8) return send(res,400,{error:'La nueva contraseña debe tener al menos 8 caracteres.'});
    const account=db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id),[salt,hash]=account.password_hash.split(':');
    if(!timingSafeEqual(await scrypt(currentPassword,salt,64),Buffer.from(hash,'hex'))) return send(res,400,{error:'La contraseña actual es incorrecta.'});
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await passwordHash(password),user.id);
    return send(res,200,{ok:true});
  }
  const business=businessFor(req,user);
  if(!business) return send(res,403,{error:'No tenés acceso a esta barbería.'});
  const admin=business.role==='admin';
  if(path==='/api/business' && method==='PATCH') {
    if(!admin) return send(res,403,{error:'Solo un administrador puede cambiar estos datos.'});
    const b=await body(req); if(typeof b.name==='string' && b.name.trim()) db.prepare('UPDATE businesses SET name=? WHERE id=?').run(b.name.trim(),business.id);
    if(typeof b.logo==='string' && (b.logo==='' || (b.logo.startsWith('data:image/') && b.logo.length<1_500_000))) db.prepare('UPDATE businesses SET logo=? WHERE id=?').run(b.logo||null,business.id);
    return send(res,200,{ok:true});
  }
  if(path==='/api/catalog' && method==='GET') return send(res,200,db.prepare('SELECT id,type,name,price FROM catalog WHERE business_id=? AND active=1 ORDER BY type,name').all(business.id));
  if(path==='/api/customers' && method==='GET') return send(res,200,db.prepare(`SELECT c.id,c.full_name,c.phone,c.email,c.profile_photo,MAX(s.created_at) last_operation FROM customers c LEFT JOIN sales s ON s.customer_id=c.id WHERE c.business_id=? GROUP BY c.id ORDER BY c.full_name COLLATE NOCASE`).all(business.id).map(customer=>({...customer,email:customer.email.endsWith('@ritual.internal')?'':customer.email,code:String(customer.id).padStart(5,'0')})));
  if(path==='/api/customers' && method==='POST') {
    const b=await body(req),fullName=String(b.full_name||'').trim(),phone=String(b.phone||'').trim(),email=String(b.email||'').trim().toLowerCase(),profilePhoto=b.profile_photo;
    if(!fullName||!phone||(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return send(res,400,{error:'Completá nombre y teléfono; si ingresás un email, debe ser válido.'});
    if(profilePhoto!==undefined&&!validPhoto(profilePhoto)) return send(res,400,{error:'La foto de perfil no es válida o es demasiado grande.'});
    const storedEmail=email||`${randomUUID()}@ritual.internal`;
    try { const result=db.prepare('INSERT INTO customers(business_id,full_name,phone,email,profile_photo) VALUES(?,?,?,?,?)').run(business.id,fullName,phone,storedEmail,profilePhoto||null); const id=Number(result.lastInsertRowid); return send(res,201,{id,code:String(id).padStart(5,'0'),full_name:fullName,phone,email,profile_photo:profilePhoto||null,last_operation:null}); } catch(error) { if(String(error.message).includes('UNIQUE constraint failed: customers.business_id, customers.email')) return send(res,409,{error:'Ya existe un cliente con ese email.'}); throw error; }
  }
  if(path.startsWith('/api/customers/') && method==='PATCH') {
    if(!admin) return send(res,403,{error:'Solo un administrador puede modificar clientes.'});
    const id=Number(path.split('/').pop()),b=await body(req),fullName=String(b.full_name||'').trim(),phone=String(b.phone||'').trim(),email=String(b.email||'').trim().toLowerCase(),profilePhoto=b.profile_photo;
    if(!Number.isInteger(id)||id<1||!fullName||!phone||(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return send(res,400,{error:'Completá nombre y teléfono; si ingresás un email, debe ser válido.'});
    if(profilePhoto!==undefined&&!validPhoto(profilePhoto)) return send(res,400,{error:'La foto de perfil no es válida o es demasiado grande.'});
    const storedEmail=email||`${randomUUID()}@ritual.internal`;
    try { const result=db.prepare('UPDATE customers SET full_name=?,phone=?,email=?,profile_photo=? WHERE id=? AND business_id=?').run(fullName,phone,storedEmail,profilePhoto||null,id,business.id); if(!result.changes) return send(res,404,{error:'Cliente no encontrado.'}); return send(res,200,{ok:true}); } catch(error) { if(String(error.message).includes('UNIQUE constraint failed: customers.business_id, customers.email')) return send(res,409,{error:'Ya existe un cliente con ese email.'}); throw error; }
  }
  if(path==='/api/catalog' && method==='POST') {
    if(!admin) return send(res,403,{error:'Solo un administrador puede administrar el catálogo.'});
    const b=await body(req),name=String(b.name||'').trim(),price=Math.round(Number(b.price));
    if(!name||!['service','product'].includes(b.type)||!Number.isFinite(price)||price<0) return send(res,400,{error:'Revisá nombre, tipo y precio.'});
    const result=db.prepare('INSERT INTO catalog(business_id,type,name,price) VALUES(?,?,?,?)').run(business.id,b.type,name,price); return send(res,201,{id:Number(result.lastInsertRowid)});
  }
  if(path.startsWith('/api/catalog/') && method==='DELETE') {
    if(!admin) return send(res,403,{error:'Solo un administrador puede administrar el catálogo.'});
    db.prepare('UPDATE catalog SET active=0 WHERE id=? AND business_id=?').run(Number(path.split('/').pop()),business.id); return send(res,200,{ok:true});
  }
  if(path==='/api/employees' && method==='GET') return send(res,200,db.prepare('SELECT e.id,e.role,u.name,u.email,u.profile_photo FROM employees e JOIN users u ON u.id=e.user_id WHERE e.business_id=? ORDER BY e.role,u.name').all(business.id));
  if(path==='/api/employees' && method==='POST') {
    if(!admin) return send(res,403,{error:'Solo un administrador puede gestionar el equipo.'});
    const b=await body(req),email=String(b.email||'').trim().toLowerCase(),name=String(b.name||'').trim(),password=String(b.password||''),role=b.role==='admin'?'admin':'employee';
    if(!email) return send(res,400,{error:'Ingresá el email de la persona.'});
    let target=db.prepare('SELECT id FROM users WHERE email=?').get(email);
    try {
      if(!target) {
        if(!name||password.length<8) return send(res,400,{error:'Para crear una cuenta ingresá nombre y una contraseña inicial de al menos 8 caracteres.'});
        target={id:Number(db.prepare('INSERT INTO users(name,email,password_hash) VALUES(?,?,?)').run(name,email,await passwordHash(password)).lastInsertRowid)};
      }
      db.prepare('INSERT INTO employees(business_id,user_id,role) VALUES(?,?,?)').run(business.id,target.id,role);
      return send(res,201,{ok:true,created:!!name});
    } catch(error) { if(String(error.message).includes('UNIQUE constraint failed: employees.business_id, employees.user_id')) return send(res,409,{error:'Esa persona ya forma parte del equipo.'}); throw error; }
  }
  if(path.startsWith('/api/employees/') && path.endsWith('/password') && method==='PATCH') {
    if(!admin) return send(res,403,{error:'Solo un administrador puede cambiar contraseñas del equipo.'});
    const employeeId=Number(path.split('/')[3]),b=await body(req),password=String(b.password||'');
    if(!Number.isInteger(employeeId)||password.length<8) return send(res,400,{error:'La contraseña debe tener al menos 8 caracteres.'});
    const target=db.prepare('SELECT user_id FROM employees WHERE id=? AND business_id=?').get(employeeId,business.id);
    if(!target) return send(res,404,{error:'La persona no forma parte de este negocio.'});
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await passwordHash(password),target.user_id);
    return send(res,200,{ok:true});
  }
  if(path==='/api/sales' && method==='POST') {
    const b=await body(req); const items=Array.isArray(b.items)?b.items:[]; if(!items.length) return send(res,400,{error:'Agregá al menos un servicio o producto.'});
    const employee=db.prepare('SELECT id FROM employees WHERE id=? AND business_id=?').get(admin?(Number(b.employee_id)||business.employee_id):business.employee_id,business.id); if(!employee) return send(res,400,{error:'Seleccioná un empleado válido.'});
    const customerId=Number(b.customer_id)||null; if(customerId&&!db.prepare('SELECT id FROM customers WHERE id=? AND business_id=?').get(customerId,business.id)) return send(res,400,{error:'Seleccioná un cliente válido.'});
    const valid=[]; for(const item of items) { const catalog=db.prepare('SELECT id,name,type,price FROM catalog WHERE id=? AND business_id=? AND active=1').get(Number(item.id),business.id); const qty=Math.floor(Number(item.quantity)); if(catalog && qty>0) valid.push({...catalog,qty}); }
    if(valid.length!==items.length) return send(res,400,{error:'Hay productos o cantidades inválidas.'});
    const sale=db.prepare('INSERT INTO sales(business_id,employee_id,customer,customer_id,created_by_employee_id) VALUES(?,?,?,?,?)').run(business.id,employee.id,null,customerId,business.employee_id);
    const insert=db.prepare('INSERT INTO sale_items(sale_id,catalog_id,item_name,item_type,quantity,unit_price) VALUES(?,?,?,?,?,?)'); for(const i of valid) insert.run(Number(sale.lastInsertRowid),i.id,i.name,i.type,i.qty,i.price);
    return send(res,201,{id:Number(sale.lastInsertRowid)});
  }
  if(path==='/api/sales' && method==='GET') {
    const sales=db.prepare(`SELECT s.id,s.created_at,s.customer_id,COALESCE(c.full_name,s.customer,'Sin cliente') customer,u.name employee,COALESCE(SUM(si.quantity*si.unit_price),0) total,GROUP_CONCAT(si.item_name||' ×'||si.quantity,', ') items,(? OR COALESCE(s.created_by_employee_id,s.employee_id)=?) editable FROM sales s JOIN employees e ON e.id=s.employee_id JOIN users u ON u.id=e.user_id LEFT JOIN customers c ON c.id=s.customer_id JOIN sale_items si ON si.sale_id=s.id WHERE s.business_id=? GROUP BY s.id ORDER BY s.created_at DESC`).all(admin?1:0,business.employee_id,business.id);
    return send(res,200,sales);
  }
  if(path.startsWith('/api/sales/') && method==='GET') {
    const id=Number(path.split('/').pop());
    const sale=db.prepare(`SELECT s.id,s.created_at,s.customer_id,s.employee_id,COALESCE(c.full_name,s.customer,'Sin cliente') customer,u.name employee,(? OR COALESCE(s.created_by_employee_id,s.employee_id)=?) editable FROM sales s JOIN employees e ON e.id=s.employee_id JOIN users u ON u.id=e.user_id LEFT JOIN customers c ON c.id=s.customer_id WHERE s.id=? AND s.business_id=?`).get(admin?1:0,business.employee_id,id,business.id);
    if(!sale) return send(res,404,{error:'Venta no encontrada.'});
    sale.items=db.prepare('SELECT catalog_id id,item_name name,item_type type,quantity,unit_price price FROM sale_items WHERE sale_id=? ORDER BY id').all(id);
    return send(res,200,sale);
  }
  if(path.startsWith('/api/sales/') && method==='PATCH') {
    const id=Number(path.split('/').pop()),sale=db.prepare('SELECT id,employee_id,COALESCE(created_by_employee_id,employee_id) created_by_employee_id FROM sales WHERE id=? AND business_id=?').get(id,business.id);
    if(!sale) return send(res,404,{error:'Venta no encontrada.'});
    if(!admin&&sale.created_by_employee_id!==business.employee_id) return send(res,403,{error:'Solo quien cargó esta venta o un administrador puede modificarla.'});
    const b=await body(req),items=Array.isArray(b.items)?b.items:[];
    if(!items.length) return send(res,400,{error:'Agregá al menos un servicio o producto.'});
    const employee=db.prepare('SELECT id FROM employees WHERE id=? AND business_id=?').get(admin?(Number(b.employee_id)||sale.employee_id):sale.employee_id,business.id);
    const customerId=Number(b.customer_id)||null;
    if(!employee) return send(res,400,{error:'Seleccioná un empleado válido.'});
    if(customerId&&!db.prepare('SELECT id FROM customers WHERE id=? AND business_id=?').get(customerId,business.id)) return send(res,400,{error:'Seleccioná un cliente válido.'});
    const valid=[]; for(const item of items) { const catalog=db.prepare('SELECT id,name,type,price FROM catalog WHERE id=? AND business_id=? AND active=1').get(Number(item.id),business.id); const qty=Math.floor(Number(item.quantity)); if(catalog&&qty>0) valid.push({...catalog,qty}); }
    if(valid.length!==items.length) return send(res,400,{error:'Hay productos o cantidades inválidas.'});
    try { db.exec('BEGIN'); db.prepare('UPDATE sales SET employee_id=?,customer_id=?,customer=NULL WHERE id=?').run(employee.id,customerId,id); db.prepare('DELETE FROM sale_items WHERE sale_id=?').run(id); const insert=db.prepare('INSERT INTO sale_items(sale_id,catalog_id,item_name,item_type,quantity,unit_price) VALUES(?,?,?,?,?,?)'); for(const item of valid) insert.run(id,item.id,item.name,item.type,item.qty,item.price); db.exec('COMMIT'); return send(res,200,{ok:true}); } catch(error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }
  if(path==='/api/dashboard' && method==='GET') {
    const today=new Date(Date.now()-3*60*60*1000).toISOString().slice(0,10),first=db.prepare("SELECT MIN(date(created_at,'-3 hours')) date FROM sales WHERE business_id=?").get(business.id).date||today;
    const isDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||''); let start=isDate(url.searchParams.get('start'))?url.searchParams.get('start'):today,end=isDate(url.searchParams.get('end'))?url.searchParams.get('end'):today;
    if(start<first) start=first; if(end>today) end=today; if(start>end) return send(res,400,{error:'La fecha de inicio debe ser anterior o igual a la fecha final.'});
    const span=Math.round((Date.parse(`${end}T00:00:00Z`)-Date.parse(`${start}T00:00:00Z`))/86400000)+1;
    const summary=db.prepare(`SELECT COALESCE(SUM(si.quantity*si.unit_price),0) revenue, COALESCE(SUM(CASE WHEN si.item_type='service' THEN si.quantity ELSE 0 END),0) services, COALESCE(SUM(CASE WHEN si.item_type='product' THEN si.quantity ELSE 0 END),0) products, COUNT(DISTINCT s.id) tickets FROM sales s LEFT JOIN sale_items si ON si.sale_id=s.id WHERE s.business_id=? AND date(s.created_at,'-3 hours') BETWEEN ? AND ?`).get(business.id,start,end);
    const previous=db.prepare(`SELECT COALESCE(SUM(si.quantity*si.unit_price),0) revenue, COUNT(DISTINCT s.id) tickets FROM sales s LEFT JOIN sale_items si ON si.sale_id=s.id WHERE s.business_id=? AND date(s.created_at,'-3 hours')>=date(?,'-' || ? || ' days') AND date(s.created_at,'-3 hours')<?`).get(business.id,start,span,start);
    const employees=db.prepare(`SELECT u.name,u.profile_photo,COUNT(DISTINCT s.id) tickets,COALESCE(SUM(CASE WHEN si.item_type='service' THEN si.quantity ELSE 0 END),0) services,COALESCE(SUM(CASE WHEN si.item_type='product' THEN si.quantity ELSE 0 END),0) products,COALESCE(SUM(si.quantity*si.unit_price),0) revenue FROM employees e JOIN users u ON u.id=e.user_id LEFT JOIN sales s ON s.employee_id=e.id AND date(s.created_at,'-3 hours') BETWEEN ? AND ? LEFT JOIN sale_items si ON si.sale_id=s.id WHERE e.business_id=? GROUP BY e.id ORDER BY revenue DESC`).all(start,end,business.id);
    const featured=db.prepare(`SELECT si.item_name name,si.item_type type,SUM(si.quantity) quantity,SUM(si.quantity*si.unit_price) revenue FROM sales s JOIN sale_items si ON si.sale_id=s.id WHERE s.business_id=? AND date(s.created_at,'-3 hours') BETWEEN ? AND ? GROUP BY si.catalog_id ORDER BY revenue DESC`).all(business.id,start,end);
    const recent=db.prepare(`SELECT s.id,COALESCE(c.full_name,s.customer) customer,s.created_at,u.name employee,u.profile_photo,COALESCE(SUM(si.quantity*si.unit_price),0) total,GROUP_CONCAT(si.item_name||' ×'||si.quantity,', ') items FROM sales s JOIN employees e ON e.id=s.employee_id JOIN users u ON u.id=e.user_id LEFT JOIN customers c ON c.id=s.customer_id JOIN sale_items si ON si.sale_id=s.id WHERE s.business_id=? AND date(s.created_at,'-3 hours') BETWEEN ? AND ? GROUP BY s.id ORDER BY s.created_at DESC LIMIT 5`).all(business.id,start,end);
    return send(res,200,{summary,previous,dateRange:{min:first,max:today,start,end},employees,featured:{services:featured.filter(item=>item.type==='service').slice(0,3),products:featured.filter(item=>item.type==='product').slice(0,3)},recent});
  }
  return send(res,404,{error:'No encontrado.'});
}

const server=createServer(async(req,res)=>{
  req.requestId=randomUUID();
  const started=Date.now();
  res.setHeader('x-request-id',req.requestId);
  res.on('finish',()=>{
    if(req.url.startsWith('/api/')||res.statusCode>=400) {
      const path=new URL(req.url,'http://localhost').pathname;
      log('http_request',{request_id:req.requestId,method:req.method,path,status:res.statusCode,duration_ms:Date.now()-started});
    }
  });
  try { await route(req,res); } catch(error) {
    log('request_error',{request_id:req.requestId,method:req.method,path:new URL(req.url,'http://localhost').pathname,error_name:error.name||'Error',error_code:error.code||null,error_message:error.message||String(error),stack:error.stack||null});
    if(!res.headersSent) send(res,500,{error:'Ocurrió un error. Revisá los datos e intentá de nuevo.',request_id:req.requestId}); else res.end();
  }
});
const port=Number(process.env.PORT)||8081; server.listen(port,'0.0.0.0',()=>log('server_started',{url:`http://localhost:${port}`,node:process.version}));
