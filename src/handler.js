import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { notFound, unauthorized } from './errors.js';

const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};
const installPages={home:'Resumen','new-sale':'Nueva venta',sales:'Ventas',customers:'Clientes',catalog:'Catálogo',business:'Mi negocio',team:'Equipo',audit:'Auditoría'};

export function sendJson(res,status,payload) {
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
  res.end(JSON.stringify(payload));
}

export class Handler {
  constructor(service,publicDirectory) { this.service=service; this.publicDirectory=publicDirectory; }

  async handle(req,res) {
    const url=new URL(req.url,'http://localhost'),path=url.pathname,method=req.method;
    if(method==='GET'&&path==='/manifest.webmanifest') {
      const page=Object.hasOwn(installPages,url.searchParams.get('page'))?url.searchParams.get('page'):'home';
      const manifest={id:`/resolvemesto-${page}`,name:`Resolvemesto · ${installPages[page]}`,short_name:`Resolvemesto ${installPages[page]}`,start_url:`/#/${page}`,scope:'/',display:'standalone',background_color:'#f6f5f2',theme_color:'#31493d',icons:[{src:'/icon-192.png',sizes:'192x192',type:'image/png'},{src:'/icon-512.png',sizes:'512x512',type:'image/png'}]};
      res.writeHead(200,{'content-type':'application/manifest+json; charset=utf-8','cache-control':'no-store'}); res.end(JSON.stringify(manifest)); return;
    }
    if(method==='GET'&&!path.startsWith('/api/'))return this.#static(path,res);

    if(method==='POST'&&path==='/api/register')return sendJson(res,201,await this.service.registerUser(await readJsonBody(req)));
    if(method==='POST'&&path==='/api/admin/register')return sendJson(res,201,await this.service.registerAdmin(await readJsonBody(req)));
    if(method==='POST'&&path==='/api/login') {
      const result=await this.service.login(await readJsonBody(req),clientIp(req));
      res.setHeader('set-cookie',sessionCookie(result.token));
      return sendJson(res,200,result.user);
    }
    if(method==='POST'&&path==='/api/logout') {
      this.service.logout(getCookie(req,'sid'));
      res.setHeader('set-cookie',sessionCookie('',0));
      return sendJson(res,200,{ok:true});
    }

    const user=this.service.getSessionUser(getCookie(req,'sid'));
    if(path==='/api/me'&&method==='GET') {
      if(!user)throw unauthorized('Iniciá sesión.');
      return sendJson(res,200,this.service.me(user));
    }
    if(!user)throw unauthorized('Iniciá sesión.');

    if(path==='/api/profile'&&method==='PATCH')return sendJson(res,200,this.service.updateProfile(user,await readJsonBody(req)));
    if(path==='/api/password'&&method==='PATCH') {
      const result=await this.service.changePassword(user,await readJsonBody(req));
      res.setHeader('set-cookie',sessionCookie('',0));
      return sendJson(res,200,result);
    }

    const business=this.service.authorizeBusiness(user,Number(req.headers['x-business-id'])),context={user,business};
    if(path==='/api/business'&&method==='PATCH')return sendJson(res,200,this.service.updateBusiness(context,await readJsonBody(req)));

    if(path==='/api/customers'&&method==='GET')return sendJson(res,200,this.service.listCustomers(context));
    if(path==='/api/customers'&&method==='POST')return sendJson(res,201,this.service.createCustomer(context,await readJsonBody(req)));
    let match=path.match(/^\/api\/customers\/(\d+)$/);
    if(match&&method==='PATCH')return sendJson(res,200,this.service.updateCustomer(context,Number(match[1]),await readJsonBody(req)));

    if(path==='/api/catalog'&&method==='GET')return sendJson(res,200,this.service.listCatalog(context));
    if(path==='/api/catalog'&&method==='POST')return sendJson(res,201,this.service.createCatalogItem(context,await readJsonBody(req)));
    match=path.match(/^\/api\/catalog\/(\d+)\/history-impact$/);
    if(match&&method==='GET')return sendJson(res,200,this.service.catalogHistoryImpact(context,Number(match[1]),String(url.searchParams.get('start')||''),String(url.searchParams.get('end')||'')));
    match=path.match(/^\/api\/catalog\/(\d+)$/);
    if(match&&method==='PATCH')return sendJson(res,200,this.service.updateCatalogItem(context,Number(match[1]),await readJsonBody(req)));
    if(match&&method==='DELETE')return sendJson(res,200,this.service.deactivateCatalogItem(context,Number(match[1])));

    if(path==='/api/employees'&&method==='GET')return sendJson(res,200,this.service.listEmployees(context));
    if(path==='/api/employees'&&method==='POST')return sendJson(res,201,await this.service.addEmployee(context,await readJsonBody(req)));
    if(/^\/api\/employees\/\d+\/password$/.test(path)&&method==='PATCH')return this.service.rejectEmployeePasswordReset();

    if(path==='/api/sales'&&method==='GET')return sendJson(res,200,this.service.listSales(context));
    if(path==='/api/sales'&&method==='POST')return sendJson(res,201,this.service.createSale(context,await readJsonBody(req)));
    match=path.match(/^\/api\/sales\/(\d+)\/void$/);
    if(match&&method==='POST')return sendJson(res,200,this.service.voidSale(context,Number(match[1]),await readJsonBody(req)));
    match=path.match(/^\/api\/sales\/(\d+)$/);
    if(match&&method==='GET')return sendJson(res,200,this.service.getSale(context,Number(match[1])));
    if(match&&method==='PATCH')return sendJson(res,200,this.service.updateSale(context,Number(match[1]),await readJsonBody(req)));

    if(path==='/api/audit'&&method==='GET')return sendJson(res,200,this.service.listAudit(context));
    if(path==='/api/dashboard'&&method==='GET')return sendJson(res,200,this.service.dashboard(context,url.searchParams.get('start'),url.searchParams.get('end')));
    throw notFound('No encontrado.');
  }

  async #static(path,res) {
    const file=path==='/'||path==='/new/admin'?'index.html':path.slice(1);
    if(file.includes('..'))throw notFound('No encontrado.');
    try { const data=await readFile(join(this.publicDirectory,file)); res.writeHead(200,{'content-type':mime[extname(file)]||'application/octet-stream','cache-control':'no-store'}); res.end(data); }
    catch(error) { if(error.code==='ENOENT')throw notFound('No encontrado.'); throw error; }
  }
}

async function readJsonBody(req) {
  let data='';
  for await(const chunk of req) {
    data+=chunk;
    if(data.length>2_000_000) { const error=new Error('El archivo es demasiado grande.'); error.status=413; throw error; }
  }
  try { return data?JSON.parse(data):{}; }
  catch { const error=new Error('Los datos enviados no tienen un formato válido.'); error.status=400; throw error; }
}

function getCookie(req,name) { return (req.headers.cookie||'').split(';').map(value=>value.trim()).find(value=>value.startsWith(`${name}=`))?.slice(name.length+1); }
function sessionCookie(token,maxAge=2592000) { return `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${process.env.NODE_ENV==='production'?'; Secure':''}`; }
function clientIp(req) { const address=process.env.TRUST_PROXY==='1'?req.headers['x-forwarded-for']:req.socket.remoteAddress; return String(address||'unknown').split(',')[0].trim(); }
