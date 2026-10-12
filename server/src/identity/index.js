import { createIdentity as local } from './local.js';
import { createMail } from '../mail.js';
export function identity(env) { return local(env, createMail(env)); }
