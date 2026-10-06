import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const scrypt = promisify(scryptCallback);
const root = new URL('.', import.meta.url).pathname;
const db = new DatabaseSync(process.env.DB_PATH || join(root, 'barberia.sqlite'));
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
if(!db.prepare("SELECT 1 FROM pragma_table_info('sales') WHERE name='customer_id'").get()) db.exec('ALTER TABLE sales ADD COLUMN customer_id INTEGER REFERENCES customers(id)');
if(!db.prepare("SELECT 1 FROM pragma_table_info('sales') WHERE name='created_by_employee_id'").get()) db.exec('ALTER TABLE sales ADD COLUMN created_by_employee_id INTEGER REFERENCES employees(id)');
if(!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name='profile_photo'").get()) db.exec('ALTER TABLE users ADD COLUMN profile_photo TEXT');
if(!db.prepare("SELECT 1 FROM pragma_table_info('customers') WHERE name='profile_photo'").get()) db.exec('ALTER TABLE customers ADD COLUMN profile_photo TEXT');
if(!db.prepare("SELECT 1 FROM pragma_table_info('catalog') WHERE name='photo'").get()) db.exec('ALTER TABLE catalog ADD COLUMN photo TEXT');
if(!db.prepare("SELECT 1 FROM pragma_table_info('sales') WHERE name='payment_method'").get()) db.exec("ALTER TABLE sales ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'cash'");
if(!db.prepare("SELECT 1 FROM pragma_table_info('sales') WHERE name='discount'").get()) db.exec('ALTER TABLE sales ADD COLUMN discount INTEGER NOT NULL DEFAULT 0');
if(!db.prepare("SELECT 1 FROM pragma_table_info('sales') WHERE name='notes'").get()) db.exec('ALTER TABLE sales ADD COLUMN notes TEXT');
if(!db.prepare("SELECT 1 FROM pragma_table_info('sales') WHERE name='status'").get()) db.exec("ALTER TABLE sales ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'");
if(!db.prepare("SELECT 1 FROM pragma_table_info('sales') WHERE name='void_reason'").get()) db.exec('ALTER TABLE sales ADD COLUMN void_reason TEXT');
if(!db.prepare("SELECT 1 FROM pragma_table_info('sales') WHERE name='voided_at'").get()) db.exec('ALTER TABLE sales ADD COLUMN voided_at TEXT');
db.exec('CREATE INDEX IF NOT EXISTS customers_business_name ON customers(business_id,full_name); CREATE INDEX IF NOT EXISTS sales_customer_date ON sales(customer_id,created_at);');

const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml' };
const emailPattern=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const paymentMethods=new Set(['cash','debit','credit','transfer','other']);
const loginAttempts=new Map();
function log(event, details={}) { console.log(JSON.stringify({ time:new Date().toISOString(), event, ...details })); }
const send = (res, status, body) => { res.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }); res.end(JSON.stringify(body)); };
function cookie(req, name) { return (req.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith(`${name}=`))?.slice(name.length+1); }
async function body(req) { let data=''; for await(const chunk of req) { data+=chunk; if(data.length>2_000_000) { const error=new Error('El archivo es demasiado grande.'); error.status=413; throw error; } } try { return data ? JSON.parse(data) : {}; } catch { const error=new Error('Los datos enviados no tienen un formato válido.'); error.status=400; throw error; } }
function normalizeEmail(value) { return String(value||'').normalize('NFKC').trim().toLowerCase(); }
function validEmail(value) { return value.length<=254&&emailPattern.test(value); }
function validPassword(value) { return typeof value==='string'&&value.length>=10&&value.length<=200; }
async function passwordHash(password) { const salt=randomBytes(16); const hash=await scrypt(password,salt,64,{N:16384,r:8,p:1,maxmem:32*1024*1024}); return `scrypt$16384$8$1$${salt.toString('hex')}$${hash.toString('hex')}`; }
async function passwordMatches(password, encoded) {
  try {
    if(encoded.startsWith('scrypt$')) { const [,n,r,p,salt,hash]=encoded.split('$'); const expected=Buffer.from(hash,'hex'); const actual=await scrypt(password,Buffer.from(salt,'hex'),expected.length,{N:Number(n),r:Number(r),p:Number(p),maxmem:32*1024*1024}); return expected.length===actual.length&&timingSafeEqual(actual,expected); }
    const [salt,hash]=encoded.split(':'); const expected=Buffer.from(hash,'hex'),actual=await scrypt(password,salt,expected.length); return expected.length===actual.length&&timingSafeEqual(actual,expected);
  } catch { return false; }
}
function sessionCookie(token,maxAge=2592000) { return `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${process.env.NODE_ENV==='production'?'; Secure':''}`; }
function sessionKey(token) { return createHash('sha256').update(token).digest('hex'); }
function clientIp(req) { const address=process.env.TRUST_PROXY==='1'?req.headers['x-forwarded-for']:req.socket.remoteAddress; return String(address||'unknown').split(',')[0].trim(); }
function loginKey(req,email) { return `${clientIp(req)}:${email}`; }
function rateLimitFor(key) { const now=Date.now(),attempt=loginAttempts.get(key); if(!attempt||attempt.resetAt<=now) { loginAttempts.delete(key); return 0; } return attempt.count>=5?Math.ceil((attempt.resetAt-now)/1000):0; }
function recordLoginFailure(key) { const now=Date.now(),current=loginAttempts.get(key); loginAttempts.set(key,!current||current.resetAt<=now?{count:1,resetAt:now+15*60_000}:{...current,count:current.count+1}); if(loginAttempts.size>10_000) { for(const [attemptKey,attempt] of loginAttempts)if(attempt.resetAt<=now)loginAttempts.delete(attemptKey); if(loginAttempts.size>10_000)loginAttempts.delete(loginAttempts.keys().next().value); } }
function allowedOrigin(req) { if(!req.headers.origin||!req.headers.host)return true; try { return new URL(req.headers.origin).host===req.headers.host; } catch { return false; } }
function auditData(value) { if(value===null)return null; return JSON.parse(JSON.stringify(value,(key,item)=>['profile_photo','photo','logo'].includes(key)&&item?'[imagen]':item)); }
function audit(business,user,action,entityType,entityId,before=null,after=null) { db.prepare('INSERT INTO audit_logs(business_id,actor_user_id,actor_employee_id,action,entity_type,entity_id,before_json,after_json) VALUES(?,?,?,?,?,?,?,?)').run(business.id,user.id,business.employee_id,action,entityType,entityId??null,before===null?null:JSON.stringify(auditData(before)),after===null?null:JSON.stringify(auditData(after))); }
function saleSnapshot(id,businessId) { const sale=db.prepare('SELECT id,employee_id,customer_id,payment_method,discount,notes,status,void_reason,voided_at,created_at FROM sales WHERE id=? AND business_id=?').get(id,businessId); if(!sale)return null; return {...sale,items:db.prepare('SELECT catalog_id,item_name,item_type,quantity,unit_price FROM sale_items WHERE sale_id=? ORDER BY id').all(id)}; }
async function userFor(req) {
  const token=cookie(req,'sid'); if(!token) return null;
  const hashed=sessionKey(token),session=db.prepare('SELECT user_id FROM sessions WHERE token IN (?,?) AND expires_at>?').get(hashed,token,Date.now());
  if(!session) db.prepare('DELETE FROM sessions WHERE token IN (?,?)').run(hashed,token);
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
    const b=await body(req); const name=String(b.name||'').trim(),email=normalizeEmail(b.email),password=String(b.password||''),profilePhoto=b.profile_photo;
    if(!name||name.length>100||!validEmail(email)||!validPassword(password)) return send(res,400,{error:'Completá un nombre y email válidos; la contraseña debe tener entre 10 y 200 caracteres.'});
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
    const b=await body(req); const name=String(b.name||'').trim(),email=normalizeEmail(b.email),password=String(b.password||''),businessName=String(b.business_name||'').trim(),profilePhoto=b.profile_photo;
    if(!name||name.length>100||!validEmail(email)||!validPassword(password)||!businessName||businessName.length>120) return send(res,400,{error:'Completá datos válidos y una contraseña de entre 10 y 200 caracteres.'});
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
    const b=await body(req),email=normalizeEmail(b.email),key=loginKey(req,email),retryAfter=rateLimitFor(key);
    if(retryAfter) { res.setHeader('retry-after',String(retryAfter)); return send(res,429,{error:`Demasiados intentos. Probá nuevamente en ${Math.ceil(retryAfter/60)} minutos.`}); }
    const u=db.prepare('SELECT * FROM users WHERE email=?').get(email),password=String(b.password||'');
    const passwordOk=u?await passwordMatches(password,u.password_hash):(await scrypt(password,Buffer.alloc(16),64,{N:16384,r:8,p:1,maxmem:32*1024*1024}),false);
    if(!u||!passwordOk) { recordLoginFailure(key); return send(res,401,{error:'Email o contraseña incorrectos.'}); }
    loginAttempts.delete(key);
    if(!u.password_hash.startsWith('scrypt$')) db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await passwordHash(password),u.id);
    const token=randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sessionKey(token),u.id,Date.now()+30*86400000);
    res.setHeader('set-cookie',sessionCookie(token));
    return send(res,200,{id:u.id,name:u.name,email:u.email});
  }
  if(method==='POST' && path==='/api/logout') { const token=cookie(req,'sid'); if(token) db.prepare('DELETE FROM sessions WHERE token IN (?,?)').run(sessionKey(token),token); res.setHeader('set-cookie',sessionCookie('',0)); return send(res,200,{ok:true}); }
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
    if(!validPassword(password)) return send(res,400,{error:'La nueva contraseña debe tener entre 10 y 200 caracteres.'});
    const account=db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id);
    if(!await passwordMatches(currentPassword,account.password_hash)) return send(res,400,{error:'La contraseña actual es incorrecta.'});
    db.exec('BEGIN');
    try { db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await passwordHash(password),user.id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id); db.exec('COMMIT'); }
    catch(error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    res.setHeader('set-cookie',sessionCookie('',0));
    return send(res,200,{ok:true,reauthenticate:true,message:'Contraseña actualizada. Cerramos todas tus sesiones.'});
  }
  const business=businessFor(req,user);
  if(!business) return send(res,403,{error:'No tenés acceso a esta barbería.'});
  const admin=business.role==='admin';
  if(path==='/api/business' && method==='PATCH') {
    if(!admin) return send(res,403,{error:'Solo un administrador puede cambiar estos datos.'});
    const b=await body(req),before=db.prepare('SELECT name,logo FROM businesses WHERE id=?').get(business.id),name=typeof b.name==='string'?b.name.trim():before.name;
    if(!name||name.length>120) return send(res,400,{error:'El nombre del negocio debe tener entre 1 y 120 caracteres.'});
    if(b.logo!==undefined&&!validPhoto(b.logo)) return send(res,400,{error:'El logo no es válido o es demasiado grande.'});
    const after={name,logo:b.logo===undefined?before.logo:(b.logo||null)};
    db.prepare('UPDATE businesses SET name=?,logo=? WHERE id=?').run(after.name,after.logo,business.id);
    audit(business,user,'updated','business',business.id,before,after);
    return send(res,200,{ok:true});
  }
  if(path==='/api/catalog' && method==='GET') return send(res,200,db.prepare(`SELECT id,type,name,price,active,photo FROM catalog WHERE business_id=? ${admin?'':'AND active=1'} ORDER BY active DESC,type,name`).all(business.id));
  if(path==='/api/customers' && method==='GET') return send(res,200,db.prepare(`SELECT c.id,c.full_name,c.phone,c.email,c.profile_photo,MAX(s.created_at) last_operation FROM customers c LEFT JOIN sales s ON s.customer_id=c.id WHERE c.business_id=? GROUP BY c.id ORDER BY c.full_name COLLATE NOCASE`).all(business.id).map(customer=>({...customer,email:customer.email.endsWith('@ritual.internal')?'':customer.email,code:String(customer.id).padStart(5,'0')})));
  if(path==='/api/customers' && method==='POST') {
    const b=await body(req),fullName=String(b.full_name||'').trim(),phone=String(b.phone||'').trim(),email=normalizeEmail(b.email),profilePhoto=b.profile_photo;
    if(!fullName||fullName.length>120||!phone||phone.length>40||(email&&!validEmail(email))) return send(res,400,{error:'Completá nombre y teléfono; si ingresás un email, debe ser válido.'});
    if(profilePhoto!==undefined&&!validPhoto(profilePhoto)) return send(res,400,{error:'La foto de perfil no es válida o es demasiado grande.'});
    const storedEmail=email||`${randomUUID()}@ritual.internal`;
    try { const result=db.prepare('INSERT INTO customers(business_id,full_name,phone,email,profile_photo) VALUES(?,?,?,?,?)').run(business.id,fullName,phone,storedEmail,profilePhoto||null); const id=Number(result.lastInsertRowid),after={full_name:fullName,phone,email,profile_photo:profilePhoto||null}; audit(business,user,'created','customer',id,null,after); return send(res,201,{id,code:String(id).padStart(5,'0'),...after,last_operation:null}); } catch(error) { if(String(error.message).includes('UNIQUE constraint failed: customers.business_id, customers.email')) return send(res,409,{error:'Ya existe un cliente con ese email.'}); throw error; }
  }
  if(path.startsWith('/api/customers/') && method==='PATCH') {
    if(!admin) return send(res,403,{error:'Solo un administrador puede modificar clientes.'});
    const id=Number(path.split('/').pop()),b=await body(req),fullName=String(b.full_name||'').trim(),phone=String(b.phone||'').trim(),email=normalizeEmail(b.email),profilePhoto=b.profile_photo;
    if(!Number.isInteger(id)||id<1||!fullName||fullName.length>120||!phone||phone.length>40||(email&&!validEmail(email))) return send(res,400,{error:'Completá nombre y teléfono; si ingresás un email, debe ser válido.'});
    if(profilePhoto!==undefined&&!validPhoto(profilePhoto)) return send(res,400,{error:'La foto de perfil no es válida o es demasiado grande.'});
    const storedEmail=email||`${randomUUID()}@ritual.internal`;
    const before=db.prepare('SELECT full_name,phone,email,profile_photo FROM customers WHERE id=? AND business_id=?').get(id,business.id);
    if(!before) return send(res,404,{error:'Cliente no encontrado.'});
    try { db.prepare('UPDATE customers SET full_name=?,phone=?,email=?,profile_photo=? WHERE id=? AND business_id=?').run(fullName,phone,storedEmail,profilePhoto||null,id,business.id); audit(business,user,'updated','customer',id,before,{full_name:fullName,phone,email:storedEmail,profile_photo:profilePhoto||null}); return send(res,200,{ok:true}); } catch(error) { if(String(error.message).includes('UNIQUE constraint failed: customers.business_id, customers.email')) return send(res,409,{error:'Ya existe un cliente con ese email.'}); throw error; }
  }
  if(path==='/api/catalog' && method==='POST') {
    if(!admin) return send(res,403,{error:'Solo un administrador puede administrar el catálogo.'});
    const b=await body(req),name=String(b.name||'').trim(),price=Number(b.price),photo=b.photo;
    if(!name||name.length>120||!['service','product'].includes(b.type)||!Number.isSafeInteger(price)||price<0||price>1_000_000_000) return send(res,400,{error:'Revisá nombre, tipo y precio.'});
    if(photo!==undefined&&!validPhoto(photo)) return send(res,400,{error:'La foto no es válida o es demasiado grande.'});
    if(db.prepare('SELECT id FROM catalog WHERE business_id=? AND type=? AND lower(name)=lower(?)').get(business.id,b.type,name)) return send(res,409,{error:'Ya existe un producto o servicio con ese nombre.'});
    const result=db.prepare('INSERT INTO catalog(business_id,type,name,price,photo) VALUES(?,?,?,?,?)').run(business.id,b.type,name,price,photo||null),id=Number(result.lastInsertRowid); audit(business,user,'created','catalog',id,null,{type:b.type,name,price,active:1}); return send(res,201,{id});
  }
  if(path.startsWith('/api/catalog/') && path.endsWith('/history-impact') && method==='GET') {
    if(!admin) return send(res,403,{error:'Solo un administrador puede consultar este impacto.'});
    const id=Number(path.split('/')[3]),start=String(url.searchParams.get('start')||''),end=String(url.searchParams.get('end')||''),isDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value);
    if(!isDate(start)||!isDate(end)||start>end) return send(res,400,{error:'Elegí un período válido.'});
    const item=db.prepare('SELECT id,name,type FROM catalog WHERE id=? AND business_id=?').get(id,business.id);
    if(!item) return send(res,404,{error:'Producto o servicio no encontrado.'});
    const impact=db.prepare(`SELECT COUNT(DISTINCT s.id) sales,COUNT(si.id) items FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE si.catalog_id=? AND s.business_id=? AND date(s.created_at,'-3 hours') BETWEEN ? AND ?`).get(id,business.id,start,end);
    return send(res,200,{...item,sales:Number(impact.sales),items:Number(impact.items),start,end});
  }
  if(path.startsWith('/api/catalog/') && method==='PATCH') {
    if(!admin) return send(res,403,{error:'Solo un administrador puede modificar el catálogo.'});
    const id=Number(path.split('/').pop()),current=db.prepare('SELECT id,type,name,price,active,photo FROM catalog WHERE id=? AND business_id=?').get(id,business.id),b=await body(req),name=String(b.name||'').trim(),price=Number(b.price),active=b.active?1:0,photo=b.photo;
    if(!current) return send(res,404,{error:'Producto o servicio no encontrado.'});
    if(!name||name.length>120||!Number.isSafeInteger(price)||price<0||price>1_000_000_000) return send(res,400,{error:'Revisá nombre y precio.'});
    if(photo!==undefined&&!validPhoto(photo)) return send(res,400,{error:'La foto no es válida o es demasiado grande.'});
    if(db.prepare('SELECT id FROM catalog WHERE business_id=? AND type=? AND lower(name)=lower(?) AND id<>?').get(business.id,current.type,name,id)) return send(res,409,{error:'Ya existe un producto o servicio con ese nombre.'});
    if(b.apply_price_to_history) return send(res,409,{error:'Los precios históricos no se reescriben. Corregí cada venta para conservar su trazabilidad.'});
    const after={...current,name,price,active,photo:photo||null};
    db.prepare('UPDATE catalog SET name=?,price=?,active=?,photo=? WHERE id=? AND business_id=?').run(name,price,active,photo||null,id,business.id); audit(business,user,'updated','catalog',id,current,after); return send(res,200,{ok:true});
  }
  if(path.startsWith('/api/catalog/') && method==='DELETE') {
    if(!admin) return send(res,403,{error:'Solo un administrador puede administrar el catálogo.'});
    const id=Number(path.split('/').pop()),before=db.prepare('SELECT id,type,name,price,active FROM catalog WHERE id=? AND business_id=?').get(id,business.id); if(!before)return send(res,404,{error:'Producto o servicio no encontrado.'}); db.prepare('UPDATE catalog SET active=0 WHERE id=? AND business_id=?').run(id,business.id); audit(business,user,'deactivated','catalog',id,before,{...before,active:0}); return send(res,200,{ok:true});
  }
  if(path==='/api/employees' && method==='GET') {
    const team=db.prepare('SELECT e.id,e.user_id,e.role,u.name,u.email,u.profile_photo FROM employees e JOIN users u ON u.id=e.user_id WHERE e.business_id=? ORDER BY e.role,u.name').all(business.id);
    return send(res,200,team.map(member=>({...member,email:admin||member.user_id===user.id?member.email:null,user_id:undefined})));
  }
  if(path==='/api/employees' && method==='POST') {
    if(!admin) return send(res,403,{error:'Solo un administrador puede gestionar el equipo.'});
    const b=await body(req),email=normalizeEmail(b.email),name=String(b.name||'').trim(),password=String(b.password||''),role=b.role==='admin'?'admin':'employee';
    if(!validEmail(email)) return send(res,400,{error:'Ingresá un email válido.'});
    let target=db.prepare('SELECT id FROM users WHERE email=?').get(email);
    const created=!target;
    try {
      if(!target) {
        if(!name||name.length>100||!validPassword(password)) return send(res,400,{error:'Para crear una cuenta ingresá nombre y una contraseña inicial de al menos 10 caracteres.'});
        target={id:Number(db.prepare('INSERT INTO users(name,email,password_hash) VALUES(?,?,?)').run(name,email,await passwordHash(password)).lastInsertRowid)};
      }
      const membership=db.prepare('INSERT INTO employees(business_id,user_id,role) VALUES(?,?,?)').run(business.id,target.id,role),employeeId=Number(membership.lastInsertRowid);
      audit(business,user,'added','employee',employeeId,null,{user_id:target.id,role});
      return send(res,201,{ok:true,created});
    } catch(error) { if(String(error.message).includes('UNIQUE constraint failed: employees.business_id, employees.user_id')) return send(res,409,{error:'Esa persona ya forma parte del equipo.'}); throw error; }
  }
  if(path.startsWith('/api/employees/') && path.endsWith('/password') && method==='PATCH') {
    return send(res,403,{error:'Por seguridad, cada persona debe cambiar su propia contraseña desde su perfil.'});
  }
  if(path==='/api/sales' && method==='POST') {
    const b=await body(req); const items=Array.isArray(b.items)?b.items:[]; if(!items.length||items.length>100) return send(res,400,{error:'Agregá entre 1 y 100 servicios o productos.'});
    const requestedEmployee=b.employee_id==null||b.employee_id===''?business.employee_id:Number(b.employee_id),employee=db.prepare('SELECT id FROM employees WHERE id=? AND business_id=?').get(admin?requestedEmployee:business.employee_id,business.id); if(!employee) return send(res,400,{error:'Seleccioná un empleado válido.'});
    const customerId=b.customer_id==null||b.customer_id===''?null:Number(b.customer_id); if(customerId!==null&&(!Number.isInteger(customerId)||customerId<1||!db.prepare('SELECT id FROM customers WHERE id=? AND business_id=?').get(customerId,business.id))) return send(res,400,{error:'Seleccioná un cliente válido.'});
    const seen=new Set(),valid=[]; for(const item of items) { const itemId=Number(item.id),catalog=db.prepare('SELECT id,name,type,price FROM catalog WHERE id=? AND business_id=? AND active=1').get(itemId,business.id),qty=Number(item.quantity); if(catalog&&Number.isInteger(qty)&&qty>0&&qty<=1000&&!seen.has(itemId)) { seen.add(itemId); valid.push({...catalog,qty}); } }
    if(valid.length!==items.length) return send(res,400,{error:'Hay productos o cantidades inválidas.'});
    const subtotal=valid.reduce((sum,item)=>sum+item.price*item.qty,0),discount=Number(b.discount||0),paymentMethod=String(b.payment_method||'cash'),notes=String(b.notes||'').trim();
    if(!Number.isSafeInteger(discount)||discount<0||discount>subtotal) return send(res,400,{error:'El descuento debe ser un monto entero, no negativo y no superar el subtotal.'});
    if(!paymentMethods.has(paymentMethod)) return send(res,400,{error:'Seleccioná un medio de pago válido.'});
    if(notes.length>500) return send(res,400,{error:'Las notas pueden tener hasta 500 caracteres.'});
    let saleId;
    try { db.exec('BEGIN'); const sale=db.prepare('INSERT INTO sales(business_id,employee_id,customer,customer_id,created_by_employee_id,payment_method,discount,notes,status) VALUES(?,?,?,?,?,?,?,?,?)').run(business.id,employee.id,null,customerId,business.employee_id,paymentMethod,discount,notes||null,'completed'); saleId=Number(sale.lastInsertRowid); const insert=db.prepare('INSERT INTO sale_items(sale_id,catalog_id,item_name,item_type,quantity,unit_price) VALUES(?,?,?,?,?,?)'); for(const i of valid) insert.run(saleId,i.id,i.name,i.type,i.qty,i.price); audit(business,user,'created','sale',saleId,null,saleSnapshot(saleId,business.id)); db.exec('COMMIT'); } catch(error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    return send(res,201,{id:saleId});
  }
  if(path==='/api/sales' && method==='GET') {
    const sales=db.prepare(`SELECT s.id,s.created_at,s.customer_id,s.payment_method,s.discount,s.status,s.notes,s.void_reason,COALESCE(c.full_name,s.customer,'Sin cliente') customer,u.name employee,MAX(0,COALESCE(SUM(si.quantity*si.unit_price),0)-s.discount) total,GROUP_CONCAT(si.item_name||' ×'||si.quantity,', ') items,((? OR COALESCE(s.created_by_employee_id,s.employee_id)=?) AND s.status='completed') editable FROM sales s JOIN employees e ON e.id=s.employee_id JOIN users u ON u.id=e.user_id LEFT JOIN customers c ON c.id=s.customer_id JOIN sale_items si ON si.sale_id=s.id WHERE s.business_id=? GROUP BY s.id ORDER BY s.created_at DESC`).all(admin?1:0,business.employee_id,business.id);
    return send(res,200,sales);
  }
  if(path.startsWith('/api/sales/') && method==='GET') {
    const id=Number(path.split('/').pop());
    const sale=db.prepare(`SELECT s.id,s.created_at,s.customer_id,s.employee_id,s.payment_method,s.discount,s.notes,s.status,s.void_reason,s.voided_at,COALESCE(c.full_name,s.customer,'Sin cliente') customer,u.name employee,((? OR COALESCE(s.created_by_employee_id,s.employee_id)=?) AND s.status='completed') editable FROM sales s JOIN employees e ON e.id=s.employee_id JOIN users u ON u.id=e.user_id LEFT JOIN customers c ON c.id=s.customer_id WHERE s.id=? AND s.business_id=?`).get(admin?1:0,business.employee_id,id,business.id);
    if(!sale) return send(res,404,{error:'Venta no encontrada.'});
    sale.items=db.prepare('SELECT catalog_id id,item_name name,item_type type,quantity,unit_price price FROM sale_items WHERE sale_id=? ORDER BY id').all(id);
    return send(res,200,sale);
  }
  if(path.startsWith('/api/sales/') && path.endsWith('/void') && method==='POST') {
    const id=Number(path.split('/')[3]),sale=db.prepare('SELECT id,status,COALESCE(created_by_employee_id,employee_id) created_by_employee_id FROM sales WHERE id=? AND business_id=?').get(id,business.id);
    if(!sale) return send(res,404,{error:'Venta no encontrada.'});
    if(!admin&&sale.created_by_employee_id!==business.employee_id) return send(res,403,{error:'Solo quien cargó esta venta o un administrador puede anularla.'});
    if(sale.status==='voided') return send(res,409,{error:'La venta ya está anulada.'});
    const b=await body(req),reason=String(b.reason||'').trim(); if(reason.length<3||reason.length>300) return send(res,400,{error:'Indicá un motivo de anulación de entre 3 y 300 caracteres.'});
    const before=saleSnapshot(id,business.id); db.prepare("UPDATE sales SET status='voided',void_reason=?,voided_at=CURRENT_TIMESTAMP WHERE id=? AND business_id=?").run(reason,id,business.id); audit(business,user,'voided','sale',id,before,saleSnapshot(id,business.id)); return send(res,200,{ok:true});
  }
  if(path.startsWith('/api/sales/') && method==='PATCH') {
    const id=Number(path.split('/').pop()),sale=db.prepare('SELECT id,employee_id,COALESCE(created_by_employee_id,employee_id) created_by_employee_id FROM sales WHERE id=? AND business_id=?').get(id,business.id);
    if(!sale) return send(res,404,{error:'Venta no encontrada.'});
    if(!admin&&sale.created_by_employee_id!==business.employee_id) return send(res,403,{error:'Solo quien cargó esta venta o un administrador puede modificarla.'});
    const status=db.prepare('SELECT status FROM sales WHERE id=?').get(id).status; if(status==='voided') return send(res,409,{error:'Una venta anulada se conserva sin modificaciones.'});
    const b=await body(req),items=Array.isArray(b.items)?b.items:[];
    if(!items.length||items.length>100) return send(res,400,{error:'Agregá entre 1 y 100 servicios o productos.'});
    const requestedEmployee=b.employee_id==null||b.employee_id===''?sale.employee_id:Number(b.employee_id),employee=db.prepare('SELECT id FROM employees WHERE id=? AND business_id=?').get(admin?requestedEmployee:sale.employee_id,business.id);
    const customerId=b.customer_id==null||b.customer_id===''?null:Number(b.customer_id);
    if(!employee) return send(res,400,{error:'Seleccioná un empleado válido.'});
    if(customerId!==null&&(!Number.isInteger(customerId)||customerId<1||!db.prepare('SELECT id FROM customers WHERE id=? AND business_id=?').get(customerId,business.id))) return send(res,400,{error:'Seleccioná un cliente válido.'});
    const previousPrices=new Map(db.prepare('SELECT catalog_id,unit_price FROM sale_items WHERE sale_id=?').all(id).map(item=>[item.catalog_id,item.unit_price]));
    const seen=new Set(),valid=[]; for(const item of items) { const itemId=Number(item.id),catalog=db.prepare('SELECT id,name,type,price FROM catalog WHERE id=? AND business_id=?').get(itemId,business.id),qty=Number(item.quantity); if(catalog&&Number.isInteger(qty)&&qty>0&&qty<=1000&&!seen.has(itemId)) { seen.add(itemId); valid.push({...catalog,price:previousPrices.get(catalog.id)??catalog.price,qty}); } }
    if(valid.length!==items.length) return send(res,400,{error:'Hay productos o cantidades inválidas.'});
    const subtotal=valid.reduce((sum,item)=>sum+item.price*item.qty,0),discount=Number(b.discount||0),paymentMethod=String(b.payment_method||'cash'),notes=String(b.notes||'').trim();
    if(!Number.isSafeInteger(discount)||discount<0||discount>subtotal) return send(res,400,{error:'El descuento debe ser un monto entero, no negativo y no superar el subtotal.'});
    if(!paymentMethods.has(paymentMethod)) return send(res,400,{error:'Seleccioná un medio de pago válido.'});
    if(notes.length>500) return send(res,400,{error:'Las notas pueden tener hasta 500 caracteres.'});
    const before=saleSnapshot(id,business.id);
    try { db.exec('BEGIN'); db.prepare('UPDATE sales SET employee_id=?,customer_id=?,customer=NULL,payment_method=?,discount=?,notes=? WHERE id=? AND business_id=?').run(employee.id,customerId,paymentMethod,discount,notes||null,id,business.id); db.prepare('DELETE FROM sale_items WHERE sale_id=?').run(id); const insert=db.prepare('INSERT INTO sale_items(sale_id,catalog_id,item_name,item_type,quantity,unit_price) VALUES(?,?,?,?,?,?)'); for(const item of valid) insert.run(id,item.id,item.name,item.type,item.qty,item.price); audit(business,user,'updated','sale',id,before,saleSnapshot(id,business.id)); db.exec('COMMIT'); return send(res,200,{ok:true}); } catch(error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }
  if(path==='/api/audit' && method==='GET') {
    if(!admin) return send(res,403,{error:'Solo un administrador puede consultar la auditoría.'});
    const rows=db.prepare(`SELECT a.id,a.action,a.entity_type,a.entity_id,a.before_json,a.after_json,a.created_at,COALESCE(u.name,'Sistema') actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id WHERE a.business_id=? ORDER BY a.id DESC LIMIT 100`).all(business.id);
    return send(res,200,rows.map(row=>({...row,before:row.before_json?JSON.parse(row.before_json):null,after:row.after_json?JSON.parse(row.after_json):null,before_json:undefined,after_json:undefined})));
  }
  if(path==='/api/dashboard' && method==='GET') {
    const today=new Date(Date.now()-3*60*60*1000).toISOString().slice(0,10),first=db.prepare("SELECT MIN(date(created_at,'-3 hours')) date FROM sales WHERE business_id=? AND status='completed'").get(business.id).date||today;
    const isDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||''); let start=isDate(url.searchParams.get('start'))?url.searchParams.get('start'):today,end=isDate(url.searchParams.get('end'))?url.searchParams.get('end'):today;
    if(start<first) start=first; if(end>today) end=today; if(start>end) return send(res,400,{error:'La fecha de inicio debe ser anterior o igual a la fecha final.'});
    const span=Math.round((Date.parse(`${end}T00:00:00Z`)-Date.parse(`${start}T00:00:00Z`))/86400000)+1;
    const summary=db.prepare(`WITH ticket_totals AS (SELECT s.id,MAX(0,SUM(si.quantity*si.unit_price)-s.discount) total,SUM(CASE WHEN si.item_type='service' THEN si.quantity ELSE 0 END) services,SUM(CASE WHEN si.item_type='product' THEN si.quantity ELSE 0 END) products FROM sales s JOIN sale_items si ON si.sale_id=s.id WHERE s.business_id=? AND s.status='completed' AND date(s.created_at,'-3 hours') BETWEEN ? AND ? GROUP BY s.id) SELECT COALESCE(SUM(total),0) revenue,COALESCE(SUM(services),0) services,COALESCE(SUM(products),0) products,COUNT(*) tickets FROM ticket_totals`).get(business.id,start,end);
    const previous=db.prepare(`WITH ticket_totals AS (SELECT s.id,MAX(0,SUM(si.quantity*si.unit_price)-s.discount) total FROM sales s JOIN sale_items si ON si.sale_id=s.id WHERE s.business_id=? AND s.status='completed' AND date(s.created_at,'-3 hours')>=date(?,'-' || ? || ' days') AND date(s.created_at,'-3 hours')<? GROUP BY s.id) SELECT COALESCE(SUM(total),0) revenue,COUNT(*) tickets FROM ticket_totals`).get(business.id,start,span,start);
    const employees=db.prepare(`SELECT u.name,u.profile_photo,COUNT(DISTINCT s.id) tickets,COALESCE(SUM(CASE WHEN si.item_type='service' THEN si.quantity ELSE 0 END),0) services,COALESCE(SUM(CASE WHEN si.item_type='product' THEN si.quantity ELSE 0 END),0) products,(SELECT COALESCE(SUM(total),0) FROM (SELECT MAX(0,SUM(si2.quantity*si2.unit_price)-s2.discount) total FROM sales s2 JOIN sale_items si2 ON si2.sale_id=s2.id WHERE s2.employee_id=e.id AND s2.status='completed' AND date(s2.created_at,'-3 hours') BETWEEN ? AND ? GROUP BY s2.id)) revenue FROM employees e JOIN users u ON u.id=e.user_id LEFT JOIN sales s ON s.employee_id=e.id AND s.status='completed' AND date(s.created_at,'-3 hours') BETWEEN ? AND ? LEFT JOIN sale_items si ON si.sale_id=s.id WHERE e.business_id=? GROUP BY e.id ORDER BY revenue DESC`).all(start,end,start,end,business.id);
    const featured=db.prepare(`SELECT si.item_name name,si.item_type type,SUM(si.quantity) quantity,SUM(si.quantity*si.unit_price) revenue FROM sales s JOIN sale_items si ON si.sale_id=s.id WHERE s.business_id=? AND s.status='completed' AND date(s.created_at,'-3 hours') BETWEEN ? AND ? GROUP BY si.catalog_id ORDER BY revenue DESC`).all(business.id,start,end);
    const recent=db.prepare(`SELECT s.id,COALESCE(c.full_name,s.customer) customer,s.created_at,u.name employee,u.profile_photo,MAX(0,COALESCE(SUM(si.quantity*si.unit_price),0)-s.discount) total,GROUP_CONCAT(si.item_name||' ×'||si.quantity,', ') items FROM sales s JOIN employees e ON e.id=s.employee_id JOIN users u ON u.id=e.user_id LEFT JOIN customers c ON c.id=s.customer_id JOIN sale_items si ON si.sale_id=s.id WHERE s.business_id=? AND s.status='completed' AND date(s.created_at,'-3 hours') BETWEEN ? AND ? GROUP BY s.id ORDER BY s.created_at DESC LIMIT 5`).all(business.id,start,end);
    return send(res,200,{summary,previous,dateRange:{min:first,max:today,start,end},employees,featured:{services:featured.filter(item=>item.type==='service').slice(0,3),products:featured.filter(item=>item.type==='product').slice(0,3)},recent});
  }
  return send(res,404,{error:'No encontrado.'});
}

