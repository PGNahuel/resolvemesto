import { randomUUID } from 'node:crypto';
import { badRequest, conflict, forbidden, notFound, unauthorized, AppError } from './errors.js';
import { createSessionToken, normalizeEmail, passwordHash, passwordMatches, sessionKey, spendPasswordHashTime, validEmail, validPassword, validPhoto } from './security.js';

const paymentMethods=new Set(['cash','debit','credit','transfer','other']);
const isDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||'');
const uniqueKeys={
  'users.email':'email',
  'customers.business_id, customers.email':'customers_business_email',
  'employees.business_id, employees.user_id':'employees_business_user'
};
const isUnique=(error,target)=>error.code==='ER_DUP_ENTRY'&&String(error.sqlMessage||error.message).includes(uniqueKeys[target]);

export class Service {
  constructor(repository) { this.repository=repository; this.loginAttempts=new Map(); }

  async registerUser(input) {
    const name=String(input.name||'').trim(),email=normalizeEmail(input.email),password=String(input.password||''),profilePhoto=input.profile_photo;
    if(!name||name.length>100||!validEmail(email)||!validPassword(password))throw badRequest('Completá un nombre y email válidos; la contraseña debe tener entre 10 y 200 caracteres.');
    if(profilePhoto!==undefined&&!validPhoto(profilePhoto))throw badRequest('La foto de perfil no es válida o es demasiado grande.');
    try { return {id:await this.repository.createUser({name,email,passwordHash:await passwordHash(password),profilePhoto:profilePhoto||null})}; }
    catch(error) { if(isUnique(error,'users.email'))throw conflict('Ese email ya tiene una cuenta. Iniciá sesión o probá con otro email.'); throw error; }
  }

  async registerAdmin(input) {
    const name=String(input.name||'').trim(),email=normalizeEmail(input.email),password=String(input.password||''),businessName=String(input.business_name||'').trim(),profilePhoto=input.profile_photo;
    if(!name||name.length>100||!validEmail(email)||!validPassword(password)||!businessName||businessName.length>120)throw badRequest('Completá datos válidos y una contraseña de entre 10 y 200 caracteres.');
    if(profilePhoto!==undefined&&!validPhoto(profilePhoto))throw badRequest('La foto de perfil no es válida o es demasiado grande.');
    const hash=await passwordHash(password);
    try {
      return await this.repository.transaction(async()=>{
        const userId=await this.repository.createUser({name,email,passwordHash:hash,profilePhoto:profilePhoto||null});
        const businessId=await this.repository.createBusiness(businessName);
        await this.repository.addEmployee(businessId,userId,'admin');
        return {id:userId};
      });
    } catch(error) { if(isUnique(error,'users.email'))throw conflict('Ese email ya tiene una cuenta. Iniciá sesión o usá otro email.'); throw error; }
  }

