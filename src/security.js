import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt=promisify(scryptCallback);
const options={N:16384,r:8,p:1,maxmem:32*1024*1024};

export function normalizeEmail(value) { return String(value||'').normalize('NFKC').trim().toLowerCase(); }
export function validEmail(value) { return value.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
export function validPassword(value) { return typeof value==='string'&&value.length>=10&&value.length<=200; }
export function validPhoto(value) { return typeof value==='string'&&(value===''||(value.startsWith('data:image/')&&value.length<1_500_000)); }
export function sessionKey(token) { return createHash('sha256').update(token).digest('hex'); }
export function createSessionToken() { return randomBytes(32).toString('hex'); }

export async function passwordHash(password) {
  const salt=randomBytes(16),hash=await scrypt(password,salt,64,options);
  return `scrypt$16384$8$1$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function passwordMatches(password,encoded) {
  try {
    if(encoded.startsWith('scrypt$')) {
      const [,n,r,p,salt,hash]=encoded.split('$'),expected=Buffer.from(hash,'hex');
      const actual=await scrypt(password,Buffer.from(salt,'hex'),expected.length,{N:Number(n),r:Number(r),p:Number(p),maxmem:32*1024*1024});
      return expected.length===actual.length&&timingSafeEqual(actual,expected);
    }
    const [salt,hash]=encoded.split(':'),expected=Buffer.from(hash,'hex'),actual=await scrypt(password,salt,expected.length);
    return expected.length===actual.length&&timingSafeEqual(actual,expected);
  } catch { return false; }
}

export async function spendPasswordHashTime(password) { await scrypt(password,Buffer.alloc(16),64,options); }
