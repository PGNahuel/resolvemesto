const $ = (selector, root=document) => root.querySelector(selector);
const $$ = (selector, root=document) => [...root.querySelectorAll(selector)];
const money = value => new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',maximumFractionDigits:0}).format(Number(value)||0);
const defaultProfileImage='/profile-placeholder.svg';
let me=null, business=null, catalog=[], customers=[], employees=[], cart=[], editCart=[], catalogFilter='active', authMode='login', toastTimer, selectNewCustomer=false, pendingRequests=0;
const adminRegistration=location.pathname==='/new/admin';

async function api(path, options={}) {
  const headers={'content-type':'application/json',...(options.headers||{})};
  if(business) headers['x-business-id']=business.id;
  pendingRequests++; setLoading(true);
  try {
    const response=await fetch(path,{...options,headers});
    const data=await response.json().catch(()=>({}));
    if(!response.ok) { const error=new Error(data.error||'No se pudo completar la acción.'); error.status=response.status; throw error; }
    return data;
  } finally { pendingRequests--; if(!pendingRequests)setLoading(false); }
}
function setLoading(active) { document.body.toggleAttribute('aria-busy',active); $('#loading').classList.toggle('show',active); $$('button[type="submit"]').forEach(button=>button.disabled=active); }
function toast(message,kind='info') { const el=$('#toast'); el.textContent=message; el.dataset.kind=kind; el.setAttribute('role',kind==='error'?'alert':'status'); el.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('show'),4500); }
function show(id) { ['auth','waiting','app'].forEach(name=>$('#'+name).classList.toggle('hidden',name!==id)); }
function initials(name) { return String(name||'').trim().slice(0,1).toUpperCase()||'·'; }
function setPhoto(element, photo, fallback='+') { element.replaceChildren(); if(photo) { const image=document.createElement('img'); image.src=photo; image.alt='Foto de perfil'; element.append(image); } else element.textContent=fallback; }
function setAuthMode(mode) {
  authMode=mode; const registering=mode==='register'||mode==='admin-register';
  $$('.tab').forEach(tab=>tab.classList.toggle('active',tab.dataset.auth===mode));
  $('#name-field').classList.toggle('hidden',!registering); $('#auth-photo-field').classList.toggle('hidden',!registering); $('#business-name-field').classList.toggle('hidden',mode!=='admin-register');
  const password=$('#auth-form').elements.password; password.minLength=registering?10:1; password.placeholder=registering?'Mínimo 10 caracteres':'Tu contraseña'; password.autocomplete=registering?'new-password':'current-password';
  $('#auth-submit').textContent=registering?(mode==='admin-register'?'Crear negocio y cuenta':'Crear usuario'):'Ingresar';
}
function selectBusiness(next) { business=next; localStorage.setItem('ritual-business',String(next.id)); $('#top-name').textContent=next.name; $('#top-role').textContent=next.role==='admin'?'Administración':'Equipo'; $('#brand-name').value=next.name; }
async function start() {
  try { const data=await api('/api/me'); me=data.user; $('#profile-name').textContent=me.name; $('#profile-email').textContent=me.email; setPhoto($('#avatar'),me.profile_photo,initials(me.name));
    if(!data.businesses.length) { show('waiting'); return; }
    $('#business-picker').replaceChildren();
    const saved=localStorage.getItem('ritual-business'); selectBusiness(data.businesses.find(x=>String(x.id)===saved)||data.businesses[0]);
    if(data.businesses.length>1) { const pick=document.createElement('select'); pick.className='business-select'; pick.setAttribute('aria-label','Elegir espacio'); data.businesses.forEach(item=>{const option=document.createElement('option');option.value=item.id;option.textContent=item.name;option.selected=item.id===business.id;pick.append(option)}); pick.addEventListener('change',()=>{selectBusiness(data.businesses.find(x=>String(x.id)===pick.value));startApp()}); $('#business-picker').append(pick); }
    show('app'); await startApp();
  } catch(error) { if(error.status===401)show('auth'); else { toast(error.message,'error'); if(me)show('app'); } }
}
async function startApp() { await Promise.all([loadDashboard(),loadCatalog(),loadCustomers(),loadEmployees(),loadSales()]); updateBrand(); }
function updateBrand() {
  const logo=business?.logo;
  $('#logo-preview').innerHTML=logo?`<img alt="Logo" src="${logo}">`:'✦';
  $('#brand-logo-preview').innerHTML=logo?`<img alt="Logo actual" src="${logo}">`:'✦';
}
async function loadDashboard() {
  const start=$('#date-start').value,end=$('#date-end').value;
  const data=await api('/api/dashboard?'+new URLSearchParams({start,end})),s=data.summary;
  const personal=data.scope==='personal',tickets=Number(s.tickets);
  $('#date-start').min=data.dateRange.min; $('#date-start').max=data.dateRange.max; $('#date-end').min=data.dateRange.min; $('#date-end').max=data.dateRange.max; $('#date-start').value=data.dateRange.start; $('#date-end').value=data.dateRange.end;
  const averageTicket=tickets?Number(s.revenue)/tickets:0;
  const variation=Number(data.previous.revenue)>0?(Number(s.revenue)-Number(data.previous.revenue))/Number(data.previous.revenue):null;
  const variationText=variation===null?'Sin comparación disponible':`${variation>=0?'↑':'↓'} ${Math.abs(Math.round(variation*100))}% vs. período anterior`;
  $('#stat-grid').classList.toggle('personal-stats',personal); $('#stat-tickets-card').classList.toggle('hidden',!personal); $('#team-activity-panel').classList.toggle('hidden',personal); $('#dashboard-grid').classList.toggle('personal-dashboard',personal);
  $('#stat-revenue-label').textContent=personal?'Mi facturación':'Facturación'; $('#stat-tickets').textContent=tickets;
  $('#stat-revenue').textContent=money(s.revenue); $('#stat-revenue-caption').textContent=variationText; $('#stat-average-ticket').textContent=money(averageTicket); $('#stat-average-caption').textContent=`${tickets} ${tickets===1?'operación registrada':'operaciones registradas'}`; $('#stat-services').textContent=s.services; $('#stat-products').textContent=s.products;
  $('#pulse-title').textContent=tickets?`${tickets} ${tickets===1?'atención registrada':'atenciones registradas'} en el período`:personal?'Aún no hay atenciones a tu nombre en el período':'Aún no hay ventas registradas en el período';
  $('#pulse-copy').textContent=tickets?(personal?'Este resumen incluye solo las operaciones donde figurás como quien atendió.':'Este resumen refleja únicamente la información cargada en las ventas.'):(personal?'Registrá una atención a tu nombre para ver tu facturación y actividad.':'Registrá una atención para empezar a ver facturación, ticket promedio y desempeño del equipo.');
  $('#featured-title').textContent=personal?'Tus servicios y productos más frecuentes':'Servicios y productos destacados'; $('#featured-copy').textContent=personal?'Ordenados por tu facturación registrada':'Ordenados por facturación registrada';
  $('#recent-title').textContent=personal?'Tus últimas atenciones':'Actividad reciente'; $('#recent-copy').textContent=personal?'Últimas 5 operaciones a tu nombre':'Últimas 5 operaciones registradas'; $('#recent-list').classList.toggle('personal-recent',personal);
  $('#employee-stats').innerHTML=data.employees.length?data.employees.map(e=>{const tickets=Number(e.tickets),revenue=Number(e.revenue),details=tickets?`${tickets} ${tickets===1?'ticket':'tickets'} · ${e.services} servicios · ${e.products} productos`:'Sin operaciones registradas';return `<div class="employee-row"><img class="activity-avatar" src="${escapeHtml(e.profile_photo||defaultProfileImage)}" alt="Foto de ${escapeHtml(e.name)}"><div class="employee-info"><strong>${escapeHtml(e.name)}</strong><small>${details}</small></div><div class="employee-count"><strong>${money(revenue)}</strong>${tickets?`<small>Ticket prom. ${money(revenue/tickets)}</small>`:''}</div></div>`}).join(''):'<div class="empty-state">Todavía no hay equipo registrado.</div>';
  const featuredGroup=(title,items,empty)=>`<section class="featured-group"><h3>${title}</h3>${items.length?items.map(item=>`<div class="popular-row"><div class="popular-bullet"></div><div><strong>${escapeHtml(item.name)}</strong><small>${item.quantity} ${Number(item.quantity)===1?'unidad':'unidades'}</small></div><b>${money(item.revenue)}</b></div>`).join(''):`<p class="featured-empty">${empty}</p>`}</section>`;
  $('#featured-list').innerHTML=featuredGroup('Servicios',data.featured.services,'Sin servicios registrados.')+featuredGroup('Productos',data.featured.products,'Sin productos registrados.');
  $('#recent-list').innerHTML=data.recent.length?data.recent.map(item=>`<div class="sale-row"><div><strong>${escapeHtml(item.customer||'Sin cliente')}</strong><small>${escapeHtml(item.items||'')}</small></div>${personal?'':`<span class="recent-employee"><img class="activity-avatar" src="${escapeHtml(item.profile_photo||defaultProfileImage)}" alt="Foto de ${escapeHtml(item.employee)}">${escapeHtml(item.employee)}</span>`}<span class="when">${new Date(item.created_at+'Z').toLocaleString('es-AR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</span><span class="total">${money(item.total)}</span></div>`).join(''):`<div class="empty-state">${personal?'Tus próximas atenciones aparecerán acá.':'Las operaciones recientes aparecerán acá.'}</div>`;
}
async function loadCatalog() {
  catalog=await api('/api/catalog');
  const catalogOptions=catalog.filter(item=>item.active).map(item=>`<option value="${item.id}">${escapeHtml(item.name)} · ${item.type==='service'?'Servicio':'Producto'} · ${money(item.price)}</option>`).join('');
  $('#item-picker').innerHTML='<option value="">Elegir servicio o producto…</option>'+catalogOptions; $('#edit-item-picker').innerHTML='<option value="">Sumar al ticket…</option>'+catalogOptions;
  renderCatalogList();
}
function renderCatalogList() { const query=$('#catalog-search').value.trim().toLocaleLowerCase('es-AR'),items=catalog.filter(item=>(catalogFilter==='all'||catalogFilter==='active'&&item.active||catalogFilter==='inactive'&&!item.active)&&item.name.toLocaleLowerCase('es-AR').includes(query)); $('#catalog-list').innerHTML=items.length?items.map(item=>`<div class="catalog-item ${item.active?'':'inactive'}"><div class="item-symbol">${item.photo?`<img src="${escapeHtml(item.photo)}" alt="">`:item.type==='service'?'✂':'▧'}</div><div class="catalog-info"><strong>${escapeHtml(item.name)}</strong><small>${item.type==='service'?'Servicio':'Producto'}${item.active?'':' · Inactivo'}</small></div><span class="item-price">${money(item.price)}</span>${business.role==='admin'?`<button class="button secondary edit-catalog" data-edit-catalog="${item.id}">Editar</button>`:''}</div>`).join(''):`<div class="empty-state">No encontramos productos o servicios con ese nombre.</div>`; }
function formatOperationDate(value) { return value ? new Date(value+'Z').toLocaleDateString('es-AR',{day:'2-digit',month:'short',year:'numeric'}) : 'Sin operaciones'; }
async function loadCustomers() {
  customers=await api('/api/customers');
  const customerOptions='<option value="">Sin cliente</option>'+customers.map(customer=>`<option value="${customer.id}">${escapeHtml(customer.full_name)} · #${customer.code}</option>`).join('');
  $('#sale-customer').innerHTML=customerOptions; $('#edit-sale-customer').innerHTML=customerOptions;
  const admin=business.role==='admin';
  $('#customers-list').innerHTML=customers.length?customers.map(customer=>`<div class="customer-row"><div class="customer-avatar">${customer.profile_photo?`<img src="${escapeHtml(customer.profile_photo)}" alt="">`:escapeHtml(initials(customer.full_name))}</div><div class="customer-info"><strong>${escapeHtml(customer.full_name)}</strong><small>${escapeHtml(customer.phone)} · ${escapeHtml(customer.email)}</small></div><div class="last-operation"><span>Última operación</span><strong>${formatOperationDate(customer.last_operation)}</strong></div>${admin?`<button class="button secondary edit-customer" data-edit-customer="${customer.id}">Editar</button>`:''}</div>`).join(''):'<div class="empty-state">Todavía no hay clientes registrados.</div>';
}
async function loadEmployees() {
  employees=await api('/api/employees');
  const active=employees.filter(item=>item.role==='employee'||item.id===business.employee_id);
  const employeeOptions=(business.role==='admin'?active:active.filter(item=>item.id===business.employee_id)).map(item=>`<option value="${item.id}" ${item.id===business.employee_id?'selected':''}>${escapeHtml(item.name)}${item.role==='admin'?' · administrador':''}</option>`).join('');
  $('#sale-employee').innerHTML=employeeOptions; $('#edit-sale-employee').innerHTML=employeeOptions;
  $('#team-list').innerHTML=employees.length?employees.map(item=>`<div class="team-row"><div class="employee-initial">${item.profile_photo?`<img src="${escapeHtml(item.profile_photo)}" alt="Foto de ${escapeHtml(item.name)}">`:escapeHtml(item.name.slice(0,1).toUpperCase())}</div><div class="team-info"><strong>${escapeHtml(item.name)}</strong><small>${item.email?escapeHtml(item.email):'Email privado'}</small></div><span class="role-chip">${item.role==='admin'?'Admin':'Empleado'}</span></div>`).join(''):'<div class="empty-state">Todavía no hay personas.</div>';
  const admin=business.role==='admin'; $$('.admin-only').forEach(el=>el.classList.toggle('hidden',!admin));
  $('#catalog-form').classList.toggle('hidden',!admin); $('#brand-form').classList.toggle('hidden',!admin); $('#team-add-panel').classList.toggle('hidden',!admin);
}
async function loadAudit() {
  const rows=await api('/api/audit'),labels={sale:'Venta',catalog:'Catálogo',customer:'Cliente',employee:'Equipo',business:'Negocio'},actions={created:'creó',updated:'editó',voided:'anuló',added:'agregó',deactivated:'desactivó'};
  $('#audit-list').innerHTML=rows.length?rows.map(row=>{const changes=[]; if(row.before&&row.after)for(const key of Object.keys(row.after)){if(JSON.stringify(row.before[key])!==JSON.stringify(row.after[key])&&!['items','profile_photo','logo'].includes(key))changes.push(key.replaceAll('_',' '));} const detail=row.action==='voided'&&row.after?.void_reason?`Motivo: ${row.after.void_reason}`:changes.length?`Cambios: ${changes.join(', ')}`:`Registro #${row.entity_id||'—'}`; return `<div class="audit-row"><div class="audit-dot"></div><div><strong>${escapeHtml(row.actor)} ${actions[row.action]||row.action} ${labels[row.entity_type]||row.entity_type}</strong><small>${escapeHtml(detail)}</small></div><time>${new Date(row.created_at+'Z').toLocaleString('es-AR',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})}</time></div>`;}).join(''):'<div class="empty-state">Los próximos cambios aparecerán acá.</div>';
}
function renderCart() {
  $('#cart').innerHTML=cart.map(item=>`<div class="cart-row"><div>${escapeHtml(item.name)}<small>${money(item.price)} c/u</small></div><label><span class="hidden">Cantidad</span><input type="number" min="1" step="1" value="${item.quantity}" data-quantity="${item.id}"></label><strong>${money(item.price*item.quantity)}</strong><button type="button" class="remove-item" data-remove="${item.id}" aria-label="Quitar">×</button></div>`).join('');
  updateCartTotal();
}
function updateCartTotal() { const discount=Math.max(0,Number($('#sale-form').elements.discount.value)||0); $('#sale-total').textContent=money(Math.max(0,cart.reduce((sum,item)=>sum+item.price*item.quantity,0)-discount)); }
function updateEditCartTotal() { const discount=Math.max(0,Number($('#edit-sale-form').elements.discount.value)||0); $('#edit-sale-total').textContent=money(Math.max(0,editCart.reduce((sum,item)=>sum+item.price*item.quantity,0)-discount)); }
function renderEditCart() { $('#edit-cart').innerHTML=editCart.map(item=>`<div class="cart-row"><div>${escapeHtml(item.name)}<small>${money(item.price)} c/u</small></div><label><span class="hidden">Cantidad</span><input type="number" min="1" max="1000" step="1" value="${item.quantity}" data-edit-quantity="${item.id}"></label><strong>${money(item.price*item.quantity)}</strong><button type="button" class="remove-item" data-edit-remove="${item.id}" aria-label="Quitar">×</button></div>`).join(''); updateEditCartTotal(); }
const paymentLabel={cash:'Efectivo',debit:'Débito',credit:'Crédito',transfer:'Transferencia',other:'Otro'};
async function loadSales() { const sales=await api('/api/sales'); $('#sales-list').innerHTML=sales.length?sales.map(sale=>`<div class="sale-history-row ${sale.status==='voided'?'voided':''}"><div><strong>${escapeHtml(sale.customer)} ${sale.status==='voided'?'<span class="status-chip">Anulada</span>':''}</strong><small>${escapeHtml(sale.items||'')}</small></div><div><span>${escapeHtml(sale.employee)} · ${paymentLabel[sale.payment_method]||'Otro'}</span><small>${new Date(sale.created_at+'Z').toLocaleString('es-AR',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})}</small></div><strong>${money(sale.total)}</strong><button class="button secondary view-sale" data-view-sale="${sale.id}">${sale.editable?'Ver / editar':'Ver detalle'}</button></div>`).join(''):'<div class="empty-state">Todavía no hay ventas registradas.</div>'; }
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
$$('.mobile-dock [data-page]').forEach(button=>button.addEventListener('click',()=>navigate(button.dataset.page)));
const themeToggle=$('.theme-toggle');
function setTheme(theme){document.documentElement.dataset.theme=theme;localStorage.setItem('ritual-theme',theme);const dark=theme==='dark';themeToggle.setAttribute('aria-label',dark?'Activar modo claro':'Activar modo oscuro');themeToggle.innerHTML=`${dark?'☀':'☾'} <span class="theme-label">Modo ${dark?'claro':'oscuro'}</span>`;}
setTheme(localStorage.getItem('ritual-theme')||'light');
themeToggle.addEventListener('click',()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark'));
$$('[data-go]').forEach(button=>button.addEventListener('click',()=>navigate(button.dataset.go)));
function navigate(page) { if(['business','audit'].includes(page)&&business.role!=='admin') return; $$('.nav-link[data-page],.mobile-dock [data-page]').forEach(button=>button.classList.toggle('active',button.dataset.page===page)); $$('.page').forEach(section=>section.classList.toggle('hidden',section.id!=='page-'+page)); $('#page-title').textContent=({'home':'Resumen','new-sale':'Nueva venta','sales':'Ventas realizadas','customers':'Clientes','catalog':'Servicios y productos','business':'Mi negocio','team':'Equipo','audit':'Auditoría'})[page]||'Resumen'; $('.sidebar').classList.remove('open'); menuToggle.setAttribute('aria-expanded','false'); if(page==='new-sale') $('#sale-customer').focus(); if(page==='sales') loadSales().catch(error=>toast(error.message,'error')); if(page==='audit')loadAudit().catch(error=>toast(error.message,'error')); }
['#date-start','#date-end'].forEach(selector=>$(selector).addEventListener('change',()=>loadDashboard().catch(error=>toast(error.message))));
const sidebar=$('.sidebar'), menuToggle=$('#menu-toggle');
menuToggle.addEventListener('click',()=>{
  const open=!sidebar.classList.contains('open');
  if(open)sidebar.style.setProperty('--sidebar-top',`${window.scrollY}px`);
  sidebar.classList.toggle('open',open);
  menuToggle.setAttribute('aria-expanded',String(open));
});
function closeSidebar(){sidebar.classList.remove('open');menuToggle.setAttribute('aria-expanded','false');}
function updateViewportInset(){
  const viewport=window.visualViewport;
  const viewportHeight=viewport?.height||window.innerHeight;
  const bottomInset=viewport?Math.max(0,window.innerHeight-viewport.height-viewport.offsetTop):0;
  document.documentElement.style.setProperty('--browser-chrome-bottom',`${bottomInset}px`);
  document.documentElement.style.setProperty('--visible-viewport-height',`${viewportHeight}px`);
}
updateViewportInset();
window.visualViewport?.addEventListener('resize',updateViewportInset);
window.visualViewport?.addEventListener('scroll',updateViewportInset);
window.addEventListener('resize',updateViewportInset);
window.addEventListener('scroll',()=>{
  if(window.matchMedia('(max-width: 700px)').matches)closeSidebar();
},{passive:true});
document.addEventListener('click',event=>{
  if(window.matchMedia('(max-width: 700px)').matches&&sidebar.classList.contains('open')&&!sidebar.contains(event.target)&&!menuToggle.contains(event.target))closeSidebar();
});
$('#item-picker').addEventListener('change',event=>{const item=catalog.find(entry=>String(entry.id)===event.target.value);if(item){const existing=cart.find(entry=>entry.id===item.id);if(existing)existing.quantity++;else cart.push({...item,quantity:1});renderCart();event.target.value=''}});
$('#cart').addEventListener('input',event=>{if(event.target.dataset.quantity){const item=cart.find(entry=>entry.id===Number(event.target.dataset.quantity)),quantity=Math.floor(Number(event.target.value));if(item&&quantity>0){item.quantity=quantity;event.target.closest('.cart-row').querySelector('strong').textContent=money(item.price*quantity);updateCartTotal()}}});
$('#cart').addEventListener('change',event=>{if(event.target.dataset.quantity){const item=cart.find(entry=>entry.id===Number(event.target.dataset.quantity));if(item)event.target.value=item.quantity;}});
$('#cart').addEventListener('click',event=>{const id=Number(event.target.dataset.remove);if(id){cart=cart.filter(item=>item.id!==id);renderCart()}});
$('#sale-form').elements.discount.addEventListener('input',updateCartTotal);
$('#sale-form').addEventListener('submit',async event=>{event.preventDefault();const formElement=event.currentTarget;if(!cart.length){toast('Agregá al menos un servicio o producto.','error');return}const form=new FormData(formElement);try{await api('/api/sales',{method:'POST',body:JSON.stringify({customer_id:form.get('customer_id'),employee_id:form.get('employee_id'),payment_method:form.get('payment_method'),discount:form.get('discount'),notes:form.get('notes'),items:cart.map(item=>({id:item.id,quantity:item.quantity}))})});formElement.reset();cart=[];renderCart();await Promise.all([loadDashboard(),loadCustomers(),loadSales()]);navigate('home');toast('Operación registrada.')}catch(error){toast(error.message,'error')}});
$('#edit-item-picker').addEventListener('change',event=>{const item=catalog.find(entry=>String(entry.id)===event.target.value);if(item){const existing=editCart.find(entry=>entry.id===item.id);if(existing)existing.quantity++;else editCart.push({...item,quantity:1});renderEditCart();event.target.value=''}});
$('#edit-cart').addEventListener('input',event=>{const id=Number(event.target.dataset.editQuantity);if(id){const item=editCart.find(entry=>entry.id===id),quantity=Math.floor(Number(event.target.value));if(item&&quantity>0){item.quantity=quantity;renderEditCart()}}});
$('#edit-cart').addEventListener('click',event=>{const id=Number(event.target.dataset.editRemove);if(id){editCart=editCart.filter(item=>item.id!==id);renderEditCart()}});
function closeSaleModal() { $('#sale-modal').classList.add('hidden'); }
async function openSaleModal(id) { try { const sale=await api('/api/sales/'+id),form=$('#edit-sale-form'); form.reset(); form.elements.id.value=sale.id; form.elements.customer_id.value=String(sale.customer_id||''); form.elements.employee_id.value=String(sale.employee_id); form.elements.payment_method.value=sale.payment_method||'cash'; form.elements.discount.value=sale.discount||0; form.elements.notes.value=sale.notes||''; editCart=sale.items.map(item=>({...item,quantity:Number(item.quantity),price:Number(item.price)})); renderEditCart(); const editable=!!sale.editable,status=$('#sale-status'); status.classList.toggle('hidden',sale.status!=='voided'); status.textContent=sale.status==='voided'?`Venta anulada · ${sale.void_reason}`:''; $('#sale-modal-title').textContent=editable?'Editar venta':'Detalle de venta'; $('#sale-modal-copy').textContent=sale.status==='voided'?'Se conserva para mantener la trazabilidad.':editable?'Toda corrección quedará registrada en Auditoría.':'Solo quien cargó la venta o un administrador puede modificarla.'; ['customer_id','employee_id','payment_method','discount','notes'].forEach(name=>form.elements[name].disabled=!editable); $('#edit-item-picker').disabled=!editable; $$('#edit-cart input,#edit-cart button').forEach(element=>element.disabled=!editable); $('#edit-cart').classList.toggle('read-only',!editable); $('#edit-sale-submit').classList.toggle('hidden',!editable); $('#void-sale').classList.toggle('hidden',!editable); $('#sale-modal').classList.remove('hidden'); $('.close-sale-modal').focus(); } catch(error) { toast(error.message,'error'); } }
$('#sales-list').addEventListener('click',event=>{const id=Number(event.target.dataset.viewSale);if(id)openSaleModal(id)});
$('.close-sale-modal').addEventListener('click',closeSaleModal); $('#sale-modal').addEventListener('click',event=>{if(event.target===event.currentTarget)closeSaleModal()});
$('#edit-sale-form').elements.discount.addEventListener('input',updateEditCartTotal);
$('#edit-sale-form').addEventListener('submit',async event=>{event.preventDefault();if(!editCart.length){toast('Agregá al menos un servicio o producto.','error');return}const form=new FormData(event.currentTarget);try { await api('/api/sales/'+form.get('id'),{method:'PATCH',body:JSON.stringify({customer_id:form.get('customer_id'),employee_id:form.get('employee_id'),payment_method:form.get('payment_method'),discount:form.get('discount'),notes:form.get('notes'),items:editCart.map(item=>({id:item.id,quantity:item.quantity}))})}); closeSaleModal(); await Promise.all([loadDashboard(),loadCustomers(),loadSales()]); toast('Venta actualizada y registrada en Auditoría.'); } catch(error) { toast(error.message,'error'); }});
$('#void-sale').addEventListener('click',async()=>{const form=$('#edit-sale-form'),reason=prompt('Motivo de anulación (obligatorio):');if(reason===null)return;try{await api(`/api/sales/${form.elements.id.value}/void`,{method:'POST',body:JSON.stringify({reason})});closeSaleModal();await Promise.all([loadDashboard(),loadSales()]);toast('Venta anulada. El registro se conserva en Auditoría.');}catch(error){toast(error.message,'error')}});
$('#catalog-form').addEventListener('submit',async event=>{event.preventDefault();const formElement=event.currentTarget;const form=new FormData(formElement);try{await api('/api/catalog',{method:'POST',body:JSON.stringify(Object.fromEntries(form))});formElement.reset();await loadCatalog();toast('Agregado al catálogo.')}catch(error){toast(error.message)}});
$('#catalog-search').addEventListener('input',renderCatalogList);
$$('[data-catalog-filter]').forEach(button=>button.addEventListener('click',()=>{catalogFilter=button.dataset.catalogFilter;$$('[data-catalog-filter]').forEach(item=>item.classList.toggle('active',item===button));renderCatalogList();}));
function closeCatalogModal() { $('#catalog-modal').classList.add('hidden'); }
function openCatalogModal(id) { const item=catalog.find(entry=>entry.id===id); if(!item)return; const form=$('#catalog-edit-form'); form.reset(); form.elements.id.value=item.id; form.elements.photo.value=item.photo||''; form.elements.name.value=item.name; form.elements.price.value=item.price; form.elements.active.value=String(!!item.active); $('#catalog-modal-title').textContent=`Editar: ${item.name}`; $('#catalog-modal-copy').textContent='El precio nuevo se aplicará solo a ventas futuras.'; setPhoto($('#catalog-photo-preview'),item.photo,item.type==='service'?'✂':'▧'); $('#catalog-modal').classList.remove('hidden'); }
$('#catalog-list').addEventListener('click',event=>{const id=Number(event.target.dataset.editCatalog);if(id)openCatalogModal(id)});
$('.close-catalog-modal').addEventListener('click',closeCatalogModal); $('#catalog-modal').addEventListener('click',event=>{if(event.target===event.currentTarget)closeCatalogModal()});
$('#catalog-photo-file').addEventListener('change',async event=>{try { const photo=await resizePhoto(event.target.files[0]); $('#catalog-edit-form').elements.photo.value=photo; setPhoto($('#catalog-photo-preview'),photo); } catch(error) { if(event.target.files.length)toast(error.message); } finally { event.target.value=''; }});
$('#catalog-edit-form').addEventListener('submit',async event=>{event.preventDefault();const form=new FormData(event.currentTarget);try { await api('/api/catalog/'+form.get('id'),{method:'PATCH',body:JSON.stringify({name:form.get('name'),price:form.get('price'),active:form.get('active')==='true',photo:form.get('photo')})}); closeCatalogModal(); await Promise.all([loadCatalog(),loadDashboard(),loadSales()]); toast('Producto o servicio actualizado.'); } catch(error) { toast(error.message,'error'); }});
$('#team-form').addEventListener('submit',async event=>{event.preventDefault();const formElement=event.currentTarget;try{await api('/api/employees',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(formElement)))});formElement.reset();await loadEmployees();toast('Persona agregada al equipo.')}catch(error){toast(error.message)}});
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
$('#profile-form').addEventListener('submit',async event=>{event.preventDefault();try { const form=event.currentTarget,profile_photo=form.elements.profile_photo.value,password=form.elements.password.value,currentPassword=form.elements.current_password.value; await api('/api/profile',{method:'PATCH',body:JSON.stringify({profile_photo})}); me.profile_photo=profile_photo||null; setPhoto($('#avatar'),me.profile_photo,initials(me.name)); if(password||currentPassword) { await api('/api/password',{method:'PATCH',body:JSON.stringify({current_password:currentPassword,password})}); form.reset(); closeProfileModal(); localStorage.removeItem('ritual-business'); me=null;business=null;show('auth');toast('Contraseña actualizada. Volvé a ingresar.'); return; } closeProfileModal();toast('Perfil actualizado.'); } catch(error) { toast(error.message,'error'); }});
document.addEventListener('keydown',event=>{if(event.key!=='Escape')return; closeCustomerModal();closeProfileModal();closeSaleModal();closeCatalogModal();sidebar.classList.remove('open');menuToggle.setAttribute('aria-expanded','false');});
if(adminRegistration) {
  $$('.auth-tabs').forEach(el=>el.classList.add('hidden')); $('#auth-eyebrow').textContent='ALTA ADMINISTRATIVA'; $('#auth-title').innerHTML='Creá tu negocio,<br>en orden.'; $('#auth-copy').textContent='Esta es la única vía para crear un negocio y su cuenta administradora.'; setAuthMode('admin-register');
} else setAuthMode('login');
start();
