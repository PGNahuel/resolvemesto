const $ = (selector, root=document) => root.querySelector(selector);
const $$ = (selector, root=document) => [...root.querySelectorAll(selector)];
const money = value => new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',maximumFractionDigits:0}).format(Number(value)||0);
const defaultProfileImage='/profile-placeholder.svg';
let me=null, business=null, catalog=[], customers=[], employees=[], cart=[], authMode='login', toastTimer, selectNewCustomer=false;
const adminRegistration=location.pathname==='/new/admin';

async function api(path, options={}) {
  const headers={'content-type':'application/json',...(options.headers||{})};
  if(business) headers['x-business-id']=business.id;
  const response=await fetch(path,{...options,headers});
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(data.error||'No se pudo completar la acción.');
  return data;
}
function toast(message) { const el=$('#toast'); el.textContent=message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('show'),3000); }
function show(id) { ['auth','waiting','app'].forEach(name=>$('#'+name).classList.toggle('hidden',name!==id)); }
function initials(name) { return String(name||'').trim().slice(0,1).toUpperCase()||'·'; }
function setPhoto(element, photo, fallback='+') { element.replaceChildren(); if(photo) { const image=document.createElement('img'); image.src=photo; image.alt='Foto de perfil'; element.append(image); } else element.textContent=fallback; }
function setAuthMode(mode) {
  authMode=mode; const registering=mode==='register'||mode==='admin-register';
  $$('.tab').forEach(tab=>tab.classList.toggle('active',tab.dataset.auth===mode));
  $('#name-field').classList.toggle('hidden',!registering); $('#auth-photo-field').classList.toggle('hidden',!registering); $('#business-name-field').classList.toggle('hidden',mode!=='admin-register');
  $('#auth-submit').textContent=registering?(mode==='admin-register'?'Crear negocio y cuenta':'Crear usuario'):'Ingresar';
}
function selectBusiness(next) { business=next; localStorage.setItem('ritual-business',String(next.id)); $('#top-name').textContent=next.name; $('#top-role').textContent=next.role==='admin'?'Administración':'Equipo'; $('#brand-name').value=next.name; $('#business-picker').innerHTML=''; }
async function start() {
  try { const data=await api('/api/me'); me=data.user; $('#profile-name').textContent=me.name; $('#profile-email').textContent=me.email; setPhoto($('#avatar'),me.profile_photo,initials(me.name));
    if(!data.businesses.length) { show('waiting'); return; }
    const saved=localStorage.getItem('ritual-business'); selectBusiness(data.businesses.find(x=>String(x.id)===saved)||data.businesses[0]);
    if(data.businesses.length>1) { const pick=document.createElement('select'); pick.className='business-select'; pick.setAttribute('aria-label','Elegir espacio'); data.businesses.forEach(item=>{const option=document.createElement('option');option.value=item.id;option.textContent=item.name;option.selected=item.id===business.id;pick.append(option)}); pick.addEventListener('change',()=>{selectBusiness(data.businesses.find(x=>String(x.id)===pick.value));startApp()}); $('#business-picker').append(pick); }
    show('app'); await startApp();
  } catch { show('auth'); }
}
async function startApp() { await Promise.all([loadDashboard(),loadCatalog(),loadCustomers(),loadEmployees()]); updateBrand(); }
function updateBrand() {
  const logo=business?.logo;
  $('#logo-preview').innerHTML=logo?`<img alt="Logo" src="${logo}">`:'✦';
  $('#brand-logo-preview').innerHTML=logo?`<img alt="Logo actual" src="${logo}">`:'✦';
}
async function loadDashboard() {
  const data=await api('/api/dashboard?period='+$('#period').value),s=data.summary;
  $('#stat-revenue').textContent=money(s.revenue); $('#stat-services').textContent=s.services; $('#stat-products').textContent=s.products; $('#stat-tickets').textContent=s.tickets;
  $('#employee-stats').innerHTML=data.employees.length?data.employees.map(e=>`<div class="employee-row"><img class="activity-avatar" src="${escapeHtml(e.profile_photo||defaultProfileImage)}" alt="Foto de ${escapeHtml(e.name)}"><div class="employee-info"><strong>${escapeHtml(e.name)}</strong><small>${e.operations} ítem${Number(e.operations)===1?'':'s'} registrado${Number(e.operations)===1?'':'s'}</small></div><span class="employee-count">${money(e.revenue)}</span></div>`).join(''):'<div class="empty-state">Todavía no hay actividad en este período.</div>';
  $('#popular-list').innerHTML=data.popular.length?data.popular.map(item=>`<div class="popular-row"><div class="popular-bullet"></div><div><strong>${escapeHtml(item.name)}</strong><small>${item.type==='service'?'Servicio':'Producto'}</small></div><b>${item.quantity}×</b></div>`).join(''):'<div class="empty-state">Lo más pedido aparecerá acá.</div>';
  $('#recent-list').innerHTML=data.recent.length?data.recent.map(item=>`<div class="sale-row"><div><strong>${escapeHtml(item.customer||'Sin cliente')}</strong><small>${escapeHtml(item.items||'')}</small></div><span class="recent-employee"><img class="activity-avatar" src="${escapeHtml(item.profile_photo||defaultProfileImage)}" alt="Foto de ${escapeHtml(item.employee)}">${escapeHtml(item.employee)}</span><span class="when">${new Date(item.created_at+'Z').toLocaleString('es-AR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</span><span class="total">${money(item.total)}</span></div>`).join(''):'<div class="empty-state">Las operaciones recientes aparecerán acá.</div>';
}
async function loadCatalog() {
  catalog=await api('/api/catalog');
  $('#item-picker').innerHTML='<option value="">Elegir servicio o producto…</option>'+catalog.map(item=>`<option value="${item.id}">${escapeHtml(item.name)} · ${item.type==='service'?'Servicio':'Producto'} · ${money(item.price)}</option>`).join('');
  $('#catalog-list').innerHTML=catalog.length?catalog.map(item=>`<div class="catalog-item"><div class="item-symbol">${item.type==='service'?'✂':'▧'}</div><div class="catalog-info"><strong>${escapeHtml(item.name)}</strong><small>${item.type==='service'?'Servicio':'Producto'}</small></div><span class="item-price">${money(item.price)}</span>${business.role==='admin'?`<button class="delete-button" data-delete-catalog="${item.id}" title="Quitar del catálogo">×</button>`:''}</div>`).join(''):'<div class="empty-state">Agregá el primer servicio o producto.</div>';
}
function formatOperationDate(value) { return value ? new Date(value+'Z').toLocaleDateString('es-AR',{day:'2-digit',month:'short',year:'numeric'}) : 'Sin operaciones'; }
async function loadCustomers() {
  customers=await api('/api/customers');
  $('#sale-customer').innerHTML='<option value="">Sin cliente</option>'+customers.map(customer=>`<option value="${customer.id}">${escapeHtml(customer.full_name)} · #${customer.code}</option>`).join('');
  const admin=business.role==='admin';
  $('#customers-list').innerHTML=customers.length?customers.map(customer=>`<div class="customer-row"><div class="customer-avatar">${customer.profile_photo?`<img src="${escapeHtml(customer.profile_photo)}" alt="">`:escapeHtml(initials(customer.full_name))}</div><div class="customer-info"><strong>${escapeHtml(customer.full_name)}</strong><small>${escapeHtml(customer.phone)} · ${escapeHtml(customer.email)}</small></div><div class="last-operation"><span>Última operación</span><strong>${formatOperationDate(customer.last_operation)}</strong></div>${admin?`<button class="button secondary edit-customer" data-edit-customer="${customer.id}">Editar</button>`:''}</div>`).join(''):'<div class="empty-state">Todavía no hay clientes registrados.</div>';
}
async function loadEmployees() {
  employees=await api('/api/employees');
  const active=employees.filter(item=>item.role==='employee'||item.id===business.employee_id);
  $('#sale-employee').innerHTML=(business.role==='admin'?active:active.filter(item=>item.id===business.employee_id)).map(item=>`<option value="${item.id}" ${item.id===business.employee_id?'selected':''}>${escapeHtml(item.name)}${item.role==='admin'?' · administrador':''}</option>`).join('');
  $('#team-list').innerHTML=employees.length?employees.map(item=>`<div class="team-row"><div class="employee-initial">${escapeHtml(item.name.slice(0,1).toUpperCase())}</div><div class="team-info"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.email)}</small></div><span class="role-chip">${item.role==='admin'?'Admin':'Empleado'}</span>${business.role==='admin'?`<button class="button secondary reset-password" data-reset-password="${item.id}">Contraseña</button>`:''}</div>`).join(''):'<div class="empty-state">Todavía no hay personas.</div>';
  const admin=business.role==='admin'; $$('.admin-only').forEach(el=>el.classList.toggle('hidden',!admin));
  $('#catalog-form').classList.toggle('hidden',!admin); $('#brand-form').classList.toggle('hidden',!admin); $('#team-form').classList.toggle('hidden',!admin);
}
function renderCart() {
  $('#cart').innerHTML=cart.map(item=>`<div class="cart-row"><div>${escapeHtml(item.name)}<small>${money(item.price)} c/u</small></div><label><span class="hidden">Cantidad</span><input type="number" min="1" step="1" value="${item.quantity}" data-quantity="${item.id}"></label><strong>${money(item.price*item.quantity)}</strong><button type="button" class="remove-item" data-remove="${item.id}" aria-label="Quitar">×</button></div>`).join('');
  $('#sale-total').textContent=money(cart.reduce((sum,item)=>sum+item.price*item.quantity,0));
}
function escapeHtml(value) { return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }

