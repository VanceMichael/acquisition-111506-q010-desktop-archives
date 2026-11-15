
import { startProvider } from './source.mjs';
const source = await startProvider({ port: Number(process.env.SOURCE_PORT ?? 4311), host: process.env.SOURCE_HOST ?? '127.0.0.1' });
console.log(JSON.stringify({ role: 'local-source', url: source.url }));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => source.close().then(() => process.exit(0)));