const server=createServer(async(req,res)=>{
  req.requestId=randomUUID();
  const started=Date.now();
  res.setHeader('x-request-id',req.requestId);
  res.setHeader('x-content-type-options','nosniff');
  res.setHeader('x-frame-options','DENY');
  res.setHeader('referrer-policy','no-referrer');
  res.setHeader('permissions-policy','camera=(self)');
  res.setHeader('content-security-policy',"default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.on('finish',()=>{
    if(req.url.startsWith('/api/')||res.statusCode>=400) {
      const path=new URL(req.url,'http://localhost').pathname;
      log('http_request',{request_id:req.requestId,method:req.method,path,status:res.statusCode,duration_ms:Date.now()-started});
    }
  });
  try {
    if(!allowedOrigin(req)&&['POST','PATCH','PUT','DELETE'].includes(req.method)) return send(res,403,{error:'Origen de solicitud no permitido.'});
    await route(req,res);
  } catch(error) {
    log('request_error',{request_id:req.requestId,method:req.method,path:new URL(req.url,'http://localhost').pathname,error_name:error.name||'Error',error_code:error.code||null,error_message:error.message||String(error),stack:error.stack||null});
    if(!res.headersSent) send(res,error.status||500,{error:error.status?error.message:'Ocurrió un error. Revisá los datos e intentá de nuevo.',request_id:req.requestId}); else res.end();
  }
});
const port=process.env.PORT===undefined?8081:Number(process.env.PORT); server.listen(port,'0.0.0.0',()=>log('server_started',{url:`http://localhost:${server.address().port}`,node:process.version}));
function shutdown() { server.close(()=>{ db.close(); process.exit(0); }); }
process.on('SIGTERM',shutdown);
process.on('SIGINT',shutdown);
