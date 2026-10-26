import { createServer } from 'node:http';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDatabase } from './src/database.js';
import { Repository } from './src/repository.js';
import { Service } from './src/service.js';
import { Handler, sendJson } from './src/handler.js';

const root=new URL('.',import.meta.url).pathname;
const database=createDatabase();
await database.initialize();
const repository=new Repository(database);
const service=new Service(repository);
const handler=new Handler(service,join(root,'public'),()=>database.health());

function log(event,details={}) { console.log(JSON.stringify({time:new Date().toISOString(),event,...details})); }
function allowedOrigin(req) { if(!req.headers.origin||!req.headers.host)return true; try { return new URL(req.headers.origin).host===req.headers.host; } catch { return false; } }

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
    if(req.url.startsWith('/api/')||res.statusCode>=400)log('http_request',{request_id:req.requestId,method:req.method,path:new URL(req.url,'http://localhost').pathname,status:res.statusCode,duration_ms:Date.now()-started});
  });
  try {
    if(!allowedOrigin(req)&&['POST','PATCH','PUT','DELETE'].includes(req.method))return sendJson(res,403,{error:'Origen de solicitud no permitido.'});
    await handler.handle(req,res);
  } catch(error) {
    if(!error.status)log('request_error',{request_id:req.requestId,method:req.method,path:new URL(req.url,'http://localhost').pathname,error_name:error.name||'Error',error_code:error.code||null,error_message:error.message||String(error),stack:error.stack||null});
    if(!res.headersSent) { for(const [name,value] of Object.entries(error.headers||{}))res.setHeader(name,value); sendJson(res,error.status||500,{error:error.status?error.message:'Ocurrió un error. Revisá los datos e intentá de nuevo.',request_id:req.requestId}); }
    else res.end();
  }
});

const port=process.env.PORT===undefined?8081:Number(process.env.PORT);
server.listen(port,'0.0.0.0',()=>log('server_started',{url:`http://localhost:${server.address().port}`,node:process.version}));

function shutdown() { server.close(async()=>{ await repository.close(); process.exit(0); }); }
process.on('SIGTERM',shutdown);
process.on('SIGINT',shutdown);
