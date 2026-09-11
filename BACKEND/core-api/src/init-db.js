import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config();
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const here=path.dirname(fileURLToPath(import.meta.url));
const sqlDir=path.resolve(here,'../sql');
const files=['schema.sql','portfolio.sql','support_notifications.sql','admin_controls.sql'];
const pool=new Pool({connectionString:process.env.DATABASE_URL});
try{
  for(const name of files){
    const sql=await fs.readFile(path.join(sqlDir,name),'utf8');
    await pool.query(sql);
    console.log(`DB ready: ${name}`);
  }
}finally{await pool.end();}
