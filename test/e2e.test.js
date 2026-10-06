import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot=resolve(import.meta.dirname,'..');

async function startServer() {
  const directory=await mkdtemp(join(tmpdir(),'ritual-e2e-'));
  const child=spawn(process.execPath,['server.js'],{cwd:projectRoot,env:{...process.env,PORT:'0',DB_PATH:join(directory,'test.sqlite')},stdio:['ignore','pipe','pipe']});
  const url=await new Promise((resolveUrl,reject)=>{
    let output='';
    const timer=setTimeout(()=>reject(new Error(`El servidor no inició. ${output}`)),10_000);
    child.stdout.on('data',chunk=>{ output+=chunk; for(const line of output.split('\n')) { try { const event=JSON.parse(line); if(event.event==='server_started') { clearTimeout(timer); resolveUrl(event.url); } } catch {} } });
    child.stderr.on('data',chunk=>{ output+=chunk; });
    child.once('exit',code=>{ clearTimeout(timer); reject(new Error(`El servidor terminó con código ${code}. ${output}`)); });
  });
  return {url,directory,child};
}

function client(baseUrl) {
  let cookie='';
  return {
    get cookie() { return cookie; },
    async request(path,{method='GET',body,businessId,headers={}}={}) {
      const response=await fetch(baseUrl+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...(businessId?{'x-business-id':String(businessId)}:{}),...headers},body:body?JSON.stringify(body):undefined});
      const setCookie=response.headers.get('set-cookie'); if(setCookie)cookie=setCookie.split(';')[0];
      const data=await response.json(); return {status:response.status,data,headers:response.headers};
    }
  };
}

async function registerAdmin(api,{name,email,password,business}) {
  const registered=await api.request('/api/admin/register',{method:'POST',body:{name,email,password,business_name:business}}); assert.equal(registered.status,201);
  const logged=await api.request('/api/login',{method:'POST',body:{email,password}}); assert.equal(logged.status,200);
  const me=await api.request('/api/me'); assert.equal(me.status,200);
  return me.data.businesses[0];
}

test('flujos críticos, permisos, trazabilidad y aislamiento entre negocios',async t=>{
  const server=await startServer();
  t.after(async()=>{ server.child.kill('SIGTERM'); await new Promise(resolve=>server.child.once('exit',resolve)); await rm(server.directory,{recursive:true,force:true}); });
  const admin=client(server.url),employee=client(server.url),otherAdmin=client(server.url);
  const adminPassword='AdminSeguro!2026',employeePassword='Empleado!2026';
  const business=await registerAdmin(admin,{name:'Ana Admin',email:' Admin@Example.com ',password:adminPassword,business:'Barbería Uno'});

  const duplicate=await employee.request('/api/register',{method:'POST',body:{name:'Duplicada',email:'ADMIN@example.COM',password:'OtraClave!2026'}});
  assert.equal(duplicate.status,409,'el email debe ser único y normalizado');

  assert.equal((await employee.request('/api/register',{method:'POST',body:{name:'Eva Empleada',email:'eva@example.com',password:employeePassword}})).status,201);
  assert.equal((await employee.request('/api/login',{method:'POST',body:{email:'EVA@EXAMPLE.COM',password:employeePassword}})).status,200);
  assert.deepEqual((await employee.request('/api/me')).data.businesses,[],'la cuenta independiente empieza sin negocio');
  assert.equal((await admin.request('/api/employees',{method:'POST',businessId:business.id,body:{email:' eva@example.com ',role:'employee'}})).status,201);
  const employeeMe=await employee.request('/api/me'),employeeBusiness=employeeMe.data.businesses[0];
  assert.equal(employeeBusiness.id,business.id,'la cuenta existente queda vinculada');

  const teamForEmployee=await employee.request('/api/employees',{businessId:business.id});
  assert.equal(teamForEmployee.status,200);
  assert.equal(teamForEmployee.data.find(member=>member.id===business.employee_id).email,null,'un empleado no ve el email ajeno');
  assert.equal(teamForEmployee.data.find(member=>member.id===employeeBusiness.employee_id).email,'eva@example.com');

  assert.equal((await employee.request('/api/catalog',{method:'POST',businessId:business.id,body:{name:'Ataque',type:'service',price:1}})).status,403);
  assert.equal((await employee.request('/api/employees',{method:'POST',businessId:business.id,body:{email:'intruso@example.com'}})).status,403);

  const catalogCreated=await admin.request('/api/catalog',{method:'POST',businessId:business.id,body:{name:'Corte',type:'service',price:10000}});
  assert.equal(catalogCreated.status,201); const catalogId=catalogCreated.data.id;
  const adminSale=await admin.request('/api/sales',{method:'POST',businessId:business.id,body:{employee_id:business.employee_id,payment_method:'transfer',discount:1000,notes:'Seña acreditada',items:[{id:catalogId,quantity:1}]}});
  assert.equal(adminSale.status,201);
  assert.equal((await employee.request(`/api/sales/${adminSale.data.id}`,{method:'PATCH',businessId:business.id,body:{payment_method:'cash',discount:0,items:[{id:catalogId,quantity:1}]}})).status,403,'un empleado no modifica una venta ajena');
  assert.equal((await admin.request(`/api/catalog/${catalogId}`,{method:'PATCH',businessId:business.id,body:{name:'Corte',price:12000,active:true}})).status,200);
  const historicalSale=await admin.request(`/api/sales/${adminSale.data.id}`,{businessId:business.id});
  assert.equal(Number(historicalSale.data.items[0].price),10000,'editar el catálogo no reescribe el precio histórico');

  const ownSale=await employee.request('/api/sales',{method:'POST',businessId:business.id,body:{employee_id:business.employee_id,payment_method:'debit',discount:500,notes:'Cliente frecuente',items:[{id:catalogId,quantity:2}]}});
  assert.equal(ownSale.status,201);
  assert.equal((await employee.request(`/api/sales/${ownSale.data.id}`,{method:'PATCH',businessId:business.id,body:{payment_method:'cash',discount:1000,notes:'Corrección de cobro',items:[{id:catalogId,quantity:2}]}})).status,200);
  const ownDetail=await employee.request(`/api/sales/${ownSale.data.id}`,{businessId:business.id});
  assert.equal(ownDetail.data.payment_method,'cash'); assert.equal(ownDetail.data.discount,1000);

  const audit=await admin.request('/api/audit',{businessId:business.id});
  assert.equal(audit.status,200); assert.ok(audit.data.some(entry=>entry.entity_type==='sale'&&entry.entity_id===ownSale.data.id&&entry.action==='updated'));
  assert.equal((await employee.request('/api/audit',{businessId:business.id})).status,403);

  assert.equal((await employee.request(`/api/sales/${ownSale.data.id}/void`,{method:'POST',businessId:business.id,body:{reason:'Carga duplicada'}})).status,200);
  const dashboard=await admin.request('/api/dashboard',{businessId:business.id});
  assert.equal(Number(dashboard.data.summary.tickets),1,'una venta anulada no integra el tablero');
  assert.equal(Number(dashboard.data.summary.revenue),9000,'el descuento se resta de la facturación');

  const secondBusiness=await registerAdmin(otherAdmin,{name:'Oscar Admin',email:'oscar@example.com',password:'OscarSeguro!2026',business:'Barbería Dos'});
  assert.equal((await admin.request('/api/catalog',{businessId:secondBusiness.id})).status,403,'una sesión no accede a otro negocio cambiando el header');
  const foreignCatalog=await otherAdmin.request('/api/catalog',{method:'POST',businessId:secondBusiness.id,body:{name:'Color',type:'service',price:20000}});
  assert.equal((await admin.request('/api/sales',{method:'POST',businessId:business.id,body:{items:[{id:foreignCatalog.data.id,quantity:1}]}})).status,400,'no se pueden cruzar ítems entre negocios');

  const secondSession=client(server.url); assert.equal((await secondSession.request('/api/login',{method:'POST',body:{email:'admin@example.com',password:adminPassword}})).status,200);
  assert.equal((await admin.request('/api/password',{method:'PATCH',body:{current_password:adminPassword,password:'ClaveNueva!2026'}})).status,200);
  assert.equal((await admin.request('/api/me')).status,401,'la sesión que cambió la contraseña se invalida');
  assert.equal((await secondSession.request('/api/me')).status,401,'las demás sesiones también se invalidan');

  const attacker=client(server.url);
  for(let index=0;index<5;index++)assert.equal((await attacker.request('/api/login',{method:'POST',body:{email:'eva@example.com',password:'incorrecta'}})).status,401);
  const limited=await attacker.request('/api/login',{method:'POST',body:{email:'eva@example.com',password:'incorrecta'}});
  assert.equal(limited.status,429); assert.ok(Number(limited.headers.get('retry-after'))>0);
});

