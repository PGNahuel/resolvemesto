import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDatabase } from '../src/database.js';

const tables=['users','businesses','employees','catalog','customers','sales','sale_items','sessions','audit_logs'];
const sourcePath=process.argv[2];
if(!sourcePath||!existsSync(sourcePath)) {
  console.error('Uso: npm run migrate:sqlite -- ruta/a/barberia.sqlite');
  process.exitCode=1;
} else {
  const source=new DatabaseSync(resolve(sourcePath),{readOnly:true});
  const target=createDatabase();
  try {
    await target.initialize();
    for(const table of tables) {
      const existing=await target.prepare(`SELECT COUNT(*) count FROM ${table}`).get();
      if(existing.count!==0)throw new Error(`La tabla MySQL ${table} ya contiene datos. La importación requiere una base vacía.`);
    }
    const counts={};
    await target.transaction(async()=>{
      for(const table of tables) {
        const rows=source.prepare(`SELECT * FROM ${table}`).all();
        counts[table]=rows.length;
        if(!rows.length)continue;
        const columns=Object.keys(rows[0]);
        const insert=target.prepare(`INSERT INTO ${table} (${columns.map(column=>`\`${column}\``).join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
        for(const row of rows)await insert.run(...columns.map(column=>row[column]));
      }
    });
    for(const table of tables) {
      const actual=(await target.prepare(`SELECT COUNT(*) count FROM ${table}`).get()).count;
      if(actual!==counts[table])throw new Error(`La verificación de ${table} falló: ${actual} en MySQL, ${counts[table]} en SQLite.`);
    }
    console.log(JSON.stringify({source:resolve(sourcePath),target:process.env.DB_NAME||'resolvemesto',counts}));
  } catch(error) {
    console.error(error.message);
    process.exitCode=1;
  } finally {
    source.close();
    await target.close();
  }
}