  async login(input,clientKey) {
    const email=normalizeEmail(input.email),key=`${clientKey}:${email}`,retryAfter=this.#rateLimitFor(key);
    if(retryAfter)throw new AppError(429,`Demasiados intentos. Probá nuevamente en ${Math.ceil(retryAfter/60)} minutos.`,{'retry-after':String(retryAfter)});
    const user=await this.repository.findUserByEmail(email),password=String(input.password||'');
    const passwordOk=user?await passwordMatches(password,user.password_hash):(await spendPasswordHashTime(password),false);
    if(!user||!passwordOk) { this.#recordLoginFailure(key); throw unauthorized('Email o contraseña incorrectos.'); }
    this.loginAttempts.delete(key);
    if(!user.password_hash.startsWith('scrypt$'))await this.repository.updateUserPassword(user.id,await passwordHash(password));
    const token=createSessionToken();
    await this.repository.createSession(sessionKey(token),user.id,Date.now()+30*86400000);
    return {token,user:{id:user.id,name:user.name,email:user.email}};
  }

  async logout(token) { if(token)await this.repository.deleteSessionsByTokens(sessionKey(token),token); }

  async getSessionUser(token) {
    if(!token)return null;
    const hashed=sessionKey(token),session=await this.repository.findSession(hashed,token,Date.now());
    if(!session) { await this.repository.deleteSessionsByTokens(hashed,token); return null; }
    return await this.repository.getPublicUser(session.user_id);
  }

  async me(user) { return {user,businesses:await this.repository.listUserBusinesses(user.id)}; }

  async updateProfile(user,input) {
    if(!validPhoto(input.profile_photo))throw badRequest('La foto de perfil no es válida o es demasiado grande.');
    const profilePhoto=input.profile_photo||null;
    await this.repository.updateUserPhoto(user.id,profilePhoto);
    return {ok:true,profile_photo:profilePhoto};
  }

  async changePassword(user,input) {
    const currentPassword=String(input.current_password||''),password=String(input.password||'');
    if(!validPassword(password))throw badRequest('La nueva contraseña debe tener entre 10 y 200 caracteres.');
    const account=await this.repository.findUserPassword(user.id);
    if(!account||!await passwordMatches(currentPassword,account.password_hash))throw badRequest('La contraseña actual es incorrecta.');
    const hash=await passwordHash(password);
    await this.repository.transaction(async()=>{ await this.repository.updateUserPassword(user.id,hash); await this.repository.deleteSessionsByUser(user.id); });
    return {ok:true,reauthenticate:true,message:'Contraseña actualizada. Cerramos todas tus sesiones.'};
  }

  async authorizeBusiness(user,businessId) {
    const business=Number.isInteger(businessId)&&businessId>0?await this.repository.findBusinessMembership(businessId,user.id):null;
    if(!business)throw forbidden('No tenés acceso a este negocio.');
    return business;
  }

  async updateBusiness(context,input) {
    this.#requireAdmin(context,'Solo un administrador puede cambiar estos datos.');
    const before=await this.repository.getBusinessData(context.business.id),name=typeof input.name==='string'?input.name.trim():before.name;
    if(!name||name.length>120)throw badRequest('El nombre del negocio debe tener entre 1 y 120 caracteres.');
    if(input.logo!==undefined&&!validPhoto(input.logo))throw badRequest('El logo no es válido o es demasiado grande.');
    const after={name,logo:input.logo===undefined?before.logo:(input.logo||null)};
    await this.repository.transaction(async()=>{ await this.repository.updateBusiness(context.business.id,after); await this.#audit(context,'updated','business',context.business.id,before,after); });
    return {ok:true};
  }

  async listCustomers(context) {
    return (await this.repository.listCustomers(context.business.id)).map(customer=>({...customer,email:/@(ritual|resolvemesto)\.internal$/.test(customer.email)?'':customer.email,code:String(customer.id).padStart(5,'0')}));
  }

  async createCustomer(context,input) {
    const customer=this.#customerInput(input),storedEmail=customer.email||`${randomUUID()}@resolvemesto.internal`;
    try {
      return await this.repository.transaction(async()=>{
        const id=await this.repository.createCustomer(context.business.id,{...customer,email:storedEmail});
        const after={full_name:customer.fullName,phone:customer.phone,email:customer.email,profile_photo:customer.profilePhoto};
        await this.#audit(context,'created','customer',id,null,after);
        return {id,code:String(id).padStart(5,'0'),...after,last_operation:null};
      });
    } catch(error) { if(isUnique(error,'customers.business_id, customers.email'))throw conflict('Ya existe un cliente con ese email.'); throw error; }
  }

  async updateCustomer(context,customerId,input) {
    this.#requireAdmin(context,'Solo un administrador puede modificar clientes.');
    if(!Number.isInteger(customerId)||customerId<1)throw badRequest('Completá nombre y teléfono; si ingresás un email, debe ser válido.');
    const customer=this.#customerInput(input),before=await this.repository.getCustomer(customerId,context.business.id);
    if(!before)throw notFound('Cliente no encontrado.');
    const storedEmail=customer.email||`${randomUUID()}@resolvemesto.internal`,after={full_name:customer.fullName,phone:customer.phone,email:storedEmail,profile_photo:customer.profilePhoto};
    try { await this.repository.transaction(async()=>{ await this.repository.updateCustomer(customerId,context.business.id,{...customer,email:storedEmail}); await this.#audit(context,'updated','customer',customerId,before,after); }); return {ok:true}; }
    catch(error) { if(isUnique(error,'customers.business_id, customers.email'))throw conflict('Ya existe un cliente con ese email.'); throw error; }
  }

  async listCatalog(context) { return await this.repository.listCatalog(context.business.id,context.business.role==='admin'); }

  async createCatalogItem(context,input) {
    this.#requireAdmin(context,'Solo un administrador puede administrar el catálogo.');
    const item=this.#catalogInput(input,true);
    if(await this.repository.findCatalogDuplicate(context.business.id,item.type,item.name))throw conflict('Ya existe un producto o servicio con ese nombre.');
    return await this.repository.transaction(async()=>{ const id=await this.repository.createCatalogItem(context.business.id,item); await this.#audit(context,'created','catalog',id,null,{type:item.type,name:item.name,price:item.price,active:1}); return {id}; });
  }

  async catalogHistoryImpact(context,itemId,start,end) {
    this.#requireAdmin(context,'Solo un administrador puede consultar este impacto.');
    if(!isDate(start)||!isDate(end)||start>end)throw badRequest('Elegí un período válido.');
    const item=await this.repository.getCatalogItem(itemId,context.business.id);
    if(!item)throw notFound('Producto o servicio no encontrado.');
    const impact=await this.repository.catalogHistoryImpact(itemId,context.business.id,start,end);
    return {id:item.id,name:item.name,type:item.type,sales:Number(impact.sales),items:Number(impact.items),start,end};
  }

  async updateCatalogItem(context,itemId,input) {
    this.#requireAdmin(context,'Solo un administrador puede modificar el catálogo.');
    const current=await this.repository.getCatalogItem(itemId,context.business.id);
    if(!current)throw notFound('Producto o servicio no encontrado.');
    const item=this.#catalogInput({...input,type:current.type},false);
    if(await this.repository.findCatalogDuplicate(context.business.id,current.type,item.name,itemId))throw conflict('Ya existe un producto o servicio con ese nombre.');
    if(input.apply_price_to_history)throw conflict('Los precios históricos no se reescriben. Corregí cada venta para conservar su trazabilidad.');
    const after={...current,name:item.name,price:item.price,active:item.active,photo:item.photo};
    await this.repository.transaction(async()=>{ await this.repository.updateCatalogItem(itemId,context.business.id,item); await this.#audit(context,'updated','catalog',itemId,current,after); });
    return {ok:true};
  }

  async deactivateCatalogItem(context,itemId) {
    this.#requireAdmin(context,'Solo un administrador puede administrar el catálogo.');
    const before=await this.repository.getCatalogItem(itemId,context.business.id);
    if(!before)throw notFound('Producto o servicio no encontrado.');
    await this.repository.transaction(async()=>{ await this.repository.deactivateCatalogItem(itemId,context.business.id); await this.#audit(context,'deactivated','catalog',itemId,before,{...before,active:0}); });
    return {ok:true};
  }

  async listEmployees(context) {
    const admin=context.business.role==='admin';
    return (await this.repository.listEmployees(context.business.id)).map(member=>({...member,email:admin||member.user_id===context.user.id?member.email:null,user_id:undefined}));
  }

  async addEmployee(context,input) {
    this.#requireAdmin(context,'Solo un administrador puede gestionar el equipo.');
    const email=normalizeEmail(input.email),name=String(input.name||'').trim(),password=String(input.password||''),role=input.role==='admin'?'admin':'employee';
    if(!validEmail(email))throw badRequest('Ingresá un email válido.');
    let target=await this.repository.findUserByEmail(email); const created=!target;
    let hash;
    if(created) {
      if(!name||name.length>100||!validPassword(password))throw badRequest('Para crear una cuenta ingresá nombre y una contraseña inicial de al menos 10 caracteres.');
      hash=await passwordHash(password);
    }
    try {
      return await this.repository.transaction(async()=>{ if(created)target={id:await this.repository.createUser({name,email,passwordHash:hash})}; const employeeId=await this.repository.addEmployee(context.business.id,target.id,role); await this.#audit(context,'added','employee',employeeId,null,{user_id:target.id,role}); return {ok:true,created}; });
    } catch(error) { if(isUnique(error,'employees.business_id, employees.user_id'))throw conflict('Esa persona ya forma parte del equipo.'); throw error; }
  }

  rejectEmployeePasswordReset() { throw forbidden('Por seguridad, cada persona debe cambiar su propia contraseña desde su perfil.'); }

  async createSale(context,input) {
    const prepared=await this.#prepareSale(context,input,{activeOnly:true,defaultEmployeeId:context.business.employee_id});
    return await this.repository.transaction(async()=>{
      const saleId=await this.repository.createSale({businessId:context.business.id,employeeId:prepared.employee.id,customerId:prepared.customerId,createdByEmployeeId:context.business.employee_id,paymentMethod:prepared.paymentMethod,discount:prepared.discount,notes:prepared.notes||null});
      await this.repository.insertSaleItems(saleId,prepared.items);
      await this.#audit(context,'created','sale',saleId,null,await this.repository.saleSnapshot(saleId,context.business.id));
      return {id:saleId};
    });
  }

  async listSales(context) { return await this.repository.listSales(context.business.id,context.business.role==='admin',context.business.employee_id); }

  async getSale(context,saleId) {
    const sale=await this.repository.getSale(saleId,context.business.id,context.business.role==='admin',context.business.employee_id);
    if(!sale)throw notFound('Venta no encontrada.');
    return sale;
  }

  async voidSale(context,saleId,input) {
    const sale=await this.#editableSale(context,saleId,'anularla');
    if(sale.status==='voided')throw conflict('La venta ya está anulada.');
    const reason=String(input.reason||'').trim();
    if(reason.length<3||reason.length>300)throw badRequest('Indicá un motivo de anulación de entre 3 y 300 caracteres.');
    const before=await this.repository.saleSnapshot(saleId,context.business.id);
    await this.repository.transaction(async()=>{ await this.repository.voidSale(saleId,context.business.id,reason); await this.#audit(context,'voided','sale',saleId,before,await this.repository.saleSnapshot(saleId,context.business.id)); });
    return {ok:true};
  }

  async updateSale(context,saleId,input) {
    const sale=await this.#editableSale(context,saleId,'modificarla');
    if(sale.status==='voided')throw conflict('Una venta anulada se conserva sin modificaciones.');
    const previousPrices=new Map((await this.repository.salePrices(saleId)).map(item=>[item.catalog_id,item.unit_price]));
    const prepared=await this.#prepareSale(context,input,{activeOnly:false,defaultEmployeeId:sale.employee_id,previousPrices});
    const before=await this.repository.saleSnapshot(saleId,context.business.id);
    await this.repository.transaction(async()=>{ await this.repository.updateSale(saleId,context.business.id,{employeeId:prepared.employee.id,customerId:prepared.customerId,paymentMethod:prepared.paymentMethod,discount:prepared.discount,notes:prepared.notes||null}); await this.repository.replaceSaleItems(saleId,prepared.items); await this.#audit(context,'updated','sale',saleId,before,await this.repository.saleSnapshot(saleId,context.business.id)); });
    return {ok:true};
  }

  async listAudit(context) {
    this.#requireAdmin(context,'Solo un administrador puede consultar la auditoría.');
    return (await this.repository.listAudit(context.business.id)).map(row=>({...row,before:row.before_json?JSON.parse(row.before_json):null,after:row.after_json?JSON.parse(row.after_json):null,before_json:undefined,after_json:undefined}));
  }

  async dashboard(context,startParam,endParam) {
    const isAdmin=context.business.role==='admin',employeeId=isAdmin?null:context.business.employee_id;
    const today=new Date(Date.now()-3*60*60*1000).toISOString().slice(0,10),first=await this.repository.firstSaleDate(context.business.id,employeeId)||today;
    let start=isDate(startParam)?startParam:today,end=isDate(endParam)?endParam:today;
    if(start<first)start=first; if(end>today)end=today;
    if(start>end)throw badRequest('La fecha de inicio debe ser anterior o igual a la fecha final.');
    const span=Math.round((Date.parse(`${end}T00:00:00Z`)-Date.parse(`${start}T00:00:00Z`))/86400000)+1;
    const summary=await this.repository.dashboardSummary(context.business.id,start,end,employeeId),previous=await this.repository.dashboardPrevious(context.business.id,start,span,employeeId),employees=isAdmin?await this.repository.dashboardEmployees(context.business.id,start,end):[],featured=await this.repository.dashboardFeatured(context.business.id,start,end,employeeId),recent=await this.repository.dashboardRecent(context.business.id,start,end,employeeId);
    return {scope:isAdmin?'business':'personal',summary,previous,dateRange:{min:first,max:today,start,end},employees,featured:{services:featured.filter(item=>item.type==='service').slice(0,3),products:featured.filter(item=>item.type==='product').slice(0,3)},recent};
  }

  #customerInput(input) {
    const fullName=String(input.full_name||'').trim(),phone=String(input.phone||'').trim(),email=normalizeEmail(input.email),profilePhoto=input.profile_photo||null;
    if(!fullName||fullName.length>120||!phone||phone.length>40||(email&&!validEmail(email)))throw badRequest('Completá nombre y teléfono; si ingresás un email, debe ser válido.');
    if(input.profile_photo!==undefined&&!validPhoto(input.profile_photo))throw badRequest('La foto de perfil no es válida o es demasiado grande.');
    return {fullName,phone,email,profilePhoto};
  }

  #catalogInput(input,withType) {
    const name=String(input.name||'').trim(),price=Number(input.price),photo=input.photo||null,type=input.type,active=input.active?1:0;
    if(!name||name.length>120||withType&&!['service','product'].includes(type)||!Number.isSafeInteger(price)||price<0||price>1_000_000_000)throw badRequest(withType?'Revisá nombre, tipo y precio.':'Revisá nombre y precio.');
    if(input.photo!==undefined&&!validPhoto(input.photo))throw badRequest('La foto no es válida o es demasiado grande.');
    return {type,name,price,photo,active:withType?1:active};
  }

  async #prepareSale(context,input,{activeOnly,defaultEmployeeId,previousPrices=new Map()}) {
    const sourceItems=Array.isArray(input.items)?input.items:[];
    if(!sourceItems.length||sourceItems.length>100)throw badRequest('Agregá entre 1 y 100 servicios o productos.');
    const requestedEmployee=input.employee_id==null||input.employee_id===''?defaultEmployeeId:Number(input.employee_id),employeeId=context.business.role==='admin'?requestedEmployee:defaultEmployeeId;
    const employee=await this.repository.findEmployee(employeeId,context.business.id);
    if(!employee)throw badRequest('Seleccioná un empleado válido.');
    const customerId=input.customer_id==null||input.customer_id===''?null:Number(input.customer_id);
    if(customerId!==null&&(!Number.isInteger(customerId)||customerId<1||!await this.repository.findCustomer(customerId,context.business.id)))throw badRequest('Seleccioná un cliente válido.');
    const seen=new Set(),items=[];
    for(const source of sourceItems) {
      const itemId=Number(source.id),item=await this.repository.findCatalogItem(itemId,context.business.id,{activeOnly}),qty=Number(source.quantity);
      if(item&&Number.isInteger(qty)&&qty>0&&qty<=1000&&!seen.has(itemId)) { seen.add(itemId); items.push({...item,price:previousPrices.get(item.id)??item.price,qty}); }
    }
    if(items.length!==sourceItems.length)throw badRequest('Hay productos o cantidades inválidas.');
    const subtotal=items.reduce((sum,item)=>sum+item.price*item.qty,0),discount=Number(input.discount||0),paymentMethod=String(input.payment_method||'cash'),notes=String(input.notes||'').trim();
    if(!Number.isSafeInteger(discount)||discount<0||discount>subtotal)throw badRequest('El descuento debe ser un monto entero, no negativo y no superar el subtotal.');
    if(!paymentMethods.has(paymentMethod))throw badRequest('Seleccioná un medio de pago válido.');
    if(notes.length>500)throw badRequest('Las notas pueden tener hasta 500 caracteres.');
    return {employee,customerId,items,discount,paymentMethod,notes};
  }

  async #editableSale(context,saleId,verb) {
    const sale=await this.repository.findSaleOwner(saleId,context.business.id);
    if(!sale)throw notFound('Venta no encontrada.');
    if(context.business.role!=='admin'&&sale.created_by_employee_id!==context.business.employee_id)throw forbidden(`Solo quien cargó esta venta o un administrador puede ${verb}.`);
    return sale;
  }

  #requireAdmin(context,message) { if(context.business.role!=='admin')throw forbidden(message); }
  async #audit(context,action,entityType,entityId,before,after) { await this.repository.addAudit({businessId:context.business.id,actorUserId:context.user.id,actorEmployeeId:context.business.employee_id,action,entityType,entityId,before,after}); }
  #rateLimitFor(key) { const now=Date.now(),attempt=this.loginAttempts.get(key); if(!attempt||attempt.resetAt<=now) { this.loginAttempts.delete(key); return 0; } return attempt.count>=5?Math.ceil((attempt.resetAt-now)/1000):0; }
  #recordLoginFailure(key) { const now=Date.now(),current=this.loginAttempts.get(key); this.loginAttempts.set(key,!current||current.resetAt<=now?{count:1,resetAt:now+15*60_000}:{...current,count:current.count+1}); if(this.loginAttempts.size>10_000) { for(const [attemptKey,attempt] of this.loginAttempts)if(attempt.resetAt<=now)this.loginAttempts.delete(attemptKey); if(this.loginAttempts.size>10_000)this.loginAttempts.delete(this.loginAttempts.keys().next().value); } }
}