test('rutas CRUD conservan sus contratos después de separar las capas',async t=>{
  const server=await startServer();
  t.after(async()=>{ server.child.kill('SIGTERM'); await new Promise(resolve=>server.child.once('exit',resolve)); await rm(server.directory,{recursive:true,force:true}); });
  const page=await fetch(server.url+'/'); assert.equal(page.status,200); assert.match(await page.text(),/<title>Ritual/);
  const admin=client(server.url),business=await registerAdmin(admin,{name:'Admin CRUD',email:'crud@example.com',password:'CrudSeguro!2026',business:'Nombre inicial'});

  assert.equal((await admin.request('/api/business',{method:'PATCH',businessId:business.id,body:{name:'Nombre actualizado',logo:''}})).status,200);
  assert.equal((await admin.request('/api/me')).data.businesses[0].name,'Nombre actualizado');
  assert.equal((await admin.request('/api/profile',{method:'PATCH',body:{profile_photo:''}})).status,200);

  const customer=await admin.request('/api/customers',{method:'POST',businessId:business.id,body:{full_name:'Cliente Uno',phone:'11 5555 5555',email:'cliente@example.com',profile_photo:''}});
  assert.equal(customer.status,201);
  assert.equal((await admin.request(`/api/customers/${customer.data.id}`,{method:'PATCH',businessId:business.id,body:{full_name:'Cliente Editado',phone:'11 4444 4444',email:'cliente@example.com',profile_photo:''}})).status,200);
  assert.equal((await admin.request('/api/customers',{businessId:business.id})).data[0].full_name,'Cliente Editado');

  const item=await admin.request('/api/catalog',{method:'POST',businessId:business.id,body:{name:'Barba',type:'service',price:7000}});
  assert.equal(item.status,201);
  assert.equal((await admin.request(`/api/catalog/${item.data.id}`,{method:'DELETE',businessId:business.id})).status,200);
  const catalog=await admin.request('/api/catalog',{businessId:business.id});
  assert.equal(catalog.data.find(entry=>entry.id===item.data.id).active,0);
  assert.equal((await admin.request(`/api/employees/${business.employee_id}/password`,{method:'PATCH',businessId:business.id,body:{password:'NoPermitida!2026'}})).status,403);
});