async function resizePhoto(file) {
  if(!file?.type.startsWith('image/')) throw new Error('Elegí una imagen válida.');
  const source=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('No se pudo leer la imagen.'));reader.readAsDataURL(file)});
  const image=await new Promise((resolve,reject)=>{const el=new Image();el.onload=()=>resolve(el);el.onerror=()=>reject(new Error('No se pudo procesar la imagen.'));el.src=source});
  const max=640, scale=Math.min(1,max/Math.max(image.width,image.height)),canvas=document.createElement('canvas'); canvas.width=Math.max(1,Math.round(image.width*scale)); canvas.height=Math.max(1,Math.round(image.height*scale)); canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
  return canvas.toDataURL('image/jpeg',.82);
}
function connectPhotoInputs({file,camera,preview,target,fallback='+'}) { [file,camera].forEach(input=>input.addEventListener('change',async()=>{try { const photo=await resizePhoto(input.files[0]); target.value=photo; setPhoto(preview,photo,fallback); } catch(error) { if(input.files.length) toast(error.message); } finally { input.value=''; }})); }
if(!$('#auth-form').querySelector('[name="profile_photo"]')) $('#auth-form').append(Object.assign(document.createElement('input'),{type:'hidden',name:'profile_photo'}));
connectPhotoInputs({file:$('#auth-photo-file'),camera:$('#auth-photo-camera'),preview:$('#auth-photo-preview'),target:$('#auth-form').querySelector('[name="profile_photo"]')});
connectPhotoInputs({file:$('#customer-photo-file'),camera:$('#customer-photo-camera'),preview:$('#customer-photo-preview'),target:$('#customer-form').elements.profile_photo});
connectPhotoInputs({file:$('#profile-photo-file'),camera:$('#profile-photo-camera'),preview:$('#profile-photo-preview'),target:$('#profile-form').elements.profile_photo,fallback:initials('')});
$$('.tab').forEach(tab=>tab.addEventListener('click',()=>setAuthMode(tab.dataset.auth)));
$('#auth-form').addEventListener('submit',async event=>{event.preventDefault(); const formElement=event.currentTarget; const form=new FormData(formElement); const data=Object.fromEntries(form); try { if(authMode==='register') await api('/api/register',{method:'POST',body:JSON.stringify(data)}); if(authMode==='admin-register') await api('/api/admin/register',{method:'POST',body:JSON.stringify(data)}); await api('/api/login',{method:'POST',body:JSON.stringify({email:data.email,password:data.password})}); formElement.reset(); setPhoto($('#auth-photo-preview'),null); await start(); } catch(error) { toast(error.message); } });
$('#logout').addEventListener('click',async()=>{await api('/api/logout',{method:'POST'});localStorage.removeItem('ritual-business');me=null;business=null;show('auth')});
$('#waiting-logout').addEventListener('click',async()=>{await api('/api/logout',{method:'POST'});me=null;business=null;show('auth')});
$$('.nav-link[data-page]').forEach(button=>button.addEventListener('click',()=>navigate(button.dataset.page)));
$$('[data-go]').forEach(button=>button.addEventListener('click',()=>navigate(button.dataset.go)));
function navigate(page) { if(page==='business'&&business.role!=='admin') return; $$('.nav-link[data-page]').forEach(button=>button.classList.toggle('active',button.dataset.page===page)); $$('.page').forEach(section=>section.classList.toggle('hidden',section.id!=='page-'+page)); $('#page-title').textContent=({'home':'Resumen','new-sale':'Nueva venta','customers':'Clientes','catalog':'Servicios y productos','business':'Mi negocio','team':'Equipo'})[page]||'Resumen'; $('.sidebar').classList.remove('open'); if(page==='new-sale') $('#sale-customer').focus(); }
$('#period').addEventListener('change',()=>loadDashboard().catch(error=>toast(error.message)));
$('#menu-toggle').addEventListener('click',()=>$('.sidebar').classList.toggle('open'));
$('#item-picker').addEventListener('change',event=>{const item=catalog.find(entry=>String(entry.id)===event.target.value);if(item){const existing=cart.find(entry=>entry.id===item.id);if(existing)existing.quantity++;else cart.push({...item,quantity:1});renderCart();event.target.value=''}});
$('#cart').addEventListener('input',event=>{if(event.target.dataset.quantity){const item=cart.find(entry=>entry.id===Number(event.target.dataset.quantity));if(item)item.quantity=Math.max(1,Math.floor(Number(event.target.value)||1));renderCart()}});
$('#cart').addEventListener('click',event=>{const id=Number(event.target.dataset.remove);if(id){cart=cart.filter(item=>item.id!==id);renderCart()}});
$('#sale-form').addEventListener('submit',async event=>{event.preventDefault();const formElement=event.currentTarget;if(!cart.length){toast('Agregá al menos un servicio o producto.');return}const form=new FormData(formElement);try{await api('/api/sales',{method:'POST',body:JSON.stringify({customer_id:form.get('customer_id'),employee_id:form.get('employee_id'),items:cart.map(item=>({id:item.id,quantity:item.quantity}))})});formElement.reset();cart=[];renderCart();await Promise.all([loadDashboard(),loadCustomers()]);navigate('home');toast('Operación registrada.')}catch(error){toast(error.message)}});
$('#catalog-form').addEventListener('submit',async event=>{event.preventDefault();const formElement=event.currentTarget;const form=new FormData(formElement);try{await api('/api/catalog',{method:'POST',body:JSON.stringify(Object.fromEntries(form))});formElement.reset();await loadCatalog();toast('Agregado al catálogo.')}catch(error){toast(error.message)}});
$('#catalog-list').addEventListener('click',async event=>{const id=event.target.dataset.deleteCatalog;if(!id)return;try{await api('/api/catalog/'+id,{method:'DELETE'});await loadCatalog();toast('Se quitó del catálogo.')}catch(error){toast(error.message)}});
$('#team-form').addEventListener('submit',async event=>{event.preventDefault();const formElement=event.currentTarget;try{await api('/api/employees',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(formElement)))});formElement.reset();await loadEmployees();toast('Persona agregada al equipo.')}catch(error){toast(error.message)}});
$('#team-list').addEventListener('click',async event=>{const employeeId=Number(event.target.dataset.resetPassword);if(!employeeId)return;const password=prompt('Nueva contraseña (mínimo 8 caracteres):');if(password===null)return;try { await api(`/api/employees/${employeeId}/password`,{method:'PATCH',body:JSON.stringify({password})}); toast('Contraseña actualizada.'); } catch(error) { toast(error.message); }});
$('#brand-form').addEventListener('submit',async event=>{event.preventDefault();const form=new FormData(event.currentTarget),file=form.get('logo');const save=async logo=>{await api('/api/business',{method:'PATCH',body:JSON.stringify({name:form.get('name'),logo})});business.name=form.get('name');business.logo=logo;$('#top-name').textContent=business.name;updateBrand();toast('Datos del espacio guardados.')};try{if(file?.size){if(file.size>1_000_000)throw new Error('El logo debe pesar menos de 1 MB.');const reader=new FileReader();reader.onload=()=>save(reader.result).catch(error=>toast(error.message));reader.readAsDataURL(file)}else await save(business.logo||'')}catch(error){toast(error.message)}});
function openCustomerModal(customer=null, selectAfterCreate=false) { const form=$('#customer-form'); selectNewCustomer=selectAfterCreate; form.reset(); form.elements.id.value=customer?.id||''; form.elements.profile_photo.value=customer?.profile_photo||''; setPhoto($('#customer-photo-preview'),customer?.profile_photo,initials(customer?.full_name)); form.elements.full_name.value=customer?.full_name||''; form.elements.phone.value=customer?.phone||''; form.elements.email.value=customer?.email||''; $('#customer-modal-title').textContent=customer?'Editar cliente':'Nuevo cliente'; $('#customer-modal-copy').textContent=customer?'Actualizá sus datos de contacto y su foto de perfil.':'Completá sus datos para registrarlo.'; $('#customer-modal').classList.remove('hidden'); form.elements.full_name.focus(); }
function closeCustomerModal() { $('#customer-modal').classList.add('hidden'); }
$('#new-customer').addEventListener('click',()=>openCustomerModal());
$('#new-customer-from-sale').addEventListener('click',()=>openCustomerModal(null,true));
$('.close-modal').addEventListener('click',closeCustomerModal);
$('#customer-modal').addEventListener('click',event=>{if(event.target===event.currentTarget)closeCustomerModal()});
$('#customers-list').addEventListener('click',event=>{const id=Number(event.target.dataset.editCustomer);if(id)openCustomerModal(customers.find(customer=>customer.id===id));});
$('#customer-form').addEventListener('submit',async event=>{event.preventDefault();const formElement=event.currentTarget,form=new FormData(formElement),id=Number(form.get('id'));try{const data=Object.fromEntries(form);delete data.id;const result=await api(id?'/api/customers/'+id:'/api/customers',{method:id?'PATCH':'POST',body:JSON.stringify(data)});await loadCustomers();if(!id&&selectNewCustomer)$('#sale-customer').value=String(result.id);closeCustomerModal();toast(id?'Datos del cliente actualizados.':'Cliente creado.')}catch(error){toast(error.message)}});
function openProfileModal() { const form=$('#profile-form'); form.elements.profile_photo.value=me.profile_photo||''; setPhoto($('#profile-photo-preview'),me.profile_photo,initials(me.name)); $('#profile-modal').classList.remove('hidden'); }
function closeProfileModal() { $('#profile-modal').classList.add('hidden'); }
$('#edit-profile').addEventListener('click',openProfileModal);
$('.close-profile-modal').addEventListener('click',closeProfileModal);
$('#profile-modal').addEventListener('click',event=>{if(event.target===event.currentTarget)closeProfileModal()});
$('#profile-form').addEventListener('submit',async event=>{event.preventDefault();try { const form=event.currentTarget,profile_photo=form.elements.profile_photo.value,password=form.elements.password.value,currentPassword=form.elements.current_password.value; if(password||currentPassword) await api('/api/password',{method:'PATCH',body:JSON.stringify({current_password:currentPassword,password})}); await api('/api/profile',{method:'PATCH',body:JSON.stringify({profile_photo})}); me.profile_photo=profile_photo||null; setPhoto($('#avatar'),me.profile_photo,initials(me.name)); form.elements.password.value='';form.elements.current_password.value='';closeProfileModal();toast('Perfil actualizado.'); } catch(error) { toast(error.message); }});
if(adminRegistration) {
  $$('.auth-tabs').forEach(el=>el.classList.add('hidden')); $('#auth-eyebrow').textContent='ALTA ADMINISTRATIVA'; $('#auth-title').innerHTML='Creá tu negocio,<br>en orden.'; $('#auth-copy').textContent='Esta es la única vía para crear un negocio y su cuenta administradora.'; setAuthMode('admin-register');
} else setAuthMode('login');
start();
