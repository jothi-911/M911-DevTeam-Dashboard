// Netlify Function (free plan): every /api/* request is handled by src/api.js.
import { handle } from '../../src/api.js';
export default async (req) => handle(req);
export const config = { path: '/api/*' };
