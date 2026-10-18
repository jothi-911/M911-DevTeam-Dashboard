// Scheduled every night: keeps the last 21 automatic copies of all data in the database.
import { snapshot } from '../../src/api.js';
export default async () => { await snapshot('nightly'); return new Response('ok'); };
export const config = { schedule: '@daily' };
